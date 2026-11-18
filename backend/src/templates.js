// Personalised email templates. Placeholders use {{name}} syntax and are validated before a
// campaign can be saved, so a typo cannot reach customers as a literal "{{fristName}}".
import { escapeHtml } from "./http.js";

export const PLACEHOLDERS = {
  firstName: "Customer's first name (falls back to 'there')",
  name: "Customer's full name",
  offer: "The campaign offer text",
  cartValue: "Current cart value, formatted (e.g. ₹2,600)",
  totalSpent: "Lifetime spend, formatted",
  orderCount: "Number of orders",
  lastOrderDate: "Last order date (e.g. 4 Jun 2026)",
  daysSinceLastOrder: "Days since the last order",
  businessName: "Your business name from Settings",
};

const TOKEN_RE = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

export function unknownPlaceholders(...templates) {
  const unknown = new Set();
  for (const template of templates) {
    for (const [, key] of String(template || "").matchAll(TOKEN_RE)) if (!(key in PLACEHOLDERS)) unknown.add(key);
  }
  return [...unknown];
}

const inr = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value) || 0);
const prettyDate = (value) => {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

export function daysSince(dateString) {
  if (!dateString) return null;
  const time = new Date(`${dateString}T00:00:00Z`).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 86400000));
}

export function variablesFor(customer = {}, { offer = "", businessName = "" } = {}) {
  const name = String(customer.name || "").trim();
  return {
    firstName: name.split(/\s+/)[0] || "there",
    name: name || "there",
    offer: offer || "",
    cartValue: inr(customer.cartValue),
    totalSpent: inr(customer.totalSpent),
    orderCount: String(Number(customer.orderCount) || 0),
    lastOrderDate: prettyDate(customer.lastOrderDate) || "your last visit",
    daysSinceLastOrder: String(daysSince(customer.lastOrderDate) ?? ""),
    businessName: businessName || "our store",
  };
}

export function render(template, variables) {
  return String(template || "").replace(TOKEN_RE, (match, key) => (key in variables ? variables[key] : match));
}

export function renderEmail({ subject, body, offer, businessName, senderName }, customer) {
  const vars = variablesFor(customer, { offer: render(offer, variablesFor(customer, { businessName })), businessName });
  const renderedSubject = render(subject, vars).replace(/\s+/g, " ").trim();
  const renderedBody = render(body, vars).trim();
  const footer = `You are receiving this because you agreed to receive updates from ${vars.businessName}. `
    + "Reply with \"unsubscribe\" and we will stop emailing you.";
  const signature = senderName ? `\n\n— ${senderName}${businessName ? `, ${businessName}` : ""}` : "";
  const text = `${renderedBody}${signature}\n\n--\n${footer}`;
  const paragraphs = `${renderedBody}${signature}`.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f7faf7">
<div style="max-width:560px;margin:0 auto;padding:28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#15201d">
${paragraphs}
<hr style="border:none;border-top:1px solid #dbe4df;margin:24px 0 12px">
<p style="margin:0;font-size:12px;color:#62706b">${escapeHtml(footer)}</p>
</div></body></html>`;
  return { subject: renderedSubject, text, html };
}
