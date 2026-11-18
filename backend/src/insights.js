// Segments, recommendations and dashboard analytics — all computed from the user's real records.
// Nothing here is a forecast: "value at stake" is an explicit, simple estimate whose formula is
// returned alongside the number so the UI can show it.
import * as store from "./store.js";
import { listAll } from "./customers.js";

const percentile = (values, p) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

function daysUntilBirthday(birthday) {
  if (!birthday) return null;
  const [, m, d] = birthday.split("-").map(Number);
  const nowDate = new Date();
  const todayUtc = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
  let next = Date.UTC(nowDate.getUTCFullYear(), m - 1, d);
  if (next < todayUtc) next = Date.UTC(nowDate.getUTCFullYear() + 1, m - 1, d);
  return Math.round((next - todayUtc) / 86400000);
}

const TEMPLATES = {
  sleeping_loyalists: {
    offer: "15% off your next order",
    subject: "{{firstName}}, we've missed you at {{businessName}}",
    body: "Hi {{firstName}},\n\nIt has been {{daysSinceLastOrder}} days since your last order, and we wanted to say thank you for being one of our regulars — {{orderCount}} orders so far.\n\nAs a thank-you, here is something for your next visit: {{offer}}.\n\nWe would love to see you again soon.",
    action: "Loyalty win-back email",
  },
  cart_abandoners: {
    offer: "free delivery on your saved cart",
    subject: "{{firstName}}, your cart is still waiting",
    body: "Hi {{firstName}},\n\nYou left items worth {{cartValue}} in your cart. We have saved them for you.\n\nTo make it easier to finish your order, here is {{offer}}.\n\nIf you have any questions about the items, just reply to this email.",
    action: "Saved-cart reminder",
  },
  vip_churn_watch: {
    offer: "an exclusive 20% VIP reward",
    subject: "A personal thank-you, {{firstName}}",
    body: "Hi {{firstName}},\n\nYou are one of our most valued customers, and we noticed it has been a while since we last saw you.\n\nWe have set aside {{offer}} for you. If anything about your last experience was not right, reply to this email — it comes straight to us.",
    action: "VIP retention outreach",
  },
  birthday: {
    offer: "20% off anything this week",
    subject: "Happy birthday, {{firstName}}! 🎂",
    body: "Hi {{firstName}},\n\nHappy birthday from all of us at {{businessName}}!\n\nTo celebrate, here is a small gift: {{offer}}.\n\nHave a wonderful day.",
    action: "Birthday reward",
  },
  high_value_inactive: {
    offer: "10% off plus early access to new arrivals",
    subject: "{{firstName}}, here is what is new at {{businessName}}",
    body: "Hi {{firstName}},\n\nIt has been a while since your last order on {{lastOrderDate}}. A lot has changed since then, and we think you will like what is new.\n\nCome take a look — {{offer}}.",
    action: "Reactivation email",
  },
  ml_high_risk: {
    offer: "a 10% loyalty offer on your next order",
    subject: "{{firstName}}, a little something from {{businessName}}",
    body: "Hi {{firstName}},\n\nWe value having you as a customer and wanted to check in.\n\nHere is {{offer}}. We hope to see you again soon.",
    action: "Model-targeted retention email",
  },
};

