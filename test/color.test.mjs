import assert from "node:assert/strict";
import test from "node:test";
import { chromaWeight, createColorMapper, oklabToRgb, parseColor, rgbToOklab, toHex } from "../extension/shared/color.js";

const BG = "#1e1e1e";
const FG = "#dcdcdc";
const L = c => rgbToOklab(parseColor(c))[0];
const near = (a, b, tol = 2) => parseColor(a).every((v, i) => Math.abs(v - parseColor(b)[i]) <= tol);

test("parses the color strings PDF.js produces", () => {
  assert.deepEqual(parseColor("#1f77b4"), [31, 119, 180]);
  assert.deepEqual(parseColor("#fff"), [255, 255, 255]);
  assert.deepEqual(parseColor("rgb(1, 2, 3)"), [1, 2, 3]);
  assert.deepEqual(parseColor("rgba(1 2 3 / 0.5)"), [1, 2, 3]);
  assert.equal(parseColor("transparent"), null);
});

test("OKLab round trip is lossless for in-gamut colors", () => {
  for (const c of ["#000000", "#ffffff", "#1f77b4", "#ff7f0e", "#2ca02c", "#808080", "#ccccff"]) {
    assert.ok(near(toHex(oklabToRgb(rgbToOklab(parseColor(c)))), c, 1), c);
  }
});

test("black text becomes the foreground, white fill becomes the background", () => {
  const m = createColorMapper({ background: BG, foreground: FG });
  assert.ok(near(m.text("#000000"), FG));
  assert.ok(near(m.vector("#ffffff").color, BG));
  assert.ok(near(m.background("#ffffff").color, BG));
  assert.ok(near(m.vector("#000000").color, FG));
});

test("gray lightness is reversed monotonically", () => {
  const m = createColorMapper({ background: BG, foreground: FG });
  const grays = ["#000000", "#333333", "#666666", "#999999", "#cccccc", "#ffffff"];
  const out = grays.map(g => L(m.vector(g).color));
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i] < out[i - 1], `${grays[i]} should map darker than ${grays[i - 1]}`);
  }
});

test("preserve policy keeps saturated plot colors exactly", () => {
  const m = createColorMapper({ background: BG, foreground: FG, vectorPolicy: "preserve" });
  for (const c of ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"]) {
    assert.deepEqual(m.vector(c), { color: c, keep: true });
  }
});

test("preserve policy lifts colors that would vanish into the background", () => {
  const m = createColorMapper({ background: BG, foreground: FG, vectorPolicy: "preserve" });
  const { color, keep } = m.vector("#1a1a40");
  assert.ok(keep);
  assert.ok(L(color) - L(BG) >= 0.119);
});

test("adapt policy reverses lightness but keeps hue", () => {
  const m = createColorMapper({ background: BG, foreground: FG, vectorPolicy: "adapt" });
  const pastel = rgbToOklab(parseColor("#ccccff"));
  const out = rgbToOklab(parseColor(m.vector("#ccccff").color));
  assert.ok(out[0] < 0.45, "light pastel becomes dark");
  const hue = lab => Math.atan2(lab[2], lab[1]);
  assert.ok(Math.abs(hue(out) - hue(pastel)) < 0.15, "hue preserved");
  assert.equal(m.vector("#ccccff").keep, false);
});

test("colored text stays colored and readable on the dark background", () => {
  const m = createColorMapper({ background: BG, foreground: FG });
  for (const c of ["#0000ff", "#000080", "#008000", "#ff0000", "#800080"]) {
    const out = m.text(c);
    assert.ok(L(out) - L(BG) >= 0.6 * (L(FG) - L(BG)) - 1e-3, `${c} -> ${out} too dark`);
    assert.ok(chromaWeight(rgbToOklab(parseColor(out))) > 0.5, `${c} -> ${out} lost its color`);
  }
});

test("page-sized dark fills are left alone (already-dark slides)", () => {
  const m = createColorMapper({ background: BG, foreground: FG });
  assert.deepEqual(m.background("#000000"), { color: "#000000", keep: true });
  assert.equal(m.background("#f5f5dc").keep, false);
});

test("gradients: gray ones are mapped, colored ones kept unless forced", () => {
  const m = createColorMapper({ background: BG, foreground: FG });
  const gray = m.gradientStops([[0, "#ffffff"], [1, "#808080"]]);
  assert.ok(near(gray[0][1], BG));
  assert.equal(m.gradientStops([[0, "#ff0000"], [1, "#0000ff"]]), null);
  assert.ok(m.gradientStops([[0, "#ffeeee"], [1, "#ff0000"]], true));
});

test("unparseable colors pass through", () => {
  const m = createColorMapper();
  assert.equal(m.text("transparent"), "transparent");
  assert.deepEqual(m.vector("transparent"), { color: "transparent", keep: false });
});
