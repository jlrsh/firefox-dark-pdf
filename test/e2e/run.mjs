#!/usr/bin/env node
// End-to-end checks in a real Firefox: interception, viewer features, and the
// pixels each dark mode produces on the generated fixtures.
//
//   FIREFOX_BINARY=/path/to/firefox GECKODRIVER=/path/to/geckodriver npm run e2e -- [--online] [--headed]
//
// --online also loads https://arxiv.org/pdf/1804.03252. Screenshots are
// written to test/e2e/output/. Needs geckodriver 0.36 or later (for
// --allow-system-access, without which WebDriver cannot script extension pages).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Builder, By } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { MIXED_LAYOUT as L } from "../fixture-layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(root, "test", "fixtures");
const outDir = path.join(root, "test", "e2e", "output");
const args = process.argv.slice(2);
const ONLINE = args.includes("--online");
const HEADED = args.includes("--headed");

const BG = [0x1e, 0x1e, 0x1e];
const FG = [0xdc, 0xdc, 0xdc];

// ---------------------------------------------------------------- test server

const requestLog = [];
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requestLog.push({ path: url.pathname, range: req.headers.range ?? null, cookie: req.headers.cookie ?? "" });
    const [, route, name = ""] = url.pathname.split("/");
    const file = path.join(fixtures, name.endsWith(".pdf") ? name : `${name}.pdf`);
    if (route === "login") {
      res.writeHead(200, { "Set-Cookie": "auth=1; Path=/; SameSite=Lax", "Content-Type": "text/html" });
      res.end("<p>logged in</p>");
      return;
    }
    if (route === "redirect") {
      res.writeHead(302, { Location: `/noext/${name}` });
      res.end();
      return;
    }
    if (route === "linkpage") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<!doctype html><title>link page</title><input id="field"><a id="pdf" href="/files/mixed.pdf">paper</a>');
      return;
    }
    if (route === "page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>plain page</title><p>Not a PDF</p>");
      return;
    }
    if (!name || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (route === "cookie" && !/auth=1/.test(req.headers.cookie ?? "")) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const headers = {
      files: { "Content-Type": "application/pdf" },
      noext: { "Content-Type": "application/pdf" },
      cookie: { "Content-Type": "application/pdf" },
      octet: { "Content-Type": "application/octet-stream" },
      attachment: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"` },
    }[route];
    if (!headers) {
      res.writeHead(404);
      res.end();
      return;
    }
    const data = fs.readFileSync(file);
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const common = { ...headers, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : data.length - 1;
      res.writeHead(206, { ...common, "Content-Range": `bytes ${start}-${end}/${data.length}`, "Content-Length": end - start + 1 });
      res.end(data.subarray(start, end + 1));
    } else {
      res.writeHead(200, { ...common, "Content-Length": data.length });
      res.end(data);
    }
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------------------------------------------------------------- harness

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}${detail ? ` (${detail})` : ""}`);
  } catch (ex) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n        ${String(ex?.stack ?? ex).split("\n").slice(0, 3).join("\n        ")}`);
  }
}

function assert(cond, message) {
  if (!cond) {
    throw new Error(message);
  }
}

const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const fmt = c => `rgb(${c.map(Math.round).join(",")})`;

