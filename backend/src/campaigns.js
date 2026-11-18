// Campaign lifecycle and the Gmail sending worker.
//
// Campaign status:   draft → sending ⇄ paused → completed | cancelled
// Recipient status:  queued → sending → sent | failed      (or skipped, never attempted)
//
// Duplicate-send protection:
//   1. draft → sending is a compare-and-set; a second launch request gets 409.
//   2. Only one worker loop per campaign runs in this process.
//   3. A recipient is attempted only from "queued"; "sent" is never retried.
//   4. A recipient left in "sending" by a crash/restart is marked failed with an explicit
//      "outcome unknown" reason and is NOT retried automatically.
//   5. The same email address appears once per campaign; customers who already received a
//      message with the identical subject template from another campaign are skipped.
import * as store from "./store.js";
import * as gmail from "./gmail.js";
import { HttpError, badRequest, cleanString, conflict, isValidEmail, notFound } from "./http.js";
import { renderEmail, unknownPlaceholders, PLACEHOLDERS } from "./templates.js";

const SEND_DELAY_MS = () => Number(process.env.SEND_DELAY_MS ?? 1200);
const DAILY_LIMIT = () => Number(process.env.GMAIL_DAILY_LIMIT || 400);
const MAX_ATTEMPTS = 3;
const MAX_AUDIENCE = 2000;

const running = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

export function countsOf(recipients = []) {
  const counts = { total: recipients.length, queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of recipients) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

function validateDraft(input = {}, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  if (!partial || has("name")) {
    out.name = cleanString(input.name, 120);
    if (!out.name) throw badRequest("Campaign name is required.");
  }
  if (!partial || has("subject")) {
    out.subject = cleanString(input.subject, 200);
    if (!out.subject) throw badRequest("Email subject is required.");
  }
  if (!partial || has("body")) {
    out.body = String(input.body ?? "").replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 10000);
    if (!out.body) throw badRequest("Email body is required.");
  }
  if (!partial || has("offer")) out.offer = cleanString(input.offer, 200);
  if (!partial || has("segmentKey")) out.segmentKey = cleanString(input.segmentKey, 60) || "custom";
  if (!partial || has("segmentLabel")) out.segmentLabel = cleanString(input.segmentLabel, 120) || "Custom audience";
  if (!partial || has("audienceIds")) {
    if (!Array.isArray(input.audienceIds)) throw badRequest("audienceIds must be an array of customer ids.");
    out.audienceIds = [...new Set(input.audienceIds.map(String))];
    if (out.audienceIds.length > MAX_AUDIENCE) throw badRequest(`A campaign can target at most ${MAX_AUDIENCE} customers.`);
  }
  const unknown = unknownPlaceholders(out.subject, out.body, out.offer);
  if (unknown.length) {
    throw badRequest(`Unknown placeholder(s): ${unknown.map((k) => `{{${k}}}`).join(", ")}. Available: ${Object.keys(PLACEHOLDERS).map((k) => `{{${k}}}`).join(", ")}.`);
  }
  return out;
}

export async function list(ownerId) {
  const campaigns = await store.find("campaigns", { ownerId });
  return campaigns
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(({ recipients, ...rest }) => ({ ...rest, audienceCount: rest.audienceIds?.length || 0 }));
}

export async function get(ownerId, id) {
  const campaign = await store.findOne("campaigns", { ownerId, id: String(id) });
  if (!campaign) throw notFound("Campaign not found.");
  return { ...campaign, audienceCount: campaign.audienceIds?.length || 0, running: running.has(campaign.id) };
}

export async function createDraft(ownerId, input) {
  const data = validateDraft(input);
  const owned = new Set((await store.find("customers", { ownerId })).map((c) => c.id));
  const foreign = data.audienceIds.filter((cid) => !owned.has(cid));
  if (foreign.length) throw badRequest(`${foreign.length} audience id(s) do not belong to your customers.`);
  return store.insert("campaigns", {
    ...data,
    ownerId,
    channel: "Email",
    status: "draft",
    source: cleanString(input.source, 60) || "manual",
    recipients: [],
    counts: countsOf([]),
    launchedAt: null,
    completedAt: null,
    lastError: null,
  });
}

