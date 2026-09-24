const { parseDelimited, classify, compute } = require("./assets/app.js");
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
ok(wbUnits === 40, "WIDGET-BLUE counts 40 sold units (not per-fee-line), got " + wbUnits);
ok(Math.abs(res.totals.profit - 149.58) < 0.01, "total net profit 149.58, got " + res.totals.profit.toFixed(2));
console.log("\nTotals:", { revenue: res.totals.revenue.toFixed(2), fees: res.totals.fee.toFixed(2), profit: res.totals.profit.toFixed(2) });
process.exit(fail ? 1 : 0);
