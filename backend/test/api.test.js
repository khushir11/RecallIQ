// Integration tests: real Express app + real JSON store + real ML service (if running).
// Gmail is replaced ONLY at the HTTP transport layer by a fake that mimics Gmail API responses,
// so OAuth token handling, MIME building, classification and the campaign worker are exercised.
// Run: npm test   (start the ML service first for the risk tests: uvicorn app:app --port 8000)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "recalliq-test-"));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  TOKEN_ENCRYPTION_KEY: "test-encryption-key",
  SEND_DELAY_MS: "0",
  RATE_LIMIT_PER_MIN: "100000",
  ML_SERVICE_URL: process.env.ML_SERVICE_URL || "http://127.0.0.1:8000",
});
// Set MONGODB_TEST_URI to run the whole suite against MongoDB instead of JSON files, e.g.
//   MONGODB_TEST_URI="mongodb+srv://user:pass@cluster/recalliq_test" npm test   (use a throwaway database!)
if (process.env.MONGODB_TEST_URI) process.env.MONGODB_URI = process.env.MONGODB_TEST_URI;
else delete process.env.MONGODB_URI;
const expectedStorage = process.env.MONGODB_URI ? "mongodb" : "json";

const store = await import("../src/store.js");
const gmail = await import("../src/gmail.js");
const campaignsMod = await import("../src/campaigns.js");
const { createApp } = await import("../src/app.js");

let server; let base;
const sent = [];
const attemptsByEmail = {};

function decodeRaw(raw) {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function partText(mime) {
  // Decode every base64 body part of the MIME message so assertions can read the content.
  return mime.split(/\r\n\r\n/).slice(1).map((chunk) => {
    const b64 = chunk.split(/\r\n--/)[0].replace(/\r\n/g, "");
    try { return Buffer.from(b64, "base64").toString("utf8"); } catch { return ""; }
  }).join("\n");
}

// Fake Gmail transport: behaves like users.messages.send.
gmail.__setTransportForTests(async ({ raw }) => {
  const mime = decodeRaw(raw);
  const to = mime.match(/^To: (.+)$/m)[1].trim();
  attemptsByEmail[to] = (attemptsByEmail[to] || 0) + 1;
  const err = (status, data, message) => Object.assign(new Error(message), { response: { status, data } });
  if (to.startsWith("bounce400")) throw err(400, { error: { code: 400, message: "Invalid To header", errors: [{ reason: "invalidArgument" }] } }, "Invalid To header");
  if (to.startsWith("rate429") && attemptsByEmail[to] === 1) throw err(429, { error: { code: 429, message: "User-rate limit exceeded", errors: [{ reason: "userRateLimitExceeded" }] } }, "rate");
  if (to.startsWith("revoked")) throw err(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }, "invalid_grant");
  const id = `msg_${sent.length + 1}`;
  sent.push({ to, mime, id });
  return { id, threadId: `thr_${sent.length}`, labelIds: ["SENT"] };
});

async function call(method, url, { token, body, raw = false } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = raw ? await res.text() : await res.json().catch(() => null);
  return { status: res.status, data };
}

async function connectGmail(userId, email = "owner@gmail.com") {
  await store.remove("gmailTokens", { id: userId });
  await store.insert("gmailTokens", {
    id: userId, ownerId: userId, email, connectedAt: new Date().toISOString(), needsReconnect: false,
    sealed: { plain: { access_token: "ya29.test", refresh_token: "1//test", expiry_date: Date.now() + 3600_000, scope: "https://www.googleapis.com/auth/gmail.send openid" } },
  });
}

async function waitFor(fn, ms = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 40));
  }
}

let A; let B; // { token, user }
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

