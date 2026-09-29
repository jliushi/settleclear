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

  // Expose config so standalone pages (e.g. pro.html) can read it without duplicating it.
  if (typeof window !== "undefined") window.SETTLECLEAR = CONFIG;
  // Escape untrusted values (SKUs, fee descriptions from the uploaded file) before innerHTML.
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  // Quote a CSV field so embedded commas/quotes/newlines don't break the row.
  const csvField = (x) => `"${String(x == null ? "" : x).replace(/"/g, '""')}"`;
  // As csvField, but also neutralise spreadsheet formula injection (leading = + - @ tab CR).
  const csvSafe = (x) => { let s = String(x == null ? "" : x); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return csvField(s); };

  // --- Parse a delimited settlement export (auto-detect tab vs comma). ---
  function parseDelimited(text) {
    text = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
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

  // Sub-categorise a fee line so the tool can show where fees went (not just one total).
  function feeCat(desc) {
    const d = (desc || "").toLowerCase();
    if (d.includes("commission")) return "referral";
    if (d.includes("storage")) return "storage";
    if (d.includes("advertis")) return "advertising";
    if (d.includes("fulfillment") || d.includes("fulfilment") || d.includes("fba") || d.includes("weight") || d.includes("pick")) return "fulfillment";
    return "otherFees";
  }

  // Locale-aware amount parser. Amazon prints EU amounts as "95,00" / "1.234,56"
  // (comma decimal) and US amounts as "1,234.56" (comma thousands). Decide per value
  // by which separator appears last.
  function num(v) {
    let s = String(v == null ? "" : v).trim();
    if (!s) return 0;
    let neg = /\(.*\)/.test(s); // accounting-format negative, e.g. (12.34) or $ (50.00)
    s = s.replace(/[^\d.,-]/g, ""); // strip currency symbols, parentheses, spaces
    if (!s || s === "-") return 0;
    if (s.indexOf("-") >= 0) neg = true; // leading or trailing minus
    s = s.replace(/-/g, "");
    const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(/,/g, "."); // comma is decimal (EU)
    else s = s.replace(/,/g, ""); // dot is decimal (US); commas are thousands
    const n = Number(s);
    return isNaN(n) ? 0 : (neg ? -n : n);
  }

  function compute(rows, cogsMap) {
    const bySku = new Map();
    let currency = "$", grand = 0, reserve = 0;
    const unclassified = new Set(), settleTotals = new Map();
    const feeBreakdown = { referral: 0, fulfillment: 0, storage: 0, advertising: 0, otherFees: 0 };
    for (const r of rows) {
      if (r["currency"]) currency = String(r["currency"]).replace(/[^\w$€£¥.\- ]/g, "").slice(0, 8) || currency;
      if (r["total-amount"]) settleTotals.set(r["settlement-id"] || "_", num(r["total-amount"]));
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
      if (bucket === "fee") feeBreakdown[feeCat(r["amount-description"])] += amt;
      // Units: count sold units on Principal lines; a refund's Principal reduces net units
      // so COGS tracks net units sold (assumes returned units are resellable).
      if ((r["amount-description"] || "").toLowerCase() === "principal") {
        const q = num(r["quantity-purchased"]);
        o.units += (r["transaction-type"] || "").toLowerCase() === "refund" ? -q : q;
      }
    }
    const list = [...bySku.values()].map((o) => {
      const hasCogs = !!cogsMap && Object.prototype.hasOwnProperty.call(cogsMap, o.sku);
      const cogs = hasCogs ? cogsMap[o.sku] * o.units : 0;
      const net = o.revenue + o.fee + o.promo + o.other; // tax excluded (pass-through)
      return { ...o, cogs, netProceeds: net, profit: net - cogs, hasCogs };
    }).sort((a, b) => a.profit - b.profit);
    const totals = list.reduce((a, o) => ({
      units: a.units + o.units, revenue: a.revenue + o.revenue, fee: a.fee + o.fee,
      promo: a.promo + o.promo, cogs: a.cogs + o.cogs, profit: a.profit + o.profit,
      netProceeds: a.netProceeds + o.netProceeds,
    }), { units: 0, revenue: 0, fee: 0, promo: 0, cogs: 0, profit: 0, netProceeds: 0 });
    const headerTotal = settleTotals.size ? [...settleTotals.values()].reduce((a, b) => a + b, 0) : null;
    const recognized = list.length > 0 || grand !== 0 || headerTotal !== null;
    return { list, totals, currency, headerTotal, grand, reserve, recognized, feeBreakdown, unclassified: [...unclassified] };
  }

  function parseCogsText(text) {
    const map = Object.create(null), errors = [];
    String(text || "").split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      const comma = line.indexOf(",");
      let sku = line.slice(0, comma).trim(), cost = line.slice(comma + 1).trim();
      if (line.trim().startsWith('"')) {
        const quoted = /^\s*"((?:[^"]|"")*)"\s*,\s*(.*?)\s*$/.exec(line);
        if (!quoted) { errors.push(index + 1); return; }
        sku = quoted[1].replace(/""/g, '"').trim();
        cost = quoted[2];
      }
      if (/^".*"$/.test(cost)) cost = cost.slice(1, -1).trim();
      if (comma < 1 || !sku || !/^\d+(?:[.,]\d+)?$/.test(cost) || !Number.isFinite(num(cost))) {
        errors.push(index + 1);
      } else map[sku] = num(cost);
    });
    return { map, errors };
  }

  function sampleReport() {
    const headers = ["settlement-id", "currency", "total-amount", "transaction-type", "order-id", "sku", "quantity-purchased", "amount-type", "amount-description", "amount"];
    const rows = [["90210", "USD", "723.58", "", "", "", "", "", "", ""]];
    const add = (sku, qty, type, pairs) => pairs.forEach(([at, ad, amount]) => rows.push(["90210", "USD", "", type, "111-" + sku, sku, qty, at, ad, String(amount)]));
    add("WIDGET-BLUE", "40", "Order", [["ItemPrice", "Principal", 799.6], ["ItemPrice", "Tax", 64.0], ["ItemFees", "Commission", -119.94], ["ItemFees", "FBAPerUnitFulfillmentFee", -132.0], ["ItemWithheldTax", "MarketplaceFacilitatorTax-Principal", -64.0]]);
    add("MUG-4PK", "22", "Order", [["ItemPrice", "Principal", 439.78], ["ItemFees", "Commission", -65.97], ["ItemFees", "FBAPerUnitFulfillmentFee", -114.4], ["Promotion", "Shipping", -18.0]]);
    add("CABLE-2M", "60", "Order", [["ItemPrice", "Principal", 359.4], ["ItemFees", "Commission", -53.91], ["ItemFees", "FBAPerUnitFulfillmentFee", -193.2], ["ItemFees", "FBAStorageFee", -22.5]]);
    add("WIDGET-BLUE", "2", "Refund", [["ItemPrice", "Principal", -39.98], ["ItemFees", "RefundCommission", 6.0]]);
    rows.push(["90210", "USD", "", "other-transaction", "", "", "", "other", "Cost of Advertising", "-71.30"]);
    rows.push(["90210", "USD", "", "other-transaction", "", "", "", "other-transaction", "Current Reserve Amount", "-50.00"]);
    return {
      text: [headers, ...rows].map((r) => r.join("\t")).join("\n"),
      costs: "WIDGET-BLUE,7.50\nMUG-4PK,9.00\nCABLE-2M,2.10",
    };
  }

  const core = { parseDelimited, classify, num, compute, esc, csvField, csvSafe, parseCogsText, sampleReport };
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (typeof window !== "undefined") window.SETTLECLEAR_CORE = core;

})();
