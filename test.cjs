const { parseDelimited, classify, compute, num, esc, csvField, csvSafe } = require("./assets/app.js");
let fail = 0;
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); fail++; } else console.log("ok:", m); };

const csv = [
  "settlement-id,currency,total-amount,transaction-type,order-id,sku,quantity-purchased,amount-type,amount-description,amount",
  "90210,USD,773.58,,,,,,,",
  "90210,USD,,Order,111-1,WIDGET-BLUE,40,ItemPrice,Principal,799.60",
  "90210,USD,,Order,111-1,WIDGET-BLUE,40,ItemPrice,Tax,64.00",
  "90210,USD,,Order,111-1,WIDGET-BLUE,40,ItemFees,Commission,-119.94",
  "90210,USD,,Order,111-1,WIDGET-BLUE,40,ItemFees,FBAPerUnitFulfillmentFee,-132.00",
  "90210,USD,,Order,111-1,WIDGET-BLUE,40,ItemWithheldTax,MarketplaceFacilitatorTax-Principal,-64.00",
  "90210,USD,,Order,111-2,MUG-4PK,22,ItemPrice,Principal,439.78",
  "90210,USD,,Order,111-2,MUG-4PK,22,ItemFees,Commission,-65.97",
  "90210,USD,,Order,111-2,MUG-4PK,22,ItemFees,FBAPerUnitFulfillmentFee,-114.40",
  "90210,USD,,Order,111-2,MUG-4PK,22,Promotion,Shipping,-18.00",
  "90210,USD,,Order,111-3,CABLE-2M,60,ItemPrice,Principal,359.40",
  "90210,USD,,Order,111-3,CABLE-2M,60,ItemFees,Commission,-53.91",
  "90210,USD,,Order,111-3,CABLE-2M,60,ItemFees,FBAPerUnitFulfillmentFee,-193.20",
  "90210,USD,,Order,111-3,CABLE-2M,60,ItemFees,FBAStorageFee,-22.50",
  "90210,USD,,Refund,111-1,WIDGET-BLUE,2,ItemPrice,Principal,-39.98",
  "90210,USD,,Refund,111-1,WIDGET-BLUE,2,ItemFees,RefundCommission,6.00",
  "90210,USD,,other-transaction,,,,other,Cost of Advertising,-71.30",
].join("\n");

const { rows } = parseDelimited(csv);
ok(rows.length === 17, "parsed 17 line rows, got " + rows.length);
ok(classify("ItemFees", "Commission") === "fee", "commission is a fee");
ok(classify("ItemPrice", "Tax") === "tax", "tax is pass-through");

const res = compute(rows, { "WIDGET-BLUE": 7.5, "MUG-4PK": 9.0, "CABLE-2M": 2.1 });
ok(Math.abs(res.grand - 773.58) < 0.01, "line items sum to deposit total 773.58, got " + res.grand.toFixed(2));
ok(res.headerTotal === 773.58, "header total read");
const wb = res.list.find((o) => o.sku === "WIDGET-BLUE");
ok(Math.abs(wb.netProceeds - 513.68) < 0.01, "WIDGET-BLUE net proceeds 513.68, got " + wb.netProceeds.toFixed(2));
ok(res.list.length === 4, "4 skus incl advertising bucket, got " + res.list.length);
const wbUnits = res.list.find((o) => o.sku === "WIDGET-BLUE").units;
ok(wbUnits === 38, "WIDGET-BLUE net units = 40 sold - 2 refunded = 38, got " + wbUnits);
ok(Math.abs(res.totals.profit - 164.58) < 0.01, "total net profit 164.58 (COGS on net units), got " + res.totals.profit.toFixed(2));
const fb = res.feeBreakdown;
ok(Math.abs(fb.referral + 233.82) < 0.01, "fee breakdown: referral -233.82, got " + fb.referral.toFixed(2));
ok(Math.abs(fb.fulfillment + 439.6) < 0.01, "fee breakdown: FBA fulfillment -439.60, got " + fb.fulfillment.toFixed(2));
ok(Math.abs(fb.storage + 22.5) < 0.01, "fee breakdown: storage -22.50, got " + fb.storage.toFixed(2));
ok(Math.abs(fb.advertising + 71.3) < 0.01, "fee breakdown: advertising -71.30, got " + fb.advertising.toFixed(2));
ok(Math.abs((fb.referral + fb.fulfillment + fb.storage + fb.advertising + fb.otherFees) - res.totals.fee) < 0.01, "fee breakdown sums to total fees");
console.log("\nTotals:", { revenue: res.totals.revenue.toFixed(2), fees: res.totals.fee.toFixed(2), profit: res.totals.profit.toFixed(2) });

