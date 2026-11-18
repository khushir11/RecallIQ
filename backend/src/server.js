import "dotenv/config";
import { createApp } from "./app.js";
import { initStore, storageMode } from "./store.js";
import { recoverInterrupted } from "./campaigns.js";
import { purgeExpiredSessions } from "./auth.js";
import { purgeExpiredStates, isConfigured } from "./gmail.js";

const PORT = Number(process.env.PORT || 4000);

function checkProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;
  const problems = [];
  if (!process.env.MONGODB_URI) problems.push("MONGODB_URI is not set: JSON files on most hosts are wiped on every deploy/restart.");
  if (!process.env.TOKEN_ENCRYPTION_KEY) problems.push("TOKEN_ENCRYPTION_KEY is not set: Gmail tokens would be stored unencrypted.");
  if (!process.env.CORS_ORIGINS) problems.push("CORS_ORIGINS is not set: the deployed frontend will be blocked by CORS.");
  if (!process.env.FRONTEND_URL) problems.push("FRONTEND_URL is not set: the Gmail OAuth callback cannot redirect back to the app.");
  if (!/^https:\/\//.test(process.env.GOOGLE_REDIRECT_URI || "")) problems.push("GOOGLE_REDIRECT_URI should be the https:// URL of the deployed backend's /api/gmail/callback.");
  for (const p of problems) console.warn(`[config] WARNING: ${p}`);
  if (problems.length && process.env.STRICT_CONFIG === "true") process.exit(1);
}

async function main() {
  checkProductionConfig();
  const mode = await initStore();
  const recovered = await recoverInterrupted();
  if (recovered) console.warn(`[campaigns] ${recovered} campaign(s) were sending when the server stopped; they are now paused for review.`);
  setInterval(() => { purgeExpiredSessions().catch(() => {}); purgeExpiredStates().catch(() => {}); }, 3600_000).unref();

  createApp().listen(PORT, () => {
    console.log(`RecallIQ API running at http://localhost:${PORT} (${mode} storage)`);
    console.log(`ML service: ${process.env.ML_SERVICE_URL || "http://127.0.0.1:8000"}`);
    console.log(`Gmail OAuth: ${isConfigured() ? "configured" : "NOT configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)"}`);
    if (storageMode() === "json" && process.env.NODE_ENV === "production") console.warn("[storage] JSON storage in production is not durable.");
  });
}

main().catch((error) => {
  console.error("Failed to start RecallIQ backend:", error);
  process.exit(1);
});