before(async () => {
  await store.initStore();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  server.close();
  await store.flush();
  if (process.env.MONGODB_URI) {
    const mongoose = (await import("mongoose")).default;
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- auth
test("auth: register, duplicate, validation, login, me, logout", async () => {
  let r = await call("POST", "/auth/register", { body: { name: "Asha", email: "asha@shop.in", password: "secret123", businessName: "Asha Stores" } });
  assert.equal(r.status, 201);
  assert.ok(r.data.token);
  assert.equal(r.data.user.passwordHash, undefined, "password hash must never be returned");
  A = r.data;

  r = await call("POST", "/auth/register", { body: { name: "Asha", email: "ASHA@shop.in", password: "secret123" } });
  assert.equal(r.status, 409, "duplicate registration (case-insensitive)");
  r = await call("POST", "/auth/register", { body: { name: "X", email: "x@shop.in", password: "short" } });
  assert.equal(r.status, 400);
  r = await call("POST", "/auth/register", { body: { name: "X", email: "not-an-email", password: "secret123" } });
  assert.equal(r.status, 400);

  r = await call("POST", "/auth/login", { body: { email: "asha@shop.in", password: "wrongpass1" } });
  assert.equal(r.status, 401);
  r = await call("POST", "/auth/login", { body: { email: "nobody@shop.in", password: "secret123" } });
  assert.equal(r.status, 401);
  assert.equal(r.data.error, "Invalid email or password.", "no account enumeration");
  r = await call("POST", "/auth/login", { body: { email: "asha@shop.in", password: "secret123" } });
  assert.equal(r.status, 200);
  const second = r.data.token;

  r = await call("GET", "/auth/me", { token: second });
  assert.equal(r.data.user.email, "asha@shop.in");
  r = await call("POST", "/auth/logout", { token: second });
  assert.equal(r.status, 200);
  r = await call("GET", "/auth/me", { token: second });
  assert.equal(r.status, 401, "token invalid after logout");

  r = await call("GET", "/customers");
  assert.equal(r.status, 401, "protected without token");
  r = await call("GET", "/customers", { token: "forged" });
  assert.equal(r.status, 401);

  const users = await store.find("users", {});
  assert.match(users[0].passwordHash, /^scrypt\$/);

  B = (await call("POST", "/auth/register", { body: { name: "Bilal", email: "bilal@shop.in", password: "secret123" } })).data;
});

// ---------------------------------------------------------------- customers
const ids = {};
test("customers: CRUD, validation, ownership", async () => {
  const mk = (body) => call("POST", "/customers", { token: A.token, body });
  let r = await mk({ name: "Aarav Mehta", email: "aarav@example.com", lastOrderDate: daysAgo(90), totalSpent: 18400, orderCount: 8, cartValue: 0, consent: true, engagementScore: 30, phone: "+91 99000 00001" });
  assert.equal(r.status, 201); ids.aarav = r.data.id;
  assert.equal(r.data.emailable, true);
  assert.equal(r.data.status, "at_risk");

  r = await mk({ name: "Bad", email: "bad@@example", consent: true });
  assert.equal(r.status, 400, "invalid email rejected");
  r = await mk({ name: "Dup", email: "AARAV@example.com" });
  assert.equal(r.status, 409, "duplicate email per user");
  r = await mk({ name: "Future", lastOrderDate: "2999-01-01" });
  assert.equal(r.status, 400, "future order date rejected");
  r = await mk({ name: "Neg", totalSpent: -5 });
  assert.equal(r.status, 400);

  ids.mira = (await mk({ name: "Mira Shah", email: "mira@example.com", lastOrderDate: daysAgo(10), totalSpent: 6200, orderCount: 3, cartValue: 2600, consent: true })).data.id;
  ids.dev = (await mk({ name: "Dev Iyer", email: "dev@example.com", lastOrderDate: daysAgo(70), totalSpent: 21600, orderCount: 7, consent: false })).data.id;
  ids.noemail = (await mk({ name: "Kabir Rao", email: "", lastOrderDate: daysAgo(100), totalSpent: 58200, orderCount: 19, consent: true })).data.id;
  ids.bounce = (await mk({ name: "Bounce Test", email: "bounce400@example.com", lastOrderDate: daysAgo(80), totalSpent: 9000, orderCount: 4, consent: true })).data.id;
  ids.rate = (await mk({ name: "Rate Limited", email: "rate429@example.com", lastOrderDate: daysAgo(65), totalSpent: 9500, orderCount: 5, consent: true })).data.id;

  r = await call("PATCH", `/customers/${ids.mira}`, { token: A.token, body: { cartValue: 3000, engagementScore: 70 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.cartValue, 3000);
  r = await call("PATCH", `/customers/${ids.mira}`, { token: A.token, body: { email: "nope" } });
  assert.equal(r.status, 400);

  r = await call("GET", "/customers?search=mira", { token: A.token });
  assert.equal(r.data.total, 1);
  r = await call("GET", "/customers?sort=totalSpent&order=desc", { token: A.token });
  assert.equal(r.data.items[0].name, "Kabir Rao");
  r = await call("GET", "/customers?consent=no", { token: A.token });
  assert.deepEqual(r.data.items.map((c) => c.name), ["Dev Iyer"]);

  // Ownership: user B sees nothing of A's and cannot touch it.
  r = await call("GET", "/customers", { token: B.token });
  assert.equal(r.data.total, 0);
  r = await call("GET", `/customers/${ids.aarav}`, { token: B.token });
  assert.equal(r.status, 404);
  r = await call("PATCH", `/customers/${ids.aarav}`, { token: B.token, body: { name: "hacked" } });
  assert.equal(r.status, 404);
  r = await call("DELETE", `/customers/${ids.aarav}`, { token: B.token });
  assert.equal(r.status, 404);

  const tmp = (await mk({ name: "Temp", email: "temp@example.com" })).data.id;
  r = await call("DELETE", `/customers/${tmp}`, { token: A.token });
  assert.equal(r.status, 200);
  r = await call("GET", `/customers/${tmp}`, { token: A.token });
  assert.equal(r.status, 404);
});

test("customers: CSV import (quoted fields, errors, merge) and export round-trip", async () => {
  const csv = [
    "name,email,phone,lastOrderDate,totalSpent,orderCount,cartValue,birthday,preferredChannel,consent",
    `"Rao, Tara",tara@example.com,+919900000008,${daysAgo(40)},4800,2,0,2001-06-16,Email,yes`,
    `Naina Kapoor,naina@example.com,,${daysAgo(5)},"9,200",4,1800,,SMS,true`,
    "Broken Row,broken@@x,,,,,,,,true",
    `Mira Shah,mira@example.com,,${daysAgo(10)},6500,4,3000,,Email,true`,
  ].join("\n");
  const r = await call("POST", "/customers/import", { token: A.token, body: { csv } });
  assert.equal(r.status, 200);
  assert.equal(r.data.created, 2);
  assert.equal(r.data.updated, 1, "existing email merged, not duplicated");
  assert.equal(r.data.errors.length, 1);
  assert.equal(r.data.errors[0].row, 4);

  const list = await call("GET", "/customers?search=tara", { token: A.token });
  assert.equal(list.data.items[0].name, "Rao, Tara");
  assert.equal(list.data.items[0].totalSpent, 4800);

  const exp = await call("GET", "/customers/export.csv", { token: A.token, raw: true });
  assert.equal(exp.status, 200);
  assert.match(exp.data, /"Rao, Tara"/);
  assert.match(exp.data, /\+919900000008/, "phone numbers not mangled by formula guard");

  // Re-importing the export must not create duplicates.
  const again = await call("POST", "/customers/import", { token: A.token, body: { csv: exp.data } });
  assert.equal(again.data.created, 0);
  assert.equal(again.data.errors.length, 0);
});

test("segments are computed from real data", async () => {
  const r = await call("GET", "/segments", { token: A.token });
  assert.equal(r.status, 200);
  const byKey = Object.fromEntries(r.data.segments.map((s) => [s.key, s]));
  // sleeping loyalists: 4+ orders and 60+ days → Aarav(8,90d) Dev(7,70d) Kabir(19,100d) Bounce(4,80d) Rate(5,65d)
  assert.equal(byKey.sleeping_loyalists.size, 5);
  assert.equal(byKey.sleeping_loyalists.reachable, 3, "Dev has no consent, Kabir has no email");
  assert.deepEqual(byKey.sleeping_loyalists.excluded, { noConsent: 1, invalidEmail: 1 });
  assert.equal(byKey.cart_abandoners.size, 2); // Mira, Naina
  assert.ok(byKey.sleeping_loyalists.recommendation.subject.includes("{{firstName}}"));
  const empty = await call("GET", "/segments", { token: B.token });
  assert.ok(empty.data.segments.every((s) => s.size === 0));
});

// ---------------------------------------------------------------- gmail + campaigns
test("gmail: status, test email, invalid recipient, not connected", async () => {
  let r = await call("GET", "/gmail/status", { token: A.token });
  assert.equal(r.data.connected, false);
  r = await call("POST", "/gmail/test", { token: A.token, body: { to: "asha@shop.in" } });
  assert.equal(r.status, 400, "test email without Gmail connected");
  assert.match(r.data.error, /not connected/i);

  r = await call("POST", "/gmail/connect", { token: A.token });
  assert.match(r.data.url, /accounts\.google\.com/);
  assert.match(r.data.url, /state=/);
  assert.match(r.data.url, /gmail\.send/);

  const forged = await fetch(`${base}/gmail/callback?code=abc&state=forged`);
  assert.equal(forged.status, 400, "callback with unknown state rejected");

  await connectGmail(A.user.id);
  r = await call("GET", "/gmail/status", { token: A.token });
  assert.equal(r.data.connected, true);
  assert.equal(r.data.email, "owner@gmail.com");
  assert.equal(JSON.stringify(r.data).includes("ya29"), false, "tokens never exposed");

  r = await call("POST", "/gmail/test", { token: A.token, body: { to: "asha@shop.in" } });
  assert.equal(r.status, 200);
  assert.match(r.data.messageId, /^msg_/);
  r = await call("POST", "/gmail/test", { token: A.token, body: { to: "not valid" } });
  assert.equal(r.status, 400);
  r = await call("POST", "/gmail/test", { token: A.token, body: { to: "bounce400@example.com" } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /rejected the recipient/);
});

test("tokens are encrypted at rest (AES-256-GCM) and round-trip", async () => {
  const { sealTokens, openTokens } = gmail.__internals;
  const sealed = sealTokens({ access_token: "ya29.secret", refresh_token: "1//refresh-secret" });
  assert.ok(sealed.enc && !sealed.plain);
  assert.equal(JSON.stringify(sealed).includes("refresh-secret"), false, "no plaintext token in stored record");
  assert.equal(openTokens({ sealed }).refresh_token, "1//refresh-secret");
  const tampered = structuredClone(sealed);
  tampered.enc.data = Buffer.from("x".repeat(40)).toString("base64");
  assert.throws(() => openTokens({ sealed: tampered }), "tampering is detected");
});

let campaignId;
test("campaigns: draft → launch → real per-recipient results", async () => {
  sent.length = 0;
  const audienceIds = [ids.aarav, ids.dev, ids.noemail, ids.bounce, ids.rate];
  let r = await call("POST", "/campaigns", { token: A.token, body: { name: "Loyalty Wake-Up", subject: "{{firstName}}, we saved ₹ perks for you 🎁", body: "Hi {{firstName}},\n\nIt has been {{daysSinceLastOrder}} days. {{offer}}.", offer: "15% off", segmentKey: "sleeping_loyalists", audienceIds } });
  assert.equal(r.status, 201);
  campaignId = r.data.id;
  assert.equal(r.data.status, "draft");

  r = await call("POST", "/campaigns", { token: A.token, body: { name: "x", subject: "Hi {{fristName}}", body: "b", audienceIds: [] } });
  assert.equal(r.status, 400, "unknown placeholder rejected");
  r = await call("POST", "/campaigns", { token: B.token, body: { name: "x", subject: "s", body: "b", audienceIds: [ids.aarav] } });
  assert.equal(r.status, 400, "cannot target another user's customers");

  r = await call("PUT", `/campaigns/${campaignId}`, { token: A.token, body: { offer: "15% off your next order" } });
  assert.equal(r.status, 200, "draft editable");

  r = await call("GET", `/campaigns/${campaignId}/eligibility`, { token: A.token });
  assert.equal(r.data.counts.queued, 3);
  assert.equal(r.data.counts.skipped, 2);
  assert.deepEqual(r.data.skippedReasons, { "No marketing consent": 1, "No email address": 1 });

  r = await call("POST", `/campaigns/${campaignId}/launch`, { token: B.token });
  assert.equal(r.status, 404, "other user cannot launch");

  const [l1, l2] = await Promise.all([
    call("POST", `/campaigns/${campaignId}/launch`, { token: A.token }),
    call("POST", `/campaigns/${campaignId}/launch`, { token: A.token }),
  ]);
  assert.deepEqual([l1.status, l2.status].sort(), [200, 409], "double launch → exactly one succeeds");

  const done = await waitFor(async () => { const c = (await call("GET", `/campaigns/${campaignId}`, { token: A.token })).data; return c.status === "completed" && c; });
  assert.equal(done.counts.sent, 2, "Aarav + Rate(after retry)");
  assert.equal(done.counts.failed, 1, "bounce400 rejected by Gmail");
  assert.equal(done.counts.skipped, 2);
  assert.equal(done.counts.queued, 0);
  const byName = Object.fromEntries(done.recipients.map((x) => [x.name, x]));
  assert.match(byName["Aarav Mehta"].messageId, /^msg_/);
  assert.equal(byName["Rate Limited"].attempts, 2, "429 retried once then sent");
  assert.equal(byName["Bounce Test"].status, "failed");
  assert.match(byName["Bounce Test"].reason, /Invalid To header/);
  assert.equal(byName["Bounce Test"].messageId, null);
  assert.equal(byName["Dev Iyer"].reason, "No marketing consent");
  assert.equal(sent.length, 2, "exactly two messages accepted by the fake Gmail");

  const aaravMail = sent.find((m) => m.to === "aarav@example.com");
  assert.match(aaravMail.mime, /^Subject: =\?UTF-8\?B\?/m, "non-ASCII subject is RFC 2047 encoded");
  const subject = Buffer.from(aaravMail.mime.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1], "base64").toString("utf8");
  assert.equal(subject, "Aarav, we saved ₹ perks for you 🎁");
  const body = partText(aaravMail.mime);
  assert.match(body, /Hi Aarav,/);
  assert.match(body, /It has been 90 days\. 15% off your next order\./);
  assert.match(body, /unsubscribe/i);
  assert.match(aaravMail.mime, /From: Asha Stores <owner@gmail\.com>/);

  r = await call("POST", `/campaigns/${campaignId}/launch`, { token: A.token });
  assert.equal(r.status, 409, "completed campaign cannot be relaunched");
  r = await call("PUT", `/campaigns/${campaignId}`, { token: A.token, body: { name: "edit" } });
  assert.equal(r.status, 409, "non-draft not editable");

  const hist = await call("GET", `/customers/${ids.aarav}`, { token: A.token });
  assert.equal(hist.data.history[0].status, "sent");
});

test("campaigns: same email to same customers is not sent twice", async () => {
  const dup = await call("POST", `/campaigns/${campaignId}/duplicate`, { token: A.token });
  assert.equal(dup.status, 201);
  const r = await call("POST", `/campaigns/${dup.data.id}/launch`, { token: A.token });
  assert.equal(r.status, 200);
  const byName = Object.fromEntries(r.data.recipients.map((x) => [x.name, x]));
  assert.match(byName["Aarav Mehta"].reason, /Already received this email in "Loyalty Wake-Up"/);
  assert.match(byName["Rate Limited"].reason, /Already received/);
  assert.equal(byName["Bounce Test"].status, "queued", "a previously FAILED recipient may be retried in a new campaign");
  assert.equal(r.data.counts.queued, 1);
  const before = sent.length;
  await waitFor(async () => (await call("GET", `/campaigns/${dup.data.id}`, { token: A.token })).data.status === "completed");
  assert.equal(sent.length, before, "no new message accepted (bounce fails again)");
});

test("campaigns: expired/revoked Gmail token pauses the campaign without losing recipients", async () => {
  const c = (await call("POST", "/customers", { token: A.token, body: { name: "Revoked Case", email: "revoked@example.com", lastOrderDate: daysAgo(70), consent: true } })).data;
  const camp = (await call("POST", "/campaigns", { token: A.token, body: { name: "Token test", subject: "Token test", body: "Hello {{firstName}}", audienceIds: [c.id] } })).data;
  let r = await call("POST", `/campaigns/${camp.id}/launch`, { token: A.token });
  assert.equal(r.status, 200);
  const paused = await waitFor(async () => { const x = (await call("GET", `/campaigns/${camp.id}`, { token: A.token })).data; return x.status === "paused" && !x.running && x; });
  assert.match(paused.lastError, /expired or was revoked/);
  assert.equal(paused.recipients[0].status, "queued", "not marked failed — Gmail never accepted it");
  assert.equal(paused.counts.sent, 0);
  const status = (await call("GET", "/gmail/status", { token: A.token })).data;
  assert.equal(status.needsReconnect, true);
  assert.equal(status.connected, false);
  r = await call("POST", `/campaigns/${camp.id}/resume`, { token: A.token });
  assert.equal(r.status, 400, "cannot resume until Gmail is reconnected");
  r = await call("POST", `/campaigns/${camp.id}/cancel`, { token: A.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.recipients[0].status, "skipped");
  assert.equal(r.data.status, "cancelled");
  await connectGmail(A.user.id);
});

test("campaigns: pause, resume, cancel while sending; delete rules", async () => {
  process.env.SEND_DELAY_MS = "150";
  const created = [];
  for (let i = 0; i < 6; i += 1) created.push((await call("POST", "/customers", { token: A.token, body: { name: `Bulk ${i}`, email: `bulk${i}@example.com`, lastOrderDate: daysAgo(70), consent: true } })).data.id);
  const camp = (await call("POST", "/campaigns", { token: A.token, body: { name: "Bulk", subject: "Bulk {{firstName}}", body: "Hi", audienceIds: created } })).data;
  await call("POST", `/campaigns/${camp.id}/launch`, { token: A.token });
  let r = await call("DELETE", `/campaigns/${camp.id}`, { token: A.token });
  assert.equal(r.status, 409, "cannot delete while sending");
  r = await call("POST", `/campaigns/${camp.id}/pause`, { token: A.token });
  assert.equal(r.status, 200);
  const paused = await waitFor(async () => { const x = (await call("GET", `/campaigns/${camp.id}`, { token: A.token })).data; return !x.running && x; });
  assert.equal(paused.status, "paused");
  assert.ok(paused.counts.queued > 0, "remaining recipients still queued");
  const sentSoFar = paused.counts.sent;

  r = await call("POST", `/campaigns/${camp.id}/resume`, { token: A.token });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 200));
  r = await call("POST", `/campaigns/${camp.id}/cancel`, { token: A.token });
  assert.equal(r.status, 200);
  const final = await waitFor(async () => { const x = (await call("GET", `/campaigns/${camp.id}`, { token: A.token })).data; return !x.running && x.counts.queued === 0 && x; });
  assert.equal(final.status, "cancelled");
  assert.ok(final.counts.sent >= sentSoFar);
  assert.equal(final.counts.sent + final.counts.skipped, 6);
  assert.ok(final.recipients.filter((x) => x.status === "skipped").every((x) => x.reason === "Campaign cancelled before sending"));
  const uniqueSent = new Set(sent.filter((m) => m.to.startsWith("bulk")).map((m) => m.to));
  assert.equal(uniqueSent.size, sent.filter((m) => m.to.startsWith("bulk")).length, "no recipient emailed twice");
  r = await call("DELETE", `/campaigns/${camp.id}`, { token: A.token });
  assert.equal(r.status, 200);
  process.env.SEND_DELAY_MS = "0";
});

test("campaigns: crash recovery never re-sends an in-flight recipient", async () => {
  const camp = await store.insert("campaigns", {
    ownerId: A.user.id, name: "Crashed", subject: "c", body: "b", status: "sending", audienceIds: [ids.aarav, ids.mira],
    recipients: [
      { customerId: ids.aarav, name: "Aarav", email: "aarav@example.com", status: "sending" },
      { customerId: ids.mira, name: "Mira", email: "mira@example.com", status: "queued" },
    ],
    counts: {},
  });
  const n = await campaignsMod.recoverInterrupted();
  assert.equal(n, 1);
  const after = await store.findOne("campaigns", { id: camp.id });
  assert.equal(after.status, "paused");
  assert.equal(after.recipients[0].status, "failed");
  assert.match(after.recipients[0].reason, /outcome unknown/);
  assert.equal(after.recipients[1].status, "queued");
  assert.equal(after.counts.failed, 1);
});

test("analytics match stored records", async () => {
  const r = await call("GET", "/analytics", { token: A.token });
  assert.equal(r.status, 200);
  const all = await store.find("campaigns", { ownerId: A.user.id });
  const sum = (k) => all.reduce((s, c) => s + (c.counts?.[k] || 0), 0);
  assert.equal(r.data.campaigns.total, all.length);
  assert.equal(r.data.campaigns.recipients.sent, sum("sent"));
  assert.equal(r.data.campaigns.recipients.failed, sum("failed"));
  assert.equal(r.data.campaigns.recipients.skipped, sum("skipped"));
  const customers = await store.find("customers", { ownerId: A.user.id });
  assert.equal(r.data.customers.total, customers.length);
  assert.equal(r.data.customers.consenting, customers.filter((c) => c.consent).length);
  assert.equal(r.data.campaigns.opensClicks, null, "opens/clicks reported as unavailable, not invented");
  const rB = await call("GET", "/analytics", { token: B.token });
  assert.equal(rB.data.customers.total, 0);
});

// ---------------------------------------------------------------- risk / ML
test("risk: ML health, prediction stored on customer, invalid input, ML unavailable", async (t) => {
  const health = await call("GET", "/health/ml", { token: A.token });
  if (!health.data.reachable) { t.skip("ML service not running on ML_SERVICE_URL"); return; }
  assert.equal(health.data.provenance, "synthetic");

  let r = await call("POST", "/risk/predict", { token: A.token, body: { customerId: ids.aarav } });
  assert.equal(r.status, 200);
  assert.ok(["LOW", "MEDIUM", "HIGH"].includes(r.data.risk.level));
  assert.ok(r.data.risk.probability >= 0 && r.data.risk.probability <= 1);
  assert.equal(r.data.risk.channel, "Email");
  assert.ok(Array.isArray(r.data.risk.reasons));
  const stored = await call("GET", `/customers/${ids.aarav}`, { token: A.token });
  assert.equal(stored.data.risk.level, r.data.risk.level);

  r = await call("POST", "/risk/predict", { token: A.token, body: { customerId: ids.dev } });
  assert.equal(r.data.risk.channel, null, "no consent → no channel recommended");

  const nodate = (await call("POST", "/customers", { token: A.token, body: { name: "No Date", email: "nodate@example.com" } })).data;
  r = await call("POST", "/risk/predict", { token: A.token, body: { customerId: nodate.id } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no last order date/);

  r = await call("POST", "/risk/predict", { token: A.token, body: { features: { days_since_last_order: -1, order_count: 1, total_spent: 1, engagement_score: 500, support_tickets: 0, cart_value: 0 } } });
  assert.equal(r.status, 400, "invalid features → 400 with detail");
  assert.match(r.data.error, /engagement_score/);

  r = await call("POST", "/risk/score-all", { token: A.token });
  assert.equal(r.status, 200);
  assert.ok(r.data.scored >= 5);
  assert.ok(r.data.skipped.some((s) => s.name === "No Date"));

  r = await call("POST", "/risk/predict", { token: B.token, body: { customerId: ids.aarav } });
  assert.equal(r.status, 404, "cannot score another user's customer");

  const saved = process.env.ML_SERVICE_URL;
  process.env.ML_SERVICE_URL = "http://127.0.0.1:9"; // nothing listens here
  r = await call("POST", "/risk/predict", { token: A.token, body: { customerId: ids.aarav } });
  process.env.ML_SERVICE_URL = saved;
  assert.equal(r.status, 503);
  assert.match(r.data.error, /not reachable/);
});

test("misc: unknown route 404, bad JSON 400, health", async () => {
  let r = await call("GET", "/nope", { token: A.token });
  assert.equal(r.status, 404);
  const bad = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
  assert.equal(bad.status, 400);
  r = await call("GET", "/health");
  assert.equal(r.data.ok, true);
  assert.equal(r.data.storage, expectedStorage);
});

test("gmail error classification matches real googleapis error shapes", () => {
  const { classifyGmailError } = gmail;
  const g = (status, data, message = "x", extra = {}) => Object.assign(new Error(message), { response: { status, data }, ...extra });
  assert.equal(classifyGmailError(g(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }, "invalid_grant")).kind, "auth");
  assert.equal(classifyGmailError(g(401, { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } })).kind, "auth");
  assert.equal(classifyGmailError(g(403, { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } })).kind, "auth");
  assert.equal(classifyGmailError(g(429, { error: { code: 429, errors: [{ reason: "userRateLimitExceeded" }] } })).retryable, true);
  assert.equal(classifyGmailError(g(403, { error: { code: 403, message: "Daily user sending limit exceeded", errors: [{ reason: "dailyLimitExceeded" }] } })).kind, "quota");
  assert.equal(classifyGmailError(g(400, { error: { code: 400, message: "Invalid To header" } })).kind, "invalid_recipient");
  assert.equal(classifyGmailError(g(503, { error: { code: 503, message: "Backend Error" } })).kind, "transient");
  const net = Object.assign(new Error("request to https://gmail.googleapis.com failed"), { code: "ECONNRESET" });
  const c = classifyGmailError(net);
  assert.equal(c.kind, "ambiguous");
  assert.equal(c.retryable, false, "ambiguous network failures are never retried (avoid duplicates)");
});

test("legacy /api/gmail/auth explains the new flow", async () => {
  const r = await fetch(`${base}/gmail/auth`);
  assert.equal(r.status, 410);
});