export async function updateDraft(ownerId, id, input) {
  const existing = await get(ownerId, id);
  if (existing.status !== "draft") throw conflict("Only draft campaigns can be edited. Duplicate it to make changes.");
  const patch = validateDraft({ ...input }, { partial: true });
  if (patch.audienceIds) {
    const owned = new Set((await store.find("customers", { ownerId })).map((c) => c.id));
    if (patch.audienceIds.some((cid) => !owned.has(cid))) throw badRequest("Some audience ids do not belong to your customers.");
  }
  const updated = await store.update("campaigns", { ownerId, id: existing.id, status: "draft" }, patch);
  if (!updated) throw conflict("The campaign was launched while you were editing it.");
  return updated;
}

export async function duplicate(ownerId, id) {
  const source = await get(ownerId, id);
  return createDraft(ownerId, {
    name: `${source.name} (copy)`, subject: source.subject, body: source.body, offer: source.offer,
    segmentKey: source.segmentKey, segmentLabel: source.segmentLabel, audienceIds: source.audienceIds, source: "duplicate",
  });
}

export async function removeCampaign(ownerId, id) {
  const existing = await get(ownerId, id);
  if (existing.status === "sending" || running.has(existing.id)) throw conflict("Pause or cancel the campaign before deleting it.");
  await store.remove("campaigns", { ownerId, id: existing.id });
  return { deleted: true };
}

// ---------------------------------------------------------------- eligibility
function ineligibility(customer) {
  if (!customer) return "Customer was deleted";
  if (!customer.email) return "No email address";
  if (!isValidEmail(customer.email)) return `Invalid email address (${customer.email})`;
  if (!customer.consent) return "No marketing consent";
  return null;
}

async function buildRecipients(ownerId, campaign) {
  const customers = await store.find("customers", { ownerId });
  const byId = new Map(customers.map((c) => [c.id, c]));
  const others = (await store.find("campaigns", { ownerId })).filter((c) => c.id !== campaign.id);
  const alreadyReceived = new Map(); // customerId -> campaign name with identical subject template
  for (const other of others) {
    if (other.subject !== campaign.subject) continue;
    for (const r of other.recipients || []) if (r.status === "sent") alreadyReceived.set(r.customerId, other.name);
  }
  const seenEmails = new Set();
  return campaign.audienceIds.map((customerId) => {
    const customer = byId.get(customerId);
    const base = { customerId, name: customer?.name || "(deleted customer)", email: customer?.email || "", status: "queued", reason: null, messageId: null, threadId: null, attempts: 0, attemptedAt: null, sentAt: null };
    const reason = ineligibility(customer);
    if (reason) return { ...base, status: "skipped", reason };
    if (seenEmails.has(customer.email)) return { ...base, status: "skipped", reason: "Duplicate email address in this campaign" };
    seenEmails.add(customer.email);
    if (alreadyReceived.has(customerId)) return { ...base, status: "skipped", reason: `Already received this email in "${alreadyReceived.get(customerId)}"` };
    return base;
  });
}

export async function eligibility(ownerId, id) {
  const campaign = await get(ownerId, id);
  const recipients = campaign.status === "draft" ? await buildRecipients(ownerId, campaign) : campaign.recipients;
  const reasons = {};
  for (const r of recipients) if (r.status === "skipped") reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  return { counts: countsOf(recipients), skippedReasons: reasons, recipients };
}

// ---------------------------------------------------------------- lifecycle actions
async function sentInLast24h(ownerId) {
  const since = Date.now() - 86400000;
  const campaigns = await store.find("campaigns", { ownerId });
  return campaigns.reduce((sum, c) => sum + (c.recipients || []).filter((r) => r.status === "sent" && new Date(r.sentAt).getTime() >= since).length, 0);
}

