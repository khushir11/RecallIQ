// Shared API client + small UI helpers used by every page.
(function () {
  const TOKEN_KEY = "recalliq.session";
  const base = () => window.RECALLIQ_API_BASE;

  const session = {
    get() { try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || "null"); } catch { return null; } },
    set(data) { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: data.token, user: data.user, expiresAt: data.expiresAt })); },
    clear() { localStorage.removeItem(TOKEN_KEY); },
  };

  class ApiError extends Error {
    constructor(status, message, data) { super(message); this.status = status; this.data = data; }
  }

  async function request(path, { method = "GET", body, raw = false } = {}) {
    const s = session.get();
    let response;
    try {
      response = await fetch(`${base()}${path}`, {
        method,
        headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(s?.token ? { Authorization: `Bearer ${s.token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, `Cannot reach the RecallIQ backend at ${base()}. Make sure it is running.`);
    }
    if (response.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/register")) {
      session.clear();
      if (!/login\.html|register\.html/.test(location.pathname)) location.replace(`login.html?expired=1`);
      throw new ApiError(401, "Your session has expired. Please log in again.");
    }
    if (raw) {
      if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status}).`);
      return response;
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, data?.error || `Request failed (${response.status}).`, data);
    return data;
  }

  const api = {
    get: (p) => request(p),
    post: (p, body = {}) => request(p, { method: "POST", body }),
    put: (p, body = {}) => request(p, { method: "PUT", body }),
    patch: (p, body = {}) => request(p, { method: "PATCH", body }),
    del: (p) => request(p, { method: "DELETE" }),
    raw: (p) => request(p, { raw: true }),
  };

  // ---------------------------------------------------------------- UI helpers
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const inr = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value) || 0);
  const num = (value) => new Intl.NumberFormat("en-IN").format(Number(value) || 0);
  const date = (value) => {
    if (!value) return "—";
    const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  };
  const dateTime = (value) => {
    if (!value) return "—";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  function toast(message, type = "ok", ms = 4500) {
    let host = document.querySelector(".toasts");
    if (!host) {
      host = document.createElement("div");
      host.className = "toasts";
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), type === "error" ? Math.max(ms, 7000) : ms);
  }

  async function withBusy(button, fn, busyLabel) {
    const original = button?.innerHTML;
    if (button) { button.disabled = true; button.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${esc(busyLabel || "Working…")}`; }
    try { return await fn(); } finally { if (button) { button.disabled = false; button.innerHTML = original; } }
  }

  window.RIQ = { api, session, ApiError, esc, inr, num, date, dateTime, toast, withBusy };
})();
