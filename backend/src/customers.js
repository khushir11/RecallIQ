// Customer records. Every query is scoped to ownerId = the authenticated user.
import * as store from "./store.js";
import { badRequest, cleanString, conflict, isValidDate, isValidEmail, notFound } from "./http.js";
import { daysSince } from "./templates.js";

export const CHANNELS = ["Email", "SMS", "WhatsApp", "App Push", "Phone"];
export const CSV_HEADERS = [
  "name", "email", "phone", "lastOrderDate", "totalSpent", "orderCount", "cartValue",
  "birthday", "preferredChannel", "consent", "engagementScore", "supportTickets", "notes",
];
const MAX_CUSTOMERS_PER_USER = Number(process.env.MAX_CUSTOMERS_PER_USER || 10000);

const toBool = (value) => value === true || ["true", "yes", "y", "1", "on"].includes(String(value ?? "").trim().toLowerCase());
const today = () => new Date().toISOString().slice(0, 10);

function num(value, field, { min = 0, max = 1e10, integer = false, optional = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (optional) return null;
    return 0;
  }
  const n = Number(String(value).replace(/[,₹\s]/g, "").replace(/^rs\.?/i, ""));
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number.`);
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}.`);
  if (integer && !Number.isInteger(n)) throw badRequest(`${field} must be a whole number.`);
  return n;
}

