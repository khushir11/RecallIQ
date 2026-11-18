# RecallIQ 2.0: repair report

## Phase 1: audit findings (all fixed)
1. **Repeated real emails.** `tickCampaigns()` ran every 4.5 s → `saveCampaigns()` → `DELETE /api/campaigns` + re-`POST` of every campaign, and each POST called Gmail again.
2. Simulated sends were counted as delivered (`sent || simulated`). The frontend made up progress and conversions with `Math.random()`.
3. No backend auth: all data and one Gmail token were global. `login.html`, `register.html` and `auth.js` were not in the archive.
4. Hard-coded statistics: segment sizes, ₹ figures, lift, confidence, lifecycle funnel, channel scores, chart bars, and "Simulate open/click/purchase" buttons.
5. The AI panel read localStorage keys that were never written, so its dropdown was always empty.
6. `PUT /customers` replaced everything; there was no per-record edit or delete; JSON writes were not atomic.
7. Subjects were not RFC 2047-encoded; there was no expired-token handling and no test email; the `.gitignore` last line was broken.
8. The ML model was synthetic but this wasn't surfaced; `train.py` used a different schema than the API.

## Files
**New:** `backend/src/{app,auth,http,customers,campaigns,insights,risk,templates}.js`, `backend/test/{api.test.js,e2e-server.js}`, `login.html`, `register.html`, `auth-page.js`, `api.js`, `config.js`, `favicon.svg`, `frontend-server.js`, `render.yaml`, `ml-service/train_behavioral.py`, `docs/{DEPLOYMENT,CHANGELOG}.md`, `backend/data/.gitkeep`.
**Rewritten:** `backend/src/{server,store,gmail}.js`, `index.html`, `script.js`, `styles.css` (same tokens, brand and buttons), `ml-service/app.py`, `README.md`, `docs/ARCHITECTURE.md`, `docs/RESUME.md`, `ml-service/{README,EVALUATION}.md`, `.gitignore`, `backend/.env.example`, `netlify.toml`, root `package.json`, start scripts.
**Removed:** `ai-integration.js` (duplicate, broken), `ml-service/RUN.md` (merged), empty `backend/data/*.json`, `GMAIL_MODE=simulation`.

## Verified
- 16 backend integration tests: auth, isolation, customers, CSV, segments, Gmail paths and error classification, campaign lifecycle and duplicate protection, crash recovery, analytics accuracy, ML.
- Browser run (Chrome, desktop + 390 px mobile): register → import → sort/search → score → edit (stale flag) → segments → draft → launch blocked without Gmail → confirm → live progress → 2 sent / 1 failed / 2 skipped with message IDs → dashboard → test email → logout, with no console errors.
- Single-service mode serves only the UI files (`.env`, source and data return 404).

## Not verified here (needs your machine/accounts)
- **A real send through Google** (the sandbox cannot reach Google). Follow README → "Gmail setup".
- **MongoDB adapter** (MongoDB could not be downloaded in the sandbox). Run `MONGODB_TEST_URI=... npm test`.
- Render deployment and the production OAuth redirect.
