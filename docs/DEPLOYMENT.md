# Deploying RecallIQ

Do not deploy until the app works locally: the Gmail test email succeeds and `npm test` passes.

## Recommended architecture

| Part | Host | Notes |
|---|---|---|
| Database | **MongoDB Atlas** (free M0) | Required. JSON files on Render/Railway/Heroku are erased on every deploy or restart. |
| Backend + frontend | **Render** web service | `SERVE_FRONTEND=true` makes the backend serve the UI too: one URL, no CORS, and the OAuth redirect stays simple. |
| ML service | **Render** web service (Python) | Free instances sleep after inactivity. The first prediction after a sleep can take ~30–60 s, and the backend times out at 10 s (`ML_TIMEOUT_MS`), so either raise the timeout or use a paid instance. |

`render.yaml` describes both services (Render → *New → Blueprint*).

## 1. MongoDB Atlas

1. Create a free cluster, a database user, and allow network access (`0.0.0.0/0`, or Render's outbound IPs).
2. Copy the `mongodb+srv://…/recalliq` connection string into `MONGODB_URI`. The database name in the path is used.
3. **DNS problem you had before:** errors like `querySrv ECONNREFUSED` / `ENOTFOUND _mongodb._tcp…` come from a local DNS resolver that refuses SRV lookups. This happens on some ISPs and Windows setups, and doesn't happen on Render. Locally, set `MONGODB_DNS_SERVERS=8.8.8.8,1.1.1.1`, or use Atlas's "standard connection string" (`mongodb://host1,host2,host3/...`), which needs no SRV lookup.
4. Check it: `MONGODB_TEST_URI="<uri to a throwaway db>" npm test` in `backend/` runs the full suite against Atlas. *This was not run by Claude, because MongoDB was unreachable from the build sandbox.*

## 2. Render services

Set these in the Render dashboard (never commit them):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SERVE_FRONTEND` | `true` |
| `TRUST_PROXY` | `1` |
| `MONGODB_URI` | Atlas URI |
| `ML_SERVICE_URL` | ML service URL (Blueprint fills in the private address; or use `https://recalliq-ml.onrender.com`) |
| `FRONTEND_URL` | `https://recalliq-api.onrender.com` (your backend URL, since it serves the UI) |
| `CORS_ORIGINS` | same URL (add other origins comma-separated if you host the UI elsewhere) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from Google Cloud |
| `GOOGLE_REDIRECT_URI` | `https://recalliq-api.onrender.com/api/gmail/callback` |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes in base64 (Blueprint generates one). **Keep it stable.** Changing it makes stored Gmail tokens unreadable. |

On start, the backend logs a `[config] WARNING` for anything important that's missing. Set `STRICT_CONFIG=true` to refuse to start instead.

## 3. Google OAuth for production

1. In the same OAuth client, **add** the production redirect URI exactly (https, no trailing slash) and keep the localhost one.
2. On the OAuth consent screen, add the production domain under *Authorized domains*.
3. While the app is in **Testing**, only listed test users can connect, and refresh tokens expire after **7 days**. When that happens, campaigns pause with "reconnect Gmail" and nothing is lost. For a longer-lived demo, publish the app. Google requires verification for the `gmail.send` scope if outside users will connect.
4. After deploying: log in → Settings → Connect Gmail → Verify → Send test.

## 4. Optional: frontend on Netlify / Vercel instead

1. Set `PRODUCTION_API_BASE` in `config.js` to `https://<backend>/api`.
2. Netlify: `netlify.toml` publishes only the frontend files. Vercel: deploy the same files as a static site.
3. Backend: `SERVE_FRONTEND=false`, `CORS_ORIGINS=https://<your-site>`, `FRONTEND_URL=https://<your-site>`.
4. Auth uses bearer tokens (not cookies), so cross-site hosting isn't affected by third-party-cookie blocking.

## 5. Pre-launch checklist

- [ ] `GET /api/health` → `storage: "mongodb"`, `storageDurable: true`, `tokenEncryption: true`, `gmailOAuthConfigured: true`
- [ ] `GET /api/health/ml` → `reachable: true`
- [ ] Register, log in, log out
- [ ] Import CSV, then export it
- [ ] Gmail connect → verify → test email arrives
- [ ] A campaign to yourself (as a consenting customer) shows **Sent** with a message ID matching your Gmail Sent folder
- [ ] Restart the backend; the data is still there
- [ ] `.env`, `backend/data/*` and token files are not in git (`git status`, `git log --all -- backend/.env`)

## Scaling notes

- Rate limiting and the send worker are in-process. Run **one** backend instance, or move limits and the queue to Redis before scaling out. Two instances could each run a worker for the same campaign after a restart.
- Gmail is not a bulk email provider: roughly 500/day on personal accounts and 2,000/day on Workspace. For larger volumes, move to a transactional email provider with real delivery/open webhooks.