function normaliseDate(value, field, { notFuture = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let iso = raw;
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // 01/03/2026 → 2026-03-01 (day-first, Indian format)
  if (dmy) iso = `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  if (!isValidDate(iso)) throw badRequest(`${field} must be a valid date (YYYY-MM-DD).`);
  if (notFuture && iso > today()) throw badRequest(`${field} cannot be in the future.`);
  return iso;
}

/** Validates and normalises customer input. `partial` allows PATCH-style updates. */
export function validateCustomer(input = {}, { partial = false } = {}) {
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  if (!partial || has("name")) {
    out.name = cleanString(input.name, 120);
    if (!out.name) throw badRequest("Customer name is required.");
  }
  if (!partial || has("email")) {
    out.email = cleanString(input.email, 254).toLowerCase();
    if (out.email && !isValidEmail(out.email)) throw badRequest(`"${out.email}" is not a valid email address.`);
  }
  if (!partial || has("phone")) {
    out.phone = cleanString(input.phone, 30);
    if (out.phone && !/^\+?[0-9 ()-]{6,20}$/.test(out.phone)) throw badRequest("Phone number contains invalid characters.");
  }
  if (!partial || has("lastOrderDate")) out.lastOrderDate = normaliseDate(input.lastOrderDate, "Last order date", { notFuture: true });
  if (!partial || has("birthday")) out.birthday = normaliseDate(input.birthday, "Birthday", { notFuture: true });
  if (!partial || has("totalSpent")) out.totalSpent = num(input.totalSpent, "Total spent");
  if (!partial || has("orderCount")) out.orderCount = num(input.orderCount, "Order count", { integer: true, max: 1e6 });
  if (!partial || has("cartValue")) out.cartValue = num(input.cartValue, "Cart value");
  if (!partial || has("engagementScore")) out.engagementScore = num(input.engagementScore, "Engagement score", { max: 100, optional: true });
  if (!partial || has("supportTickets")) out.supportTickets = num(input.supportTickets, "Support tickets", { integer: true, max: 10000 });
  if (!partial || has("preferredChannel")) {
    const raw = cleanString(input.preferredChannel, 20) || "Email";
    const match = CHANNELS.find((c) => c.toLowerCase() === raw.toLowerCase());
    if (!match) throw badRequest(`Preferred channel must be one of: ${CHANNELS.join(", ")}.`);
    out.preferredChannel = match;
  }
  if (!partial || has("consent")) out.consent = toBool(input.consent);
  if (!partial || has("notes")) out.notes = cleanString(input.notes, 1000);
  return out;
}

// Derived, read-only fields so the UI never has to re-implement business rules.
export function decorate(customer) {
  const days = daysSince(customer.lastOrderDate);
  return {
    ...customer,
    daysSinceLastOrder: days,
    emailValid: isValidEmail(customer.email),
    emailable: Boolean(customer.consent && isValidEmail(customer.email)),
    averageOrderValue: customer.orderCount ? Math.round(customer.totalSpent / customer.orderCount) : 0,
    status: days === null ? "unknown" : days <= 30 ? "active" : days <= 60 ? "cooling" : "at_risk",
  };
}

export async function listAll(ownerId) {
  return (await store.find("customers", { ownerId })).map(decorate);
}

export async function list(ownerId, query = {}) {
  let items = await listAll(ownerId);
  const search = String(query.search || "").trim().toLowerCase();
  if (search) items = items.filter((c) => `${c.name} ${c.email} ${c.phone} ${c.notes || ""}`.toLowerCase().includes(search));
  if (query.consent === "yes") items = items.filter((c) => c.consent);
  if (query.consent === "no") items = items.filter((c) => !c.consent);
  if (query.channel) items = items.filter((c) => c.preferredChannel === query.channel);
  if (query.status) items = items.filter((c) => c.status === query.status);
  if (query.risk) items = items.filter((c) => (query.risk === "unscored" ? !c.risk : c.risk?.level === query.risk));
  if (query.emailable === "yes") items = items.filter((c) => c.emailable);

  const sortKey = ["name", "email", "lastOrderDate", "totalSpent", "orderCount", "cartValue", "engagementScore", "createdAt", "risk", "daysSinceLastOrder"].includes(query.sort) ? query.sort : "createdAt";
  const dir = query.order === "asc" ? 1 : -1;
  const value = (c) => (sortKey === "risk" ? c.risk?.probability ?? -1 : c[sortKey] ?? "");
  items.sort((a, b) => {
    const va = value(a); const vb = value(b);
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });

  const total = items.length;
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
  const page = Math.max(1, Number(query.page) || 1);
  return { items: items.slice((page - 1) * limit, page * limit), total, page, limit };
}

export async function get(ownerId, id) {
  const customer = await store.findOne("customers", { ownerId, id: String(id) });
  if (!customer) throw notFound("Customer not found.");
  return decorate(customer);
}

export async function history(ownerId, customerId) {
  const campaigns = await store.find("campaigns", { ownerId });
  return campaigns.flatMap((campaign) => (campaign.recipients || [])
    .filter((r) => r.customerId === customerId)
    .map((r) => ({ campaignId: campaign.id, campaignName: campaign.name, status: r.status, reason: r.reason || null, messageId: r.messageId || null, at: r.sentAt || r.attemptedAt || campaign.launchedAt })))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

async function assertUniqueEmail(ownerId, email, exceptId = null) {
  if (!email) return;
  const existing = await store.findOne("customers", { ownerId, email });
  if (existing && existing.id !== exceptId) throw conflict(`Another customer (${existing.name}) already uses ${email}.`);
}

export async function create(ownerId, input) {
  const data = validateCustomer(input);
  await assertUniqueEmail(ownerId, data.email);
  const count = (await store.find("customers", { ownerId })).length;
  if (count >= MAX_CUSTOMERS_PER_USER) throw badRequest(`Customer limit reached (${MAX_CUSTOMERS_PER_USER}).`);
  return decorate(await store.insert("customers", { ...data, ownerId, consentUpdatedAt: new Date().toISOString(), risk: null }));
}

export async function updateOne(ownerId, id, input) {
  const existing = await get(ownerId, id);
  const patch = validateCustomer(input, { partial: true });
  if (patch.email !== undefined) await assertUniqueEmail(ownerId, patch.email, existing.id);
  if (patch.consent !== undefined && patch.consent !== existing.consent) patch.consentUpdatedAt = new Date().toISOString();
  // Behavioural inputs changed → previous risk score no longer describes this customer.
  if (["lastOrderDate", "orderCount", "totalSpent", "cartValue", "engagementScore", "supportTickets"].some((k) => patch[k] !== undefined && patch[k] !== existing[k])) {
    patch.risk = existing.risk ? { ...existing.risk, stale: true } : null;
  }
  return decorate(await store.update("customers", { ownerId, id: existing.id }, patch));
}

export async function removeOne(ownerId, id) {
  const removed = await store.remove("customers", { ownerId, id: String(id) });
  if (!removed) throw notFound("Customer not found.");
  return { deleted: true };
}

export async function removeMany(ownerId, ids) {
  if (!Array.isArray(ids) || !ids.length) throw badRequest("Provide the ids of the customers to delete.");
  const removed = await store.remove("customers", { ownerId, id: { $in: ids.map(String) } });
  return { deleted: removed };
}

// ---------------------------------------------------------------- CSV
/** RFC 4180 parser: quoted fields, escaped quotes (""), commas and newlines inside quotes, BOM. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

const HEADER_ALIASES = {
  name: ["name", "customer", "customername", "fullname"],
  email: ["email", "emailaddress", "mail"],
  phone: ["phone", "mobile", "phonenumber"],
  lastOrderDate: ["lastorderdate", "lastorder", "lastpurchasedate", "lastpurchase"],
  totalSpent: ["totalspent", "spent", "lifetimevalue", "ltv", "totalspend"],
  orderCount: ["ordercount", "orders", "totalorders"],
  cartValue: ["cartvalue", "cart", "carttotal"],
  birthday: ["birthday", "dob", "dateofbirth"],
  preferredChannel: ["preferredchannel", "channel"],
  consent: ["consent", "marketingconsent", "optin", "emailconsent"],
  engagementScore: ["engagementscore", "engagement"],
  supportTickets: ["supporttickets", "tickets"],
  notes: ["notes", "note"],
};

export async function importCsv(ownerId, text, { mode = "merge" } = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw badRequest("The CSV needs a header row and at least one customer row.");
  if (rows.length > 5001) throw badRequest("Import at most 5,000 rows at a time.");
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
  const columnFor = Object.fromEntries(Object.entries(HEADER_ALIASES).map(([field, aliases]) => [field, header.findIndex((h) => aliases.includes(h))]));
  if (columnFor.name === -1) throw badRequest("The CSV must include a 'name' column.");

  const existing = await store.find("customers", { ownerId });
  const byEmail = new Map(existing.filter((c) => c.email).map((c) => [c.email, c]));
  // Rows without an email are matched to an existing email-less customer with the same name,
  // so re-importing an export does not duplicate them.
  const nameKey = (name) => String(name || "").trim().toLowerCase();
  const byNameNoEmail = new Map(existing.filter((c) => !c.email).map((c) => [nameKey(c.name), c]));
  const seenInFile = new Set();
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  const toInsert = [];

  for (let i = 1; i < rows.length; i += 1) {
    const raw = Object.fromEntries(Object.entries(columnFor).filter(([, idx]) => idx !== -1).map(([field, idx]) => [field, rows[i][idx] ?? ""]));
    try {
      const data = validateCustomer(raw);
      if (data.email && seenInFile.has(data.email)) throw badRequest(`Duplicate email in file: ${data.email}`);
      if (data.email) seenInFile.add(data.email);
      const match = data.email ? byEmail.get(data.email) : byNameNoEmail.get(nameKey(data.name));
      if (match) {
        if (mode === "skip-existing") { result.skipped += 1; continue; }
        const patch = { ...data };
        if (patch.consent !== match.consent) patch.consentUpdatedAt = new Date().toISOString();
        await store.update("customers", { ownerId, id: match.id }, patch);
        result.updated += 1;
      } else {
        toInsert.push({ ...data, ownerId, consentUpdatedAt: new Date().toISOString(), risk: null });
      }
    } catch (error) {
      result.errors.push({ row: i + 1, message: error.message });
    }
  }
  if (existing.length + toInsert.length > MAX_CUSTOMERS_PER_USER) throw badRequest(`Import would exceed the customer limit (${MAX_CUSTOMERS_PER_USER}).`);
  if (toInsert.length) await store.insertMany("customers", toInsert);
  result.created = toInsert.length;
  result.skipped += result.errors.length;
  return result;
}

export async function exportCsv(ownerId) {
  const customers = await store.find("customers", { ownerId });
  const cell = (value) => {
    let s = String(value ?? "");
    // Neutralise spreadsheet formula injection, but leave plain phone numbers like +91 98… intact.
    if (/^[=+\-@\t\r]/.test(s) && !/^\+?[0-9 ()-]+$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [[...CSV_HEADERS, "riskLevel", "churnProbability"].join(",")];
  for (const c of customers) {
    lines.push([...CSV_HEADERS.map((h) => cell(c[h])), cell(c.risk?.level || ""), cell(c.risk?.probability ?? "")].join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
