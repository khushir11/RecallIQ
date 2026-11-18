// Gmail API integration (per RecallIQ user).
//
// - Each RecallIQ user connects their own Gmail account through Google OAuth 2.0.
// - The OAuth `state` parameter is a single-use, 10-minute nonce bound to the user, so a callback
//   cannot attach a Google account to someone else's RecallIQ account (CSRF protection).
// - Tokens are stored in the `gmailTokens` collection, encrypted with AES-256-GCM when
//   TOKEN_ENCRYPTION_KEY is set (required in production).
// - Refreshed access tokens are persisted automatically. A revoked/expired refresh token is
//   detected (invalid_grant) and surfaced as "needs reconnect" instead of failing silently.
// - There is NO simulation mode. A message is reported as "sent" only when Gmail's
//   users.messages.send returns a message id. That means Gmail accepted it – not that it reached
//   the inbox (bounces arrive later as separate emails in the sender's mailbox).

import crypto from "node:crypto";
import { google } from "googleapis";
import * as store from "./store.js";
import { HttpError, badRequest, isValidEmail } from "./http.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];
const STATE_TTL_MS = 10 * 60 * 1000;

const env = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI || "http://localhost:4000/api/gmail/callback",
});

export const isConfigured = () => Boolean(env().clientId && env().clientSecret);

function oauthClient() {
  const { clientId, clientSecret, redirectUri } = env();
  if (!clientId || !clientSecret) {
    throw new HttpError(503, "Gmail OAuth is not configured on the server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to backend/.env and restart the backend.");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// ---------------------------------------------------------------- token encryption at rest
function encryptionKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  return raw ? crypto.createHash("sha256").update(raw).digest() : null;
}

function sealTokens(tokens) {
  const key = encryptionKey();
  if (!key) return { plain: tokens };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return { enc: { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") } };
}

function openTokens(record) {
  if (!record) return null;
  if (record.sealed?.plain) return record.sealed.plain;
  if (record.sealed?.enc) {
    const key = encryptionKey();
    if (!key) throw new HttpError(500, "Stored Gmail tokens are encrypted but TOKEN_ENCRYPTION_KEY is not set.");
    const { iv, tag, data } = record.sealed.enc;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8"));
  }
  return null;
}

const getRecord = (userId) => store.findOne("gmailTokens", { id: userId });

async function saveTokens(userId, tokens, extra = {}) {
  const existing = await getRecord(userId);
  const sealed = sealTokens(tokens);
  if (existing) return store.update("gmailTokens", { id: userId }, { sealed, ...extra });
  return store.insert("gmailTokens", { id: userId, ownerId: userId, sealed, ...extra });
}

async function markNeedsReconnect(userId, message) {
  await store.update("gmailTokens", { id: userId }, { needsReconnect: true, lastError: message, lastErrorAt: new Date().toISOString() });
}

// ---------------------------------------------------------------- status / OAuth flow
export async function getStatus(userId) {
  const record = await getRecord(userId);
  let tokens = null;
  let tokenError = null;
  try { tokens = openTokens(record); } catch (error) { tokenError = error.message; }
  const grantedScopes = String(tokens?.scope || "").split(" ").filter(Boolean);
  return {
    provider: "Gmail API",
    configured: isConfigured(),
    redirectUri: env().redirectUri,
    connected: Boolean(tokens) && !record?.needsReconnect,
    email: record?.email || null,
    connectedAt: record?.connectedAt || null,
    canSend: grantedScopes.length ? grantedScopes.includes(SCOPES[0]) : Boolean(tokens),
    hasRefreshToken: Boolean(tokens?.refresh_token),
    needsReconnect: Boolean(record?.needsReconnect) || Boolean(tokenError),
    lastError: tokenError || record?.lastError || null,
    lastVerifiedAt: record?.lastVerifiedAt || null,
    lastTestEmail: record?.lastTestEmail || null,
  };
}

export async function createAuthorizationUrl(userId) {
  const client = oauthClient();
  const state = crypto.randomBytes(24).toString("base64url");
  await store.insert("oauthStates", { id: state, userId, expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString() });
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // guarantees a refresh_token is issued
    include_granted_scopes: true,
    scope: SCOPES,
    state,
  });
}

function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8"));
    return payload.email_verified === false ? null : payload.email || null;
  } catch {
    return null;
  }
}