async function assertGmailReady(ownerId) {
  const status = await gmail.getStatus(ownerId);
  if (!status.configured) throw new HttpError(503, "Gmail OAuth is not configured on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  if (!status.connected) throw badRequest(status.needsReconnect ? `Gmail needs to be reconnected: ${status.lastError || "authorization expired"}` : "Connect your Gmail account in Settings before launching a campaign.");
}

export async function launch(ownerId, id) {
  const campaign = await get(ownerId, id); // ownership first: 404 for other users' campaigns
  await assertGmailReady(ownerId);
  if (campaign.status !== "draft") throw conflict(`This campaign is already ${campaign.status}. A campaign can only be launched once.`);
  const recipients = await buildRecipients(ownerId, campaign);
  const counts = countsOf(recipients);
  if (!counts.queued) {
    const reasons = [...new Set(recipients.map((r) => r.reason).filter(Boolean))];
    throw badRequest(`No eligible recipients. ${reasons.length ? `Reasons: ${reasons.join("; ")}.` : "The audience is empty."}`, { counts });
  }
  const remaining = DAILY_LIMIT() - (await sentInLast24h(ownerId));
  if (remaining <= 0) throw badRequest(`Daily sending limit reached (${DAILY_LIMIT()} emails in 24 hours). Try again later.`);

  const launched = await store.update("campaigns", { ownerId, id: campaign.id, status: "draft" }, {
    status: "sending", recipients, counts, launchedAt: nowIso(), lastError: null,
  });
  if (!launched) throw conflict("This campaign was already launched.");
  startWorker(ownerId, campaign.id);
  return { ...launched, warning: counts.queued > remaining ? `Only ${remaining} emails remain in today's limit; the campaign will pause when it is reached.` : null };
}

export async function pause(ownerId, id) {
  const updated = await store.update("campaigns", { ownerId, id: String(id), status: "sending" }, { status: "paused", lastError: "Paused by you." });
  if (!updated) throw conflict("Only a campaign that is sending can be paused.");
  return updated;
}

export async function resume(ownerId, id) {
  await get(ownerId, id);
  await assertGmailReady(ownerId);
  const updated = await store.update("campaigns", { ownerId, id: String(id), status: "paused" }, { status: "sending", lastError: null });
  if (!updated) throw conflict("Only a paused campaign can be resumed.");
  startWorker(ownerId, updated.id);
  return updated;
}

async function skipQueued(ownerId, id, reason) {
  const campaign = await store.findOne("campaigns", { ownerId, id });
  if (!campaign) return null;
  const patch = {};
  campaign.recipients.forEach((r, i) => {
    if (r.status === "queued") { patch[`recipients.${i}.status`] = "skipped"; patch[`recipients.${i}.reason`] = reason; }
  });
  const updated = Object.keys(patch).length ? await store.update("campaigns", { ownerId, id }, patch) : campaign;
  return store.update("campaigns", { ownerId, id }, { counts: countsOf(updated.recipients) });
}

export async function cancel(ownerId, id) {
  const campaign = await get(ownerId, id);
  if (!["sending", "paused"].includes(campaign.status)) throw conflict("Only a sending or paused campaign can be cancelled.");
  const updated = await store.update("campaigns", { ownerId, id: campaign.id, status: campaign.status }, { status: "cancelled", completedAt: nowIso(), lastError: null });
  if (!updated) throw conflict("Campaign state changed; refresh and try again.");
  // If a worker is running it converts the queue itself when it sees "cancelled"; otherwise do it now.
  if (!running.has(campaign.id)) return skipQueued(ownerId, campaign.id, "Campaign cancelled before sending");
  return updated;
}

// ---------------------------------------------------------------- worker
async function patchRecipient(ownerId, id, index, fields) {
  const patch = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`recipients.${index}.${k}`, v]));
  const doc = await store.update("campaigns", { ownerId, id }, patch);
  return store.update("campaigns", { ownerId, id }, { counts: countsOf(doc.recipients) });
}

export function startWorker(ownerId, id) {
  if (running.has(id)) return;
  running.add(id);
  runWorker(ownerId, id)
    .catch(async (error) => {
      console.error(`[campaign ${id}] worker crashed`, error);
      await store.update("campaigns", { ownerId, id, status: "sending" }, { status: "paused", lastError: `Sending stopped unexpectedly: ${error.message}` }).catch(() => {});
    })
    .finally(() => running.delete(id));
}

