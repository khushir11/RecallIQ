// RecallIQ dashboard application. Every number on screen comes from the backend API.
(function () {
  const { api, session, esc, inr, num, date, dateTime, toast, withBusy } = window.RIQ;
  if (!session.get()?.token) { location.replace("login.html"); return; }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const view = $("#view");
  const state = {
    user: session.get().user,
    gmail: null,
    ml: null,
    health: null,
    customersQuery: { page: 1, limit: 25, sort: "createdAt", order: "desc", search: "", consent: "", status: "", risk: "", channel: "" },
    selectedCustomers: new Set(),
    segmentKey: null,
    placeholders: {},
    poll: null,
  };
  const CHANNELS = ["Email", "SMS", "WhatsApp", "App Push", "Phone"];
  const STATUS_LABEL = { draft: "Draft", sending: "Sending", paused: "Paused", completed: "Completed", cancelled: "Cancelled", queued: "Queued", sent: "Sent", failed: "Failed", skipped: "Skipped", active: "Active", cooling: "Cooling", at_risk: "At risk", unknown: "No order date" };
  const badge = (status, label) => `<span class="badge ${esc(status)}">${esc(label || STATUS_LABEL[status] || status)}</span>`;
  const riskBadge = (risk) => (risk ? `${badge(risk.level.toLowerCase(), `${risk.level} · ${Math.round(risk.probability * 100)}%`)}${risk.stale ? ' <span class="chip" title="Customer data changed since scoring">stale</span>' : ""}` : badge("unscored", "Not scored"));
  const errorBox = (error) => `<div class="notice error">${esc(error.message || error)}</div>`;

  // ================================================================ modal + confirm
  const modal = $("#modal");
  function openModal({ title, body, foot = "", wide = false }) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = body;
    $("#modalFoot").innerHTML = foot;
    $("#modalFoot").hidden = !foot;
    modal.classList.toggle("wide", wide);
    if (!modal.open) modal.showModal();
    return modal;
  }
  function closeModal() { if (modal.open) modal.close(); }
  modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest("[data-close]")) closeModal(); });
  modal.addEventListener("close", () => {
    stopPoll();
    $("#modalBody").innerHTML = "";
    if (route().name === "campaigns") renderCampaignsList();
  });

  function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
    const dlg = $("#confirm");
    $("#confirmTitle").textContent = title;
    $("#confirmBody").innerHTML = message;
    const ok = $("#confirmOk");
    ok.textContent = confirmLabel;
    ok.className = `btn ${danger ? "btn-danger" : "btn-dark"}`;
    dlg.showModal();
    ok.focus();
    return new Promise((resolve) => {
      const done = (value) => { dlg.close(); ok.onclick = null; $("#confirmCancel").onclick = null; resolve(value); };
      ok.onclick = () => done(true);
      $("#confirmCancel").onclick = () => done(false);
      dlg.oncancel = () => done(false);
    });
  }

  function stopPoll() { if (state.poll) { clearInterval(state.poll); state.poll = null; } }

  // ================================================================ shell
  $("#userName").textContent = state.user?.name || "";
  $("#userEmail").textContent = state.user?.email || "";
  $("#logoutBtn").addEventListener("click", async () => {
    try { await api.post("/auth/logout"); } catch { /* session may already be gone */ }
    session.clear();
    location.replace("login.html?loggedout=1");
  });
  const sidebar = $("#sidebar");
  $("#menuBtn").addEventListener("click", () => { const open = sidebar.classList.toggle("open"); $("#menuBtn").setAttribute("aria-expanded", String(open)); });

  async function refreshStatus() {
    const set = (id, ok, label) => { const el = $(id); el.classList.toggle("ok", ok === true); el.classList.toggle("bad", ok === false); el.textContent = label; };
    const [health, gmail, ml] = await Promise.allSettled([api.get("/health"), api.get("/gmail/status"), api.get("/health/ml")]);
    state.health = health.value || null;
    state.gmail = gmail.value || null;
    state.ml = ml.value || null;
    set("#dotBackend", health.status === "fulfilled", health.status === "fulfilled" ? `Backend · ${health.value.storage}` : "Backend offline");
    set("#dotGmail", state.gmail ? state.gmail.connected : false, state.gmail?.connected ? `Gmail · ${state.gmail.email || "connected"}` : state.gmail?.needsReconnect ? "Gmail · reconnect" : "Gmail · not connected");
    set("#dotMl", state.ml ? state.ml.reachable : false, state.ml?.reachable ? `ML · ${state.ml.provenance}` : "ML offline");
  }

  // ================================================================ router
  const routes = { dashboard: renderDashboard, customers: renderCustomers, segments: renderSegments, campaigns: renderCampaigns, risk: renderRisk, settings: renderSettings };
  function route() {
    const [name, query] = location.hash.slice(1).split("?");
    return { name: routes[name] ? name : "dashboard", params: new URLSearchParams(query || "") };
  }
  async function render() {
    stopPoll();
    sidebar.classList.remove("open");
    const { name, params } = route();
    $$(".nav a").forEach((a) => (a.dataset.view === name ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    view.innerHTML = '<div class="loading"><span class="spinner"></span> Loading…</div>';
    try {
      await routes[name](params);
    } catch (error) {
      view.innerHTML = `<div class="page-head"><h1>Something went wrong</h1></div>${errorBox(error)}<p><button class="btn" onclick="location.reload()">Retry</button></p>`;
    }
    view.focus({ preventScroll: true });
  }
  window.addEventListener("hashchange", render);

  // ================================================================ dashboard
  async function renderDashboard() {
    const a = await api.get("/analytics");
    const r = a.campaigns.recipients;
    const attempted = r.sent + r.failed;
    const maxBucket = Math.max(1, ...a.recency.map((b) => b.customers));
    const onboarding = [];
    if (!a.customers.total) onboarding.push(`<li><a href="#customers">Add or import customers</a> to unlock segments and risk scoring.</li>`);
    if (!state.gmail?.connected) onboarding.push(`<li><a href="#settings">Connect Gmail</a> and send a test email before launching campaigns.</li>`);
    if (a.customers.total && !a.risk.scored) onboarding.push(`<li><a href="#risk">Score churn risk</a> for your customers with the ML service.</li>`);

    view.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Overview</p><h1>Dashboard</h1><p>Live figures from your customer and campaign records. Updated ${esc(dateTime(a.generatedAt))}.</p></div>
        <div class="actions"><a class="btn" href="#segments">View recommendations</a><a class="btn btn-primary" href="#campaigns?new=1">New campaign</a></div>
      </div>
      ${onboarding.length ? `<div class="notice warn"><strong>Getting started</strong><ul class="clean">${onboarding.join("")}</ul></div><br>` : ""}
      <div class="kpis">
        <div class="kpi accent"><span>Total customers</span><strong>${num(a.customers.total)}</strong><small>${num(a.customers.emailable)} emailable (consent + valid address)</small></div>
        <div class="kpi"><span>Active</span><strong>${num(a.customers.active)}</strong><small>${esc(a.customers.definitions.active)}</small></div>
        <div class="kpi"><span>At risk</span><strong>${num(a.customers.atRisk)}</strong><small>${esc(a.customers.definitions.atRisk)}</small></div>
        <div class="kpi"><span>High churn risk (model)</span><strong>${num(a.risk.high)}</strong><small>${a.risk.scored ? `of ${num(a.risk.scored)} scored` : "no customers scored yet"}${a.risk.stale ? ` · ${a.risk.stale} stale` : ""}</small></div>
        <div class="kpi"><span>Campaigns</span><strong>${num(a.campaigns.total)}</strong><small>${Object.entries(a.campaigns.byStatus).map(([k, v]) => `${v} ${STATUS_LABEL[k] || k}`).join(" · ") || "none yet"}</small></div>
        <div class="kpi"><span>Emails sent</span><strong>${num(r.sent)}</strong><small>accepted by Gmail API</small></div>
        <div class="kpi"><span>Failed</span><strong>${num(r.failed)}</strong><small>${attempted ? `${Math.round((r.failed / attempted) * 100)}% of attempts` : "no attempts yet"}</small></div>
        <div class="kpi"><span>Skipped</span><strong>${num(r.skipped)}</strong><small>not eligible (consent, email, duplicates)</small></div>
      </div>

      <div class="grid grid-2">
        <section class="card">
          <div class="card-head"><div><h2>Customers by days since last order</h2><p class="muted small" style="margin:0">Retention view: how recently each customer bought.</p></div></div>
          ${a.customers.total ? `<div class="bars" role="list">
            ${a.recency.map((b) => `<div class="bar-row" role="listitem" title="${esc(b.label)}: ${b.customers} customers, lifetime spend ${esc(inr(b.lifetimeSpend))}">
              <span>${esc(b.label)}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${(b.customers / maxBucket) * 100}%"></div></div>
              <span class="num">${num(b.customers)}</span></div>`).join("")}
          </div>
          ${a.customers.unknownRecency ? `<p class="muted small" style="margin:10px 0 0">${a.customers.unknownRecency} customer(s) have no last order date.</p>` : ""}` : `<div class="empty"><strong>No customers yet</strong>Import customers to see retention insights.<br><a class="btn" href="#customers">Go to customers</a></div>`}
        </section>

        <section class="card">
          <div class="card-head"><div><h2>Recipient outcomes</h2><p class="muted small" style="margin:0">Across all launched campaigns.</p></div></div>
          ${r.sent + r.failed + r.skipped + r.queued ? `
            <div class="progress" role="img" aria-label="Sent ${r.sent}, failed ${r.failed}, queued ${r.queued}, skipped ${r.skipped}">
              ${["sent", "failed", "queued", "skipped"].map((k) => (r[k] ? `<span class="${k}" style="flex:${r[k]}" title="${STATUS_LABEL[k]}: ${r[k]}"></span>` : "")).join("")}
            </div>
            <div class="legend">${["sent", "failed", "queued", "skipped"].map((k) => `<span><i style="background:var(--st-${k})"></i>${STATUS_LABEL[k]} <strong>${num(r[k])}</strong></span>`).join("")}</div>
          ` : `<div class="empty"><strong>No campaigns launched yet</strong>Results appear here once a campaign is sent.</div>`}
          <div class="notice" style="margin-top:14px">${esc(a.campaigns.opensClicksNote)}</div>
        </section>
      </div>
      <br>
      <div class="grid grid-3">
        <div class="kpi"><span>Lifetime spend (all customers)</span><strong>${inr(a.revenue.lifetimeSpend)}</strong><small>sum of recorded totals</small></div>
        <div class="kpi"><span>Value at risk (estimate)</span><strong>${inr(a.revenue.atRiskValueEstimate)}</strong><small>${esc(a.revenue.atRiskValueRule)}</small></div>
        <div class="kpi"><span>Open cart value</span><strong>${inr(a.revenue.openCartValue)}</strong><small>${esc(a.revenue.recoveredNote)}</small></div>
      </div>
      <br>
      <section class="card">
        <div class="card-head"><h2>Recent campaign performance</h2><a class="btn btn-sm" href="#campaigns">All campaigns</a></div>
        ${a.campaigns.recent.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Campaign</th><th>Status</th><th>Launched</th><th class="num">Sent</th><th class="num">Failed</th><th class="num">Skipped</th><th class="num">Queued</th></tr></thead>
          <tbody>${a.campaigns.recent.map((c) => `<tr class="clickable" data-campaign="${esc(c.id)}"><td><strong>${esc(c.name)}</strong></td><td>${badge(c.status)}</td><td>${esc(dateTime(c.launchedAt))}</td>
            <td class="num">${num(c.counts?.sent)}</td><td class="num">${num(c.counts?.failed)}</td><td class="num">${num(c.counts?.skipped)}</td><td class="num">${num(c.counts?.queued)}</td></tr>`).join("")}</tbody>
        </table></div>` : `<div class="empty"><strong>No launched campaigns</strong>Create one from an AI recommendation.<br><a class="btn btn-primary" href="#segments">See recommendations</a></div>`}
      </section>`;
    $$("[data-campaign]", view).forEach((row) => row.addEventListener("click", () => openCampaign(row.dataset.campaign)));
  }

  // ================================================================ customers
  async function renderCustomers(params) {
    if (params.get("risk")) state.customersQuery.risk = params.get("risk");
    view.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Data</p><h1>Customers</h1><p>Every record belongs to your account only. Email campaigns go only to customers with marketing consent and a valid address.</p></div>
        <div class="actions">
          <button class="btn" id="importBtn" type="button">Import CSV</button>
          <button class="btn" id="exportBtn" type="button">Export CSV</button>
          <button class="btn btn-primary" id="addBtn" type="button">Add customer</button>
        </div>
      </div>
      <section class="card">
        <div class="toolbar" role="search">
          <label class="sr-only" for="cSearch">Search customers</label>
          <input type="search" id="cSearch" placeholder="Search name, email, phone…" value="${esc(state.customersQuery.search)}" />
          <select id="cConsent" aria-label="Filter by consent"><option value="">All consent</option><option value="yes">Consented</option><option value="no">No consent</option></select>
          <select id="cStatus" aria-label="Filter by activity"><option value="">All activity</option><option value="active">Active (≤30d)</option><option value="cooling">Cooling (31–60d)</option><option value="at_risk">At risk (60d+)</option><option value="unknown">No order date</option></select>
          <select id="cRisk" aria-label="Filter by churn risk"><option value="">All risk</option><option value="HIGH">High risk</option><option value="MEDIUM">Medium risk</option><option value="LOW">Low risk</option><option value="unscored">Not scored</option></select>
          <select id="cChannel" aria-label="Filter by preferred channel"><option value="">All channels</option>${CHANNELS.map((c) => `<option>${c}</option>`).join("")}</select>
          <button class="btn btn-danger btn-sm" id="bulkDelete" type="button" hidden>Delete selected</button>
        </div>
        <div id="customerTable"><div class="loading"><span class="spinner"></span></div></div>
      </section>`;
    const q = state.customersQuery;
    $("#cConsent").value = q.consent; $("#cStatus").value = q.status; $("#cRisk").value = q.risk; $("#cChannel").value = q.channel;
    let timer;
    $("#cSearch").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => { q.search = e.target.value; q.page = 1; loadCustomerTable(); }, 250); });
    [["#cConsent", "consent"], ["#cStatus", "status"], ["#cRisk", "risk"], ["#cChannel", "channel"]].forEach(([sel, key]) => $(sel).addEventListener("change", (e) => { q[key] = e.target.value; q.page = 1; loadCustomerTable(); }));
    $("#addBtn").addEventListener("click", () => openCustomerForm());
    $("#importBtn").addEventListener("click", openImport);
    $("#exportBtn").addEventListener("click", (e) => withBusy(e.currentTarget, exportCsv, "Exporting…"));
    $("#bulkDelete").addEventListener("click", bulkDelete);
    await loadCustomerTable();
  }

  async function loadCustomerTable() {
    const host = $("#customerTable");
    if (!host) return;
    const q = state.customersQuery;
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== "" && v !== null)).toString();
    let data;
    try { data = await api.get(`/customers?${qs}`); } catch (error) { host.innerHTML = errorBox(error); return; }
    state.selectedCustomers.clear();
    updateBulk();
    const filtered = q.search || q.consent || q.status || q.risk || q.channel;
    if (!data.total) {
      host.innerHTML = filtered
        ? `<div class="empty"><strong>No customers match these filters</strong><button class="btn" id="clearFilters">Clear filters</button></div>`
        : `<div class="empty"><strong>No customers yet</strong>Import a CSV or add your first customer.<br><button class="btn btn-primary" id="emptyImport">Import CSV</button></div>`;
      $("#clearFilters")?.addEventListener("click", () => { Object.assign(q, { search: "", consent: "", status: "", risk: "", channel: "", page: 1 }); renderCustomers(new URLSearchParams()); });
      $("#emptyImport")?.addEventListener("click", openImport);
      return;
    }
    const sortTh = (key, label, cls = "") => `<th class="${cls}" aria-sort="${q.sort === key ? (q.order === "asc" ? "ascending" : "descending") : "none"}"><button data-sort="${key}">${label}${q.sort === key ? (q.order === "asc" ? " ▲" : " ▼") : ""}</button></th>`;
    const pages = Math.max(1, Math.ceil(data.total / data.limit));
    host.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th><input type="checkbox" id="selAll" aria-label="Select all on this page" /></th>
          ${sortTh("name", "Customer")}${sortTh("lastOrderDate", "Last order")}${sortTh("orderCount", "Orders", "num")}${sortTh("totalSpent", "Spent", "num")}${sortTh("cartValue", "Cart", "num")}
          ${sortTh("engagementScore", "Engagement", "num")}<th>Channel</th><th>Consent</th>${sortTh("risk", "Churn risk")}
        </tr></thead>
        <tbody>${data.items.map((c) => `
          <tr class="clickable" data-id="${esc(c.id)}">
            <td><input type="checkbox" class="sel" value="${esc(c.id)}" aria-label="Select ${esc(c.name)}" /></td>
            <td><strong>${esc(c.name)}</strong><span class="sub">${c.email ? esc(c.email) : "<em>no email</em>"}${c.email && !c.emailValid ? " · invalid" : ""}</span></td>
            <td>${esc(date(c.lastOrderDate))}<span class="sub">${c.daysSinceLastOrder === null ? "" : `${c.daysSinceLastOrder} days ago · `}${badge(c.status)}</span></td>
            <td class="num">${num(c.orderCount)}</td><td class="num">${inr(c.totalSpent)}</td><td class="num">${c.cartValue ? inr(c.cartValue) : "—"}</td>
            <td class="num">${c.engagementScore ?? "—"}</td><td>${esc(c.preferredChannel)}</td>
            <td>${c.consent ? badge("yes", "Yes") : badge("no", "No")}</td><td>${riskBadge(c.risk)}</td>
          </tr>`).join("")}
        </tbody></table></div>
      <div class="pager"><span>${num(data.total)} customer(s) · page ${data.page} of ${pages}</span>
        <span class="actions"><button class="btn btn-sm" id="prevPage" ${data.page <= 1 ? "disabled" : ""}>Previous</button><button class="btn btn-sm" id="nextPage" ${data.page >= pages ? "disabled" : ""}>Next</button></span></div>`;
    $$("[data-sort]", host).forEach((b) => b.addEventListener("click", () => {
      q.order = q.sort === b.dataset.sort && q.order === "desc" ? "asc" : "desc";
      q.sort = b.dataset.sort;
      loadCustomerTable();
    }));
    $("#prevPage").addEventListener("click", () => { q.page -= 1; loadCustomerTable(); });
    $("#nextPage").addEventListener("click", () => { q.page += 1; loadCustomerTable(); });
    $$("tr[data-id]", host).forEach((row) => row.addEventListener("click", (e) => { if (!e.target.closest("input")) openCustomer(row.dataset.id); }));
    $$(".sel", host).forEach((cb) => cb.addEventListener("change", () => { cb.checked ? state.selectedCustomers.add(cb.value) : state.selectedCustomers.delete(cb.value); updateBulk(); }));
    $("#selAll").addEventListener("change", (e) => { $$(".sel", host).forEach((cb) => { cb.checked = e.target.checked; cb.dispatchEvent(new Event("change")); }); });
  }

  function updateBulk() {
    const btn = $("#bulkDelete");
    if (!btn) return;
    btn.hidden = !state.selectedCustomers.size;
    btn.textContent = `Delete selected (${state.selectedCustomers.size})`;
  }

  async function bulkDelete() {
    const ids = [...state.selectedCustomers];
    if (!(await confirmDialog({ title: "Delete customers?", message: `<p>Permanently delete <strong>${ids.length}</strong> customer(s)? Campaign history keeps their past send results.</p>`, confirmLabel: "Delete", danger: true }))) return;
    try {
      const r = await api.post("/customers/bulk-delete", { ids });
      toast(`${r.deleted} customer(s) deleted.`);
      loadCustomerTable();
    } catch (error) { toast(error.message, "error"); }
  }

  async function exportCsv() {
    try {
      const response = await api.raw("/customers/export.csv");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: `recalliq-customers-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("CSV downloaded.");
    } catch (error) { toast(error.message, "error"); }
  }

  const SAMPLE_CSV = `name,email,phone,lastOrderDate,totalSpent,orderCount,cartValue,birthday,preferredChannel,consent,engagementScore,supportTickets
Aarav Mehta,aarav@example.com,+919900000001,2026-08-01,18400,8,0,1998-06-20,Email,true,32,1
Mira Shah,mira@example.com,+919900000002,2026-11-04,6200,3,2600,1999-11-25,Email,true,70,0
Kabir Rao,kabir@example.com,+919900000003,2026-07-18,58200,19,0,1995-07-02,Email,true,45,2
Naina Kapoor,naina@example.com,+919900000004,2026-10-21,9200,4,1800,2000-06-18,SMS,true,60,0
Dev Iyer,dev@example.com,+919900000005,2026-09-08,21600,7,0,1997-09-05,Email,false,40,1`;

  function openImport() {
    openModal({
      title: "Import customers from CSV",
      wide: true,
      body: `
        <p class="muted">Columns: <span class="mono">name</span> (required), <span class="mono">email, phone, lastOrderDate, totalSpent, orderCount, cartValue, birthday, preferredChannel, consent, engagementScore, supportTickets, notes</span>.
        Dates as YYYY-MM-DD or DD/MM/YYYY. Consent: true/yes/1. Rows with an existing email update that customer instead of creating a duplicate.</p>
        <div class="toolbar">
          <label class="btn" for="csvFile">Choose CSV file</label>
          <input type="file" id="csvFile" accept=".csv,text/csv" class="sr-only" />
          <button class="btn btn-sm" type="button" id="sampleCsv">Paste example rows</button>
          <label class="check"><input type="checkbox" id="skipExisting" /> Do not update existing customers</label>
        </div>
        <label class="field">CSV content<textarea id="csvText" spellcheck="false" style="min-height:220px" class="mono" placeholder="name,email,lastOrderDate,totalSpent,…"></textarea></label>
        <div id="importResult"></div>
        <p class="muted small">The example rows use <span class="mono">example.com</span> addresses, which cannot receive mail. Use real, consenting recipients for live sends.</p>`,
      foot: `<button class="btn" data-close>Close</button><button class="btn btn-primary" id="doImport">Import</button>`,
    });
    $("#csvFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2_500_000) { toast("File is larger than 2.5 MB. Split it into smaller files.", "error"); return; }
      $("#csvText").value = await file.text();
    });
    $("#sampleCsv").addEventListener("click", () => { $("#csvText").value = SAMPLE_CSV; });
    $("#doImport").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
      const csv = $("#csvText").value;
      if (!csv.trim()) { toast("Paste CSV content or choose a file first.", "warn"); return; }
      try {
        const r = await api.post("/customers/import", { csv, mode: $("#skipExisting").checked ? "skip-existing" : "merge" });
        $("#importResult").innerHTML = `<div class="notice ${r.errors.length ? "warn" : "ok"}"><strong>${r.created} created, ${r.updated} updated, ${r.skipped} skipped.</strong>
          ${r.errors.length ? `<ul class="clean">${r.errors.slice(0, 15).map((er) => `<li>Row ${er.row}: ${esc(er.message)}</li>`).join("")}${r.errors.length > 15 ? `<li>…and ${r.errors.length - 15} more</li>` : ""}</ul>` : ""}</div>`;
        toast(`Import finished: ${r.created} created, ${r.updated} updated.`);
        loadCustomerTable();
      } catch (error) { $("#importResult").innerHTML = errorBox(error); }
    }, "Importing…"));
  }

  function customerFormHtml(c = {}) {
    const v = (k) => esc(c[k] ?? "");
    return `<form id="customerForm" class="form-grid" novalidate>
      <label class="field">Name *<input type="text" name="name" required maxlength="120" value="${v("name")}" /></label>
      <label class="field">Email<input type="email" name="email" value="${v("email")}" /></label>
      <label class="field">Phone<input type="text" name="phone" value="${v("phone")}" /></label>
      <label class="field">Preferred channel<select name="preferredChannel">${CHANNELS.map((ch) => `<option ${c.preferredChannel === ch ? "selected" : ""}>${ch}</option>`).join("")}</select></label>
      <label class="field">Last order date<input type="date" name="lastOrderDate" max="${new Date().toISOString().slice(0, 10)}" value="${v("lastOrderDate")}" /></label>
      <label class="field">Birthday<input type="date" name="birthday" value="${v("birthday")}" /></label>
      <label class="field">Total spent (₹)<input type="number" name="totalSpent" min="0" step="1" value="${v("totalSpent")}" /></label>
      <label class="field">Order count<input type="number" name="orderCount" min="0" step="1" value="${v("orderCount")}" /></label>
      <label class="field">Cart value (₹)<input type="number" name="cartValue" min="0" step="1" value="${v("cartValue")}" /></label>
      <label class="field">Engagement score <small>0–100, e.g. from email/app activity</small><input type="number" name="engagementScore" min="0" max="100" step="1" value="${v("engagementScore")}" /></label>
      <label class="field">Support tickets<input type="number" name="supportTickets" min="0" step="1" value="${v("supportTickets")}" /></label>
      <div class="field" style="align-self:end"><label class="check"><input type="checkbox" name="consent" ${c.consent ? "checked" : ""} /> Has given marketing consent</label></div>
      <label class="field full">Notes<textarea name="notes" maxlength="1000" style="min-height:70px">${v("notes")}</textarea></label>
      <div class="full" id="formError"></div>
    </form>`;
  }

  function readCustomerForm() {
    const form = $("#customerForm");
    const data = Object.fromEntries(new FormData(form).entries());
    data.consent = form.consent.checked;
    if (!data.name.trim()) throw new Error("Name is required.");
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) throw new Error("Enter a valid email address or leave it blank.");
    return data;
  }

  function openCustomerForm(existing = null) {
    openModal({
      title: existing ? `Edit ${existing.name}` : "Add customer",
      body: customerFormHtml(existing || { preferredChannel: "Email", consent: false }),
      foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="saveCustomer">${existing ? "Save changes" : "Add customer"}</button>`,
    });
    $("#saveCustomer").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
      try {
        const data = readCustomerForm();
        const saved = existing ? await api.patch(`/customers/${existing.id}`, data) : await api.post("/customers", data);
        toast(existing ? "Customer updated." : `${saved.name} added.`);
        if (existing) openCustomer(saved.id); else closeModal();
        loadCustomerTable();
      } catch (error) { $("#formError").innerHTML = errorBox(error); }
    }, "Saving…"));
  }

  function riskPanel(risk) {
    if (!risk) return `<p class="muted">Not scored yet.</p>`;
    const maxImpact = Math.max(0.01, ...[...risk.drivers, ...risk.protective].map((d) => Math.abs(d.impact)));
    return `
      <div class="risk-meter"><strong>${Math.round(risk.probability * 100)}%</strong><span>${badge(risk.level.toLowerCase(), `${risk.level} risk`)}</span>${risk.stale ? '<span class="chip">Data changed since scoring — rescore</span>' : ""}</div>
      <p class="muted small">Scored ${esc(dateTime(risk.scoredAt))} by the ${esc(risk.model)} model.</p>
      ${risk.reasons?.length ? `<h3>Why</h3><ul class="clean">${risk.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${risk.drivers.length || risk.protective.length ? `<h3 style="margin-top:12px">Model factors</h3>
        ${risk.drivers.map((d) => `<div class="driver"><span>${esc(d.label)} <span class="muted">(${esc(num(d.value))})</span> raises risk</span><div class="driver-bar"><span class="up" style="width:${(Math.abs(d.impact) / maxImpact) * 100}%"></span></div></div>`).join("")}
        ${risk.protective.map((d) => `<div class="driver"><span>${esc(d.label)} <span class="muted">(${esc(num(d.value))})</span> lowers risk</span><div class="driver-bar"><span class="down" style="width:${(Math.abs(d.impact) / maxImpact) * 100}%"></span></div></div>`).join("")}` : ""}
      <div class="stat-row">
        <div><span>Next best action</span><strong style="font-size:0.95rem">${esc(risk.action)}</strong></div>
        <div><span>Channel</span><strong style="font-size:0.95rem">${esc(risk.channel || "Do not contact")}</strong></div>
        <div><span>Suggested offer</span><strong style="font-size:0.95rem">${esc(risk.offer)}</strong></div>
      </div>
      <p class="small muted">${esc(risk.channelNote)}</p>
      ${risk.assumptions?.length ? `<div class="notice warn small">${risk.assumptions.map(esc).join("<br>")}</div>` : ""}`;
  }

  async function openCustomer(id) {
    openModal({ title: "Customer", body: '<div class="loading"><span class="spinner"></span></div>', wide: true });
    let c;
    try { c = await api.get(`/customers/${id}`); } catch (error) { $("#modalBody").innerHTML = errorBox(error); return; }
    openModal({
      title: c.name,
      wide: true,
      body: `
        <div class="grid grid-2">
          <div>
            <div class="stat-row">
              <div><span>Last order</span><strong>${esc(date(c.lastOrderDate))}</strong></div>
              <div><span>Orders</span><strong>${num(c.orderCount)}</strong></div>
              <div><span>Total spent</span><strong>${inr(c.totalSpent)}</strong></div>
              <div><span>Avg. order</span><strong>${inr(c.averageOrderValue)}</strong></div>
              <div><span>Cart</span><strong>${inr(c.cartValue)}</strong></div>
              <div><span>Engagement</span><strong>${c.engagementScore ?? "—"}</strong></div>
            </div>
            <p><strong>Email:</strong> ${c.email ? esc(c.email) : "—"} ${c.email ? (c.emailValid ? "" : badge("failed", "invalid")) : ""}<br>
              <strong>Phone:</strong> ${esc(c.phone || "—")}<br>
              <strong>Preferred channel:</strong> ${esc(c.preferredChannel)}<br>
              <strong>Marketing consent:</strong> ${c.consent ? badge("yes", "Yes") : badge("no", "No")} <span class="muted small">updated ${esc(dateTime(c.consentUpdatedAt))}</span><br>
              <strong>Birthday:</strong> ${esc(date(c.birthday))}<br>
              <strong>Support tickets:</strong> ${num(c.supportTickets)}</p>
            ${c.notes ? `<p class="notice small">${esc(c.notes)}</p>` : ""}
            <h3 style="margin-top:16px">Email history</h3>
            ${c.history.length ? `<div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>When</th></tr></thead><tbody>
              ${c.history.map((h) => `<tr><td>${esc(h.campaignName)}${h.reason ? `<span class="sub">${esc(h.reason)}</span>` : ""}</td><td>${badge(h.status)}</td><td>${esc(dateTime(h.at))}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No campaign has included this customer yet.</p>`}
          </div>
          <div class="card" style="box-shadow:none">
            <div class="card-head"><h3>Churn risk</h3><button class="btn btn-sm" id="scoreOne" ${c.lastOrderDate ? "" : "disabled title=\"Add a last order date first\""}>${c.risk ? "Rescore" : "Score now"}</button></div>
            <div id="riskBox">${riskPanel(c.risk)}</div>
          </div>
        </div>`,
      foot: `<button class="btn btn-danger" id="delCustomer">Delete</button><span style="flex:1"></span><button class="btn" data-close>Close</button><button class="btn btn-dark" id="editCustomer">Edit</button>`,
    });
    $("#editCustomer").addEventListener("click", () => openCustomerForm(c));
    $("#delCustomer").addEventListener("click", async () => {
      if (!(await confirmDialog({ title: `Delete ${c.name}?`, message: "<p>This permanently removes the customer. Past campaign results are kept.</p>", confirmLabel: "Delete", danger: true }))) return;
      try { await api.del(`/customers/${c.id}`); toast("Customer deleted."); closeModal(); loadCustomerTable(); } catch (error) { toast(error.message, "error"); }
    });
    $("#scoreOne").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
      try { const r = await api.post("/risk/predict", { customerId: c.id }); $("#riskBox").innerHTML = riskPanel(r.risk); loadCustomerTable(); } catch (error) { $("#riskBox").innerHTML = errorBox(error) + riskPanel(c.risk); }
    }, "Scoring…"));
  }

  // ================================================================ segments / AI recommendations
  async function renderSegments() {
    const { segments, placeholders } = await api.get("/segments");
    state.placeholders = placeholders;
    if (!state.segmentKey || !segments.find((s) => s.key === state.segmentKey)) state.segmentKey = (segments.find((s) => s.reachable) || segments[0]).key;
    const total = segments.reduce((s, x) => s + x.size, 0);
    view.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">AI recommendation engine</p><h1>Who needs attention</h1><p>Segments are calculated from your customer records using the rules shown. Pick one, review the suggested message, then approve it as a campaign draft. Nothing is sent until you launch.</p></div>
        <div class="actions"><a class="btn" href="#risk">Score churn risk</a></div>
      </div>
      ${!total ? `<div class="notice warn">No customers match any segment yet. <a href="#customers">Add or import customers</a> with last order dates, spend and cart values.</div><br>` : ""}
      <div class="grid" style="grid-template-columns:minmax(240px,320px) 1fr">
        <div class="segment-list" role="group" aria-label="Segments">
          ${segments.map((s) => `<button class="segment-btn" type="button" data-key="${s.key}" aria-pressed="${s.key === state.segmentKey}">
            <span class="row"><strong><span class="priority ${s.priority}" aria-hidden="true"></span>${esc(s.label)}</strong><span class="chip ${s.reachable ? "mint" : ""}">${s.size}</span></span>
            <small>${esc(s.rule)}</small><small>${s.reachable} reachable by email</small></button>`).join("")}
        </div>
        <section class="card" id="segmentDetail"></section>
      </div>`;
    const show = (key) => {
      state.segmentKey = key;
      $$(".segment-btn", view).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === key)));
      const s = segments.find((x) => x.key === key);
      $("#segmentDetail").innerHTML = `
        <div class="card-head"><div><p class="eyebrow">${esc(s.priority)} priority</p><h2>${esc(s.label)}</h2><p class="muted" style="margin:0">Rule: ${esc(s.rule)}</p></div>
          <button class="btn btn-primary" id="approveSegment" ${s.reachable ? "" : "disabled"}>Create campaign draft</button></div>
        <div class="stat-row">
          <div><span>Matching customers</span><strong>${num(s.size)}</strong></div>
          <div><span>Reachable by email</span><strong>${num(s.reachable)}</strong></div>
          <div><span>Excluded: no consent</span><strong>${num(s.excluded.noConsent)}</strong></div>
          <div><span>Excluded: bad/no email</span><strong>${num(s.excluded.invalidEmail)}</strong></div>
          <div><span>Value at stake</span><strong>${inr(s.valueAtStake)}</strong></div>
          <div><span>Avg. churn risk</span><strong>${s.averageRisk === null ? "—" : `${Math.round(s.averageRisk * 100)}%`}</strong></div>
        </div>
        <p class="small muted">${esc(s.valueRule)} ${s.averageRisk === null ? "No customers in this segment have a current risk score." : `Based on ${s.scoredCount} scored customer(s).`}</p>
        <div class="grid grid-2">
          <div>
            <h3>Recommended channel</h3>
            <p>${s.recommendedChannel ? `<strong>${esc(s.recommendedChannel)}</strong> — ` : ""}${esc(s.channelNote)}</p>
            ${Object.keys(s.channelPreferences).length ? `<p class="small muted">Stated preferences: ${Object.entries(s.channelPreferences).map(([k, v]) => `${esc(k)} ${v}`).join(" · ")}</p>` : ""}
            <h3>Next best action</h3><p>${esc(s.recommendation.action)}</p>
            <h3>Suggested offer</h3><p>${esc(s.recommendation.offer)}</p>
            <h3>Customers</h3>
            ${s.preview.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Last order</th><th>Email</th></tr></thead><tbody>
              ${s.preview.map((c) => `<tr class="clickable" data-cust="${esc(c.id)}"><td>${esc(c.name)}${c.risk ? ` ${badge(c.risk.toLowerCase(), c.risk)}` : ""}</td><td>${c.daysSinceLastOrder === null ? "—" : `${c.daysSinceLastOrder}d ago`}</td><td>${c.emailable ? badge("sent", "reachable") : badge("skipped", "excluded")}</td></tr>`).join("")}
            </tbody></table></div>${s.size > s.preview.length ? `<p class="small muted">…and ${s.size - s.preview.length} more.</p>` : ""}` : `<p class="muted">No matching customers.</p>`}
          </div>
          <div>
            <h3>Personalised message</h3>
            <div class="email-preview"><header><strong>Subject:</strong> <span id="segSubject">…</span></header><div class="body" id="segBody"><span class="spinner"></span></div></div>
            <p class="small muted">Rendered for ${s.preview[0] ? esc(s.preview[0].name) : "a sample customer"}. Placeholders like {{firstName}} are filled per recipient.</p>
          </div>
        </div>`;
      api.post("/campaigns/preview", { subject: s.recommendation.subject, body: s.recommendation.body, offer: s.recommendation.offer, customerId: s.preview[0]?.id })
        .then((p) => { $("#segSubject").textContent = p.subject; $("#segBody").textContent = p.text; })
        .catch((error) => { $("#segBody").innerHTML = errorBox(error); });
      $$("[data-cust]").forEach((row) => row.addEventListener("click", () => openCustomer(row.dataset.cust)));
      $("#approveSegment").addEventListener("click", () => openCampaignEditor({
        name: `${s.label} – ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`,
        subject: s.recommendation.subject, body: s.recommendation.body, offer: s.recommendation.offer,
        segmentKey: s.key, segmentLabel: s.label, audienceIds: s.customerIds, source: "AI recommendation",
      }));
    };
    $$(".segment-btn", view).forEach((b) => b.addEventListener("click", () => show(b.dataset.key)));
    show(state.segmentKey);
  }

  // ================================================================ campaign editor
  async function openCampaignEditor(draft = {}) {
    const editing = Boolean(draft.id);
    openModal({ title: editing ? "Edit campaign draft" : "New campaign", body: '<div class="loading"><span class="spinner"></span></div>', wide: true });
    const [{ segments, placeholders }, customerList] = await Promise.all([api.get("/segments"), api.get("/customers?limit=500&sort=name&order=asc")]);
    state.placeholders = placeholders;
    const selected = new Set(draft.audienceIds || []);
    let mode = draft.segmentKey && draft.segmentKey !== "custom" ? draft.segmentKey : (selected.size ? "custom" : "");
    const byId = new Map(customerList.items.map((c) => [c.id, c]));

    openModal({
      title: editing ? "Edit campaign draft" : "New campaign",
      wide: true,
      body: `
        <div class="grid grid-2">
          <form id="campaignForm" novalidate style="display:grid;gap:12px">
            <label class="field">Campaign name *<input type="text" name="name" maxlength="120" required value="${esc(draft.name || "")}" /></label>
            <label class="field">Audience
              <select id="audienceMode">
                <option value="">Choose a segment…</option>
                ${segments.map((s) => `<option value="${s.key}" ${mode === s.key ? "selected" : ""}>${esc(s.label)} (${s.size}, ${s.reachable} reachable)</option>`).join("")}
                <option value="custom" ${mode === "custom" ? "selected" : ""}>Pick customers manually</option>
              </select>
            </label>
            <div id="manualPick" hidden>
              <input type="search" id="pickSearch" placeholder="Filter customers…" style="margin-bottom:6px" />
              <div id="pickList" style="max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 10px"></div>
              ${customerList.total > customerList.items.length ? `<p class="small muted">Showing first ${customerList.items.length} customers.</p>` : ""}
            </div>
            <p class="small" id="audienceSummary"></p>
            <label class="field">Subject *<input type="text" name="subject" maxlength="200" required value="${esc(draft.subject || "")}" /></label>
            <label class="field">Offer <small>inserted where you write {{offer}}</small><input type="text" name="offer" maxlength="200" value="${esc(draft.offer || "")}" /></label>
            <label class="field">Message *<textarea name="body" required style="min-height:200px">${esc(draft.body || "")}</textarea></label>
            <div><span class="small muted">Insert placeholder:</span><div class="placeholder-list">${Object.entries(placeholders).map(([k, d]) => `<button type="button" data-ph="${k}" title="${esc(d)}">{{${k}}}</button>`).join("")}</div></div>
            <p class="small muted">An unsubscribe note is added to every email automatically.</p>
            <div id="campaignError"></div>
          </form>
          <div>
            <div class="toolbar"><strong style="margin-right:auto">Preview</strong>
              <label class="sr-only" for="previewFor">Preview for customer</label><select id="previewFor" style="max-width:240px"></select></div>
            <div class="email-preview"><header><strong>Subject:</strong> <span id="pvSubject"></span></header><div class="body" id="pvBody"></div></div>
          </div>
        </div>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="saveCampaign">${editing ? "Save draft" : "Save as draft"}</button>`,
    });

    const form = $("#campaignForm");
    let lastField = form.body;
    ["subject", "offer", "body"].forEach((n) => form[n].addEventListener("focus", () => { lastField = form[n]; }));
    $$("[data-ph]").forEach((b) => b.addEventListener("click", () => {
      const f = lastField; const token = `{{${b.dataset.ph}}}`;
      const start = f.selectionStart ?? f.value.length;
      f.value = f.value.slice(0, start) + token + f.value.slice(f.selectionEnd ?? start);
      f.focus(); f.selectionStart = f.selectionEnd = start + token.length;
      schedulePreview();
    }));

    function renderPickList() {
      const q = $("#pickSearch").value.toLowerCase();
      $("#pickList").innerHTML = customerList.items.filter((c) => !q || `${c.name} ${c.email}`.toLowerCase().includes(q)).map((c) => `
        <label class="check" style="display:flex;padding:3px 0"><input type="checkbox" value="${esc(c.id)}" ${selected.has(c.id) ? "checked" : ""} />
        <span>${esc(c.name)} <span class="muted small">${esc(c.email || "no email")}${c.emailable ? "" : " · not emailable"}</span></span></label>`).join("") || '<p class="muted small">No customers.</p>';
      $$("#pickList input").forEach((cb) => cb.addEventListener("change", () => { cb.checked ? selected.add(cb.value) : selected.delete(cb.value); updateAudience(); }));
    }
    function updateAudience() {
      const members = [...selected].map((id) => byId.get(id)).filter(Boolean);
      const reachable = members.filter((c) => c.emailable).length;
      $("#audienceSummary").innerHTML = selected.size ? `<strong>${selected.size}</strong> customer(s) selected · <strong>${reachable}</strong> can be emailed now; the rest will be recorded as skipped with a reason.` : '<span class="muted">No audience selected yet.</span>';
      const options = members.slice(0, 50);
      const current = $("#previewFor").value;
      $("#previewFor").innerHTML = `<option value="">Sample customer</option>${options.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}`;
      if (options.some((c) => c.id === current)) $("#previewFor").value = current;
      else if (options[0]) $("#previewFor").value = options[0].id;
      schedulePreview();
    }
    $("#audienceMode").addEventListener("change", (e) => {
      mode = e.target.value;
      if (mode && mode !== "custom") { selected.clear(); segments.find((s) => s.key === mode).customerIds.forEach((id) => selected.add(id)); }
      $("#manualPick").hidden = mode !== "custom";
      if (mode === "custom") renderPickList();
      updateAudience();
    });
    $("#pickSearch").addEventListener("input", renderPickList);
    $("#manualPick").hidden = mode !== "custom";
    if (mode === "custom") renderPickList();

    let pvTimer;
    function schedulePreview() {
      clearTimeout(pvTimer);
      pvTimer = setTimeout(async () => {
        try {
          const p = await api.post("/campaigns/preview", { subject: form.subject.value, body: form.body.value, offer: form.offer.value, customerId: $("#previewFor").value || undefined });
          $("#pvSubject").textContent = p.subject; $("#pvBody").textContent = p.text;
        } catch (error) { $("#pvBody").textContent = error.message; }
      }, 300);
    }
    ["subject", "offer", "body"].forEach((n) => form[n].addEventListener("input", schedulePreview));
    $("#previewFor").addEventListener("change", schedulePreview);
    updateAudience();

    $("#saveCampaign").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
      const seg = segments.find((s) => s.key === mode);
      const payload = {
        name: form.name.value, subject: form.subject.value, body: form.body.value, offer: form.offer.value,
        segmentKey: seg ? seg.key : "custom", segmentLabel: seg ? seg.label : "Custom audience", audienceIds: [...selected],
        source: draft.source || "manual",
      };
      if (!payload.name.trim() || !payload.subject.trim() || !payload.body.trim()) { $("#campaignError").innerHTML = errorBox("Name, subject and message are required."); return; }
      if (!payload.audienceIds.length) { $("#campaignError").innerHTML = errorBox("Choose an audience."); return; }
      try {
        const saved = editing ? await api.put(`/campaigns/${draft.id}`, payload) : await api.post("/campaigns", payload);
        toast(editing ? "Draft saved." : "Campaign draft created. Review it, send a test, then launch.");
        if (route().name === "campaigns") renderCampaignsList();
        openCampaign(saved.id);
      } catch (error) { $("#campaignError").innerHTML = errorBox(error); }
    }, "Saving…"));
  }

  // ================================================================ campaigns
  async function renderCampaigns(params) {
    view.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Campaigns</p><h1>Email campaigns</h1><p>Drafts, launches and real sending results from the Gmail API. <strong>Sent</strong> means Gmail accepted the message; it does not prove inbox delivery.</p></div>
        <div class="actions"><button class="btn btn-primary" id="newCampaign">New campaign</button></div>
      </div>
      ${state.gmail && !state.gmail.connected ? `<div class="notice warn">Gmail is not connected, so campaigns cannot be launched. <a href="#settings">Connect Gmail</a>.</div><br>` : ""}
      <section class="card"><div id="campaignList"><div class="loading"><span class="spinner"></span></div></div></section>`;
    $("#newCampaign").addEventListener("click", () => openCampaignEditor({}));
    await renderCampaignsList();
    if (params.get("new")) openCampaignEditor({});
    if (params.get("id")) openCampaign(params.get("id"));
  }

  const progressBar = (counts = {}) => {
    const t = counts.total || 0;
    if (!t) return '<span class="muted small">No recipients yet</span>';
    return `<div class="progress" role="img" aria-label="Sent ${counts.sent}, failed ${counts.failed}, queued ${counts.queued + (counts.sending || 0)}, skipped ${counts.skipped} of ${t}">
      ${["sent", "failed", "sending", "queued", "skipped"].map((k) => (counts[k] ? `<span class="${k}" style="flex:${counts[k]}"></span>` : "")).join("")}</div>
      <span class="sub">${counts.sent} sent · ${counts.failed} failed · ${counts.skipped} skipped · ${counts.queued + (counts.sending || 0)} queued</span>`;
  };

  async function renderCampaignsList() {
    const host = $("#campaignList");
    if (!host) return;
    let list;
    try { list = await api.get("/campaigns"); } catch (error) { host.innerHTML = errorBox(error); return; }
    if (!list.length) {
      host.innerHTML = `<div class="empty"><strong>No campaigns yet</strong>Start from an AI recommendation or write your own.<br><a class="btn btn-primary" href="#segments">See recommendations</a></div>`;
      return;
    }
    host.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Campaign</th><th>Status</th><th>Audience</th><th style="min-width:220px">Results</th><th>Created</th><th>Launched</th></tr></thead>
      <tbody>${list.map((c) => `<tr class="clickable" data-id="${esc(c.id)}">
        <td><strong>${esc(c.name)}</strong><span class="sub">${esc(c.segmentLabel || "")}${c.source === "AI recommendation" ? " · AI" : ""}</span></td>
        <td>${badge(c.status)}${c.lastError && c.status === "paused" ? `<span class="sub" title="${esc(c.lastError)}">needs attention</span>` : ""}</td>
        <td>${num(c.audienceCount)}</td><td>${c.status === "draft" ? '<span class="muted small">Not launched</span>' : progressBar(c.counts)}</td>
        <td>${esc(dateTime(c.createdAt))}</td><td>${esc(dateTime(c.launchedAt))}</td></tr>`).join("")}</tbody></table></div>`;
    $$("tr[data-id]", host).forEach((row) => row.addEventListener("click", () => openCampaign(row.dataset.id)));
    if (list.some((c) => c.status === "sending") && !modal.open && !state.poll) {
      state.poll = setInterval(async () => {
        if (route().name !== "campaigns" || modal.open) return stopPoll();
        const latest = await api.get("/campaigns").catch(() => null);
        if (latest && !latest.some((c) => c.status === "sending")) stopPoll();
        renderCampaignsList();
      }, 3000);
    }
  }

  async function openCampaign(id, { keepFilter } = {}) {
    stopPoll();
    if (!modal.open) openModal({ title: "Campaign", body: '<div class="loading"><span class="spinner"></span></div>', wide: true });
    let c;
    try { c = await api.get(`/campaigns/${id}`); } catch (error) { $("#modalBody").innerHTML = errorBox(error); return; }
    const filter = keepFilter ?? "all";
    const recipients = c.recipients || [];
    const counts = c.counts || {};
    const buttons = [];
    if (c.status === "draft") buttons.push('<button class="btn btn-danger" data-act="delete">Delete</button>', '<span style="flex:1"></span>', '<button class="btn" data-act="edit">Edit</button>', '<button class="btn" data-act="test">Send test</button>', '<button class="btn btn-primary" data-act="launch">Review &amp; launch</button>');
    if (c.status === "sending") buttons.push('<button class="btn" data-act="pause">Pause</button>', '<button class="btn btn-danger" data-act="cancel">Cancel remaining</button>');
    if (c.status === "paused") buttons.push('<button class="btn btn-danger" data-act="cancel">Cancel remaining</button>', '<button class="btn btn-primary" data-act="resume">Resume</button>');
    if (["completed", "cancelled"].includes(c.status)) buttons.push('<button class="btn btn-danger" data-act="delete">Delete</button>', '<span style="flex:1"></span>');
    if (c.status !== "draft") buttons.push('<button class="btn" data-act="duplicate">Duplicate as draft</button>');

    const shown = filter === "all" ? recipients : recipients.filter((r) => r.status === filter || (filter === "queued" && r.status === "sending"));
    openModal({
      title: c.name,
      wide: true,
      body: `
        <div class="toolbar">${badge(c.status)} <span class="muted small">Created ${esc(dateTime(c.createdAt))}${c.launchedAt ? ` · launched ${esc(dateTime(c.launchedAt))}` : ""}${c.completedAt ? ` · finished ${esc(dateTime(c.completedAt))}` : ""}</span>
          ${c.status === "sending" ? '<span class="chip mint"><span class="spinner" style="width:12px;height:12px;border-width:2px"></span> Sending… updates every 2s</span>' : ""}</div>
        ${c.lastError ? `<div class="notice ${c.status === "paused" ? "warn" : "error"}">${esc(c.lastError)}${/reconnect/i.test(c.lastError) ? ' <a href="#settings">Open Settings</a>' : ""}</div>` : ""}
        ${c.status === "draft" ? `<div class="notice">Draft for <strong>${num(c.audienceCount)}</strong> customer(s) in <em>${esc(c.segmentLabel)}</em>. Eligibility (consent, valid email, duplicates) is checked when you launch.</div>` : `
        <div class="stat-row">
          <div><span>Recipients</span><strong>${num(counts.total)}</strong></div>
          <div><span>Sent (Gmail accepted)</span><strong style="color:var(--st-sent)">${num(counts.sent)}</strong></div>
          <div><span>Failed</span><strong style="color:var(--st-failed)">${num(counts.failed)}</strong></div>
          <div><span>Skipped</span><strong style="color:#8f6905">${num(counts.skipped)}</strong></div>
          <div><span>Queued</span><strong style="color:var(--st-queued)">${num((counts.queued || 0) + (counts.sending || 0))}</strong></div>
          <div><span>Opens / clicks</span><strong style="font-size:0.9rem">Not tracked</strong></div>
        </div>${progressBar(counts)}`}
        <div class="grid grid-2" style="margin-top:16px">
          <div class="email-preview"><header><span class="muted small">Template — placeholders are filled per recipient</span><br><strong>Subject:</strong> ${esc(c.subject)}</header><div class="body">${esc(c.body)}${c.offer ? `\n\n<span class="muted">{{offer}} = ${esc(c.offer)}</span>` : ""}</div></div>
          <div>
            ${recipients.length ? `
              <div class="toolbar"><strong style="margin-right:auto">Recipients</strong>
                <select id="rcptFilter" aria-label="Filter recipients"><option value="all">All (${recipients.length})</option>${["sent", "failed", "skipped", "queued"].map((s) => `<option value="${s}" ${filter === s ? "selected" : ""}>${STATUS_LABEL[s]} (${s === "queued" ? (counts.queued || 0) + (counts.sending || 0) : counts[s] || 0})</option>`).join("")}</select></div>
              <div class="table-wrap" style="max-height:340px;overflow:auto"><table><thead><tr><th>Customer</th><th>Status</th><th>Details</th></tr></thead><tbody>
                ${shown.map((r) => `<tr><td><strong>${esc(r.name)}</strong><span class="sub">${esc(r.email || "—")}</span></td><td>${badge(r.status)}</td>
                  <td class="small">${r.messageId ? `<span class="mono" title="Gmail message ID">${esc(r.messageId)}</span><span class="sub">${esc(dateTime(r.sentAt))}${r.attempts > 1 ? ` · ${r.attempts} attempts` : ""}</span>` : ""}${r.reason ? esc(r.reason) : ""}</td></tr>`).join("") || '<tr><td colspan="3" class="muted">None.</td></tr>'}
              </tbody></table></div>` : `<p class="muted">Recipients are listed here after launch.</p>`}
          </div>
        </div>`,
      foot: `${buttons.join("")}<button class="btn" data-close>Close</button>`,
    });
    $("#rcptFilter")?.addEventListener("change", (e) => openCampaign(c.id, { keepFilter: e.target.value }));
    $$("[data-act]", $("#modalFoot")).forEach((b) => b.addEventListener("click", () => campaignAction(b.dataset.act, c, b)));
    if (c.status === "sending") {
      state.poll = setInterval(async () => {
        if (!modal.open) return stopPoll();
        const latest = await api.get(`/campaigns/${c.id}`).catch(() => null);
        if (!latest) return;
        if (latest.status !== "sending" || JSON.stringify(latest.counts) !== JSON.stringify(c.counts)) {
          const f = $("#rcptFilter")?.value;
          openCampaign(c.id, { keepFilter: f });
          if (latest.status !== "sending") { renderCampaignsList(); toast(`"${latest.name}" ${latest.status}: ${latest.counts.sent} sent, ${latest.counts.failed} failed, ${latest.counts.skipped} skipped.`, latest.counts.failed ? "warn" : "ok"); }
        }
      }, 2000);
    }
  }

  async function campaignAction(action, c, button) {
    const refresh = () => { renderCampaignsList(); refreshStatus(); };
    try {
      if (action === "edit") return openCampaignEditor(c);
      if (action === "test") return sendCampaignTest(c);
      if (action === "delete") {
        if (!(await confirmDialog({ title: "Delete campaign?", message: `<p>Delete <strong>${esc(c.name)}</strong>${c.status !== "draft" ? " and its sending history" : ""}? This cannot be undone.</p>`, confirmLabel: "Delete", danger: true }))) return;
        await api.del(`/campaigns/${c.id}`); toast("Campaign deleted."); closeModal(); return refresh();
      }
      if (action === "duplicate") { const d = await api.post(`/campaigns/${c.id}/duplicate`); toast("Copied to a new draft."); refresh(); return openCampaign(d.id); }
      if (action === "pause") { await withBusy(button, () => api.post(`/campaigns/${c.id}/pause`), "Pausing…"); toast("Campaign paused. The message currently being sent (if any) will finish."); }
      if (action === "resume") { await withBusy(button, () => api.post(`/campaigns/${c.id}/resume`), "Resuming…"); toast("Sending resumed."); }
      if (action === "cancel") {
        if (!(await confirmDialog({ title: "Cancel remaining sends?", message: "<p>Recipients not yet sent will be marked <strong>skipped</strong>. Emails already sent cannot be recalled.</p>", confirmLabel: "Cancel remaining", danger: true }))) return;
        await api.post(`/campaigns/${c.id}/cancel`); toast("Campaign cancelled.");
      }
      if (action === "launch") return launchFlow(c, button);
      refresh();
      openCampaign(c.id);
    } catch (error) { toast(error.message, "error"); }
  }

  async function launchFlow(c, button) {
    await refreshStatus();
    if (!state.gmail?.connected) {
      toast(state.gmail?.needsReconnect ? "Gmail must be reconnected before launching." : "Connect Gmail in Settings before launching.", "error");
      return;
    }
    const el = await withBusy(button, () => api.get(`/campaigns/${c.id}/eligibility`), "Checking…");
    const reasons = Object.entries(el.skippedReasons);
    const ok = await confirmDialog({
      title: "Launch campaign?",
      message: `<p>RecallIQ will send <strong>${el.counts.queued}</strong> personalised email(s) from <strong>${esc(state.gmail.email || "your Gmail account")}</strong>, one at a time.</p>
        ${reasons.length ? `<p><strong>${el.counts.skipped}</strong> customer(s) will be skipped:</p><ul class="clean">${reasons.map(([r, n]) => `<li>${esc(r)}: ${n}</li>`).join("")}</ul>` : ""}
        ${el.counts.queued ? "<p class=\"small muted\">You can pause or cancel while it is sending. Sent emails cannot be recalled.</p>" : '<div class="notice error">Nobody in this audience can be emailed.</div>'}`,
      confirmLabel: el.counts.queued ? `Send ${el.counts.queued} email(s)` : "OK",
    });
    if (!ok || !el.counts.queued) return;
    try {
      const result = await api.post(`/campaigns/${c.id}/launch`);
      toast(`Launched: ${result.counts.queued} queued, ${result.counts.skipped} skipped.`);
      if (result.warning) toast(result.warning, "warn");
      renderCampaignsList();
      openCampaign(c.id);
    } catch (error) { toast(error.message, "error"); openCampaign(c.id); }
  }

  async function sendCampaignTest(c) {
    await refreshStatus();
    const to = state.gmail?.email || state.user.email;
    openModal({
      title: "Send a test of this campaign",
      body: `<p>Renders the campaign for a chosen customer and sends it <strong>only</strong> to the address below, with “[TEST]” in the subject. No customer is emailed.</p>
        <div class="form-grid">
          <label class="field">Send to<input type="email" id="testTo" value="${esc(to)}" /></label>
          <label class="field">Render as customer<select id="testAs"><option value="">Sample data</option></select></label>
        </div><div id="testResult"></div>`,
      foot: `<button class="btn" id="backToCampaign">Back</button><button class="btn btn-primary" id="sendTest">Send test</button>`,
    });
    api.get("/customers?limit=500&sort=name&order=asc").then((r) => {
      const ids = new Set(c.audienceIds);
      $("#testAs").innerHTML = `<option value="">Sample data</option>${r.items.filter((x) => ids.has(x.id)).slice(0, 100).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}`;
    }).catch(() => {});
    $("#backToCampaign").addEventListener("click", () => openCampaign(c.id));
    $("#sendTest").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
      try {
        const r = await api.post("/gmail/test", { to: $("#testTo").value, campaignId: c.id, customerId: $("#testAs").value || undefined });
        $("#testResult").innerHTML = `<div class="notice ok">Gmail accepted the test (message ID <span class="mono">${esc(r.messageId)}</span>). ${esc(r.note)}</div>`;
      } catch (error) { $("#testResult").innerHTML = errorBox(error); }
    }, "Sending…"));
  }

  // ================================================================ churn risk
  async function renderRisk() {
    const ml = await api.get("/health/ml");
    state.ml = ml;
    const list = await api.get("/customers?limit=500&sort=risk&order=desc");
    const m = ml.metrics || {};
    view.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">AI risk prediction</p><h1>Churn risk</h1><p>The Python ML service estimates each customer's probability of churning from recency, orders, spend, engagement, support tickets and cart value.</p></div>
        <div class="actions"><button class="btn btn-primary" id="scoreAll" ${ml.reachable && list.total ? "" : "disabled"}>Score all customers</button></div>
      </div>
      ${ml.reachable ? `
        <div class="notice ${ml.provenance === "synthetic" ? "warn" : "ok"}">
          <strong>Model: ${esc(ml.provenance === "synthetic" ? "Synthetic-data demonstration model" : "Model trained on your data")}.</strong> ${esc(ml.description || "")}
          ${m.roc_auc ? `<br>Hold-out metrics (${esc(ml.provenance)} data): ROC-AUC ${m.roc_auc}, accuracy ${m.accuracy}, precision ${m.precision}, recall ${m.recall}. <span class="small">${esc(ml.metrics_note || "")}</span>` : ""}
        </div>` : `<div class="notice error"><strong>ML service unavailable.</strong> ${esc(ml.error)}</div>`}
      <br>
      <section class="card">
        ${list.total ? `<div class="table-wrap"><table>
          <thead><tr><th>Customer</th><th>Churn risk</th><th>Top reason</th><th>Next best action</th><th>Channel</th><th>Scored</th></tr></thead>
          <tbody>${list.items.map((c) => `<tr class="clickable" data-id="${esc(c.id)}">
            <td><strong>${esc(c.name)}</strong><span class="sub">${c.daysSinceLastOrder === null ? "no order date" : `${c.daysSinceLastOrder} days since last order`}</span></td>
            <td>${riskBadge(c.risk)}</td><td class="small">${esc(c.risk?.reasons?.[0] || "—")}</td><td class="small">${esc(c.risk?.action || "—")}</td>
            <td class="small">${c.risk ? esc(c.risk.channel || "Do not contact") : "—"}</td><td class="small">${esc(dateTime(c.risk?.scoredAt))}</td></tr>`).join("")}</tbody></table></div>`
          : `<div class="empty"><strong>No customers to score</strong><a class="btn" href="#customers">Add customers</a></div>`}
      </section>`;
    $$("tr[data-id]", view).forEach((row) => row.addEventListener("click", () => openCustomer(row.dataset.id)));
    $("#scoreAll")?.addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
      try {
        const r = await api.post("/risk/score-all");
        toast(`Scored ${r.scored} of ${r.total} customer(s).${r.skipped.length ? ` ${r.skipped.length} skipped (missing last order date).` : ""}`, r.skipped.length ? "warn" : "ok");
        renderRisk();
      } catch (error) { toast(error.message, "error"); }
    }, "Scoring…"));
    modal.addEventListener("close", () => { if (route().name === "risk") renderRisk(); }, { once: true });
  }

  // ================================================================ settings
  async function renderSettings(params) {
    if (params.get("gmail") === "connected") { toast("Gmail connected. Send a test email to confirm it works."); history.replaceState(null, "", "#settings"); }
    if (params.get("gmail") === "denied") { toast("Gmail connection was cancelled on the Google screen.", "warn"); history.replaceState(null, "", "#settings"); }
    await refreshStatus();
    const g = state.gmail || {};
    const h = state.health || {};
    view.innerHTML = `
      <div class="page-head"><div><p class="eyebrow">Settings</p><h1>Settings &amp; Gmail</h1><p>Connect the Gmail account RecallIQ sends from, verify it, and check service health.</p></div></div>
      <div class="grid grid-2">
        <section class="card">
          <div class="card-head"><div><h2>Gmail sending</h2><p class="muted small" style="margin:0">Uses the Gmail API with Google OAuth 2.0 (permission: send email only).</p></div>
            ${g.connected ? badge("sent", "Connected") : g.needsReconnect ? badge("failed", "Reconnect needed") : badge("cancelled", "Not connected")}</div>
          ${!g.configured ? `<div class="notice error">The server has no Google OAuth credentials. Add <span class="mono">GOOGLE_CLIENT_ID</span> and <span class="mono">GOOGLE_CLIENT_SECRET</span> to <span class="mono">backend/.env</span> and restart the backend.</div>` : ""}
          ${g.needsReconnect && g.lastError ? `<div class="notice error">${esc(g.lastError)}</div>` : ""}
          <p>${g.email ? `Sending as <strong>${esc(g.email)}</strong>` : g.connected ? "Connected (account email unknown — reconnect to display it)." : "No Gmail account connected."}
            ${g.connectedAt ? `<br><span class="small muted">Connected ${esc(dateTime(g.connectedAt))}${g.lastVerifiedAt ? ` · verified ${esc(dateTime(g.lastVerifiedAt))}` : ""}</span>` : ""}</p>
          ${g.connected && !g.hasRefreshToken ? `<div class="notice warn">No refresh token stored, so access will stop when the current token expires. Disconnect and connect again.</div>` : ""}
          <div class="actions">
            <button class="btn ${g.connected ? "" : "btn-primary"}" id="connectGmail" ${g.configured ? "" : "disabled"}>${g.connected ? "Reconnect" : g.needsReconnect ? "Reconnect Gmail" : "Connect Gmail"}</button>
            <button class="btn" id="verifyGmail" ${g.connected ? "" : "disabled"}>Verify connection</button>
            <button class="btn btn-danger" id="disconnectGmail" ${g.connected || g.needsReconnect ? "" : "disabled"}>Disconnect</button>
          </div>
          <p class="small muted" style="margin-top:10px">OAuth redirect URI configured on the server: <span class="mono">${esc(g.redirectUri || "")}</span> — it must be listed exactly under “Authorized redirect URIs” in Google Cloud Console.</p>
          <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
          <h3>Send a test email</h3>
          <form id="testForm" class="toolbar" novalidate>
            <label class="sr-only" for="testEmailTo">Recipient</label>
            <input type="email" id="testEmailTo" value="${esc(g.email || state.user.email)}" style="flex:1 1 220px" />
            <button class="btn btn-dark" type="submit" ${g.connected ? "" : "disabled"}>Send test</button>
          </form>
          <div id="testOut">${g.lastTestEmail ? `<p class="small muted">Last test: ${g.lastTestEmail.ok ? `accepted by Gmail for ${esc(g.lastTestEmail.to)} (ID <span class="mono">${esc(g.lastTestEmail.messageId)}</span>)` : `failed for ${esc(g.lastTestEmail.to)}: ${esc(g.lastTestEmail.error)}`} · ${esc(dateTime(g.lastTestEmail.at))}</p>` : ""}</div>
        </section>

        <div>
          <section class="card">
            <h2>Profile</h2>
            <form id="profileForm" style="display:grid;gap:12px">
              <label class="field">Your name <small>used as the email signature</small><input type="text" name="name" maxlength="80" value="${esc(state.user.name)}" /></label>
              <label class="field">Business name <small>sender display name and {{businessName}}</small><input type="text" name="businessName" maxlength="120" value="${esc(state.user.businessName || "")}" /></label>
              <div><button class="btn btn-dark" type="submit">Save profile</button></div>
            </form>
          </section>
          <section class="card">
            <h2>Service health</h2>
            <ul class="clean">
              <li>Backend: ${h.ok ? badge("sent", "online") : badge("failed", "offline")} ${h.storage ? `· storage <strong>${esc(h.storage)}</strong>${h.storageDurable ? "" : ' <span class="small muted">(local JSON files — fine for development, not durable on most cloud hosts)</span>'}` : ""}</li>
              <li>Gmail token encryption: ${h.tokenEncryption ? badge("sent", "on") : badge("skipped", "off — set TOKEN_ENCRYPTION_KEY")}</li>
              <li>ML service: ${state.ml?.reachable ? `${badge("sent", "online")} · ${esc(state.ml.provenance)} model` : `${badge("failed", "offline")} <span class="small">${esc(state.ml?.error || "")}</span>`}</li>
            </ul>
          </section>
        </div>
      </div>`;

    $("#connectGmail").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
      try { const { url } = await api.post("/gmail/connect"); location.href = url; } catch (error) { toast(error.message, "error"); }
    }, "Opening Google…"));
    $("#verifyGmail").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
      try { const r = await api.post("/gmail/verify"); toast(r.message); } catch (error) { toast(error.message, "error"); }
      renderSettings(new URLSearchParams());
    }, "Verifying…"));
    $("#disconnectGmail").addEventListener("click", async () => {
      if (!(await confirmDialog({ title: "Disconnect Gmail?", message: "<p>RecallIQ will revoke its access at Google and delete the stored token. Campaigns cannot send until you reconnect.</p>", confirmLabel: "Disconnect", danger: true }))) return;
      try { await api.post("/gmail/disconnect"); toast("Gmail disconnected."); } catch (error) { toast(error.message, "error"); }
      renderSettings(new URLSearchParams());
    });
    $("#testForm").addEventListener("submit", (e) => {
      e.preventDefault();
      withBusy(e.submitter, async () => {
        try {
          const r = await api.post("/gmail/test", { to: $("#testEmailTo").value });
          $("#testOut").innerHTML = `<div class="notice ok">Gmail accepted the test email to <strong>${esc(r.to)}</strong>. Message ID <span class="mono">${esc(r.messageId)}</span>.<br>${esc(r.note)}</div>`;
        } catch (error) { $("#testOut").innerHTML = errorBox(error); }
        refreshStatus();
      }, "Sending…");
    });
    $("#profileForm").addEventListener("submit", (e) => {
      e.preventDefault();
      withBusy(e.submitter, async () => {
        try {
          const { user } = await api.patch("/auth/me", Object.fromEntries(new FormData(e.target).entries()));
          state.user = user;
          session.set({ ...session.get(), user });
          $("#userName").textContent = user.name;
          toast("Profile saved.");
        } catch (error) { toast(error.message, "error"); }
      }, "Saving…");
    });
  }

  // ================================================================ boot
  (async function boot() {
    try {
      const { user } = await api.get("/auth/me");
      state.user = user;
      session.set({ ...session.get(), user });
      $("#userName").textContent = user.name;
      $("#userEmail").textContent = user.email;
    } catch (error) {
      if (error.status !== 401) view.innerHTML = `<div class="page-head"><h1>Cannot reach RecallIQ</h1></div>${errorBox(error)}<p><button class="btn" onclick="location.reload()">Retry</button></p>`;
      return;
    }
    await refreshStatus();
    render();
    setInterval(refreshStatus, 60_000);
  })();
})();
