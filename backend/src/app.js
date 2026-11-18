// Express application (routes). server.js starts it; tests import createApp() directly.
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import * as auth from "./auth.js";
import * as customers from "./customers.js";
import * as campaigns from "./campaigns.js";
import * as gmail from "./gmail.js";
import * as risk from "./risk.js";
import * as insights from "./insights.js";
import * as store from "./store.js";
import { HttpError, badRequest, corsOptions, escapeHtml, isValidEmail, rateLimit, route, securityHeaders } from "./http.js";
import { PLACEHOLDERS, renderEmail } from "./templates.js";

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Only these files are ever served (never the project root): .env and data files stay private.
const FRONTEND_FILES = ["index.html", "login.html", "register.html", "styles.css", "config.js", "api.js", "script.js", "auth-page.js", "favicon.svg"];

const frontendUrl = () => (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
const perUser = (req) => req.user?.id || req.ip;

export function createApp() {
  const app = express();
  if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: "3mb" }));
  app.use("/api", rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_PER_MIN || 300) }));

  // ------------------------------------------------------------ health
  app.get("/api/health", route(async (_req, res) => {
    res.json({
      ok: true,
      service: "recalliq-backend",
      time: new Date().toISOString(),
      storage: store.storageMode(),
      storageDurable: store.storageMode() === "mongodb",
      gmailOAuthConfigured: gmail.isConfigured(),
      tokenEncryption: Boolean(process.env.TOKEN_ENCRYPTION_KEY),
      activeSendWorkers: campaigns.runningCount(),
    });
  }));
  app.get("/api/health/ml", route(async (_req, res) => res.json(await risk.mlHealth())));

  // ------------------------------------------------------------ auth
  app.post("/api/auth/register", rateLimit({ windowMs: 3600_000, max: 10, message: "Too many sign-ups from this network. Try again later." }),
    route(async (req, res) => res.status(201).json(await auth.register(req.body))));
  app.post("/api/auth/login", rateLimit({ windowMs: 15 * 60_000, max: 10, message: "Too many login attempts. Wait 15 minutes and try again." }),
    route(async (req, res) => res.json(await auth.login(req.body))));

  // Old entry point (pre-auth version). Gmail is now connected per user from Settings.
  app.get("/api/gmail/auth", (_req, res) => res.status(410).type("html").send(`<!doctype html><meta charset="utf-8"><title>Moved</title>
<body style="font-family:Arial,sans-serif;max-width:560px;margin:60px auto;line-height:1.5"><h2>Gmail is now connected per account</h2>
<p>Log in to RecallIQ and use <strong>Settings &amp; Gmail → Connect Gmail</strong>.</p><p><a href="${escapeHtml(frontendUrl())}/index.html#settings">Open Settings</a></p></body>`));

  // The OAuth callback is opened by Google in the browser, so it cannot carry our bearer token.
  // It is authenticated by the single-use `state` nonce created for the logged-in user.
  app.get("/api/gmail/callback", route(async (req, res) => {
    if (req.query.error) return res.redirect(`${frontendUrl()}/index.html#settings?gmail=denied`);
    try {
      await gmail.handleCallback({ code: req.query.code, state: req.query.state });
      res.redirect(`${frontendUrl()}/index.html#settings?gmail=connected`);
    } catch (error) {
      console.error("[gmail] OAuth callback failed:", error.message);
      res.status(error.status && error.status < 500 ? error.status : 500).type("html").send(`<!doctype html><meta charset="utf-8"><title>Gmail connection failed</title>
<body style="font-family:Arial,sans-serif;max-width:560px;margin:60px auto;line-height:1.5">
<h2>Gmail connection failed</h2><p>${escapeHtml(error.message)}</p>
<p><a href="${escapeHtml(frontendUrl())}/index.html#settings">Return to RecallIQ Settings</a> and try again.</p></body>`);
    }
  }));

  // Everything below requires a logged-in user.
  const api = express.Router();
  api.use(auth.requireAuth);

  api.get("/auth/me", (req, res) => res.json({ user: req.user }));
  api.patch("/auth/me", route(async (req, res) => res.json({ user: await auth.updateProfile(req.user.id, req.body) })));
  api.post("/auth/logout", route(async (req, res) => { await auth.logout(req.sessionToken); res.json({ loggedOut: true }); }));

  // ------------------------------------------------------------ gmail
  api.get("/gmail/status", route(async (req, res) => res.json(await gmail.getStatus(req.user.id))));
  api.post("/gmail/connect", route(async (req, res) => res.json({ url: await gmail.createAuthorizationUrl(req.user.id) })));
  api.post("/gmail/verify", route(async (req, res) => res.json(await gmail.verifyConnection(req.user.id))));
  api.post("/gmail/disconnect", route(async (req, res) => res.json(await gmail.disconnect(req.user.id))));
  api.post("/gmail/test", rateLimit({ windowMs: 3600_000, max: 20, key: perUser, message: "Test-email limit reached (20 per hour)." }),
    route(async (req, res) => {
      const status = await gmail.getStatus(req.user.id);
      const to = String(req.body?.to || status.email || req.user.email || "").trim().toLowerCase();
      if (!isValidEmail(to)) throw badRequest("Enter a valid recipient email address for the test.");
      let message;
      if (req.body?.campaignId) {
        // Render a real campaign for a chosen customer, but deliver it to the test address only.
        const campaign = await campaigns.get(req.user.id, req.body.campaignId);
        const sample = req.body.customerId ? await customers.get(req.user.id, req.body.customerId) : { name: req.user.name, totalSpent: 12500, orderCount: 5, cartValue: 2600, lastOrderDate: new Date(Date.now() - 75 * 86400000).toISOString().slice(0, 10) };
        const rendered = renderEmail({ ...campaign, businessName: req.user.businessName, senderName: req.user.name }, sample);
        message = { ...rendered, subject: `[TEST] ${rendered.subject}` };
      } else {
        const sentAt = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        message = {
          subject: "RecallIQ test email",
          text: `This is a test email from RecallIQ, sent through the Gmail API at ${sentAt} IST.\n\nIf you can read this, Gmail sending is working for ${status.email || "your account"}.`,
        };
      }
      try {
        const result = await gmail.sendEmail(req.user.id, { ...message, to, fromName: req.user.businessName || req.user.name });
        const info = { to, at: new Date().toISOString(), messageId: result.messageId, ok: true };
        await gmail.recordTestEmail(req.user.id, info);
        res.json({ ...info, threadId: result.threadId, labelIds: result.labelIds, note: "Gmail accepted the message (it is in your Sent folder). Check the recipient inbox and spam folder to confirm delivery." });
      } catch (error) {
        await gmail.recordTestEmail(req.user.id, { to, at: new Date().toISOString(), ok: false, error: error.message }).catch(() => {});
        throw new HttpError(error.kind === "not_connected" || error.kind === "invalid_recipient" ? 400 : 502, error.message, { kind: error.kind });
      }
    }));

  // ------------------------------------------------------------ customers
  api.get("/customers", route(async (req, res) => res.json(await customers.list(req.user.id, req.query))));
  api.get("/customers/export.csv", route(async (req, res) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="recalliq-customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await customers.exportCsv(req.user.id));
  }));
  api.post("/customers/import", route(async (req, res) => {
    if (typeof req.body?.csv !== "string") throw badRequest("Send the CSV text as { csv: \"...\" }.");
    res.json(await customers.importCsv(req.user.id, req.body.csv, { mode: req.body.mode }));
  }));
  api.post("/customers/bulk-delete", route(async (req, res) => res.json(await customers.removeMany(req.user.id, req.body?.ids))));
  api.post("/customers", route(async (req, res) => res.status(201).json(await customers.create(req.user.id, req.body))));
  api.get("/customers/:id", route(async (req, res) => {
    const customer = await customers.get(req.user.id, req.params.id);
    res.json({ ...customer, history: await customers.history(req.user.id, customer.id) });
  }));
  api.patch("/customers/:id", route(async (req, res) => res.json(await customers.updateOne(req.user.id, req.params.id, req.body))));
  api.put("/customers/:id", route(async (req, res) => res.json(await customers.updateOne(req.user.id, req.params.id, req.body))));
  api.delete("/customers/:id", route(async (req, res) => res.json(await customers.removeOne(req.user.id, req.params.id))));

  // ------------------------------------------------------------ risk / AI
  api.post("/risk/predict", route(async (req, res) => {
    if (req.body?.customerId) return res.json(await risk.predictCustomer(req.user.id, req.body.customerId));
    if (req.body?.features) return res.json({ prediction: await risk.predictFeatures(req.body.features) });
    throw badRequest("Send { customerId } (or { features } for an ad-hoc prediction).");
  }));
  api.post("/risk/score-all", rateLimit({ windowMs: 60_000, max: 6, key: perUser }), route(async (req, res) => res.json(await risk.scoreAll(req.user.id))));
  api.get("/segments", route(async (req, res) => res.json({ segments: await insights.computeSegments(req.user.id), placeholders: PLACEHOLDERS })));
  api.get("/analytics", route(async (req, res) => res.json(await insights.analytics(req.user.id))));

  // ------------------------------------------------------------ campaigns
  api.get("/campaigns", route(async (req, res) => res.json(await campaigns.list(req.user.id))));
  api.post("/campaigns", route(async (req, res) => res.status(201).json(await campaigns.createDraft(req.user.id, req.body))));
  api.post("/campaigns/preview", route(async (req, res) => {
    const { subject = "", body = "", offer = "", customerId } = req.body || {};
    const sample = customerId ? await customers.get(req.user.id, customerId) : { name: "Aarav Mehta", totalSpent: 18400, orderCount: 8, cartValue: 2600, lastOrderDate: new Date(Date.now() - 75 * 86400000).toISOString().slice(0, 10) };
    res.json(renderEmail({ subject, body, offer, businessName: req.user.businessName, senderName: req.user.name }, sample));
  }));
  api.get("/campaigns/:id", route(async (req, res) => res.json(await campaigns.get(req.user.id, req.params.id))));
  api.put("/campaigns/:id", route(async (req, res) => res.json(await campaigns.updateDraft(req.user.id, req.params.id, req.body))));
  api.delete("/campaigns/:id", route(async (req, res) => res.json(await campaigns.removeCampaign(req.user.id, req.params.id))));
  api.get("/campaigns/:id/eligibility", route(async (req, res) => res.json(await campaigns.eligibility(req.user.id, req.params.id))));
  api.post("/campaigns/:id/duplicate", route(async (req, res) => res.status(201).json(await campaigns.duplicate(req.user.id, req.params.id))));
  api.post("/campaigns/:id/launch", rateLimit({ windowMs: 3600_000, max: 30, key: perUser }), route(async (req, res) => res.json(await campaigns.launch(req.user.id, req.params.id))));
  api.post("/campaigns/:id/pause", route(async (req, res) => res.json(await campaigns.pause(req.user.id, req.params.id))));
  api.post("/campaigns/:id/resume", route(async (req, res) => res.json(await campaigns.resume(req.user.id, req.params.id))));
  api.post("/campaigns/:id/cancel", route(async (req, res) => res.json(await campaigns.cancel(req.user.id, req.params.id))));

  app.use("/api", api);

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "API route not found.")));

  // Optional single-service deployment: SERVE_FRONTEND=true serves the static UI from this backend.
  if (process.env.SERVE_FRONTEND === "true") {
    app.get("/", (_req, res) => res.redirect("/index.html"));
    for (const file of FRONTEND_FILES) {
      app.get(`/${file}`, (_req, res) => res.sendFile(path.join(FRONTEND_DIR, file), { headers: { "Cache-Control": file.endsWith(".html") ? "no-cache" : "public, max-age=300" } }));
    }
  }

  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "Request body is not valid JSON." });
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status === 500 && !(error instanceof HttpError) ? "Something went wrong on the server. Check the backend logs." : error.message, ...(error.extra || {}) });
  });
  return app;
}