async function runWorker(ownerId, id) {
  const user = await store.findOne("users", { id: ownerId });
  for (;;) {
    const campaign = await store.findOne("campaigns", { ownerId, id });
    if (!campaign) return;
    if (campaign.status === "cancelled") { await skipQueued(ownerId, id, "Campaign cancelled before sending"); return; }
    if (campaign.status !== "sending") return; // paused

    const index = campaign.recipients.findIndex((r) => r.status === "queued");
    if (index === -1) {
      await store.update("campaigns", { ownerId, id, status: "sending" }, { status: "completed", completedAt: nowIso(), counts: countsOf(campaign.recipients) });
      return;
    }
    if ((await sentInLast24h(ownerId)) >= DAILY_LIMIT()) {
      await store.update("campaigns", { ownerId, id, status: "sending" }, { status: "paused", lastError: `Paused: daily sending limit of ${DAILY_LIMIT()} emails reached. Resume after 24 hours.` });
      return;
    }

    // Re-check eligibility at send time: consent may have been withdrawn since launch.
    const recipient = campaign.recipients[index];
    const customer = await store.findOne("customers", { ownerId, id: recipient.customerId });
    const reason = ineligibility(customer);
    if (reason) { await patchRecipient(ownerId, id, index, { status: "skipped", reason: `${reason} (checked at send time)` }); continue; }

    await patchRecipient(ownerId, id, index, { status: "sending", attemptedAt: nowIso(), email: customer.email, name: customer.name });
    const email = renderEmail({ subject: campaign.subject, body: campaign.body, offer: campaign.offer, businessName: user?.businessName, senderName: user?.name }, customer);

    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await gmail.sendEmail(ownerId, { to: customer.email, subject: email.subject, text: email.text, html: email.html, fromName: user?.businessName || user?.name });
        await patchRecipient(ownerId, id, index, { status: "sent", messageId: result.messageId, threadId: result.threadId, sentAt: nowIso(), attempts: attempt, reason: null });
        break;
      } catch (error) {
        if (error.retryable && attempt < MAX_ATTEMPTS) { await sleep(Math.min(30000, 1000 * 3 ** (attempt - 1))); continue; }
        if (["auth", "not_connected", "quota"].includes(error.kind)) {
          // Gmail rejected the request before sending, so it is safe to put the recipient back in the queue.
          await patchRecipient(ownerId, id, index, { status: "queued", attempts: attempt, reason: null });
          await store.update("campaigns", { ownerId, id, status: "sending" }, { status: "paused", lastError: error.message });
          return;
        }
        await patchRecipient(ownerId, id, index, { status: "failed", reason: error.message, errorKind: error.kind || "unknown", httpStatus: error.httpStatus || null, attempts: attempt });
        break;
      }
    }
    if (SEND_DELAY_MS() > 0) await sleep(SEND_DELAY_MS());
  }
}

/** Called once at startup: campaigns cannot be "sending" if no worker survived the restart. */
export async function recoverInterrupted() {
  const all = await store.find("campaigns", { status: "sending" });
  for (const campaign of all) {
    const patch = { status: "paused", lastError: "The server restarted while this campaign was sending. Review the results and press Resume to continue." };
    campaign.recipients.forEach((r, i) => {
      if (r.status === "sending") {
        patch[`recipients.${i}.status`] = "failed";
        patch[`recipients.${i}.reason`] = "Interrupted during sending; outcome unknown. Not retried to avoid a duplicate email. Check your Gmail Sent folder.";
        patch[`recipients.${i}.errorKind`] = "ambiguous";
      }
    });
    const updated = await store.update("campaigns", { id: campaign.id }, patch);
    await store.update("campaigns", { id: campaign.id }, { counts: countsOf(updated.recipients) });
  }
  return all.length;
}

export const isRunning = (id) => running.has(id);
export const runningCount = () => running.size;
