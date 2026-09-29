# SettleClear

Free, open-source, **100% client-side** tool for understanding an Amazon **settlement report**: per-SKU proceeds, profit after supplied product costs, fee breakdowns and reconciliation checks. Review flags are not proof of overcharges, and report-based results are not a complete business P&L.

Live: **https://jliushi.github.io/settleclear/**

## Why
A payout isn't a profit statement. SettleClear separates the revenue, fees, promotions and account-level movements present in the report, lets you add unit costs, and highlights rows worth reviewing. Missing unit costs, unmapped amounts and reserve movements stay explicit; separately billed ads, overhead and other absent costs are not included.

## Privacy
There is no backend. Your settlement file is parsed in your browser and never uploaded. You can go offline after the page loads and it still works.

## Develop
Pure static site — no build step. Open `index.html` in a browser, or serve the folder:

```bash
python -m http.server 8000   # then open http://localhost:8000
```

Files: `index.html` (homepage + workspace), `guide.html` and other articles (seller library), `assets/app.js` (parser + pure calculations + sample fixture), `assets/workspace.js` (local-only UI), `assets/style.css` (shared design).

The sample preview is tied to the tested fixture, and sample exports are labeled. Real uploads never inherit sample costs. The workspace supports SKU search, keyboard-accessible sorting, negative-SKU filtering, explicit missing-cost coverage and CSV exports. Imports are limited to 30 MB to bound browser memory usage; no data is stored.

### Tests

```bash
node test.cjs                       # calculation, escaping, cost and sample regressions
python -m pip install playwright     # one-time browser test dependency
python -m playwright install chromium
python test-browser.py              # starts its own local server
```

Browser checks cover imports, sample/real state, invalid files, zero/missing costs, input validation, filtering, sorting, export contents, DOM escaping, offline operation, 320–1440px layouts, article layouts and no-JavaScript fallbacks.

To run the same checks against a deployed copy, set `SETTLECLEAR_URL=https://jliushi.github.io/settleclear/`. Test files remain in the browser; no settlement data is submitted to a server.

## Monetisation (dormant by default)
Optional links are pre-wired but off. In `assets/app.js`, `CONFIG.supportUrl` and `CONFIG.proWaitlistUrl` accept a real support or waitlist destination; `affiliateTag` is reserved for future integrations and currently unused. Nothing renders while the destinations are empty. The planned Pro tier is not available for purchase.

## License
MIT. Not affiliated with Amazon.
