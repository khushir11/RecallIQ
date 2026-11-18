# RecallIQ — AI Customer Re-Engagement Platform

RecallIQ finds customers who are at risk of churning, explains why, recommends what to do, and sends
personalised, consent-checked re-engagement emails from your own Gmail account. Every result it
reports is a real result.

```text
 Browser (HTML/CSS/JS)  ──REST + Bearer token──►  Node.js / Express API  ──►  Gmail API (OAuth 2.0)
 login · dashboard ·                               auth · customers ·        users.messages.send
 customers · segments ·                            campaigns + send worker
 campaigns · risk · settings                       segments · analytics  ──►  FastAPI ML service
                                                          │                   /predict, /predict/batch
                                                          ▼
                                                JSON files (dev) / MongoDB (prod)
```

## What you can do

1. **Register / log in.** Passwords are hashed with scrypt. Sessions use opaque bearer tokens that are stored hashed and revoked on logout.
2. **Manage customers.** Add, edit, delete, search, filter, sort and paginate customers, and import or export CSV. Emails are validated, and consent is tracked with a timestamp. Each customer has an engagement score, support-ticket count, cart value and spend.
3. **Score churn risk.** The ML service returns a probability, a LOW/MEDIUM/HIGH level, the model factors that raised or lowered the risk, a next best action and an offer. Channel advice comes from the customer's consent and email validity.
4. **AI recommendations.** Six segments are computed from your data: sleeping loyalists, cart abandoners, VIP churn watch, birthday customers, high-value inactive, and high model risk. Each shows its rule, audience size, how many are reachable, who is excluded and why, and a personalised message.
5. **Approve and send.** Save a recommendation as a draft, edit it, preview it per customer, send yourself a `[TEST]` copy, then launch. Before anything is sent, RecallIQ shows exactly who will be emailed and who will be skipped.
6. **Monitor real results.** Per recipient: `queued → sent | failed | skipped`, with Gmail message IDs, retry counts and error reasons. You can pause, resume or cancel. The dashboard figures are computed from the stored records.

## What RecallIQ does *not* claim