export async function handleCallback({ code, state }) {
  if (!state) throw badRequest("Missing OAuth state. Start the connection from RecallIQ Settings.");
  const saved = await store.findOne("oauthStates", { id: String(state) });
  await store.remove("oauthStates", { id: String(state) }); // single use
  if (!saved || new Date(saved.expiresAt).getTime() < Date.now()) {
    throw badRequest("This Gmail connection link has expired or was already used. Start again from RecallIQ Settings.");
  }
  if (!code) throw badRequest("Google did not return an authorization code.");
  const client = oauthClient();
  const { tokens } = await client.getToken(String(code));
  if (!String(tokens.scope || "").includes(SCOPES[0])) {
    throw badRequest("Gmail send permission was not granted. Reconnect and tick the 'Send email on your behalf' checkbox.");
  }
  const previous = openTokens(await getRecord(saved.userId)) || {};
  const merged = { ...tokens, refresh_token: tokens.refresh_token || previous.refresh_token };
  await saveTokens(saved.userId, merged, {
    email: emailFromIdToken(tokens.id_token),
    connectedAt: new Date().toISOString(),
    needsReconnect: false,
    lastError: null,
  });
  return { userId: saved.userId };
}

export async function disconnect(userId) {
  const record = await getRecord(userId);
  let revoked = false;
  try {
    const tokens = openTokens(record);
    if (tokens?.refresh_token || tokens?.access_token) {
      await oauthClient().revokeToken(tokens.refresh_token || tokens.access_token);
      revoked = true;
    }
  } catch (error) {
    console.warn("[gmail] token revoke failed (token removed locally anyway):", error.message);
  }
  await store.remove("gmailTokens", { id: userId });
  return { disconnected: true, revokedAtGoogle: revoked };
}

export async function purgeExpiredStates() {
  const states = await store.find("oauthStates", {});
  for (const s of states) if (new Date(s.expiresAt).getTime() < Date.now()) await store.remove("oauthStates", { id: s.id });
}