export async function computeSegments(ownerId) {
  const customers = await listAll(ownerId);
  const spends = customers.map((c) => c.totalSpent).filter((v) => v > 0);
  const vipThreshold = percentile(spends, 80);
  const medianSpend = percentile(spends, 50);

  const defs = [
    {
      key: "sleeping_loyalists",
      label: "Sleeping loyalists",
      rule: "4+ orders, but no order in the last 60 days",
      priority: "high",
      test: (c) => c.orderCount >= 4 && c.daysSinceLastOrder !== null && c.daysSinceLastOrder >= 60,
      value: (c) => c.averageOrderValue,
      valueRule: "one average order per customer",
    },
    {
      key: "cart_abandoners",
      label: "Cart abandoners",
      rule: "Items currently left in cart (cart value > 0)",
      priority: "medium",
      test: (c) => c.cartValue > 0,
      value: (c) => c.cartValue,
      valueRule: "sum of current cart values",
    },
    {
      key: "vip_churn_watch",
      label: "VIP churn watch",
      rule: vipThreshold ? `Top 20% by lifetime spend (≥ ₹${Math.round(vipThreshold).toLocaleString("en-IN")}) and no order in 30+ days` : "Top 20% by lifetime spend and no order in 30+ days",
      priority: "high",
      test: (c) => vipThreshold > 0 && c.totalSpent >= vipThreshold && c.daysSinceLastOrder !== null && c.daysSinceLastOrder >= 30,
      value: (c) => c.averageOrderValue,
      valueRule: "one average order per customer",
    },
    {
      key: "birthday",
      label: "Birthday customers",
      rule: "Birthday within the next 14 days",
      priority: "low",
      test: (c) => { const d = daysUntilBirthday(c.birthday); return d !== null && d <= 14; },
      value: (c) => c.averageOrderValue,
      valueRule: "one average order per customer",
    },
    {
      key: "high_value_inactive",
      label: "High-value inactive",
      rule: medianSpend ? `Spend at or above the median (₹${Math.round(medianSpend).toLocaleString("en-IN")}) and no order in 90+ days` : "Spend at or above the median and no order in 90+ days",
      priority: "high",
      test: (c) => medianSpend > 0 && c.totalSpent >= medianSpend && c.daysSinceLastOrder !== null && c.daysSinceLastOrder >= 90,
      value: (c) => c.averageOrderValue,
      valueRule: "one average order per customer",
    },
    {
      key: "ml_high_risk",
      label: "High churn risk (model)",
      rule: "Latest risk score is HIGH (run 'Score all customers' first)",
      priority: "high",
      test: (c) => c.risk?.level === "HIGH" && !c.risk?.stale,
      value: (c) => c.averageOrderValue,
      valueRule: "one average order per customer",
    },
  ];

  return defs.map((def) => {
    const members = customers.filter(def.test);
    const reachable = members.filter((c) => c.emailable);
    const noConsent = members.filter((c) => !c.consent).length;
    const invalidEmail = members.filter((c) => c.consent && !c.emailValid).length;
    const channels = members.reduce((acc, c) => ({ ...acc, [c.preferredChannel]: (acc[c.preferredChannel] || 0) + 1 }), {});
    const nonEmailPreferred = members.filter((c) => c.preferredChannel !== "Email").length;
    const scored = members.filter((c) => c.risk && !c.risk.stale);
    const template = TEMPLATES[def.key];
    let channelNote;
    if (!members.length) channelNote = "No customers match this segment yet.";
    else if (!reachable.length) channelNote = "Nobody in this segment can be emailed (missing consent or valid email).";
    else channelNote = `Email reaches ${reachable.length} of ${members.length} (consented, valid address).`
      + (nonEmailPreferred ? ` ${nonEmailPreferred} prefer another channel; only Email sending is connected, so they are emailed only if they consented.` : "");
    return {
      key: def.key,
      label: def.label,
      rule: def.rule,
      priority: def.priority,
      size: members.length,
      reachable: reachable.length,
      excluded: { noConsent, invalidEmail },
      channelPreferences: channels,
      recommendedChannel: reachable.length ? "Email" : null,
      channelNote,
      valueAtStake: Math.round(reachable.reduce((sum, c) => sum + (def.value(c) || 0), 0)),
      valueRule: `Estimate: ${def.valueRule}, reachable customers only. Not a forecast.`,
      averageRisk: scored.length ? Number((scored.reduce((s, c) => s + c.risk.probability, 0) / scored.length).toFixed(3)) : null,
      scoredCount: scored.length,
      customerIds: members.map((c) => c.id),
      reachableIds: reachable.map((c) => c.id),
      preview: members.slice(0, 8).map((c) => ({ id: c.id, name: c.name, email: c.email, emailable: c.emailable, daysSinceLastOrder: c.daysSinceLastOrder, totalSpent: c.totalSpent, cartValue: c.cartValue, risk: c.risk?.level || null })),
      recommendation: { action: template.action, offer: template.offer, subject: template.subject, body: template.body },
    };
  });
}

