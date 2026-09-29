/* Local-only workspace. The calculation engine also runs independently in Node tests. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  if (!$("#drop") || !window.SETTLECLEAR_CORE) return;
  const { parseDelimited, compute, esc, csvSafe, parseCogsText, sampleReport } = window.SETTLECLEAR_CORE;
  const symbols = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" };
  const money = (n, currency) => (n < 0 ? "−" : "") + esc(symbols[currency] || currency + " ") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const scrollOptions = () => ({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  let raw = null, last = null, sourceName = "", isSample = false, loadVersion = 0;
  let sortKey = "profit", sortDirection = 1, lossOnly = false;
  const hasCosts = (res) => res.list.some((r) => r.hasCogs && r.units !== 0);
  const missingCosts = (res) => res.list.filter((r) => r.units > 0 && !r.hasCogs);

  function updateSteps(loaded) {
    ["import", "costs", "review"].forEach((name) => {
      const step = $("#step-" + name), active = name === (loaded ? "review" : "import");
      step.classList.toggle("active", active);
      step.classList.toggle("complete", loaded && name === "import");
      if (active) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
  }

  function clearResults() {
    raw = null; last = null;
    $("#results").hidden = true;
    $("#importError").hidden = true;
    $("#cogsError").hidden = true;
    $("#cogsInput").value = "";
    $("#cogsInput").removeAttribute("aria-invalid");
    ["#summary", "#alerts", "#table thead", "#table tbody", "#feeBreakdown", "#coverageNote", "#rowCount"].forEach((selector) => { $(selector).textContent = ""; });
    $("#cogs details").open = false;
    $("#search").value = "";
    lossOnly = false; sortKey = "profit"; sortDirection = 1;
    $("#lossFilter").setAttribute("aria-pressed", "false");
    updateSteps(false);
  }

  function showError(message) {
    $("#importError").textContent = message;
    $("#importError").hidden = false;
    $("#fileStatus").textContent = "Report not loaded. Choose another file to try again.";
  }

  function render(res, focusResult) {
    if (!res.recognized) {
      clearResults();
      showError("This doesn't look like an Amazon Flat File V2 settlement report. Use a CSV, TXT or TSV containing amount, amount-type and amount-description columns, not a sales dashboard export.");
      return;
    }
    last = res;
    const currency = res.currency, costs = hasCosts(res), missing = missingCosts(res);
    $("#importError").hidden = true;
    $("#results").hidden = false;
    $("#cogs").hidden = false;
    $("#sampleNotice").hidden = !isSample;
    $("#resultSource").textContent = isSample ? "SAMPLE WORKSPACE · ILLUSTRATIVE DATA" : "YOUR REPORT · PROCESSED LOCALLY";
    $("#fileStatus").textContent = isSample ? "Sample loaded. No personal data is being used." : sourceName + " · " + raw.length.toLocaleString() + " rows · only in this tab";
    $("#resultTitle").textContent = isSample ? "A sample, with all the details." : "Your settlement breakdown";
    const card = (label, value, note, featured) => `<div class="card${featured ? " featured" : ""}"><div class="k">${label}</div><div class="v">${value}</div><div class="card-note">${note}</div></div>`;
    $("#summary").innerHTML =
      card("Reported revenue", money(res.totals.revenue, currency), "Includes reported refunds") +
      card("Amazon fees", money(res.totals.fee, currency), "Net fees in this settlement") +
      card(costs ? "Added cost of goods" : "Net units", costs ? money(-res.totals.cogs, currency) : res.totals.units.toLocaleString(), costs ? (missing.length ? "Some SKU costs are missing" : "Based on supplied unit costs") : "Sold units less returned units") +
      card(costs ? "Profit after added costs" : "Net proceeds", money(res.totals.profit, currency), costs ? "Not a complete business P&L" : "Before product costs & overhead", true);
    $("#summary").hidden = false;
    $("#coverageNote").textContent = (costs ? (missing.length ? missing.length + " SKU(s) with net sales have no unit cost. Their costs are not deducted. " : "Unit costs supplied for every SKU with positive net sales. ") : "Product costs have not been added. These are proceeds, not profit. ") + "Only reported amounts and supplied costs are included; separately billed ads, overhead and other missing expenses are not. Promotions in this report: " + res.totals.promo.toFixed(2) + " " + currency + ".";

    const alerts = [];
    if (res.headerTotal === null) {
      alerts.push(["neutral", "No settlement total to compare", "This file has no total-amount value, so we cannot verify reconciliation. The figures below are based on the available rows."]);
    } else {
      const diff = res.grand - res.headerTotal;
      if (Math.abs(diff) > 0.01) alerts.push(["bad", "The totals don't match", `Line items total ${money(res.grand, currency)}; the report total is ${money(res.headerTotal, currency)}. Difference: ${money(diff, currency)}. Check the original report and amount formats before relying on these results.`]);
      else alerts.push(["ok", "The settlement adds up", `Line items reconcile to the report total of ${money(res.headerTotal, currency)}. This checks the arithmetic, not whether every charge was correct.`]);
    }
    const negative = res.list.filter((r) => r.profit < 0 && r.units > 0);
    if (negative.length) alerts.push(["bad", `${negative.length} SKU${negative.length === 1 ? " needs" : "s need"} a closer look`, `Negative results after reported amounts${costs ? " and added costs" : ""}: ${negative.slice(0, 5).map((r) => esc(r.sku)).join(", ")}${negative.length > 5 ? "…" : ""}. Review the underlying rows before making a decision.`]);
    if (res.reserve) alerts.push(["neutral", res.reserve < 0 ? "Reserve held, not a product cost" : "A reserve movement was released", `${money(Math.abs(res.reserve), currency)} ${res.reserve < 0 ? "held" : "released"} in this report. Reserve and deferred movements affect settlement timing, so they are excluded from profit. Release timing depends on Amazon's policies and your account.`]);
    if (res.unclassified.length) alerts.push(["", "Some amount descriptions need review", `${res.unclassified.length} unmapped description(s): ${res.unclassified.slice(0, 6).map(esc).join(", ")}${res.unclassified.length > 6 ? "…" : ""}. These amounts are included as “other”, not silently dropped. They aren't necessarily fees or errors.`]);
    $("#alerts").innerHTML = alerts.map(([kind, title, text]) => `<div class="alert ${kind}"><strong>${title}</strong>${text}</div>`).join("");
    $("#alerts").hidden = false;
    const categories = [["referral", "Referral"], ["fulfillment", "FBA fulfillment"], ["storage", "Storage"], ["advertising", "Advertising"], ["otherFees", "Other fees"]];
    const fees = categories.filter(([key]) => res.feeBreakdown[key] !== 0);
    $("#feeBreakdown").innerHTML = fees.length ? fees.map(([key, label]) => `<div><dt>${label}</dt><dd>${money(res.feeBreakdown[key], currency)}</dd></div>`).join("") : "<div><dt>No classified fee amounts</dt><dd>—</dd></div>";
    $("#reportCurrency").textContent = currency;
    $("#tableWrap").hidden = false;
    updateSteps(true);
    drawTable();
    if (focusResult) {
      $("#resultTitle").focus({ preventScroll: true });
      $("#results").scrollIntoView(scrollOptions());
    }
  }

  function drawTable() {
    if (!last) return;
    const query = $("#search").value.trim().toLowerCase();
    const list = last.list.filter((row) => row.sku.toLowerCase().includes(query) && (!lossOnly || (row.profit < 0 && row.units > 0))).sort((a, b) => {
      return sortDirection * (sortKey === "sku" ? a.sku.localeCompare(b.sku) : a[sortKey] - b[sortKey]);
    });
    const columns = [["sku", "SKU / account item"], ["units", "Net units"], ["revenue", "Revenue"], ["fee", "Fees"], ["promo", "Promotions"], ["cogs", "Added COGS"], ["profit", hasCosts(last) ? "After added costs" : "Net proceeds"]];
    $("#table thead").innerHTML = "<tr>" + columns.map(([key, label]) => `<th scope="col" aria-sort="${sortKey === key ? (sortDirection === 1 ? "ascending" : "descending") : "none"}"><button type="button" data-sort="${key}">${label} <span aria-hidden="true">${sortKey === key ? (sortDirection === 1 ? "↑" : "↓") : "↕"}</span></button></th>`).join("") + "</tr>";
    $("#table tbody").innerHTML = list.length ? list.map((row) => `<tr class="${row.profit < 0 && row.units > 0 ? "neg" : ""}${row.sku.startsWith("(") ? " account-row" : ""}"><td>${esc(row.sku)}</td><td>${row.units}</td><td>${money(row.revenue, last.currency)}</td><td>${money(row.fee, last.currency)}</td><td>${money(row.promo, last.currency)}</td><td>${row.hasCogs ? money(-row.cogs, last.currency) : (row.units > 0 ? '<span title="Unit cost not supplied">Not added</span>' : "—")}</td><td>${money(row.profit, last.currency)}</td></tr>`).join("") : '<tr class="empty-row"><td colspan="7">No matching rows. Try another SKU or turn off the negative-SKU filter.</td></tr>';
    $("#rowCount").textContent = list.length + " OF " + last.list.length + " ROWS";
  }

  function run(focusResult) {
    if (!raw) return;
    const parsed = parseCogsText($("#cogsInput").value);
    $("#cogsError").hidden = !parsed.errors.length;
    $("#cogsInput").setAttribute("aria-invalid", parsed.errors.length ? "true" : "false");
    if (parsed.errors.length) {
      $("#cogsError").textContent = "Check line(s) " + parsed.errors.join(", ") + ". Use SKU,cost with a non-negative numeric cost (for example MY-SKU,4.20). Results still use your last applied costs.";
      $("#cogs details").open = true;
      return;
    }
    render(compute(raw, parsed.map), focusResult);
  }

  function handleFile(file) {
    const version = ++loadVersion;
    clearResults();
    isSample = false;
    sourceName = file.name;
    if (!/\.(csv|txt|tsv)$/i.test(file.name)) {
      showError("Choose a CSV, TXT or TSV settlement report. PDF and Excel workbook files are not supported.");
      return;
    }
    // Bound in-tab work so an accidental large file doesn't freeze the entire page.
    if (file.size > 30 * 1024 * 1024) {
      showError("This file is over 30 MB. Export a shorter settlement period and try again.");
      return;
    }
    $("#fileStatus").textContent = "Reading " + file.name + " locally…";
    const reader = new FileReader();
    reader.onload = () => {
      if (version !== loadVersion) return;
      try {
        const parsed = parseDelimited(String(reader.result));
        if (!["amount", "amount-type", "amount-description"].every((name) => parsed.headers.includes(name))) {
          showError("This file is missing settlement columns. Please use an Amazon Flat File V2 report with amount, amount-type and amount-description columns.");
          return;
        }
        raw = parsed.rows;
        run(true);
      } catch (error) {
        clearResults();
        showError("We couldn't read this report. Try exporting it again as a CSV, TXT or TSV settlement file.");
      }
    };
    reader.onerror = () => { if (version === loadVersion) showError("Your browser couldn't read that file. Check that it is available on this device, then try again."); };
    reader.readAsText(file);
  }

  function download(name, csv) {
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const drop = $("#drop");
  ["dragover", "dragenter"].forEach((event) => drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((event) => drop.addEventListener(event, () => drop.classList.remove("drag")));
  drop.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  $("#pick").addEventListener("click", () => $("#file").click());
  $("#file").addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ""; });
  $("#apply").addEventListener("click", () => run(false));
  $("#search").addEventListener("input", drawTable);
  $("#lossFilter").addEventListener("click", () => { lossOnly = !lossOnly; $("#lossFilter").setAttribute("aria-pressed", String(lossOnly)); drawTable(); });
  $("#table thead").addEventListener("click", (e) => {
    const button = e.target.closest("[data-sort]");
    if (!button) return;
    const key = button.dataset.sort;
    sortDirection = sortKey === key ? -sortDirection : 1;
    sortKey = key;
    drawTable();
    $("#table thead [data-sort='" + key + "']").focus({ preventScroll: true });
  });
  $("#reset").addEventListener("click", () => {
    loadVersion++;
    clearResults();
    isSample = false; sourceName = "";
    $("#file").value = "";
    $("#cogsInput").removeAttribute("aria-invalid");
    $("#fileStatus").textContent = "Report cleared. Nothing was stored or uploaded.";
    $("#pick").focus({ preventScroll: true });
    $("#tool").scrollIntoView(scrollOptions());
  });
  document.querySelectorAll("[data-demo]").forEach((button) => button.addEventListener("click", () => {
    loadVersion++;
    clearResults();
    const sample = sampleReport();
    raw = parseDelimited(sample.text).rows;
    isSample = true; sourceName = "Sample settlement";
    $("#cogsInput").value = sample.costs;
    run(true);
  }));
  $("#export").addEventListener("click", () => {
    if (!last) return;
    const header = "sku,units,revenue,fees,promo,added_cogs," + (hasCosts(last) ? "profit_after_added_costs" : "net_proceeds") + ",cost_provided,currency\n";
    const body = last.list.map((r) => [csvSafe(r.sku), r.units, r.revenue.toFixed(2), r.fee.toFixed(2), r.promo.toFixed(2), r.hasCogs ? (-r.cogs).toFixed(2) : "", r.profit.toFixed(2), r.hasCogs ? "yes" : "no", csvSafe(last.currency)].join(",")).join("\n");
    download(isSample ? "sample-profit-by-sku.csv" : "profit-by-sku.csv", header + body);
  });
  $("#exportAudit").addEventListener("click", () => {
    if (!last) return;
    const rows = [["issue_type", "sku_or_item", "detail", "amount", "currency"]];
    if (isSample) rows.push(["sample_data", "", "Illustrative sample, not your business results", "", last.currency]);
    if (last.headerTotal !== null) {
      const diff = last.grand - last.headerTotal;
      rows.push(["reconciliation", "(settlement)", Math.abs(diff) > 0.01 ? "Line items do not match report total" : "Line items match report total; not proof of correct charges", diff.toFixed(2), last.currency]);
    } else rows.push(["reconciliation_unavailable", "(settlement)", "No report total present", "", last.currency]);
    last.list.filter((r) => r.profit < 0 && r.units > 0).forEach((r) => rows.push(["negative_sku", r.sku, "Negative after reported amounts and supplied costs", r.profit.toFixed(2), last.currency]));
    missingCosts(last).forEach((r) => rows.push(["missing_cost", r.sku, "Unit cost not provided; product cost not deducted", "", last.currency]));
    last.unclassified.forEach((description) => rows.push(["unmapped_amount", description, "Included as other; classification needs review", "", last.currency]));
    if (last.reserve) rows.push(["reserve_movement", "(settlement)", "Timing movement, excluded from profit", last.reserve.toFixed(2), last.currency]);
    rows.push(["scope", "", "Only report amounts and supplied costs; not a full business P&L or proof of overcharges", "", last.currency]);
    download(isSample ? "sample-audit-report.csv" : "audit-report.csv", rows.map((r) => r.map(csvSafe).join(",")).join("\n"));
  });

  // Optional configured links stay dormant until a real destination is supplied.
  const config = window.SETTLECLEAR || {};
  for (const [key, label] of [["supportUrl", "Support this free tool"], ["proWaitlistUrl", "Join the Pro waitlist"]]) {
    if (!config[key]) continue;
    const link = document.createElement("a"); link.href = config[key]; link.textContent = label; link.rel = "noopener";
    $(".footer-links").appendChild(link);
  }
})();
