#!/usr/bin/env node
// Generates the PDFs used by the end-to-end tests into test/fixtures/.
// Each fixture exercises one class of content whose expected dark-mode
// treatment is known, so tests can sample pixels at fixed positions.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { MIXED_LAYOUT } from "../test/fixture-layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test", "fixtures");

class PdfWriter {
  objects = [];

  reserve() {
    this.objects.push(null);
    return this.objects.length;
  }

  set(id, body) {
    this.objects[id - 1] = Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1");
    return id;
  }

  add(body) {
    return this.set(this.reserve(), body);
  }

  stream(dict, data, compress = true) {
    let bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
    if (compress) {
      bytes = zlib.deflateSync(bytes);
      dict += " /Filter /FlateDecode";
    }
    return this.add(Buffer.concat([Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`, "latin1"), bytes, Buffer.from("\nendstream", "latin1")]));
  }

  build(rootId) {
    const parts = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let offset = parts[0].length;
    const offsets = [];
    this.objects.forEach((body, i) => {
      offsets.push(offset);
      const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
      parts.push(chunk);
      offset += chunk.length;
    });
    let xref = `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) {
      xref += `${String(o).padStart(10, "0")} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${this.objects.length + 1} /Root ${rootId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
    parts.push(Buffer.from(xref, "latin1"));
    return Buffer.concat(parts);
  }
}

function document(pages, build) {
  const pdf = new PdfWriter();
  const pagesId = pdf.reserve();
  const kids = pages.map(page => build(pdf, pagesId, page));
  pdf.set(pagesId, `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  const catalog = pdf.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return pdf.build(catalog);
}

const esc = s => s.replace(/[\\()]/g, m => `\\${m}`);
const rgb = hex => [1, 3, 5].map(i => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4)).join(" ");
const text = (x, y, size, str, color = "#000000", font = "F1") => `BT /${font} ${size} Tf ${rgb(color)} rg ${x} ${y} Td (${esc(str)}) Tj ET\n`;
const rect = (x, y, w, h, color) => `${rgb(color)} rg ${x} ${y} ${w} ${h} re f\n`;

function hsvToRgb(h, s, v) {
  const f = n => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)].map(c => Math.round(c * 255));
}

// A colorful "photo": hue across, brightness down.
function photoPixels(w, h) {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      data.set(hsvToRgb(x / w, 0.85, 0.35 + 0.6 * (1 - y / h)), (y * w + x) * 3);
    }
  }
  return data;
}


