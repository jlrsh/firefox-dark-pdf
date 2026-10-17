#!/usr/bin/env node
// Downloads the pinned PDF.js release into extension/pdfjs/ and injects the
// extension's stylesheet and boot script into its viewer.html.
//
// PDF.js itself is not modified: viewer.html gains two tags, every other file
// is byte-for-byte the upstream release.
//
//   node scripts/fetch-pdfjs.mjs [--zip path/to/pdfjs-dist.zip] [--keep-maps]

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PDFJS_VERSION = "6.4.299";
const PDFJS_SHA256 = "f2245eb7ef3f674c872fe568a177bfec15874f5c034613e55d8e307f93ebd86d";
const PDFJS_URL = `https://github.com/mozilla/pdf.js/releases/download/v${PDFJS_VERSION}/pdfjs-${PDFJS_VERSION}-dist.zip`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "extension", "pdfjs");
const args = process.argv.slice(2);
const zipArg = args.includes("--zip") ? args[args.indexOf("--zip") + 1] : null;
const keepMaps = args.includes("--keep-maps");

// Tags added to viewer.html. Our boot script must run after pdf.mjs and
// before viewer.mjs, so it can wrap pdfjsLib.getDocument before the viewer
// captures it.
const INJECTIONS = [
  {
    anchor: '<link rel="stylesheet" href="viewer.css" />',
    insert: '\n    <link rel="stylesheet" href="../../viewer/viewer-ext.css" />',
    position: "after",
  },
  {
    anchor: '<script src="viewer.mjs" type="module"></script>',
    insert: '<script src="../../viewer/boot.js" type="module"></script>\n  ',
    position: "before",
  },
];

async function getZip() {
  if (zipArg) {
    return fs.readFileSync(zipArg);
  }
  console.log(`Downloading ${PDFJS_URL}`);
  const response = await fetch(PDFJS_URL);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function patchViewerHtml(file) {
  let html = fs.readFileSync(file, "utf8");
  for (const { anchor, insert, position } of INJECTIONS) {
    const count = html.split(anchor).length - 1;
    if (count !== 1) {
      throw new Error(`viewer.html: expected one occurrence of ${anchor}, found ${count}. Has the PDF.js layout changed?`);
    }
    html = html.replace(anchor, position === "after" ? anchor + insert : insert + anchor);
  }
  fs.writeFileSync(file, html);
}

function removeFiles(dir, predicate) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeFiles(full, predicate);
    } else if (predicate(entry.name)) {
      fs.rmSync(full);
    }
  }
}

const zip = await getZip();
const digest = createHash("sha256").update(zip).digest("hex");
if (digest !== PDFJS_SHA256) {
  throw new Error(`Checksum mismatch for PDF.js ${PDFJS_VERSION}: got ${digest}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdfjs-"));
try {
  const zipPath = path.join(tmp, "pdfjs.zip");
  fs.writeFileSync(zipPath, zip);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("unzip", ["-q", zipPath, "-d", dest], { stdio: "inherit" });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The sample document is the viewer's defaultUrl, which we disable.
fs.rmSync(path.join(dest, "web", "compressed.tracemonkey-pldi-09.pdf"), { force: true });
if (!keepMaps) {
  removeFiles(dest, name => name.endsWith(".map"));
}
patchViewerHtml(path.join(dest, "web", "viewer.html"));
fs.writeFileSync(path.join(dest, "VERSION"), `${PDFJS_VERSION}\n`);
console.log(`PDF.js ${PDFJS_VERSION} installed in ${path.relative(root, dest)}/`);
