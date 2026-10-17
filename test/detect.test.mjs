import assert from "node:assert/strict";
import test from "node:test";
import {
  buildViewerUrl,
  dispositionFilenameIsPdf,
  interceptDecision,
  isHostBypassed,
  isPdfResponse,
  pdfUrlFromViewerUrl,
} from "../extension/background/detect.js";
import { DEFAULT_SETTINGS } from "../extension/shared/settings.js";

const h = obj => Object.entries(obj).map(([name, value]) => ({ name, value }));
const event = (url, headers, extra = {}) => ({ url, method: "GET", statusCode: 200, type: "main_frame", responseHeaders: h(headers), ...extra });
const decide = (e, settings = {}) => interceptDecision(e, { ...DEFAULT_SETTINGS, ...settings });

test("PDF content type is detected regardless of URL suffix", () => {
  assert.ok(isPdfResponse("https://arxiv.org/pdf/1804.03252", h({ "Content-Type": "application/pdf" })));
  assert.ok(isPdfResponse("https://x.test/a", h({ "content-type": "Application/PDF; charset=binary" })));
  assert.ok(!isPdfResponse("https://x.test/a.pdf", h({ "Content-Type": "text/html" })));
});

test("octet-stream counts only with a .pdf path or filename", () => {
  assert.ok(isPdfResponse("https://s3.test/bucket/paper.PDF?sig=1", h({ "Content-Type": "application/octet-stream" })));
  assert.ok(isPdfResponse("https://x.test/get?id=3", h({ "Content-Type": "binary/octet-stream", "Content-Disposition": 'inline; filename="r.pdf"' })));
  assert.ok(!isPdfResponse("https://x.test/get?id=3", h({ "Content-Type": "application/octet-stream" })));
  assert.ok(!isPdfResponse("https://x.test/a.zip", h({ "Content-Type": "application/octet-stream" })));
});

test("Content-Disposition filename parsing", () => {
  assert.ok(dispositionFilenameIsPdf('attachment; filename="a b.pdf"'));
  assert.ok(dispositionFilenameIsPdf("inline; filename=report.pdf; size=3"));
  assert.ok(dispositionFilenameIsPdf("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"));
  assert.ok(!dispositionFilenameIsPdf('attachment; filename="a.pdf.zip"'));
});

test("intercepts top-level GET PDF responses", () => {
  assert.deepEqual(decide(event("https://arxiv.org/pdf/1804.03252", { "Content-Type": "application/pdf" })), { intercept: true, reason: "pdf" });
});

test("leaves downloads, non-GET, errors, frames and disabled state alone", () => {
  const pdf = { "Content-Type": "application/pdf" };
  assert.equal(decide(event("https://x.test/a.pdf", { ...pdf, "Content-Disposition": "attachment; filename=a.pdf" })).reason, "attachment");
  assert.equal(decide(event("https://x.test/a.pdf", { ...pdf, "Content-Disposition": "attachment" }), { interceptAttachments: true }).intercept, true);
  assert.equal(decide(event("https://x.test/a.pdf", pdf, { method: "POST" })).reason, "not-get");
  assert.equal(decide(event("https://x.test/a.pdf", pdf, { statusCode: 404 })).reason, "status");
  assert.equal(decide(event("https://x.test/a.pdf", pdf, { type: "sub_frame" })).reason, "not-top-level");
  assert.equal(decide(event("https://x.test/a.pdf", pdf), { interceptEnabled: false }).reason, "disabled");
});

test("per-site bypass matches the host and its subdomains", () => {
  assert.ok(isHostBypassed("https://www.example.com/a.pdf", ["example.com"]));
  assert.ok(isHostBypassed("https://example.com/a.pdf", ["example.com"]));
  assert.ok(!isHostBypassed("https://notexample.com/a.pdf", ["example.com"]));
  const e = event("https://cdn.example.com/a.pdf", { "Content-Type": "application/pdf" });
  assert.equal(decide(e, { bypassHosts: ["example.com"] }).reason, "site-bypassed");
});

test("viewer URL round-trips the PDF URL and keeps the fragment outside", () => {
  const base = "moz-extension://abc/pdfjs/web/viewer.html";
  const url = buildViewerUrl(base, "https://x.test/a b.pdf?x=1&y=2#page=3");
  assert.equal(url, `${base}?file=${encodeURIComponent("https://x.test/a b.pdf?x=1&y=2")}#page=3`);
  assert.equal(pdfUrlFromViewerUrl(url, base), "https://x.test/a b.pdf?x=1&y=2");
  assert.equal(pdfUrlFromViewerUrl("https://x.test/", base), null);
});