function mixedPage(pdf, parent, pageIndex) {
  const L = MIXED_LAYOUT;
  const resources = [];
  let content = "";

  if (pageIndex === 0) {
    const photo = pdf.stream("/Type /XObject /Subtype /Image /Width 128 /Height 128 /ColorSpace /DeviceRGB /BitsPerComponent 8", photoPixels(128, 128));

    // 64x64 green/red image with a circular soft mask (alpha).
    const alphaW = 64;
    const alphaRgb = Buffer.alloc(alphaW * alphaW * 3);
    const alpha = Buffer.alloc(alphaW * alphaW);
    for (let y = 0; y < alphaW; y++) {
      for (let x = 0; x < alphaW; x++) {
        alphaRgb.set(x < alphaW / 2 ? [20, 170, 60] : [220, 40, 40], (y * alphaW + x) * 3);
        alpha[y * alphaW + x] = Math.hypot(x - 31.5, y - 31.5) < 30 ? 255 : 0;
      }
    }
    const smask = pdf.stream(`/Type /XObject /Subtype /Image /Width ${alphaW} /Height ${alphaW} /ColorSpace /DeviceGray /BitsPerComponent 8`, alpha);
    const alphaImage = pdf.stream(`/Type /XObject /Subtype /Image /Width ${alphaW} /Height ${alphaW} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${smask} 0 R`, alphaRgb);

    // 1-bit stencil mask: a ring.
    const sw = 32;
    const stencilBits = Buffer.alloc((sw / 8) * sw);
    for (let y = 0; y < sw; y++) {
      for (let x = 0; x < sw; x++) {
        const d = Math.hypot(x - 15.5, y - 15.5);
        const paint = d < 15 && d > 8;
        if (!paint) {
          // ImageMask: 1 bits are *not* painted with the default Decode [0 1].
          stencilBits[y * (sw / 8) + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
    const stencil = pdf.stream(`/Type /XObject /Subtype /Image /Width ${sw} /Height ${sw} /ImageMask true /BitsPerComponent 1`, stencilBits);

    // Luminosity soft mask: white on the left fading to black on the right,
    // so the masked rectangle is opaque on the left and transparent on the right.
    const [mx, my, mw, mh] = L.maskedRect;
    const fadeShading = pdf.add(`<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [${mx} 0 ${mx + mw} 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >> /Extend [true true] >>`);
    const maskForm = pdf.stream(
      `/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Group << /S /Transparency /CS /DeviceGray >> /Resources << /Shading << /Fade ${fadeShading} 0 R >> >>`,
      `${mx} ${my} ${mw} ${mh} re W n /Fade sh`
    );
    const gsMask = pdf.add(`<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G ${maskForm} 0 R >> >>`);
    const gsMultiply = pdf.add("<< /Type /ExtGState /BM /Multiply >>");

    const [gx, gy, gw, gh] = L.grayGradient;
    const grayShading = pdf.add(`<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${gx} 0 ${gx + gw} 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [0.55 0.55 0.55] /N 1 >> >>`);
    const [cx, , cw] = L.colorGradient;
    const colorShading = pdf.add(`<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${cx} 0 ${cx + cw} 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0.9 0.1 0.1] /C1 [0.1 0.2 0.9] /N 1 >> >>`);

    resources.push(
      `/XObject << /Photo ${photo} 0 R /Alpha ${alphaImage} 0 R /Ring ${stencil} 0 R >>`,
      `/ExtGState << /GSMask ${gsMask} 0 R /GSMul ${gsMultiply} 0 R >>`,
      `/Shading << /Gray ${grayShading} 0 R /Color ${colorShading} 0 R >>`
    );

    content += text(50, 740, 22, "Selective dark mode test", "#000000", "F2");
    content += text(50, 712, 11, "Black body text should turn light gray; the page background dark gray.");
    content += text(50, 696, 11, "Mathematics and symbols are text too: E = mc^2, a + b = c.");
    content += text(50, 676, 11, "Blue hyperlink-colored text stays blue but readable.", "#0000ff");
    content += text(50, 662, 11, "Dark red text stays red.", "#8b0000");
    content += text(50, 648, 11, "Dark green text stays green.", "#006400");

    content += rect(...L.pastelBox, "#cce5ff");
    content += text(62, 596, 12, "Black text on a pastel box");
    content += rect(...L.navyBox, "#1f3a93");
    content += text(332, 596, 12, "White text on a navy box", "#ffffff");

    // Vector plot: white plot area, gray grid, black axes, colored series.
    const [px, py, pw, ph] = L.plot;
    content += rect(px, py, pw, ph, "#ffffff");
    content += `${rgb("#cccccc")} RG 0.5 w\n`;
    for (let i = 1; i < 5; i++) {
      content += `${px + 20} ${py + 20 + i * 32} m ${px + pw - 10} ${py + 20 + i * 32} l S\n`;
    }
    content += `${rgb("#000000")} RG 1.2 w ${px + 20} ${py + 20} m ${px + pw - 10} ${py + 20} l S ${px + 20} ${py + 20} m ${px + 20} ${py + ph - 10} l S\n`;
    const series = [["#1f77b4", x => 0.2 + 0.6 * x], ["#ff7f0e", x => 0.8 - 0.5 * x], ["#2ca02c", x => 0.5 + 0.3 * Math.sin(x * 6)]];
    for (const [color, f] of series) {
      content += `${rgb(color)} RG 2.5 w\n`;
      for (let i = 0; i <= 40; i++) {
        const x = px + 20 + (i / 40) * (pw - 30);
        const y = py + 20 + f(i / 40) * (ph - 30);
        content += `${x.toFixed(2)} ${y.toFixed(2)} ${i ? "l" : "m"}\n`;
      }
      content += "S\n";
    }
    content += text(px + 4, py + 6, 8, "0");
    content += text(px + pw - 30, py + 6, 8, "time");

    const [ix, iy, iw, ih] = L.photo;
    content += `q ${iw} 0 0 ${ih} ${ix} ${iy} cm /Photo Do Q\n`;
    content += text(ix + 10, iy + 12, 12, "Black label on photo");
    content += text(ix + 10, iy + ih - 22, 12, "White label on photo", "#ffffff");

    const [ax, ay, aw, ah] = L.alphaImage;
    content += `q ${aw} 0 0 ${ah} ${ax} ${ay} cm /Alpha Do Q\n`;

    content += `q /GSMask gs ${rect(...L.maskedRect, "#ff8c00")}Q\n`;

    content += `q ${gx} ${gy} ${gw} ${gh} re W n /Gray sh Q\n`;
    const [, cy2, , ch] = L.colorGradient;
    content += `q ${cx} ${cy2} ${cw} ${ch} re W n /Color sh Q\n`;

    const [sx, sy, sw2, sh] = L.stencil;
    content += `q 0 0 0 rg ${sw2} 0 0 ${sh} ${sx} ${sy} cm /Ring Do Q\n`;

    content += text(155, 118, 12, "Highlighted text");
    content += `q /GSMul gs ${rect(...L.highlight, "#ffff00")}Q\n`;
  } else {
    content += text(50, 740, 16, `Page ${pageIndex + 1}`, "#000000", "F2");
    for (let i = 0; i < 40; i++) {
      content += text(50, 710 - i * 16, 10, `Line ${i + 1}: the quick brown fox jumps over the lazy dog. needle-${pageIndex + 1}-${i + 1}`);
    }
  }

  return pagePdf(pdf, parent, content, resources);
}

function pagePdf(pdf, parent, content, resources = []) {
  const contentId = pdf.stream("", content);
  const fonts = `/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> >>`;
  return pdf.add(`<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << ${fonts} ${resources.join(" ")} >> >>`);
}

// A "scanned" page: one full-page grayscale image of off-white paper with
// dark text-like bars, plus an invisible OCR text layer.
function scannedPage(pdf, parent) {
  const w = 612;
  const h = 792;
  const data = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const noise = ((x * 7919 + y * 104729) % 13) - 6;
      const inLine = y > 80 && y < 720 && y % 24 < 9 && x > 60 && x < 560 && (x * 31 + Math.floor(y / 24) * 17) % 97 > 12;
      data[y * w + x] = inLine ? 40 + noise : 238 + noise;
    }
  }
  const scan = pdf.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8`, data);
  const content = `q 612 0 0 792 0 0 cm /Scan Do Q\nBT 3 Tr /F1 12 Tf 60 700 Td (Scanned page OCR layer searchable) Tj ET\n`;
  return pagePdf(pdf, parent, content, [`/XObject << /Scan ${scan} 0 R >>`]);
}

// Many pages of mixed text and vector content, for render timing.
function largePage(pdf, parent, pageIndex) {
  let content = text(50, 750, 14, `Large document page ${pageIndex + 1}`, "#000000", "F2");
  for (let i = 0; i < 50; i++) {
    content += text(50, 725 - i * 13, 9, `Row ${i + 1} of page ${pageIndex + 1} with some filler text to make the line reasonably long.`);
  }
  for (let i = 0; i < 300; i++) {
    const x = 40 + ((i * 37) % 520);
    const y = 40 + ((i * 53) % 40);
    content += rect(x, y, 6, 6, ["#1f77b4", "#cccccc", "#000000"][i % 3]);
  }
  return pagePdf(pdf, parent, content);
}

fs.mkdirSync(outDir, { recursive: true });
const fixtures = {
  "mixed.pdf": document([0, 1, 2], mixedPage),
  "scanned.pdf": document([0], scannedPage),
  "large.pdf": document(Array.from({ length: 300 }, (_, i) => i), largePage),
};
for (const [name, bytes] of Object.entries(fixtures)) {
  fs.writeFileSync(path.join(outDir, name), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
