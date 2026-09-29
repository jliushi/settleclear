"""Browser regression checks. Run: python test-browser.py (requires Playwright + Chromium)."""
import csv
import io
import json
import os
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def check(condition, message):
    assert condition, message
    print("ok:", message)


def run(base):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        page = context.new_page()
        errors, uploads = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.on("request", lambda request: uploads.append(request.url) if request.method != "GET" else None)
        response = page.goto(base, wait_until="networkidle")
        check(response.status == 200, "homepage responds successfully")
        expect(page.locator("#results")).to_be_hidden()
        check(page.locator("h1").count() == 1, "one descriptive main heading")
        check(page.locator('link[rel="canonical"]').get_attribute("href") == "https://jliushi.github.io/settleclear/", "canonical URL preserved")
        for schema in page.locator('script[type="application/ld+json"]').all_text_contents():
            json.loads(schema)
        check(True, "structured data parses")

        page.get_by_role("button", name="Try it with sample data").click()
        expect(page.locator("#sampleNotice")).to_be_visible()
        expect(page.locator("#summary .featured .v")).to_have_text("$164.58")
        expect(page.locator("#table tbody tr")).to_have_count(4)
        check(page.locator("#resultTitle").evaluate("el => el === document.activeElement"), "sample moves keyboard focus to results")
        check("$723.58" in page.locator("#alerts").inner_text(), "sample settlement reconciles including reserve")
        page.locator("#lossFilter").click()
        expect(page.locator("#table tbody tr")).to_have_count(1)
        expect(page.locator("#table tbody")).to_contain_text("CABLE-2M")
        page.locator("#search").fill("no-such-sku")
        expect(page.locator(".empty-row")).to_contain_text("No matching rows")
        page.locator("#search").fill("")
        page.locator("#lossFilter").click()
        page.locator('[data-sort="sku"]').click()
        expect(page.locator('th[aria-sort="ascending"]')).to_contain_text("SKU")
        page.locator('[data-sort="sku"]').press("Enter")
        expect(page.locator('th[aria-sort="descending"]')).to_contain_text("SKU")
        check(True, "SKU filtering, negative filter, empty state and keyboard sorting")

        page.locator("#cogs summary").click()
        page.locator("#cogsInput").fill("CABLE-2M,0")
        page.locator("#apply").click()
        expect(page.locator("#coverageNote")).to_contain_text("2 SKU(s)")
        expect(page.locator("#table tbody")).to_contain_text("Not added")
        expect(page.locator("#summary .featured .v")).to_have_text("$773.58")
        page.locator("#cogsInput").fill("CABLE-2M,not-a-number")
        page.locator("#apply").click()
        expect(page.locator("#cogsError")).to_be_visible()
        expect(page.locator("#summary .featured .v")).to_have_text("$773.58")
        check(True, "zero costs differ from missing costs; invalid costs preserve previous calculation")
        page.locator("#cogsInput").fill("")
        page.locator("#apply").click()
        expect(page.locator("#summary .featured .k")).to_have_text("Net proceeds")
        expect(page.locator("#cogsError")).to_be_hidden()

        page.locator("#demo").click()
        with page.expect_download() as event:
            page.locator("#export").click()
        download = event.value
        check(download.suggested_filename == "sample-profit-by-sku.csv", "sample exports are labeled")
        rows = list(csv.DictReader(io.StringIO(Path(download.path()).read_text(encoding="utf-8-sig"))))
        check(len(rows) == 4 and rows[0]["currency"] == "USD", "CSV contains every row and currency")
        check(abs(sum(float(r["profit_after_added_costs"]) for r in rows) - 164.58) < .01, "exported profit matches displayed total")
        with page.expect_download() as event:
            page.locator("#exportAudit").click()
        audit = Path(event.value.path()).read_text(encoding="utf-8-sig")
        check("reserve_movement" in audit and "sample_data" in audit and "scope" in audit, "audit exports preserve scope and reserve context")

        fixture = 'settlement-id,currency,total-amount,transaction-type,sku,quantity-purchased,amount-type,amount-description,amount\n1,USD,90,,,,,,\n1,USD,,Order,MY-SKU,2,ItemPrice,Principal,100\n1,USD,,Order,MY-SKU,2,ItemFees,Commission,-10'
        page.locator("#file").set_input_files({"name": "my-settlement.csv", "mimeType": "text/csv", "buffer": fixture.encode()})
        expect(page.locator("#sampleNotice")).to_be_hidden()
        expect(page.locator("#summary .featured .v")).to_have_text("$90.00")
        expect(page.locator("#cogsInput")).to_have_value("")
        expect(page.locator("#summary .featured .k")).to_have_text("Net proceeds")
        check(True, "real import does not inherit sample costs or sample labels")
        with page.expect_download() as event:
            page.locator("#export").click()
        check(event.value.suggested_filename == "profit-by-sku.csv", "real report has regular export filename")

        quoted_fixture = fixture.replace("MY-SKU", '"BAD,SKU"')
        page.locator("#file").set_input_files({"name": "quoted.csv", "mimeType": "text/csv", "buffer": quoted_fixture.encode()})
        expect(page.locator("#results")).to_be_visible()
        page.locator("#cogs summary").click()
        page.locator("#cogsInput").fill('"BAD,SKU",4.20')
        page.locator("#apply").click()
        expect(page.locator("#summary .featured .v")).to_have_text("$81.60")
        check(True, "quoted comma-containing SKUs receive their costs in the browser")

        page.locator("#file").set_input_files({"name": "wrong.csv", "mimeType": "text/csv", "buffer": b'name,age\nA,1'})
        expect(page.locator("#importError")).to_be_visible()
        expect(page.locator("#results")).to_be_hidden()
        check(page.locator("#table tbody").inner_text() == "", "invalid import clears stale report data")
        page.locator("#file").set_input_files({"name": "wrong.pdf", "mimeType": "application/pdf", "buffer": b'%PDF-test'})
        expect(page.locator("#importError")).to_contain_text("not supported")
        page.locator("#file").set_input_files({"name": "empty.csv", "mimeType": "text/csv", "buffer": b''})
        expect(page.locator("#results")).to_be_hidden()
        check(True, "invalid and unsupported files show a useful error, not zero-profit results")

        payload = fixture.replace("MY-SKU", "<img src=x onerror=alert(1)>")
        page.locator("#file").set_input_files({"name": "untrusted.csv", "mimeType": "text/csv", "buffer": payload.encode()})
        expect(page.locator("#table tbody")).to_contain_text("<img src=x onerror=alert(1)>")
        check(page.locator("#table img").count() == 0, "uploaded SKU text cannot inject HTML")
        page.locator("#reset").click()
        expect(page.locator("#results")).to_be_hidden()
        check(page.locator("#table tbody").inner_text() == "", "clear report removes data from the DOM")
        check(page.locator("#pick").evaluate("el => el === document.activeElement"), "clear returns keyboard focus to import")

        # No network is needed once the page has loaded.
        context.set_offline(True)
        page.locator("#demo").click()
        expect(page.locator("#summary .featured .v")).to_have_text("$164.58")
        with page.expect_download() as event:
            page.locator("#export").click()
        check(bool(event.value.path()), "analysis and export work offline")
        context.set_offline(False)
        check(not uploads, "no POST/upload requests during imports or analysis")

        for width in (320, 390, 768, 1024, 1440):
            page.set_viewport_size({"width": width, "height": 900})
            page.goto(base, wait_until="networkidle")
            check(not page.evaluate("document.documentElement.scrollWidth > innerWidth"), f"no page overflow at {width}px")
            page.locator("#demo").click()
            expect(page.locator("#tableWrap")).to_be_visible()
            check(not page.evaluate("document.documentElement.scrollWidth > innerWidth"), f"results stay within viewport at {width}px")
        for path in ("guide.html", "pro.html", "amazon-payout-less-than-sales.html", "fba-fees.html"):
            page.set_viewport_size({"width": 390, "height": 844})
            page.goto(base + path, wait_until="networkidle")
            check(not page.evaluate("document.documentElement.scrollWidth > innerWidth"), f"reading room responsive: {path}")
        check(not errors, "no browser or JavaScript errors: " + repr(errors))
        no_js = browser.new_context(java_script_enabled=False)
        static = no_js.new_page()
        static.goto(base)
        expect(static.locator("h1")).to_contain_text("Your sales aren't")
        check("needs JavaScript" in static.locator("noscript").text_content(), "no-JavaScript fallback is present")
        check(static.locator('a[href="guide.html"]').count() > 0, "content and guides remain available without JavaScript")
        browser.close()


if __name__ == "__main__":
    external_base = os.environ.get("SETTLECLEAR_URL")
    if external_base:
        run(external_base.rstrip("/") + "/")
    else:
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            run(f"http://127.0.0.1:{server.server_port}/")
        finally:
            server.shutdown()
