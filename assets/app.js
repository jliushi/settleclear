/* SettleClear — 100% client-side Amazon settlement profit & fee audit.
   No network calls. Everything below runs in the visitor's browser. */
(function () {
  "use strict";

  // --- Monetisation config. All empty by default → nothing renders (no dead links).
  //     Paste a value in later to switch a channel on; no other change needed. ---
  const CONFIG = {
    affiliateTag: "",     // Amazon Associates tag, e.g. "yourtag-20" (used by future prep-service links)
    supportUrl: "",       // e.g. a Ko-fi / Buy Me a Coffee page URL
    proWaitlistUrl: "",   // e.g. a form or mailto: for a paid multi-platform / saved-history tier
  };

  const $ = (s) => document.querySelector(s);
  // Expose config so standalone pages (e.g. pro.html) can read it without duplicating it.
  if (typeof window !== "undefined") window.SETTLECLEAR = CONFIG;
  const money = (n, c) => (n < 0 ? "-" : "") + (c || "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Escape untrusted values (SKUs, fee descriptions from the uploaded file) before innerHTML.
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  // Quote a CSV field so embedded commas/quotes/newlines don't break the row.
  const csvField = (x) => `"${String(x == null ? "" : x).replace(/"/g, '""')}"`;

  // --- Parse a delimited settlement export (auto-detect tab vs comma). ---
  function parseDelimited(text) {
    text = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").trim();
    const lines = text.split("\n").filter((l) => l.length);
    if (!lines.length) return { headers: [], rows: [] };
    const delim = lines[0].indexOf("\t") >= 0 ? "\t" : ",";
    const split = (line) => {
      if (delim === "\t") return line.split("\t");
      const out = []; let cur = "", q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else { if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; }
      }
      out.push(cur); return out;
    };
    const headers = split(lines[0]).map((h) => h.trim().toLowerCase());
    const rows = lines.slice(1).map((l) => {
      const c = split(l), o = {};
      headers.forEach((h, i) => (o[h] = (c[i] || "").trim()));
      return o;
    });
    return { headers, rows };
  }

  // --- Classify a settlement line into a profit bucket. ---
  // Buckets: revenue (income), fee (cost), promo (cost), tax (pass-through, excluded
  // from profit), reserve (account-level timing hold, excluded from profit but surfaced),
  // other (unrecognised — still counted in net, and surfaced in the audit).
  function classify(type, desc) {
    const t = (type || "").toLowerCase(), d = (desc || "").toLowerCase();
    if (!t && !d) return "skip";
    // Pass-through amounts that must NOT count as profit: facilitated tax and reserve timing.
    if (t.includes("withheldtax") || d.includes("marketplacefacilitator") || d.includes("withheldtax")) return "tax";
    if (d.includes("reserve") || d.includes("deferred") || d.includes("holdback")) return "reserve";
    if (t === "itemprice" || t === "componentprice") return d.includes("tax") ? "tax" : "revenue";
    if (t === "promotion") return "promo";
    if (t === "itemfees") return "fee";
    if (d.includes("tax")) return "tax";
    // other-transaction / servicefee style rows keyed off the description.
    const feeWords = ["fee", "commission", "advertis", "storage", "fulfillment", "fulfilment",
      "fba", "shippinglabel", "inbound", "transport", "subscription", "disposal",
      "removal", "restock", "chargeback", "adjustment", "service", "liquidation"];
    if (feeWords.some((w) => d.includes(w))) return "fee";
    if (d) return "other";
    return "skip";
  }

  // PLACEHOLDER_COMPUTE
  // Locale-aware amount parser. Amazon prints EU amounts as "95,00" / "1.234,56"
  // (comma decimal) and US amounts as "1,234.56" (comma thousands). Decide per value
  // by which separator appears last.
  function num(v) {
    let s = String(v == null ? "" : v).trim();
    if (!s) return 0;
    s = s.replace(/[^\d.,-]/g, ""); // strip currency symbols and any spaces
    if (!s || s === "-") return 0;
    const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(/,/g, "."); // comma is decimal (EU)
    else s = s.replace(/,/g, ""); // dot is decimal (US); commas are thousands
    const n = Number(s);
    return isNaN(n) ? 0 : n;
  }

  function compute(rows, cogsMap) {
    const bySku = new Map();
    let currency = "$", headerTotal = null, grand = 0, reserve = 0;
    const unclassified = new Set();
    for (const r of rows) {
      if (r["currency"]) currency = r["currency"];
      if (r["total-amount"]) headerTotal = num(r["total-amount"]);
      const amt = num(r["amount"]);
      if (r["amount"] !== "" && r["amount"] != null) grand += amt;
      const bucket = classify(r["amount-type"], r["amount-description"]);
      if (bucket === "skip") continue;
      // Reserve/deferred is an account-level timing movement, not profit — track it apart.
      if (bucket === "reserve") { reserve += amt; continue; }
      if (bucket === "other" && r["amount-description"]) unclassified.add(r["amount-description"]);
      const sku = r["sku"] || (r["transaction-type"] ? "(" + r["transaction-type"] + ")" : "(unattributed)");
      if (!bySku.has(sku)) bySku.set(sku, { sku, units: 0, revenue: 0, fee: 0, promo: 0, tax: 0, other: 0 });
      const o = bySku.get(sku);
      o[bucket === "revenue" ? "revenue" : bucket === "fee" ? "fee" : bucket === "promo" ? "promo" : bucket === "tax" ? "tax" : "other"] += amt;
      // Count units once per sold item (the Principal price line), not per fee line.
      if ((r["amount-description"] || "").toLowerCase() === "principal" && (r["transaction-type"] || "").toLowerCase() !== "refund")
        o.units += num(r["quantity-purchased"]);
    }
    const list = [...bySku.values()].map((o) => {
      const cogs = cogsMap && cogsMap[o.sku] != null ? cogsMap[o.sku] * o.units : 0;
      const net = o.revenue + o.fee + o.promo + o.other; // tax excluded (pass-through)
      return { ...o, cogs, netProceeds: net, profit: net - cogs, hasCogs: cogs !== 0 };
    }).sort((a, b) => a.profit - b.profit);
    const totals = list.reduce((a, o) => ({
      units: a.units + o.units, revenue: a.revenue + o.revenue, fee: a.fee + o.fee,
      promo: a.promo + o.promo, cogs: a.cogs + o.cogs, profit: a.profit + o.profit,
      netProceeds: a.netProceeds + o.netProceeds,
    }), { units: 0, revenue: 0, fee: 0, promo: 0, cogs: 0, profit: 0, netProceeds: 0 });
    const recognized = list.length > 0 || grand !== 0 || headerTotal !== null;
    return { list, totals, currency, headerTotal, grand, reserve, recognized, unclassified: [...unclassified] };
  }

  // PLACEHOLDER_RENDER
  let LAST = null;

  function render(res) {
    LAST = res;
    // Guard: the upload isn't a recognizable settlement report — say so instead of showing zeros.
    if (!res.recognized) {
      $("#alerts").innerHTML = `<div class="alert bad">This file doesn't look like an Amazon <strong>Flat File V2 settlement report</strong>. Download it from Seller Central → Reports → Payments → Date Range Reports — a tab- or comma-delimited .txt/.csv with columns like <code>transaction-type</code>, <code>amount-type</code>, and <code>amount</code>. Then drop it here again.</div>`;
      $("#alerts").hidden = false;
      $("#summary").hidden = true; $("#tableWrap").hidden = true; $("#cogs").hidden = true;
      $("#tool").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const c = res.currency;
    const card = (k, v, cls) => `<div class="card"><div class="k">${k}</div><div class="v ${cls || ""}">${v}</div></div>`;
    $("#summary").innerHTML =
      card("Units", res.totals.units.toLocaleString()) +
      card("Gross revenue", money(res.totals.revenue, c)) +
      card("Amazon fees", money(res.totals.fee, c), "bad") +
      card("Promo", money(res.totals.promo, c)) +
      (res.totals.cogs ? card("COGS", money(-res.totals.cogs, c), "bad") : "") +
      card(res.totals.cogs ? "Net profit" : "Net proceeds", money(res.totals.profit, c), res.totals.profit >= 0 ? "good" : "bad") +
      (res.reserve ? card("Reserve / held", money(res.reserve, c)) : "");
    $("#summary").hidden = false;

    const alerts = [];
    if (res.headerTotal != null) {
      const diff = res.grand - res.headerTotal;
      if (Math.abs(diff) > 0.01)
        alerts.push(["bad", `Reconciliation gap: line items sum to ${money(res.grand, c)} but the settlement total is ${money(res.headerTotal, c)} (off by ${money(diff, c)}). Some lines may be miscategorised — review below.`]);
      else
        alerts.push(["ok", `Reconciled: line items tie out to the settlement total of ${money(res.headerTotal, c)}.`]);
    }
    if (res.reserve) {
      const held = res.reserve < 0;
      alerts.push(["warn", `${held ? "Amazon held" : "This settlement released"} ${money(Math.abs(res.reserve), c)} ${held ? "in reserve this cycle — it is not lost, it releases in a later settlement" : "of previously-held reserve"}. This is a timing movement, not profit, so it is excluded from the figures above and explains part of the gap between your sales and your deposit.`]);
    }
    const neg = res.list.filter((o) => o.profit < 0 && o.units > 0);
    if (neg.length) alerts.push(["bad", `${neg.length} SKU(s) lose money after fees${res.totals.cogs ? " and COGS" : ""}: ${neg.slice(0, 5).map((o) => esc(o.sku)).join(", ")}${neg.length > 5 ? "…" : ""}.`]);
    if (res.unclassified.length) alerts.push(["warn", `${res.unclassified.length} fee type(s) not in the standard map were bucketed as “other” (not silently dropped): ${res.unclassified.slice(0, 6).map(esc).join(", ")}.`]);
    $("#alerts").innerHTML = alerts.map(([k, t]) => `<div class="alert ${k === "bad" ? "bad" : ""}">${t}</div>`).join("");
    $("#alerts").hidden = !alerts.length;

    drawTable(res.list, res.currency);
    $("#tableWrap").hidden = false;
    $("#cogs").hidden = false;
    $("#tool").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function drawTable(list, c) {
    const cols = [["sku", "SKU"], ["units", "Units"], ["revenue", "Revenue"], ["fee", "Fees"], ["promo", "Promo"], ["cogs", "COGS"], ["profit", "Profit"]];
    $("#table thead").innerHTML = "<tr>" + cols.map(([, l]) => `<th>${l}</th>`).join("") + "</tr>";
    $("#table tbody").innerHTML = list.map((o) => `<tr class="${o.profit < 0 ? "neg" : ""}"><td>${esc(o.sku)}</td><td>${o.units}</td><td>${money(o.revenue, c)}</td><td>${money(o.fee, c)}</td><td>${money(o.promo, c)}</td><td>${o.cogs ? money(-o.cogs, c) : "—"}</td><td>${money(o.profit, c)}</td></tr>`).join("");
  }

  // PLACEHOLDER_WIRE
  let RAW = null;
  function parseCogs() {
    const map = {}; const txt = $("#cogsInput").value || "";
    txt.split("\n").forEach((l) => { const [s, c] = l.split(","); if (s && c) map[s.trim()] = num(c); });
    return map;
  }
  function run() { if (RAW) render(compute(RAW, parseCogs())); }

  function handleFile(file) {
    const fr = new FileReader();
    fr.onload = () => { RAW = parseDelimited(fr.result).rows; run(); };
    fr.readAsText(file);
  }

  if (typeof document === "undefined" || !document.getElementById("drop")) {
    if (typeof module !== "undefined" && module.exports) module.exports = { parseDelimited, classify, num, compute, esc, csvField };
    return;
  }
  const drop = $("#drop");

  // Render monetisation links only if a channel is configured (dormant by default).
  (function renderMonetization() {
    const foot = document.querySelector("footer.site");
    if (!foot) return;
    const bits = [];
    if (CONFIG.supportUrl) bits.push(`<a href="${CONFIG.supportUrl}" rel="noopener">♥ Support this free tool</a>`);
    if (CONFIG.proWaitlistUrl) bits.push(`<a class="btn" href="${CONFIG.proWaitlistUrl}" rel="noopener">Get Pro: multi-platform + saved history</a>`);
    if (bits.length) { const p = document.createElement("p"); p.innerHTML = bits.join(" · "); foot.prepend(p); }
  })();
  ["dragover", "dragenter"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((e) => drop.addEventListener(e, () => drop.classList.remove("drag")));
  drop.addEventListener("drop", (ev) => { ev.preventDefault(); if (ev.dataTransfer.files[0]) handleFile(ev.dataTransfer.files[0]); });
  $("#pick").addEventListener("click", () => $("#file").click());
  $("#file").addEventListener("change", (e) => e.target.files[0] && handleFile(e.target.files[0]));
  $("#apply").addEventListener("click", run);
  $("#search").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    if (LAST) drawTable(LAST.list.filter((o) => o.sku.toLowerCase().includes(q)), LAST.currency);
  });
  $("#export").addEventListener("click", () => {
    if (!LAST) return;
    const head = "sku,units,revenue,fees,promo,cogs,net_profit\n";
    const body = LAST.list.map((o) => [csvField(o.sku), o.units, o.revenue.toFixed(2), o.fee.toFixed(2), o.promo.toFixed(2), (-o.cogs).toFixed(2), o.profit.toFixed(2)].join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([head + body], { type: "text/csv" }));
    a.download = "profit-by-sku.csv"; a.click();
  });

  // Export the audit findings (reconciliation, negative-margin SKUs, unclassified fees).
  const auditBtn = $("#exportAudit");
  if (auditBtn) auditBtn.addEventListener("click", () => {
    if (!LAST) return;
    const rows = [["issue_type", "sku_or_item", "detail", "amount"]];
    if (LAST.headerTotal != null) {
      const diff = LAST.grand - LAST.headerTotal;
      rows.push(["reconciliation", "(settlement)", Math.abs(diff) > 0.01 ? "line items do NOT tie to deposit total" : "reconciled to deposit total", diff.toFixed(2)]);
    }
    LAST.list.filter((o) => o.profit < 0 && o.units > 0).forEach((o) =>
      rows.push(["negative_margin_sku", o.sku, "loses money after fees" + (o.cogs ? " and COGS" : ""), o.profit.toFixed(2)]));
    LAST.unclassified.forEach((d) => rows.push(["unclassified_fee", d, "fee type not in standard map (counted, bucketed as other)", ""]));
    const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "audit-report.csv"; a.click();
  });

  // --- Sample settlement so visitors can try without their own file. ---
  $("#demo").addEventListener("click", () => {
    const H = ["settlement-id", "currency", "total-amount", "transaction-type", "order-id", "sku", "quantity-purchased", "amount-type", "amount-description", "amount"];
    const rows = [[ "90210", "USD", "723.58", "", "", "", "", "", "", "" ]];
    const add = (sku, qty, tt, pairs) => pairs.forEach(([at, ad, amt]) => rows.push(["90210", "USD", "", tt, "111-" + sku, sku, qty, at, ad, String(amt)]));
    add("WIDGET-BLUE", "40", "Order", [["ItemPrice", "Principal", 799.6], ["ItemPrice", "Tax", 64.0], ["ItemFees", "Commission", -119.94], ["ItemFees", "FBAPerUnitFulfillmentFee", -132.0], ["ItemWithheldTax", "MarketplaceFacilitatorTax-Principal", -64.0]]);
    add("MUG-4PK", "22", "Order", [["ItemPrice", "Principal", 439.78], ["ItemFees", "Commission", -65.97], ["ItemFees", "FBAPerUnitFulfillmentFee", -114.4], ["Promotion", "Shipping", -18.0]]);
    add("CABLE-2M", "60", "Order", [["ItemPrice", "Principal", 359.4], ["ItemFees", "Commission", -53.91], ["ItemFees", "FBAPerUnitFulfillmentFee", -193.2], ["ItemFees", "FBAStorageFee", -22.5]]);
    add("WIDGET-BLUE", "2", "Refund", [["ItemPrice", "Principal", -39.98], ["ItemFees", "RefundCommission", 6.0]]);
    rows.push(["90210", "USD", "", "other-transaction", "", "", "", "other", "Cost of Advertising", "-71.30"]);
    rows.push(["90210", "USD", "", "other-transaction", "", "", "", "other-transaction", "Current Reserve Amount", "-50.00"]);
    RAW = rows.slice(1).map((r) => { const o = {}; H.forEach((h, i) => (o[h] = r[i])); o["total-amount"] = rows[0][2]; return o; });
    $("#cogsInput").value = "WIDGET-BLUE,7.50\nMUG-4PK,9.00\nCABLE-2M,2.10";
    run();
  });

})();