export async function analytics(ownerId) {
  const [customers, campaigns] = await Promise.all([listAll(ownerId), store.find("campaigns", { ownerId })]);
  const scored = customers.filter((c) => c.risk && !c.risk.stale);
  const buckets = [
    { label: "0–30 days", min: 0, max: 30 },
    { label: "31–60 days", min: 31, max: 60 },
    { label: "61–90 days", min: 61, max: 90 },
    { label: "91–180 days", min: 91, max: 180 },
    { label: "180+ days", min: 181, max: Infinity },
  ].map((b) => {
    const inBucket = customers.filter((c) => c.daysSinceLastOrder !== null && c.daysSinceLastOrder >= b.min && c.daysSinceLastOrder <= b.max);
    return { label: b.label, customers: inBucket.length, lifetimeSpend: inBucket.reduce((s, c) => s + c.totalSpent, 0) };
  });
  const noDate = customers.filter((c) => c.daysSinceLastOrder === null).length;

  const recipientTotals = { sent: 0, failed: 0, skipped: 0, queued: 0 };
  for (const campaign of campaigns) for (const k of Object.keys(recipientTotals)) recipientTotals[k] += campaign.counts?.[k] || 0;
  const byStatus = campaigns.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }), {});
  const atRisk = customers.filter((c) => c.status === "at_risk");

  return {
    generatedAt: new Date().toISOString(),
    customers: {
      total: customers.length,
      active: customers.filter((c) => c.status === "active").length,
      cooling: customers.filter((c) => c.status === "cooling").length,
      atRisk: atRisk.length,
      unknownRecency: noDate,
      consenting: customers.filter((c) => c.consent).length,
      emailable: customers.filter((c) => c.emailable).length,
      definitions: { active: "ordered in the last 30 days", cooling: "last order 31–60 days ago", atRisk: "no order in 60+ days" },
    },
    risk: {
      scored: scored.length,
      high: scored.filter((c) => c.risk.level === "HIGH").length,
      medium: scored.filter((c) => c.risk.level === "MEDIUM").length,
      low: scored.filter((c) => c.risk.level === "LOW").length,
      stale: customers.filter((c) => c.risk?.stale).length,
      unscored: customers.length - scored.length,
    },
    revenue: {
      lifetimeSpend: customers.reduce((s, c) => s + c.totalSpent, 0),
      openCartValue: customers.reduce((s, c) => s + c.cartValue, 0),
      atRiskValueEstimate: Math.round(atRisk.reduce((s, c) => s + c.averageOrderValue, 0)),
      atRiskValueRule: "Estimate: one average order for each customer with no order in 60+ days. Not a forecast.",
      recovered: null,
      recoveredNote: "Recovered revenue is not tracked: RecallIQ does not receive order data after a campaign.",
    },
    recency: buckets,
    campaigns: {
      total: campaigns.length,
      byStatus,
      recipients: recipientTotals,
      opensClicks: null,
      opensClicksNote: "Opens and clicks are not tracked. Gmail API only confirms that a message was accepted for sending.",
      recent: campaigns
        .filter((c) => c.status !== "draft")
        .sort((a, b) => String(b.launchedAt || b.createdAt).localeCompare(String(a.launchedAt || a.createdAt)))
        .slice(0, 8)
        .map((c) => ({ id: c.id, name: c.name, status: c.status, launchedAt: c.launchedAt, counts: c.counts })),
    },
  };
}