| Metric | Status |
|---|---|
| **Sent** | Gmail API accepted the message and returned a message ID. This is **not** proof of inbox delivery. Bounces arrive later as emails in your Gmail inbox. |
| Delivered / opened / clicked / purchased | **Not tracked.** Shown as "Not tracked" rather than invented. |
| Revenue "value at stake" | A labelled estimate (formula shown in the UI), not a forecast. |
| Churn model | A **synthetic-data demonstration model** unless you train it on your own data (see [ML](#ml-model)). |

---

## Run locally (Windows / macOS / Linux)

Requirements: Node.js 20+, Python 3.10+.

```bash
# 1. ML service (terminal 1)
cd ml-service
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8000

# 2. Backend (terminal 2)
cd backend
copy .env.example .env            # macOS/Linux: cp .env.example .env  — then fill in Google values
npm install
npm start                         # http://localhost:4000/api/health

# 3. Frontend (terminal 3, project root)
npm start                         # http://localhost:3000 (frontend-server.js, app files only)
```

On Windows, `start-recalliq.bat` opens all three. Open **http://localhost:3000**, create an account, and import customers.

> **Existing installs:** the old `backend/data/customers.json`, `campaigns.json` and `gmail-token.json` belonged to no user. After upgrading, register, re-import your customers (export them first if you need them), and click **Connect Gmail** once in Settings. Each user now has their own Gmail connection. The old global token is no longer read, and you can delete that file.

## Gmail setup (your existing OAuth client keeps working)

1. In Google Cloud Console → *APIs & Services*, the **Gmail API** must be enabled. You already did this.
2. Under *Credentials → OAuth 2.0 Client IDs* (type **Web application**), this must be listed exactly under **Authorized redirect URIs**:
   `http://localhost:4000/api/gmail/callback`
3. *OAuth consent screen*: while the app is in **Testing**, add every Gmail account that will connect as a **Test user**. RecallIQ asks for `gmail.send` plus `openid email`, so it can show which account is connected. Google may show the "unverified app" screen. That's expected for a personal project.
4. Put the values in `backend/.env` (never in code or chat):
   ```env
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:4000/api/gmail/callback
   TOKEN_ENCRYPTION_KEY=<output of: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
   ```
5. Restart the backend, then in the app go to **Settings & Gmail → Connect Gmail**, approve, and you'll come back to Settings.
6. Click **Verify connection**. This forces a refresh-token exchange and sends nothing.
7. Click **Send test** to your own address. You get a Gmail message ID. Check the inbox and the spam folder.
8. Only then launch a campaign. Add yourself as a customer with consent first if you want to see a real campaign email.

**Token handling:** tokens are stored per user in the `gmailTokens` collection and encrypted with AES-256-GCM when `TOKEN_ENCRYPTION_KEY` is set. Refreshed access tokens are saved automatically. If Google returns `invalid_grant` (revoked, expired, or a "Testing" app's 7-day token lifetime), any running campaign **pauses**. Unsent recipients stay queued, and Settings shows **Reconnect**.

## Campaign sending rules

- A recipient is **skipped** if: there's no email; the email is invalid; there's no marketing consent (also re-checked at send time); the email address is a duplicate in the campaign; or they already received an email with the identical subject template from another campaign.
- A draft can be launched **once**. That's an atomic `draft → sending` transition, so a double-click gets `409`.
- One sender loop runs per campaign. Messages go out one at a time (`SEND_DELAY_MS`, default 1.2 s), with a 24-hour cap (`GMAIL_DAILY_LIMIT`, default 400). The campaign pauses when the cap is reached.
- Gmail `429` / `5xx` errors are retried up to 3 times with backoff. `400` invalid-recipient errors → **failed**. Auth or quota errors → campaign **paused**, and the recipient goes back to queued.
- A network error with no response is marked **failed (outcome unknown)** and **not retried**, so nobody is emailed twice. The same applies to a server restart mid-send: the campaign is paused and the in-flight recipient is marked accordingly.
- Every email gets an unsubscribe note ("reply 'unsubscribe'"). Set the customer's consent to *No* when someone opts out.

## ML model

`ml-service/app.py` trains a logistic regression **at startup on 6,000 synthetic customers**. Their churn labels come from a hand-written rule. `/health` reports this (`provenance: "synthetic"`), and the UI shows it on the Churn risk page. The hold-out metrics (ROC-AUC ≈ 0.83) only show that the model recovers that rule. **They are not evidence of real-world accuracy and should not be quoted as such.**

Explanations come from the model itself: each feature's contribution to the log-odds (coefficient × standardised value). Inputs outside the training range are flagged.

**To use real data:** export historical snapshots with the six features plus an observed `churned` outcome, then run:

```bash
cd ml-service
python train_behavioral.py --data data/my_customers.csv
```

Restart the service and `/health` reports `provenance: "user-trained"` with your hold-out metrics. `train.py` is a separate, optional evaluation pipeline for the IBM Telco dataset. It has a different feature schema and is **not** used by the running app.

## Tests

```bash
# start the ML service first (port 8000), then:
cd backend && npm test
```

There are 14 integration tests against the real Express app and storage. They cover:

- auth: register, duplicate, weak password, invalid login, logout, protected routes
- per-user data isolation
- customer CRUD and validation
- CSV import/export round-trip
- segment counts
- Gmail: status, test email, invalid recipient, forged OAuth state
- campaigns: personalisation and RFC 2047 subjects, sent/failed/skipped counts with message IDs, 429 retry, double-launch protection, cross-campaign duplicate protection, revoked token → pause, pause/resume/cancel, crash recovery
- dashboard numbers match stored records
- ML: prediction, invalid input, and service down

Gmail is replaced **only at the HTTP transport** by a fake that answers like `users.messages.send`. Everything above it runs for real.

`MONGODB_TEST_URI=<throwaway db> npm test` runs the same suite against MongoDB.

`node backend/test/e2e-server.js` starts a UI test harness with the fake transport. It's never used by `npm start`.

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short: MongoDB Atlas for storage (JSON files are wiped on most hosts), Render for the backend and the ML service (`render.yaml`), the production redirect URI added in Google Cloud, and `TOKEN_ENCRYPTION_KEY` set.

## API

All routes except `/api/health*`, `/api/auth/register`, `/api/auth/login` and `/api/gmail/callback` require `Authorization: Bearer <token>`. They only ever touch the caller's own data.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | Returns `{ user, token, expiresAt }` |
| GET/PATCH | `/api/auth/me` | Profile (name, business name) |
| POST | `/api/auth/logout` | Revoke the current session |
| GET | `/api/customers?search=&consent=&status=&risk=&channel=&sort=&order=&page=&limit=` | List customers |
| POST | `/api/customers` | Create a customer |
| GET/PATCH/DELETE | `/api/customers/:id` | Detail (with email history), update, delete |
| POST | `/api/customers/import` `{ csv, mode }` | Import CSV |
| GET | `/api/customers/export.csv` | Export CSV |
| POST | `/api/customers/bulk-delete` | Delete several customers |
| POST | `/api/risk/predict` `{ customerId }` | Score one customer (saved on the customer) |
| POST | `/api/risk/score-all` | Score all customers |
| GET | `/api/health/ml` | ML service status |
| GET | `/api/segments` | Segments + recommendations |
| GET | `/api/analytics` | Dashboard figures |
| GET/POST | `/api/campaigns` | List / create a draft |
| POST | `/api/campaigns/preview` | Render an email |
| GET/PUT/DELETE | `/api/campaigns/:id` | Detail / edit draft / delete |
| GET | `/api/campaigns/:id/eligibility` | Who will be sent or skipped, and why |
| POST | `/api/campaigns/:id/launch` · `pause` · `resume` · `cancel` · `duplicate` | Lifecycle actions |
| GET | `/api/gmail/status` | Gmail connection status |
| POST | `/api/gmail/connect` · `verify` · `test` · `disconnect` | Gmail connection |
| GET | `/api/gmail/callback` | Google OAuth redirect target |
