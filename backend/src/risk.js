// Bridges customer records to the FastAPI risk service and stores the latest score on the customer.
import * as store from "./store.js";
import { HttpError, badRequest } from "./http.js";
import { decorate, get as getCustomer } from "./customers.js";

const ML_URL = () => {
  const raw = (process.env.ML_SERVICE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
  return /^https?:\/\//.test(raw) ? raw : `http://${raw}`; // Render's internal "host:port" form
};
const TIMEOUT_MS = () => Number(process.env.ML_TIMEOUT_MS || 10000);

async function callMl(path, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
  let response;
  try {
    response = await fetch(`${ML_URL()}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    const why = error.name === "AbortError" ? `did not respond within ${TIMEOUT_MS() / 1000}s` : "is not reachable";
    throw new HttpError(503, `The ML risk service ${why} (${ML_URL()}). Start it with: cd ml-service && uvicorn app:app --port 8000`);
  } finally {
    clearTimeout(timer);
  }
  const payload = await response.json().catch(() => ({}));
  if (response.status === 422) {
    const detail = Array.isArray(payload.detail) ? payload.detail.map((d) => `${(d.loc || []).slice(1).join(".")}: ${d.msg}`).join("; ") : "invalid input";
    throw badRequest(`The ML service rejected the customer features: ${detail}`);
  }
  if (!response.ok) throw new HttpError(502, `ML service error (${response.status}).`);
  return payload;
}

export async function mlHealth() {
  try {
    return { reachable: true, url: ML_URL(), ...(await callMl("/health")) };
  } catch (error) {
    return { reachable: false, url: ML_URL(), error: error.message };
  }
}

/** Builds the model's six features. Returns { features, assumptions } or throws if unusable. */
export function featuresFor(customer) {
  const c = decorate(customer);
  if (c.daysSinceLastOrder === null) throw badRequest(`${c.name} has no last order date, so churn risk cannot be scored. Add a last order date first.`);
  const assumptions = [];
  let engagement = c.engagementScore;
  if (engagement === null || engagement === undefined) {
    engagement = 50;
    assumptions.push("Engagement score not recorded; a neutral 50/100 was assumed.");
  }
  return {
    features: {
      days_since_last_order: c.daysSinceLastOrder,
      order_count: c.orderCount || 0,
      total_spent: c.totalSpent || 0,
      engagement_score: engagement,
      support_tickets: c.supportTickets || 0,
      cart_value: c.cartValue || 0,
    },
    assumptions,
  };
}

function channelAdvice(customer) {
  const c = decorate(customer);
  if (c.emailable) {
    return {
      channel: "Email",
      note: c.preferredChannel === "Email" ? "Prefers email and has consented." : `Prefers ${c.preferredChannel}, which is not connected. Email is used because they consented to marketing.`,
    };
  }
  if (!c.consent) return { channel: null, note: "No marketing consent — do not contact for marketing." };
  return { channel: null, note: "Consented, but the email address is missing or invalid. Fix the address to reach them." };
}

function toRiskRecord(prediction, assumptions, customer) {
  const advice = channelAdvice(customer);
  return {
    probability: prediction.churn_probability,
    level: prediction.risk,
    reasons: prediction.reasons || [],
    drivers: prediction.drivers || [],
    protective: prediction.protective_factors || [],
    action: prediction.recommended_action,
    offer: prediction.recommended_offer,
    channel: advice.channel,
    channelNote: advice.note,
    assumptions: [...assumptions, ...(prediction.out_of_training_range?.length ? [`Outside the model's training range: ${prediction.out_of_training_range.join(", ")} — treat with caution.`] : [])],
    model: prediction.model?.provenance || "unknown",
    scoredAt: new Date().toISOString(),
    stale: false,
  };
}

export async function predictCustomer(ownerId, customerId) {
  const customer = await getCustomer(ownerId, customerId);
  const { features, assumptions } = featuresFor(customer);
  const prediction = await callMl("/predict", { method: "POST", body: features });
  const risk = toRiskRecord(prediction, assumptions, customer);
  const updated = await store.update("customers", { ownerId, id: customer.id }, { risk });
  return { customer: decorate(updated), features, risk };
}

export async function scoreAll(ownerId) {
  const customers = await store.find("customers", { ownerId });
  const scorable = [];
  const skipped = [];
  for (const c of customers) {
    try { scorable.push({ customer: c, ...featuresFor(c) }); } catch (error) { skipped.push({ id: c.id, name: c.name, reason: error.message }); }
  }
  let scored = 0;
  for (let i = 0; i < scorable.length; i += 500) {
    const chunk = scorable.slice(i, i + 500);
    const { predictions } = await callMl("/predict/batch", { method: "POST", body: { customers: chunk.map((s) => s.features) } });
    for (let j = 0; j < chunk.length; j += 1) {
      await store.update("customers", { ownerId, id: chunk[j].customer.id }, { risk: toRiskRecord(predictions[j], chunk[j].assumptions, chunk[j].customer) });
      scored += 1;
    }
  }
  return { scored, skipped, total: customers.length };
}

/** Ad-hoc prediction from raw features (kept for backward compatibility with the old endpoint). */
export async function predictFeatures(features) {
  return callMl("/predict", { method: "POST", body: features });
}