async function waitFor(driver, script, timeout = 20000, ...scriptArgs) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await driver.executeScript(script, ...scriptArgs);
      if (last) {
        return last;
      }
    } catch (ex) {
      last = ex;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for: ${script.slice(0, 120)} (last: ${last})`);
}

async function waitForUrl(driver, predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  let url;
  while (Date.now() < end) {
    url = await driver.getCurrentUrl();
    if (predicate(url)) {
      return url;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`URL condition not met; last URL ${url}`);
}

// Resolves once page `n` (1-based) has finished rendering since `armRenderWatch`.
const ARM_WATCH = `
  const app = window.PDFViewerApplication;
  window.__darkPdfRendered = new Set();
  if (!window.__darkPdfWatching) {
    window.__darkPdfWatching = true;
    app.eventBus.on("pagerendered", e => window.__darkPdfRendered.add(e.pageNumber));
  }`;

const PAGE_RENDERED = `
  const app = window.PDFViewerApplication;
  const page = arguments[0] ?? app?.page;
  return !!(app?.pdfDocument && app.pdfViewer.getPageView(page - 1)?.renderingState === 3);`;

// Opens `url`, expects the extension viewer, and leaves it showing `page`
// (PDF.js otherwise restores the last position it remembers for a document).
async function openViewer(driver, url, page = 1) {
  await driver.get(url);
  const viewerUrl = await waitForUrl(driver, u => u.startsWith("moz-extension://"));
  await waitFor(driver, PAGE_RENDERED);
  if (page) {
    await showPage(driver, page);
  }
  await driver.executeScript(ARM_WATCH);
  return viewerUrl;
}

// Firefox opens finished PDF downloads in a new tab, which would leave the
// viewer in a background tab where rendering pauses.
async function closeExtraTabs(driver, mainHandle) {
  for (const handle of await driver.getAllWindowHandles()) {
    if (handle !== mainHandle) {
      await driver.switchTo().window(handle);
      await driver.close();
    }
  }
  await driver.switchTo().window(mainHandle);
}

async function showPage(driver, page) {
  await driver.executeScript("PDFViewerApplication.pdfViewer.scrollPageIntoView({ pageNumber: arguments[0] })", page);
  await waitFor(driver, PAGE_RENDERED, 20000, page);
}

// Changes settings the way the popup/options page do, then waits for the
// viewer to repaint `waitPage` (0: don't wait).
async function setSettings(driver, patch, waitPage = 1) {
  if (waitPage) {
    await showPage(driver, waitPage);
  }
  await driver.executeScript(ARM_WATCH);
  await driver.executeScript("return browser.storage.local.set(arguments[0])", patch);
  if (waitPage) {
    await waitFor(driver, `return window.__darkPdfRendered.has(${waitPage})`);
  }
}

// Average color of a small square around a PDF user-space point on a page.
async function sample(driver, x, y, page = 1, radius = 1) {
  return driver.executeScript(
    `const [x, y, page, r] = arguments;
     const view = PDFViewerApplication.pdfViewer.getPageView(page - 1);
     const canvas = view.div.querySelector(".canvasWrapper canvas");
     const [vx, vy] = view.viewport.convertToViewportPoint(x, y);
     const s = canvas.width / view.viewport.width;
     const px = Math.round(vx * s), py = Math.round(vy * s);
     const d = canvas.getContext("2d").getImageData(px - r, py - r, 2 * r + 1, 2 * r + 1).data;
     const sum = [0, 0, 0];
     for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
     const n = d.length / 4;
     return sum.map(v => v / n);`,
    x,
    y,
    page,
    radius
  );
}

// Luma range over a PDF-space box: tells whether light/dark ink is present.
async function lumaRange(driver, [x, y, w, h], page = 1) {
  return driver.executeScript(
    `const [x, y, w, h, page] = arguments;
     const view = PDFViewerApplication.pdfViewer.getPageView(page - 1);
     const canvas = view.div.querySelector(".canvasWrapper canvas");
     const s = canvas.width / view.viewport.width;
     const [ax, ay] = view.viewport.convertToViewportPoint(x, y + h);
     const [bx, by] = view.viewport.convertToViewportPoint(x + w, y);
     const d = canvas.getContext("2d").getImageData(Math.round(ax * s), Math.round(ay * s), Math.max(1, Math.round((bx - ax) * s)), Math.max(1, Math.round((by - ay) * s))).data;
     let min = 255, max = 0;
     for (let i = 0; i < d.length; i += 4) {
       const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
       if (l < min) min = l;
       if (l > max) max = l;
     }
     return [min, max];`,
    x,
    y,
    w,
    h,
    page
  );
}

async function screenshot(driver, name) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), await driver.takeScreenshot(), "base64");
}

// Points inside the photo, away from its text labels.
const PHOTO_POINTS = [
  [L.photo[0] + 40, L.photo[1] + 100],
  [L.photo[0] + 120, L.photo[1] + 60],
  [L.photo[0] + 200, L.photo[1] + 140],
];

// ---------------------------------------------------------------- main

if (!fs.existsSync(path.join(fixtures, "mixed.pdf"))) {
  execFileSync(process.execPath, [path.join(root, "scripts", "make-fixtures.mjs")], { stdio: "inherit" });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dark-pdf-e2e-"));
const xpi = path.join(tmp, "dark-pdf-viewer.xpi");
execFileSync("zip", ["-qr", xpi, "."], { cwd: path.join(root, "extension") });
const downloads = path.join(tmp, "downloads");
fs.mkdirSync(downloads);

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;

const options = new firefox.Options();
if (process.env.FIREFOX_BINARY) {
  options.setBinary(process.env.FIREFOX_BINARY);
}
if (!HEADED) {
  options.addArguments("-headless");
}
options.setPreference("browser.download.folderList", 2);
options.setPreference("browser.download.dir", downloads);
options.setPreference("browser.download.useDownloadDir", true);
options.setPreference("browser.download.always_ask_before_handling_new_types", false);
options.setPreference("browser.download.open_pdf_attachments_inline", false);
options.setPreference("browser.helperApps.neverAsk.saveToDisk", "application/pdf");

// Extension pages count as privileged; WebDriver only scripts them with this.
const service = new firefox.ServiceBuilder(process.env.GECKODRIVER || undefined).addArguments("--allow-system-access");
const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(service).build();

try {
  await driver.manage().window().setRect({ width: 1400, height: 1100 });
  await driver.installAddon(xpi, true);
  const mainHandle = await driver.getWindowHandle();
  const caps = await driver.getCapabilities();
  console.log(`Firefox ${caps.get("browserVersion")}, server ${base}\n`);

  console.log("Interception");
  let viewerBase;
  await check("PDF typed into an empty tab opens in that tab", async () => {
    const handles = await driver.getAllWindowHandles();
    requestLog.length = 0;
    const url = await openViewer(driver, `${base}/files/mixed.pdf`);
    viewerBase = url.slice(0, url.indexOf("?"));
    assert(url.includes(`?file=${encodeURIComponent(`${base}/files/mixed.pdf`)}`), `unexpected viewer URL ${url}`);
    assert((await driver.getAllWindowHandles()).length === handles.length, "a new tab was opened");
    const gets = requestLog.filter(r => r.path === "/files/mixed.pdf");
    return `${url.slice(0, 40)}…; server saw ${gets.length} requests (${gets.filter(r => r.range).length} ranged)`;
  });
  await check("PDF link opens the viewer in a new tab; the page stays in the original tab", async () => {
    await driver.get(`${base}/linkpage/`);
    await driver.findElement(By.id("field")).sendKeys("unsaved input");
    const before = await driver.getAllWindowHandles();
    await driver.findElement(By.id("pdf")).click();
    let added;
    const end = Date.now() + 10000;
    while (!added && Date.now() < end) {
      added = (await driver.getAllWindowHandles()).find(h => !before.includes(h));
      await new Promise(r => setTimeout(r, 100));
    }
    assert(added, "no new tab opened");
    await new Promise(r => setTimeout(r, 1000));
    const field = await driver.findElement(By.id("field")).getAttribute("value");
    const state = [await driver.getCurrentUrl(), await driver.getTitle(), await driver.executeScript("return history.length")];
    assert(state[0] === `${base}/linkpage/` && state[1] === "link page", `original tab changed: ${state}`);
    assert(field === "unsaved input", "the original page was reloaded");
    await driver.switchTo().window(added);
    await waitForUrl(driver, u => u.startsWith(viewerBase));
    await waitFor(driver, PAGE_RENDERED);
    // The rest of the suite drives a single tab.
    await driver.executeScript("return browser.storage.local.set({ openInNewTab: false })");
    await driver.close();
    await driver.switchTo().window(mainHandle);
    return `original tab history.length ${state[2]}`;
  });
  await check("URL without .pdf suffix is detected from Content-Type", async () => {
    const url = await openViewer(driver, `${base}/noext/mixed`);
    assert(url.includes(encodeURIComponent(`${base}/noext/mixed`)), url);
  });
  await check("application/octet-stream with .pdf path is detected", async () => {
    await openViewer(driver, `${base}/octet/mixed.pdf`);
  });
  await check("redirect chain ending in a PDF is intercepted", async () => {
    const url = await openViewer(driver, `${base}/redirect/mixed`);
    assert(url.includes(encodeURIComponent(`${base}/noext/mixed`)), url);
  });
  await check("URL fragment is kept (#page=2)", async () => {
    await openViewer(driver, `${base}/files/mixed.pdf#page=2`, null);
    await waitFor(driver, "return PDFViewerApplication.page === 2");
  });
  await check("cookies are sent when the viewer fetches the PDF", async () => {
    await driver.get(`${base}/login`);
    await openViewer(driver, `${base}/cookie/mixed`);
  });
  await check("PDF sent as attachment is left to Firefox (download)", async () => {
    await driver.get(`${base}/page/`);
    // A download never completes as a navigation, so don't wait on driver.get.
    await driver.executeScript("location.href = arguments[0]", `${base}/attachment/mixed.pdf`);
    await new Promise(r => setTimeout(r, 2500));
    const url = await driver.getCurrentUrl();
    assert(!url.startsWith("moz-extension://"), `intercepted: ${url}`);
    await new Promise(r => setTimeout(r, 1000));
    await closeExtraTabs(driver, mainHandle);
    return `stayed on ${url}; downloads: ${fs.readdirSync(downloads).join(", ") || "none"}`;
  });
  await check("ordinary HTML pages are untouched", async () => {
    await driver.get(`${base}/page/`);
    assert((await driver.getTitle()) === "plain page", "HTML page not shown");
  });

  console.log("\nViewer features");
  await openViewer(driver, `${base}/files/mixed.pdf`);
  await check("text layer is present for selection", async () => {
    const text = await driver.executeScript(`return document.querySelector('.page[data-page-number="1"] .textLayer')?.textContent ?? ""`);
    assert(text.includes("Selective dark mode test"), `text layer: ${text.slice(0, 80)}`);
  });
  await check("search finds text on a later page", async () => {
    const total = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      const app = PDFViewerApplication;
      app.eventBus.on("updatefindmatchescount", e => { if (e.matchesCount.total) done(e.matchesCount.total); });
      app.eventBus.dispatch("find", { source: null, type: "", query: "needle-3-7", caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false });
      setTimeout(() => done(0), 10000);`);
    assert(total >= 1, "no matches");
    return `${total} match`;
  });
  await check("download saves the original bytes", async () => {
    const before = new Set(fs.readdirSync(downloads));
    await showPage(driver, 1);
    const button = await driver.findElement(By.id("downloadButton"));
    if (await button.isDisplayed()) {
      await button.click();
    } else {
      await driver.executeScript("document.getElementById('secondaryDownload').click()");
    }
    const end = Date.now() + 10000;
    let saved;
    while (Date.now() < end && !saved) {
      saved = fs.readdirSync(downloads).find(f => !before.has(f) && f.endsWith(".pdf"));
      await new Promise(r => setTimeout(r, 200));
    }
    assert(saved, "no file downloaded");
    await new Promise(r => setTimeout(r, 500));
    const same = fs.readFileSync(path.join(downloads, saved)).equals(fs.readFileSync(path.join(fixtures, "mixed.pdf")));
    assert(same, "downloaded bytes differ from the original");
    await closeExtraTabs(driver, mainHandle);
    return saved;
  });
  await check("print rendering uses original colors", async () => {
    const corner = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      (async () => {
        const page = await PDFViewerApplication.pdfDocument.getPage(1);
        const viewport = page.getViewport({ scale: 0.5 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvas, viewport, intent: "print" }).promise;
        done(Array.from(canvas.getContext("2d").getImageData(5, 5, 1, 1).data.slice(0, 3)));
      })().catch(e => done(String(e)));`);
    assert(Array.isArray(corner) && dist(corner, [255, 255, 255]) <= 2, `print background ${corner}`);
  });

  console.log("\nSelective dark mode (default)");
  await setSettings(driver, { mode: "off" });
  const reference = {
    photo: await Promise.all(PHOTO_POINTS.map(([x, y]) => sample(driver, x, y))),
    alpha: await sample(driver, L.alphaImage[0] + 25, L.alphaImage[1] + 50),
  };
  await check("original mode: white page, original photo", async () => {
    const bg = await sample(driver, 590, 770);
    assert(dist(bg, [255, 255, 255]) <= 2, `page ${fmt(bg)}`);
  });
  await screenshot(driver, "mixed-off");

  await setSettings(driver, { mode: "selective" });
  await screenshot(driver, "mixed-selective");
  await check("page background becomes the dark color", async () => {
    const bg = await sample(driver, 590, 770);
    assert(dist(bg, BG) <= 3, fmt(bg));
  });
  await check("black body text becomes light", async () => {
    const [, max] = await lumaRange(driver, [50, 708, 300, 14]);
    assert(max > 170, `brightest text pixel luma ${max}`);
  });
  await check("photo pixels are identical to the original rendering", async () => {
    const now = await Promise.all(PHOTO_POINTS.map(([x, y]) => sample(driver, x, y)));
    const worst = Math.max(...now.map((c, i) => dist(c, reference.photo[i])));
    assert(worst <= 3, `max channel difference ${worst}`);
    return `max channel difference ${worst}`;
  });
  await check("labels drawn on the photo keep their colors", async () => {
    const [min] = await lumaRange(driver, [L.photo[0] + 10, L.photo[1] + 10, 140, 12]);
    const [, max] = await lumaRange(driver, [L.photo[0] + 10, L.photo[1] + L.photo[3] - 24, 140, 12]);
    assert(min < 40, `black label lightest-dark pixel ${min}`);
    assert(max > 230, `white label brightest pixel ${max}`);
  });
  await check("pastel box keeps its color and its black text", async () => {
    const box = await sample(driver, L.pastelBox[0] + 220, L.pastelBox[1] + 10);
    assert(dist(box, [0xcc, 0xe5, 0xff]) <= 3, `box ${fmt(box)}`);
    const [min] = await lumaRange(driver, [62, 594, 150, 12]);
    assert(min < 50, `text min luma ${min}`);
  });
  await check("navy box keeps its color and its white text", async () => {
    const box = await sample(driver, L.navyBox[0] + 220, L.navyBox[1] + 10);
    assert(dist(box, [0x1f, 0x3a, 0x93]) <= 3, `box ${fmt(box)}`);
    const [, max] = await lumaRange(driver, [332, 594, 150, 12]);
    assert(max > 220, `text max luma ${max}`);
  });
  await check("plot: white area darkened, colored series kept", async () => {
    const area = await sample(driver, L.plot[0] + 200, L.plot[1] + 185);
    assert(dist(area, BG) <= 6, `plot area ${fmt(area)}`);
    // tab:blue series at its first point.
    const [px, py, , ph] = L.plot;
    const blue = await sample(driver, px + 20 + 0.5 * 210, py + 20 + 0.5 * (ph - 30), 1, 0);
    assert(dist(blue, [0x1f, 0x77, 0xb4]) <= 12, `series ${fmt(blue)}`);
  });
  await check("transparent image: alpha respected, colors kept", async () => {
    const inside = await sample(driver, L.alphaImage[0] + 25, L.alphaImage[1] + 50);
    const corner = await sample(driver, L.alphaImage[0] + 3, L.alphaImage[1] + 3);
    assert(dist(inside, reference.alpha) <= 3, `inside ${fmt(inside)} vs ${fmt(reference.alpha)}`);
    assert(dist(corner, BG) <= 4, `transparent corner ${fmt(corner)}`);
  });
  await check("soft mask is not inverted (opaque left, transparent right)", async () => {
    const left = await sample(driver, L.maskedRect[0] + 8, L.maskedRect[1] + 50);
    const right = await sample(driver, L.maskedRect[0] + L.maskedRect[2] - 4, L.maskedRect[1] + 50);
    assert(dist(left, [0xff, 0x8c, 0x00]) <= 30, `left ${fmt(left)}`);
    assert(dist(right, BG) <= 12, `right ${fmt(right)}`);
  });
  await check("gray gradient remapped, colored gradient kept", async () => {
    const grayStart = await sample(driver, L.grayGradient[0] + 2, L.grayGradient[1] + 20);
    const colorStart = await sample(driver, L.colorGradient[0] + 2, L.colorGradient[1] + 20);
    assert(dist(grayStart, BG) <= 10, `gray gradient start ${fmt(grayStart)}`);
    assert(dist(colorStart, [230, 26, 26]) <= 15, `color gradient start ${fmt(colorStart)}`);
  });
  await check("stencil mask (bitmap glyph) recolored like text", async () => {
    const ring = await sample(driver, L.stencil[0] + 30, L.stencil[1] + 52, 1, 0);
    const hole = await sample(driver, L.stencil[0] + 30, L.stencil[1] + 30);
    assert(luma(ring) > 150, `ring ${fmt(ring)}`);
    assert(dist(hole, BG) <= 6, `hole ${fmt(hole)}`);
  });
  await check("multiply highlight stays visible and text readable", async () => {
    const [min, max] = await lumaRange(driver, L.highlight);
    const tint = await sample(driver, L.highlight[0] + L.highlight[2] - 6, L.highlight[1] + 4);
    assert(tint[0] > 120 && tint[1] > 120 && tint[2] < 120, `highlight ${fmt(tint)}`);
    assert(max - min > 40, `no contrast in highlight (${min}-${max})`);
  });

  console.log("\nSelective dark mode, adapt policy");
  await setSettings(driver, { vectorPolicy: "adapt" });
  await screenshot(driver, "mixed-selective-adapt");
  await check("pastel box darkened, its text light", async () => {
    const box = await sample(driver, L.pastelBox[0] + 220, L.pastelBox[1] + 10);
    assert(luma(box) < 90 && box[2] > box[0], `box ${fmt(box)}`);
    const [, max] = await lumaRange(driver, [62, 594, 150, 12]);
    assert(max > 170, `text max luma ${max}`);
  });
  await check("photo still identical", async () => {
    const now = await Promise.all(PHOTO_POINTS.map(([x, y]) => sample(driver, x, y)));
    assert(Math.max(...now.map((c, i) => dist(c, reference.photo[i]))) <= 3, "photo changed");
  });
  await setSettings(driver, { vectorPolicy: "preserve" });

  console.log("\nBasic dark mode (PDF.js pageColors)");
  await setSettings(driver, { mode: "basic" });
  await screenshot(driver, "mixed-basic");
  await check("background dark, text light", async () => {
    const bg = await sample(driver, 590, 770);
    assert(dist(bg, BG) <= 3, fmt(bg));
    const [, max] = await lumaRange(driver, [50, 708, 300, 14]);
    assert(max > 170, `text luma ${max}`);
  });
  await check("photo loses its colors (documented limitation of basic mode)", async () => {
    const now = await Promise.all(PHOTO_POINTS.map(([x, y]) => sample(driver, x, y)));
    const chroma = Math.max(...now.map(c => Math.max(...c) - Math.min(...c)));
    assert(chroma < 25, `photo still colored (max chroma ${chroma})`);
    return `max channel spread ${chroma.toFixed(0)} vs ${Math.max(...reference.photo.map(c => Math.max(...c) - Math.min(...c))).toFixed(0)} originally`;
  });

  console.log("\nToggling back to original colors");
  await setSettings(driver, { mode: "off" });
  await check("dark mode off restores original pixels", async () => {
    const now = await Promise.all(PHOTO_POINTS.map(([x, y]) => sample(driver, x, y)));
    assert(Math.max(...now.map((c, i) => dist(c, reference.photo[i]))) <= 3, "photo differs");
    assert(dist(await sample(driver, 590, 770), [255, 255, 255]) <= 2, "background not white");
  });
  await setSettings(driver, { mode: "selective" });

  console.log("\nScanned PDF");
  await openViewer(driver, `${base}/files/scanned.pdf`);
  await screenshot(driver, "scanned-selective");
  await check("scan stays as scanned (no inversion)", async () => {
    const paper = await sample(driver, 30, 400, 1, 2);
    assert(luma(paper) > 220, `paper ${fmt(paper)}`);
  });
  await check("invisible OCR text is searchable", async () => {
    const total = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      PDFViewerApplication.eventBus.on("updatefindmatchescount", e => { if (e.matchesCount.total) done(e.matchesCount.total); });
      PDFViewerApplication.eventBus.dispatch("find", { source: null, type: "", query: "OCR layer", caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false });
      setTimeout(() => done(0), 8000);`);
    assert(total >= 1, "no match");
  });

  console.log("\nPerformance (large.pdf, 20 pages at 2x)");
  await openViewer(driver, `${base}/files/large.pdf`);
  const timings = {};
  for (const mode of ["off", "basic", "selective"]) {
    await setSettings(driver, { mode });
    timings[mode] = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      (async () => {
        const doc = PDFViewerApplication.pdfDocument;
        const canvas = document.createElement("canvas");
        let total = 0;
        for (let n = 1; n <= 20; n++) {
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: 2 });
          canvas.width = viewport.width; canvas.height = viewport.height;
          const t = performance.now();
          await page.render({ canvas, viewport }).promise;
          total += performance.now() - t;
        }
        done(total / 20);
      })().catch(e => done(String(e)));`);
  }
  await check("selective mode overhead is modest", async () => {
    const detail = Object.entries(timings).map(([m, t]) => `${m} ${Number(t).toFixed(1)} ms`).join(", ");
    assert(timings.selective < timings.off * 2 + 15, detail);
    return `${detail} per page`;
  });
  await setSettings(driver, { mode: "selective" }, 0);

  console.log("\nBypass");
  await openViewer(driver, `${base}/files/mixed.pdf`);
  await check("'Open in Firefox's PDF viewer' leaves the extension without looping", async () => {
    await driver.executeScript("document.getElementById('darkPdfOpenNative').click()");
    const url = await waitForUrl(driver, u => u === `${base}/files/mixed.pdf`);
    await new Promise(r => setTimeout(r, 2000));
    assert((await driver.getCurrentUrl()) === url, "redirected back into the extension");
  });
  await check("per-site bypass leaves that site's PDFs to Firefox", async () => {
    await openViewer(driver, `${base}/noext/mixed`);
    await driver.executeScript("return browser.storage.local.set({ bypassHosts: ['127.0.0.1'] })");
    await driver.get(`${base}/files/mixed.pdf`);
    await new Promise(r => setTimeout(r, 2000));
    const url = await driver.getCurrentUrl();
    assert(!url.startsWith("moz-extension://"), url);
    await driver.get(`${viewerBase}`);
    await driver.executeScript("return browser.storage.local.set({ bypassHosts: [] })");
  });
  await check("global switch off disables interception", async () => {
    await driver.get(viewerBase);
    await driver.executeScript("return browser.storage.local.set({ interceptEnabled: false })");
    await driver.get(`${base}/files/mixed.pdf`);
    await new Promise(r => setTimeout(r, 2000));
    const url = await driver.getCurrentUrl();
    await driver.get(viewerBase);
    await driver.executeScript("return browser.storage.local.set({ interceptEnabled: true })");
    assert(!url.startsWith("moz-extension://"), url);
  });

  if (ONLINE) {
    console.log("\narXiv (online)");
    const arxiv = "https://arxiv.org/pdf/1804.03252";
    await check("arxiv.org/pdf/1804.03252 opens directly in the extension viewer", async () => {
      const url = await openViewer(driver, arxiv);
      assert(url.includes(encodeURIComponent("https://arxiv.org/pdf/")), url);
      const pages = await driver.executeScript("return PDFViewerApplication.pagesCount");
      const title = await driver.getTitle();
      return `${pages} pages, title "${title}"`;
    });
    for (const mode of ["off", "basic", "selective"]) {
      await setSettings(driver, { mode });
      await screenshot(driver, `arxiv-${mode}`);
    }
  }
} finally {
  await driver.quit();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${fs.existsSync(outDir) ? `; screenshots in ${path.relative(root, outDir)}/` : ""}`);
process.exit(failed.length ? 1 : 0);
