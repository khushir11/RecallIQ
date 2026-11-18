// Frontend runtime configuration.
// - Local development (frontend on :3000, backend on :4000): uses http://localhost:4000/api.
// - Single-service deployment (backend serves the UI, SERVE_FRONTEND=true): uses same-origin /api.
// - Separate frontend host (Netlify/Vercel): set PRODUCTION_API_BASE to your backend, e.g.
//   "https://recalliq-api.onrender.com/api".
(function () {
  const PRODUCTION_API_BASE = ""; // leave empty for same-origin /api
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1";
  let base;
  if (isLocal && window.location.port !== "4000") base = `http://${host}:4000/api`;
  else base = PRODUCTION_API_BASE || `${window.location.origin}/api`;
  window.RECALLIQ_API_BASE = window.RECALLIQ_API_BASE || base;
})();
