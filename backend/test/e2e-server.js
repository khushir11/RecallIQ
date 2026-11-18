// TEST HARNESS ONLY — never used by `npm start`.
// Starts the real backend on a throwaway data directory with the Gmail HTTP transport replaced by
// a fake that answers like users.messages.send, so the UI flow can be exercised end-to-end
// without a Google account. Addresses starting with "bounce" are rejected like Gmail does.
//   node test/e2e-server.js            (port 4000)
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR ||= await fs.mkdtemp(path.join(os.tmpdir(), "recalliq-e2e-"));
process.env.GOOGLE_CLIENT_ID ||= "e2e-client";
process.env.GOOGLE_CLIENT_SECRET ||= "e2e-secret";
process.env.SEND_DELAY_MS ||= "700";
process.env.FRONTEND_URL ||= "http://localhost:3000";

const store = await import("../src/store.js");
const gmail = await import("../src/gmail.js");
const { createApp } = await import("../src/app.js");

let n = 0;
gmail.__setTransportForTests(async ({ raw }) => {
  const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const to = mime.match(/^To: (.+)$/m)[1];
  if (to.startsWith("bounce")) throw Object.assign(new Error("Invalid To header"), { response: { status: 400, data: { error: { code: 400, message: "Invalid To header" } } } });
  n += 1;
  console.log(`[fake-gmail] accepted message ${n} to ${to}`);
  return { id: `18c${Date.now().toString(16)}${n}`, threadId: `thr${n}`, labelIds: ["SENT"] };
});

await store.initStore();
// Seed: any user who registers gets a "connected" Gmail token automatically (harness only).
const app = createApp();
app.post("/__e2e/connect-gmail/:email", async (req, res) => {
  const user = await store.findOne("users", { email: req.params.email });
  if (!user) return res.status(404).end();
  await store.remove("gmailTokens", { id: user.id });
  await store.insert("gmailTokens", { id: user.id, ownerId: user.id, email: "owner.test@gmail.com", connectedAt: new Date().toISOString(), sealed: { plain: { access_token: "x", refresh_token: "y", scope: "https://www.googleapis.com/auth/gmail.send" } } });
  res.json({ ok: true });
});
app.listen(Number(process.env.PORT || 4000), () => console.log(`E2E backend (fake Gmail transport) on :${process.env.PORT || 4000}, data in ${process.env.DATA_DIR}`));
