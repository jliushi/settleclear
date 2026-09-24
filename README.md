# SettleClear

Free, open-source, **100% client-side** tool to turn an Amazon **settlement report** into **true profit per SKU** after every fee — with a fee audit that flags overcharges and unreconciled lines.

Live: **https://jliushi.github.io/settleclear/**

## Why
Seller Central shows revenue. Amazon deducts 40+ fee types (referral, FBA fulfillment, storage, refund admin, ads) before the money reaches your bank. SettleClear reads the settlement line by line, classifies every fee, joins your COGS, and shows what you actually keep — then flags the rows that don't reconcile.

## Privacy
There is no backend. Your settlement file is parsed in your browser and never uploaded. You can go offline after the page loads and it still works.

## Develop
Pure static site — no build step. Open `index.html` in a browser, or serve the folder:

```bash
python -m http.server 8000   # then open http://localhost:8000
```

Files: `index.html` (tool + FAQ), `guide.html` (SEO/GEO content), `assets/app.js` (parser + compute), `assets/style.css`.

## Monetisation (dormant by default)
Revenue channels are pre-wired but off. In `assets/app.js`, the `CONFIG` object at the top has three empty fields — `supportUrl`, `proWaitlistUrl`, `affiliateTag`. Paste a value into any one and that channel activates on next load (a support link, a Pro CTA). Nothing renders while they're empty, so no dead links ship. Receiving money still requires you to create the destination account (e.g. Ko-fi, a form, Amazon Associates) — that's the only step the code can't do for you.

## License
MIT. Not affiliated with Amazon.
