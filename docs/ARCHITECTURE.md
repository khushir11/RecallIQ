# RecallIQ Architecture

## Components

| Path | Responsibility |
|---|---|
| `login.html`, `register.html`, `auth-page.js` | Account pages |
| `index.html`, `script.js` | Single-page app (hash routes: dashboard, customers, segments, campaigns, risk, settings) |
| `api.js` | Fetch wrapper (bearer token, 401 → login), toasts, formatting, HTML escaping |
| `config.js` | Resolves the API base URL per environment |
| `backend/src/server.js` | Startup: config checks, storage init, crash recovery, housekeeping |
| `backend/src/app.js` | Express routes, CORS, rate limits, error handling, optional static frontend |
| `backend/src/auth.js` | scrypt hashing, hashed session tokens, `requireAuth` |
| `backend/src/store.js` | JSON (atomic writes, serialised queue) or MongoDB adapter behind one API |
| `backend/src/customers.js` | Validation, CRUD, RFC 4180 CSV import/export |
| `backend/src/insights.js` | Segments, recommendations, dashboard analytics |
| `backend/src/risk.js` | Feature building, ML calls, stored risk scores |
| `backend/src/templates.js` | Placeholders, personalisation, HTML/text email bodies |
| `backend/src/gmail.js` | OAuth (state nonce), encrypted token storage, refresh, MIME building, error classification |
| `backend/src/campaigns.js` | Campaign state machine, eligibility, send worker, recovery |
| `ml-service/app.py` | FastAPI model service (`/health`, `/predict`, `/predict/batch`) |
| `ml-service/train_behavioral.py` | Train the runtime model on your own labelled data |
| `ml-service/train.py` | Separate IBM Telco evaluation pipeline (not used at runtime) |

## Data model (one collection each)

- `users` `{ id, name, email, businessName, passwordHash }`
- `sessions` `{ tokenHash, userId, expiresAt }`. The raw token only ever lives in the browser.
- `customers` `{ id, ownerId, name, email, phone, lastOrderDate, totalSpent, orderCount, cartValue, birthday, preferredChannel, consent, consentUpdatedAt, engagementScore, supportTickets, notes, risk }`
- `campaigns` `{ id, ownerId, name, subject, body, offer, segmentKey, audienceIds, status, recipients[], counts, launchedAt, completedAt, lastError }`
- `gmailTokens` `{ id = userId, sealed (AES-GCM), email, connectedAt, needsReconnect, lastError }`
- `oauthStates` `{ id = nonce, userId, expiresAt }` (single use, 10 minutes)

## Campaign state machine

```text
draft ──launch (atomic)──► sending ──all recipients done──► completed
                             │  ▲
                       pause │  │ resume (requires Gmail OK)
                             ▼  │
                            paused ──cancel──► cancelled (queued → skipped)
   auth/quota error, daily cap, or server restart ──► paused
```

Recipient: `queued → sending → sent | failed`, or `skipped` (never attempted, with a reason).

## Why these choices

- **Bearer tokens instead of cookies:** the frontend and backend may be on different sites (Netlify + Render), where third-party cookies are increasingly blocked.
- **The campaign worker runs in the API process:** simple and correct for one instance. A queue (BullMQ/Redis) is the next step for multiple instances.
- **No simulation mode:** the old `GMAIL_MODE=simulation` counted fake sends as delivered. It was removed. Tests replace only the HTTP transport.