// --- extended classify coverage (hardened parser) ---
ok(classify("other-transaction", "StorageRenewalBilling") === "fee", "storage renewal is a fee");
ok(classify("ServiceFee", "Subscription") === "fee", "subscription is a fee");
ok(classify("other-transaction", "FBAInboundTransportationFee") === "fee", "inbound transport is a fee");
ok(classify("other-transaction", "Current reserve amount") === "reserve", "reserve → reserve bucket");
ok(classify("other-transaction", "Deferred transaction release") === "reserve", "deferred → reserve bucket");
ok(classify("ItemFees", "FixedClosingFee") === "fee", "closing fee is a fee");
ok(classify("ItemPrice", "Principal") === "revenue", "principal is revenue");
ok(classify("", "") === "skip", "blank line skipped");

// reserve must not change profit but must stay in the deposit reconciliation
const withReserve = parseDelimited(csv + "\n90210,USD,,other-transaction,,,,other-transaction,Current reserve amount,-50.00").rows;
const r2 = compute(withReserve, {});
ok(Math.abs(r2.grand - 723.58) < 0.01, "reserve moves the deposit (grand 723.58), got " + r2.grand.toFixed(2));
ok(r2.reserve === -50, "reserve total surfaced separately (-50), got " + r2.reserve);
const baseNoCogs = compute(parseDelimited(csv).rows, {}).totals.profit;
ok(Math.abs(r2.totals.profit - baseNoCogs) < 0.01, "reserve does NOT change profit, got " + r2.totals.profit.toFixed(2) + " vs " + baseNoCogs.toFixed(2));

// --- locale-aware amount parsing (EU comma-decimal vs US comma-thousands) ---
ok(num("799.60") === 799.6, "US plain decimal");
ok(num("1,234.56") === 1234.56, "US thousands comma + decimal dot");
ok(num("-71.30") === -71.3, "US negative");
ok(num("95,00") === 95, "EU comma decimal 95,00 -> 95, got " + num("95,00"));
ok(num("1.234,56") === 1234.56, "EU dot-thousands comma-decimal -> 1234.56, got " + num("1.234,56"));
ok(num("-64,00") === -64, "EU negative comma decimal, got " + num("-64,00"));
ok(num("") === 0 && num(null) === 0 && num("  ") === 0, "blank/null -> 0");
ok(num("EUR 1.000,00") === 1000, "currency-prefixed EU amount, got " + num("EUR 1.000,00"));
// A EU-format settlement (comma decimals) still reconciles
const euCsv = [
  "settlement-id,currency,total-amount,transaction-type,order-id,sku,quantity-purchased,amount-type,amount-description,amount",
  "77,EUR,\"180,06\",,,,,,,",
  "77,EUR,,Order,111-9,EU-SKU,10,ItemPrice,Principal,\"250,00\"",
  "77,EUR,,Order,111-9,EU-SKU,10,ItemFees,Commission,\"-37,50\"",
  "77,EUR,,Order,111-9,EU-SKU,10,ItemFees,FBAPerUnitFulfillmentFee,\"-32,44\"",
].join("\n");
const eu = compute(parseDelimited(euCsv).rows, {});
ok(Math.abs(eu.grand - 180.06) < 0.01, "EU file reconciles to 180,06, got " + eu.grand.toFixed(2));
ok(Math.abs(eu.totals.revenue - 250) < 0.01, "EU revenue parsed as 250, got " + eu.totals.revenue.toFixed(2));

