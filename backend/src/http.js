// Shared HTTP helpers: typed errors, async route wrapper, validation, rate limiting, CORS, headers.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message, extra) => new HttpError(400, message, extra);
export const notFound = (message = "Not found") => new HttpError(404, message);
export const conflict = (message, extra) => new HttpError(409, message, extra);

// Express 5 forwards rejected promises to the error handler, but wrapping keeps intent explicit.
export const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// ---------------------------------------------------------------- validation
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmail(value) {
  const email = String(value || "").trim();
  if (!email || email.length > 254) return false;
  const [local, domain] = email.split("@");
  if (!local || local.length > 64 || !domain || !domain.includes(".")) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return EMAIL_RE.test(email);
}

export function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const cleanString = (value, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// ---------------------------------------------------------------- rate limiting
// In-memory fixed-window limiter. Fine for a single instance; use a shared store (Redis) if you
// scale the backend horizontally.
const buckets = new Map();

export function rateLimit({ windowMs, max, key = (req) => req.ip, message = "Too many requests. Please slow down and try again shortly." }) {
  return (req, res, next) => {
    const id = `${windowMs}:${max}:${req.baseUrl}${req.route?.path || req.path}:${key(req)}`;
    const nowMs = Date.now();
    let bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= nowMs) {
      bucket = { count: 0, resetAt: nowMs + windowMs };
      buckets.set(id, bucket);
    }
    bucket.count += 1;
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - nowMs) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

setInterval(() => {
  const nowMs = Date.now();
  for (const [id, bucket] of buckets) if (bucket.resetAt <= nowMs) buckets.delete(id);
}, 60_000).unref();

export const resetRateLimits = () => buckets.clear();

// ---------------------------------------------------------------- CORS
// CORS_ORIGINS: comma-separated list of exact origins (e.g. https://recalliq.netlify.app).
// When unset (local development) any http://localhost:* or http://127.0.0.1:* origin is allowed.
export function corsOptions() {
  const configured = (process.env.CORS_ORIGINS || "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
  const isLocal = (origin) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true); // same-origin, curl, server-to-server
      if (configured.includes(origin)) return callback(null, true);
      if (!configured.length && process.env.NODE_ENV !== "production" && isLocal(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  };
}

export function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