// ---------------------------------------------------------------- MIME message building
const b64 = (value) => Buffer.from(value, "utf8").toString("base64");
const b64url = (value) => Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const wrap76 = (value) => value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
const headerSafe = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();
// RFC 2047 encoded-word so subjects/names with ₹, accents or emoji survive.
const encodeWord = (value) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`);

export function buildRawMessage({ to, subject, text, html, fromName, fromEmail, replyTo, listUnsubscribe }) {
  if (!isValidEmail(to)) throw new GmailSendError("invalid_recipient", `Invalid recipient email address: ${to}`);
  const boundary = `riq_${crypto.randomBytes(12).toString("hex")}`;
  const headers = [`To: ${headerSafe(to)}`];
  if (fromEmail) headers.push(`From: ${fromName ? `${encodeWord(headerSafe(fromName).replace(/"/g, ""))} ` : ""}<${headerSafe(fromEmail)}>`);
  if (replyTo) headers.push(`Reply-To: ${headerSafe(replyTo)}`);
  if (listUnsubscribe) headers.push(`List-Unsubscribe: ${headerSafe(listUnsubscribe)}`);
  headers.push(`Subject: ${encodeWord(headerSafe(subject) || "(no subject)")}`, "MIME-Version: 1.0");
  let body;
  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(text || "")),
      `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(html)),
      `--${boundary}--`, "",
    ].join("\r\n");
  } else {
    headers.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
    body = wrap76(b64(text || ""));
  }
  return b64url(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

// ---------------------------------------------------------------- sending
export class GmailSendError extends Error {
  // kind: auth | rate_limit | invalid_recipient | quota | transient | ambiguous | not_connected | unknown
  constructor(kind, message, { httpStatus = null, retryable = false } = {}) {
    super(message);
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

export function classifyGmailError(error) {
  if (error instanceof GmailSendError) return error;
  const status = Number(error?.response?.status || error?.status || error?.code) || null;
  const data = error?.response?.data || {};
  const oauthError = typeof data.error === "string" ? data.error : null; // token endpoint style
  const apiError = typeof data.error === "object" ? data.error : null; // Gmail API style
  const reason = apiError?.errors?.[0]?.reason || apiError?.status || "";
  const detail = apiError?.message || data.error_description || error?.message || "Unknown Gmail error";

  if (oauthError === "invalid_grant" || /invalid_grant/i.test(error?.message || "")) {
    return new GmailSendError("auth", "Gmail authorization has expired or was revoked. Reconnect Gmail in Settings.", { httpStatus: status });
  }
  if (status === 401 || oauthError === "unauthorized_client" || oauthError === "invalid_client") {
    return new GmailSendError("auth", `Gmail rejected the credentials (${detail}). Reconnect Gmail in Settings.`, { httpStatus: status });
  }
  if (status === 403 && /insufficient|scope|permission/i.test(`${reason} ${detail}`)) {
    return new GmailSendError("auth", "RecallIQ does not have Gmail send permission. Reconnect Gmail and grant 'Send email on your behalf'.", { httpStatus: status });
  }
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded/i.test(reason)) {
    return new GmailSendError("rate_limit", "Gmail rate limit reached. RecallIQ will retry.", { httpStatus: status, retryable: true });
  }
  if (status === 403 && /dailyLimitExceeded|quotaExceeded|limit/i.test(`${reason} ${detail}`)) {
    return new GmailSendError("quota", `Gmail sending limit reached: ${detail}`, { httpStatus: status });
  }
  if (status === 400 && /recipient|address|invalid to header/i.test(detail)) {
    return new GmailSendError("invalid_recipient", `Gmail rejected the recipient: ${detail}`, { httpStatus: status });
  }
  if (status && status >= 500) {
    return new GmailSendError("transient", `Gmail server error (${status}): ${detail}`, { httpStatus: status, retryable: true });
  }
  if (!status && /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network|EAI_AGAIN|ENOTFOUND|aborted/i.test(`${error?.message || ""} ${error?.code || ""}`)) {
    // We cannot know whether Gmail received the request. Do not retry (avoids duplicates).
    return new GmailSendError("ambiguous", `Network error while sending; outcome unknown (${error.message}). Not retried to avoid a duplicate. Check your Gmail Sent folder.`);
  }
  return new GmailSendError("unknown", `Gmail error${status ? ` (${status})` : ""}: ${detail}`, { httpStatus: status });
}

// Default transport: the real Gmail API. Tests replace it with __setTransportForTests.
async function googleTransport({ client, raw }) {
  const gmail = google.gmail({ version: "v1", auth: client });
  const response = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  return response.data;
}
let transport = googleTransport;
export function __setTransportForTests(fn) { transport = fn || googleTransport; }

async function authorisedClient(userId) {
  const record = await getRecord(userId);
  const tokens = openTokens(record);
  if (!tokens) throw new GmailSendError("not_connected", "Gmail is not connected. Connect Gmail in Settings first.");
  if (record.needsReconnect) throw new GmailSendError("auth", record.lastError || "Gmail needs to be reconnected in Settings.");
  const client = oauthClient();
  client.setCredentials(tokens);
  client.on("tokens", (fresh) => {
    // Google only sends refresh_token on first consent; keep the stored one.
    saveTokens(userId, { ...tokens, ...fresh, refresh_token: fresh.refresh_token || tokens.refresh_token })
      .catch((error) => console.error("[gmail] failed to persist refreshed token", error));
  });
  return { client, record, tokens };
}

/**
 * Send one email through the user's Gmail account.
 * Resolves { messageId, threadId, labelIds } only when Gmail returned a message id.
 * Rejects with GmailSendError otherwise.
 */
export async function sendEmail(userId, { to, subject, text, html, fromName, replyTo, listUnsubscribe }) {
  let client;
  let record;
  try {
    ({ client, record } = await authorisedClient(userId));
  } catch (error) {
    throw classifyGmailError(error);
  }
  const raw = buildRawMessage({ to, subject, text, html, fromName, fromEmail: record.email, replyTo, listUnsubscribe });
  try {
    const data = await transport({ client, raw, userId });
    if (!data?.id) throw new GmailSendError("unknown", "Gmail responded without a message id; treating as not sent.");
    return { messageId: data.id, threadId: data.threadId || null, labelIds: data.labelIds || [] };
  } catch (error) {
    const classified = classifyGmailError(error);
    if (classified.kind === "auth") await markNeedsReconnect(userId, classified.message);
    throw classified;
  }
}

/** Confirms the stored refresh token still works by obtaining an access token (sends nothing). */
export async function verifyConnection(userId) {
  try {
    const { client, tokens } = await authorisedClient(userId);
    // Drop the cached access token so Google must exchange the refresh token: this proves the
    // refresh token is still valid, rather than reusing an access token that has not expired yet.
    if (tokens.refresh_token) client.setCredentials({ refresh_token: tokens.refresh_token });
    const { token } = await client.getAccessToken();
    if (!token) throw new GmailSendError("auth", "Google did not issue an access token.");
    await store.update("gmailTokens", { id: userId }, { lastVerifiedAt: new Date().toISOString(), needsReconnect: false, lastError: null });
    return { ok: true, message: "Gmail authorization is valid." };
  } catch (error) {
    const classified = classifyGmailError(error);
    if (classified.kind === "auth") await markNeedsReconnect(userId, classified.message);
    throw new HttpError(classified.kind === "not_connected" ? 400 : 502, classified.message, { kind: classified.kind });
  }
}

export const __internals = { sealTokens, openTokens };

export async function recordTestEmail(userId, info) {
  await store.update("gmailTokens", { id: userId }, { lastTestEmail: info });
}