// --- escaping + CSV quoting (untrusted SKU/description from the uploaded file) ---
ok(esc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', "esc neutralises tags");
ok(esc('a&b"c\'') === 'a&amp;b&quot;c&#39;', "esc handles &, quotes");
ok(esc("plain-sku") === "plain-sku", "esc leaves safe text");
ok(csvField("A,B") === '"A,B"', "csvField quotes commas");
ok(csvField('he said "hi"') === '"he said ""hi"""', "csvField doubles quotes");
// a SKU containing a comma must not create extra columns in profit export
const injCsv = [
  "settlement-id,currency,total-amount,transaction-type,order-id,sku,quantity-purchased,amount-type,amount-description,amount",
  "1,USD,10.00,,,,,,,",
  '1,USD,,Order,o1,"BAD,SKU",1,ItemPrice,Principal,10.00',
].join("\n");
const inj = compute(parseDelimited(injCsv).rows, {});
ok(inj.list.some((o) => o.sku === "BAD,SKU"), "SKU with comma parsed intact, got " + JSON.stringify(inj.list.map((o) => o.sku)));

// --- robustness: recognize non-settlement / empty input ---
ok(compute([], {}).recognized === false, "empty input → not recognized");
const junk = parseDelimited("name,age,city\nAlice,30,NYC\nBob,25,LA").rows;
ok(compute(junk, {}).recognized === false, "random CSV → not recognized");
ok(compute(junk, {}).list.length === 0, "random CSV → no phantom SKUs");
ok(compute(parseDelimited(csv).rows, {}).recognized === true, "real settlement → recognized");
ok(compute(parseDelimited("").rows, {}).recognized === false, "blank file → not recognized (no throw)");

// --- R8 audit fixes ---
// #10 accounting-format negatives must not flip positive
ok(num("(12.34)") === -12.34, "paren negative -> -12.34, got " + num("(12.34)"));
ok(num("$ (50.00)") === -50, "currency+paren negative -> -50, got " + num("$ (50.00)"));
ok(num("(1,234.56)") === -1234.56, "paren US negative -> -1234.56, got " + num("(1,234.56)"));
ok(num("1,234.56") === 1234.56, "positive unaffected");
// #1 currency is escaped (XSS): a currency carrying HTML is neutralised in money()/render
ok(compute(parseDelimited("currency,sku,amount-type,amount-description,amount\n<img src=x onerror=alert(1)>,FOO,ItemPrice,Principal,100").rows, {}).currency.indexOf("<") === -1, "currency sanitised (no angle brackets)");
// #15 CSV formula injection neutralised
ok(csvSafe("=1+1") === "\"'=1+1\"", "csvSafe prefixes apostrophe on formula, got " + csvSafe("=1+1"));
ok(csvSafe("@x") === "\"'@x\"", "csvSafe guards @");
ok(csvSafe("normal") === '"normal"', "csvSafe leaves normal text quoted");
ok(csvSafe("A,B") === '"A,B"', "csvSafe still quotes commas");
// #11 multiple settlement blocks: headerTotal sums distinct settlement-ids
const multi = [
  "settlement-id,currency,total-amount,transaction-type,sku,quantity-purchased,amount-type,amount-description,amount",
  "A,USD,100.00,,,,,,",
  "A,USD,,Order,S1,1,ItemPrice,Principal,100.00",
  "B,USD,50.00,,,,,,",
  "B,USD,,Order,S2,1,ItemPrice,Principal,50.00",
].join("\n");
ok(compute(parseDelimited(multi).rows, {}).headerTotal === 150, "multi-settlement headerTotal = 100+50 = 150, got " + compute(parseDelimited(multi).rows, {}).headerTotal);
// #24 lone-CR line endings still parse into rows
ok(parseDelimited("h1,h2\ra,b\rc,d").rows.length === 2, "lone-CR newlines → 2 rows, got " + parseDelimited("h1,h2\ra,b\rc,d").rows.length);

// Workspace sample stays consistent with the public preview, not invented dashboard numbers.
const { parseCogsText, sampleReport } = require("./assets/app.js");
const sample = sampleReport();
const sampleCosts = parseCogsText(sample.costs);
const sampleResult = compute(parseDelimited(sample.text).rows, sampleCosts.map);
ok(sampleCosts.errors.length === 0, "sample cost input is valid");
ok(Math.abs(sampleResult.totals.profit - 164.58) < 0.01, "preview profit matches runnable sample: 164.58");
ok(Math.abs(sampleResult.totals.cogs - 609) < 0.01, "preview COGS matches runnable sample: 609");
ok(Math.abs(sampleResult.grand - sampleResult.headerTotal) < 0.01, "sample reconciles including reserve");
ok(sampleResult.reserve === -50, "sample keeps reserve separate from profit");
ok(Math.abs(sampleResult.list.find(r => r.sku === "CABLE-2M").profit + 36.21) < 0.01, "preview negative SKU matches sample");
ok(parseCogsText("A,0\nB,4.2\nC,1,23").map.C === 1.23, "cost input supports zero and comma-decimal costs");
ok(parseCogsText("A,-2\nB,abc\nC,\nD,1,2,3\nmissing-comma").errors.length === 5, "invalid costs aren't silently treated as zero");
const zeroCosts = compute(parseDelimited(sample.text).rows, parseCogsText("CABLE-2M,0").map);
ok(zeroCosts.list.find(r => r.sku === "CABLE-2M").hasCogs, "explicit zero is a supplied cost");
ok(!zeroCosts.list.find(r => r.sku === "MUG-4PK").hasCogs, "missing cost stays distinguishable from zero");
const special = compute([{sku: "constructor", "amount-type": "ItemPrice", "amount-description": "Principal", amount: "10", "quantity-purchased": "1"}], {});
ok(special.list[0].profit === 10 && !special.list[0].hasCogs, "prototype keys don't become phantom costs");
const specialCosts = parseCogsText("__proto__,4.00\nconstructor,2.00");
ok(specialCosts.map.__proto__ === 4 && specialCosts.map.constructor === 2, "cost input treats prototype names as plain SKUs");

process.exit(fail ? 1 : 0);
