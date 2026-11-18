## RecallIQ — AI Customer Re-Engagement Platform

**Tech:** JavaScript, Node.js/Express, Python/FastAPI, scikit-learn, Gmail API (OAuth 2.0), MongoDB

- Built a multi-user customer-retention platform: scrypt auth with hashed session tokens, per-user data isolation, rate limiting, and a CSV import/export pipeline with validation.
- Integrated the Gmail API with per-user OAuth (CSRF-safe state, AES-256-GCM token encryption, refresh/expiry handling). Built a campaign engine with consent and eligibility checks, retries, pause/resume/cancel, crash recovery and duplicate-send protection, and recorded per-recipient results with Gmail message IDs.
- Served churn-risk predictions from a FastAPI logistic-regression service, with feature-contribution explanations and next-best-action recommendations. Clearly separated the synthetic-data demo model from a train-on-your-data pipeline.
- Wrote 14 integration tests covering auth, ownership, CSV, Gmail error paths, campaign state transitions and analytics accuracy.
