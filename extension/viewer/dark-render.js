// Dark-mode rendering for PDF.js, applied by patching PDF.js at runtime.
//
// PDF.js paints a page by replaying its operator list through the private
// CanvasGraphics class (src/display/canvas.js). Instead of forking pdf.mjs we
// wrap a few methods on classes reachable from public objects:
//
//   PDFPageProxy.prototype.render                    <- any page object
//   InternalRenderTask.prototype.initializeGraphics  <- renderTask._internalRenderTask
//   CanvasGraphics.prototype.<paint operators>       <- internalRenderTask.gfx
//
// "basic" mode only forwards PDF.js's own `pageColors` option. "selective"
// mode recolors at paint time: the context's fillStyle/strokeStyle is swapped
// for the duration of one text, path or stencil-mask operator and restored
// afterwards, so PDF.js's graphics state never holds a mapped color. Raster
// images are drawn untouched.

import { createColorMapper, parseColor, rgbToOklab } from "../shared/color.js";

const { OPS } = globalThis.pdfjsLib;
const PATCHED = Symbol("darkPdfPatched");
const STATE = Symbol("darkPdfState");
const MAPPED = Symbol("darkPdfMappedPattern");

// Fills covering at least this fraction of the page are page backgrounds.
const BACKGROUND_FRACTION = 0.5;
// Smaller regions (fraction of page area / of page side length) are not
// tracked as backdrops: nothing readable sits on top of them.
const MIN_REGION_AREA = 0.0004;
const MIN_REGION_SIDE = 0.006;
const MAX_REGIONS = 5000;

// Blend modes that only make sense against a light backdrop, and their
// counterparts once lightness has been reversed.
const BLEND_SWAP = {
  multiply: "screen",
  screen: "multiply",
  darken: "lighten",
  lighten: "darken",
  "color-burn": "color-dodge",
  "color-dodge": "color-burn",
};

let config = { mode: "off" };
const warned = new Set();

function warnOnce(message) {
  if (!warned.has(message)) {
    warned.add(message);
    console.warn(`[Dark PDF] ${message}`);
  }
}

export function configureRendering(settings) {
  const lightness = c => rgbToOklab(parseColor(c) ?? [0, 0, 0])[0];
  config = {
    mode: settings.mode,
    background: settings.background,
    foreground: settings.foreground,
    mapper: createColorMapper(settings),
    keepColorsOverImages: settings.keepColorsOverImages,
    swapBlendModes: settings.swapBlendModes && lightness(settings.background) < lightness(settings.foreground),
  };
}

/** Per-render bookkeeping for selective mode. */
class PageState {
  regions = []; // {x0, y0, x1, y1, keep} in page-canvas pixels, in paint order
  keptRegions = 0;
  textDepth = 0; // inside showText (Type3 glyph procedures run nested)
  keepDepth = 0; // inside an operator whose original colors are kept
  maskDepth = 0; // inside content that defines a soft mask: never recolor
  offsets = []; // saved [dx, dy, isMask] for each open transparency group
  dx = 0; // offset of the current group canvas within the page canvas
  dy = 0;
  gradients = new Map();
  forceGradients = false;
  lastGradientMapped = false;

  constructor({ mapper, keepColorsOverImages, swapBlendModes }) {
    this.mapper = mapper;
    this.keepOverImages = keepColorsOverImages;
    this.swapBlend = swapBlendModes;
  }

  start(canvas) {
    this.pageArea = Math.max(1, canvas.width * canvas.height);
    this.minArea = this.pageArea * MIN_REGION_AREA;
    this.minSide = Math.sqrt(this.pageArea) * MIN_REGION_SIDE;
  }

  /** Records a painted region; `box` is in current-canvas pixels. */
  addRegion(box, keep) {
    if (!box || (!keep && this.regions.length >= MAX_REGIONS)) {
      return;
    }
    const x0 = box[0] + this.dx;
    const y0 = box[1] + this.dy;
    const x1 = box[2] + this.dx;
    const y1 = box[3] + this.dy;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w * h < this.minArea || Math.min(w, h) < this.minSide) {
      return;
    }
    this.regions.push({ x0, y0, x1, y1, keep });
    if (keep) {
      this.keptRegions++;
    }
  }

  /** Whether the topmost region under a current-canvas point kept its colors. */
  keptAt(x, y) {
    if (!this.keepOverImages || this.keptRegions === 0) {
      return false;
    }
    x += this.dx;
    y += this.dy;
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) {
        return r.keep;
      }
    }
    return false;
  }

  keptUnder(box) {
    return !!box && this.keptAt((box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
  }

  isPageSized(box) {
    return !!box && (box[2] - box[0]) * (box[3] - box[1]) >= this.pageArea * BACKGROUND_FRACTION;
  }

  /** Color for a solid fill, or null to paint it unchanged. */
  fill(color, box) {
    if (this.keptUnder(box)) {
      this.addRegion(box, true);
      return null;
    }
    const mapped = this.isPageSized(box) ? this.mapper.background(color) : this.mapper.vector(color);
    this.addRegion(box, mapped.keep);
    return mapped.color;
  }

  stroke(color, box) {
    return this.keptUnder(box) ? null : this.mapper.vector(color).color;
  }

  /** Axial/radial shading with mapped color stops (or the original). */
  gradient(pattern, force) {
    const entry = this.gradients.get(pattern) ?? {};
    this.gradients.set(pattern, entry);
    const slot = force ? "forced" : "normal";
    if (!(slot in entry)) {
      const stops = this.mapper.gradientStops(pattern._colorStops, force);
      entry[slot] = stops ? Object.assign(Object.create(pattern), { _colorStops: stops, [MAPPED]: true }) : pattern;
    }
    return entry[slot];
  }
}

function boxOf(m, x0, y0, x1, y1) {
  const xs = [m.a * x0 + m.c * y0, m.a * x1 + m.c * y0, m.a * x0 + m.c * y1, m.a * x1 + m.c * y1];
  const ys = [m.b * x0 + m.d * y0, m.b * x1 + m.d * y0, m.b * x0 + m.d * y1, m.b * x1 + m.d * y1];
  return [Math.min(...xs) + m.e, Math.min(...ys) + m.f, Math.max(...xs) + m.e, Math.max(...ys) + m.f];
}

function clipTo(box, clip) {
  const out = [Math.max(box[0], clip[0]), Math.max(box[1], clip[1]), Math.min(box[2], clip[2]), Math.min(box[3], clip[3])];
  return out[0] < out[2] && out[1] < out[3] ? out : null;
}

// Device-space point roughly in the middle of the first glyph of a text run.
function textAnchor(gfx) {
  const c = gfx.current;
  const px = c.x;
  const py = c.y + c.textRise + 0.35 * c.fontSize;
  const tm = c.textMatrix;
  const x = tm ? tm[0] * px + tm[2] * py + tm[4] : px;
  const y = tm ? tm[1] * px + tm[3] * py + tm[5] : py;
  const m = gfx.ctx.getTransform();
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

// Calls `original` with the context's fill/stroke style temporarily replaced
// (null leaves that style alone).
function paintWith(gfx, fillStyle, strokeStyle, original, args) {
  const ctx = gfx.ctx;
  const savedFill = ctx.fillStyle;
  const savedStroke = ctx.strokeStyle;
  if (fillStyle !== null) {
    ctx.fillStyle = fillStyle;
  }
  if (strokeStyle !== null) {
    ctx.strokeStyle = strokeStyle;
  }
  try {
    return original.apply(gfx, args);
  } finally {
    if (fillStyle !== null) {
      ctx.fillStyle = savedFill;
    }
    if (strokeStyle !== null) {
      ctx.strokeStyle = savedStroke;
    }
  }
}

// The state for a CanvasGraphics call, or null when it must run untouched.
function activeState(gfx) {
  const s = gfx[STATE];
  return s && !s.maskDepth && !s.keepDepth ? s : null;
}

function patchCanvasGraphics(proto) {
  if (Object.hasOwn(proto, PATCHED)) {
    return;
  }
  proto[PATCHED] = true;

  // PDF.js dispatches operators by number (this[fnId](...)) but methods also
  // call each other by name, so both keys must point at the wrapper.
  const wrap = (name, makeWrapper) => {
    const original = proto[name];
    if (typeof original !== "function") {
      warnOnce(`CanvasGraphics.${name} not found; selective dark mode may be incomplete.`);
      return;
    }
    const wrapped = makeWrapper(original);
    proto[name] = wrapped;
    const id = OPS[name];
    if (id !== undefined && proto[id] === original) {
      proto[id] = wrapped;
    }
  };

  wrap("showText", original =>
    function () {
      const s = activeState(this);
      if (!s) {
        return original.apply(this, arguments);
      }
      const cur = this.current;
      const keep = s.keptRegions > 0 && s.keptAt(...textAnchor(this));
      s.textDepth++;
      if (keep) {
        s.keepDepth++;
      }
      try {
        if (keep) {
          return original.apply(this, arguments);
        }
        const fill = cur.patternFill ? null : s.mapper.text(cur.fillColor);
        const stroke = cur.patternStroke ? null : s.mapper.text(cur.strokeColor);
        return paintWith(this, fill, stroke, original, arguments);
      } finally {
        s.textDepth--;
        if (keep) {
          s.keepDepth--;
        }
      }
    }
  );

  // fill() also serves eoFill, fillStroke and the close* variants.
  wrap("fill", original =>
    function () {
      const s = activeState(this);
      if (!s) {
        return original.apply(this, arguments);
      }
      const cur = this.current;
      if (s.textDepth) {
        const fill = cur.patternFill ? null : s.mapper.text(cur.fillColor);
        return paintWith(this, fill, null, original, arguments);
      }
      const box = cur.getClippedPathBoundingBox();
      if (cur.patternFill) {
        return fillWithPattern(this, s, box, original, arguments);
      }
      const color = box ? s.fill(cur.fillColor, box) : null;
      return paintWith(this, color, null, original, arguments);
    }
  );

  wrap("stroke", original =>
    function () {
      const s = activeState(this);
      const cur = this.current;
      if (!s || cur.patternStroke) {
        return original.apply(this, arguments);
      }
      const color = s.textDepth ? s.mapper.text(cur.strokeColor) : s.stroke(cur.strokeColor, cur.getClippedPathBoundingBox());
      return paintWith(this, null, color, original, arguments);
    }
  );

  // Stencil masks paint the current fill color through a 1-bit mask (bitmap
  // glyphs, Type3 fonts, some scans), so they are recolored like text.
  const stencil = original =>
    function () {
      const s = activeState(this);
      if (!s || this.current.patternFill) {
        return original.apply(this, arguments);
      }
      if (!s.textDepth && s.keptRegions > 0) {
        const m = this.ctx.getTransform();
        if (s.keptAt(m.a * 0.5 + m.c * 0.5 + m.e, m.b * 0.5 + m.d * 0.5 + m.f)) {
          return original.apply(this, arguments);
        }
      }
      return paintWith(this, s.mapper.text(this.current.fillColor), null, original, arguments);
    };
  for (const name of ["paintImageMaskXObject", "paintImageMaskXObjectRepeat", "paintImageMaskXObjectGroup", "paintSolidColorImageMask", "rawFillPath"]) {
    wrap(name, stencil);
  }

  // Raster images are never recolored; we only remember where they landed so
  // that text and vectors drawn on top of them keep their original colors.
  // (paintImageXObject and paintImageXObjectRepeat delegate to these two.)
  wrap("paintInlineImageXObject", original =>
    function () {
      const s = this[STATE];
      if (s && !s.maskDepth && this.contentVisible) {
        const m = this.ctx.getTransform();
        s.addRegion(clipTo(boxOf(m, 0, 0, 1, 1), this.current.clipBox), true);
      }
      return original.apply(this, arguments);
    }
  );
  wrap("paintInlineImageXObjectGroup", original =>
    function (opIdx, imgData, map) {
      const s = this[STATE];
      if (s && !s.maskDepth && this.contentVisible) {
        const m = this.ctx.getTransform();
        for (const entry of map) {
          s.addRegion(clipTo(boxOf(m.multiply(new DOMMatrix(entry.transform)), 0, 0, 1, 1), this.current.clipBox), true);
        }
      }
      return original.apply(this, arguments);
    }
  );

  wrap("shadingFill", original =>
    function () {
      const s = activeState(this);
      if (!s || !this.contentVisible) {
        return original.apply(this, arguments);
      }
      const box = Array.from(this.current.clipBox);
      s.forceGradients = s.isPageSized(box);
      s.lastGradientMapped = false;
      try {
        return original.apply(this, arguments);
      } finally {
        s.forceGradients = false;
        s.addRegion(box, !s.lastGradientMapped);
      }
    }
  );

  // Shading lookups (sh operator and shading patterns) come through here.
  wrap("_getPattern", original =>
    function () {
      const pattern = original.apply(this, arguments);
      const s = activeState(this);
      if (!s) {
        return pattern;
      }
      const out = Array.isArray(pattern?._colorStops) ? s.gradient(pattern, s.forceGradients) : pattern;
      s.lastGradientMapped = out !== pattern;
      return out;
    }
  );

  // A group with `smask` holds the content that *defines* a soft mask; its
  // luminance becomes alpha, so recoloring it would invert transparency.
  // Other groups get their own canvas, offset within the page canvas.
  wrap("beginGroup", original =>
    function (opIdx, group) {
      const s = this[STATE];
      if (!s || !this.contentVisible) {
        return original.apply(this, arguments);
      }
      const parentCtx = this.ctx;
      const result = original.apply(this, arguments);
      s.offsets.push([s.dx, s.dy, !!group.smask]);
      if (group.smask) {
        s.maskDepth++;
      } else if (this.ctx !== parentCtx) {
        // beginGroup leaves the parent translated to the group canvas origin.
        const t = parentCtx.getTransform();
        s.dx += t.e;
        s.dy += t.f;
      }
      return result;
    }
  );
  wrap("endGroup", original =>
    function () {
      const s = this[STATE];
      if (!s || !this.contentVisible) {
        return original.apply(this, arguments);
      }
      const result = original.apply(this, arguments);
      const saved = s.offsets.pop();
      if (saved) {
        [s.dx, s.dy] = saved;
        if (saved[2]) {
          s.maskDepth--;
        }
      }
      return result;
    }
  );

  wrap("setGState", original =>
    function (opIdx, states) {
      const result = original.apply(this, arguments);
      const s = this[STATE];
      if (s?.swapBlend && !s.maskDepth) {
        for (const [key, value] of states) {
          if (key === "BM" && BLEND_SWAP[value]) {
            this.ctx.globalCompositeOperation = BLEND_SWAP[value];
          }
        }
      }
      return result;
    }
  );
}

function fillWithPattern(gfx, s, box, original, args) {
  const cur = gfx.current;
  const pattern = cur.fillColor;
  if (s.isPageSized(box) && Array.isArray(pattern?._colorStops)) {
    // A page-sized gradient is a page background: map it even when colored.
    const forced = s.gradient(pattern[MAPPED] ? Object.getPrototypeOf(pattern) : pattern, true);
    s.addRegion(box, !forced[MAPPED]);
    cur.fillColor = forced;
    try {
      return original.apply(gfx, args);
    } finally {
      cur.fillColor = pattern;
    }
  }
  // Mesh shadings and tiling patterns are artwork: drawn as-is.
  s.addRegion(box, !pattern?.[MAPPED]);
  return original.apply(gfx, args);
}

function patchInternalRenderTask(proto) {
  if (Object.hasOwn(proto, PATCHED)) {
    return;
  }
  proto[PATCHED] = true;
  const initializeGraphics = proto.initializeGraphics;
  proto.initializeGraphics = function () {
    const result = initializeGraphics.apply(this, arguments);
    const gfx = this.gfx;
    if (gfx) {
      patchCanvasGraphics(Object.getPrototypeOf(gfx));
      const state = this[STATE] ?? null;
      state?.start(gfx.ctx.canvas);
      gfx[STATE] = state;
    }
    return result;
  };
}

/** Installs the render hook on the PDFPageProxy class `page` belongs to. */
export function installPageHooks(page) {
  const proto = Object.getPrototypeOf(page);
  if (Object.hasOwn(proto, PATCHED)) {
    return;
  }
  proto[PATCHED] = true;
  const render = proto.render;
  proto.render = function (params) {
    let state = null;
    // Printing and anything else that isn't on-screen display stays original.
    if (params && (params.intent ?? "display") === "display") {
      if (config.mode === "basic") {
        params = { ...params, pageColors: { background: config.background, foreground: config.foreground } };
      } else if (config.mode === "selective") {
        params = { ...params, pageColors: null, background: config.background };
        state = new PageState(config);
      }
    }
    const task = render.call(this, params);
    const internal = task?._internalRenderTask;
    if (internal && typeof Object.getPrototypeOf(internal).initializeGraphics === "function") {
      patchInternalRenderTask(Object.getPrototypeOf(internal));
      internal[STATE] = state;
    } else if (state) {
      warnOnce("PDF.js internals changed; selective dark mode is unavailable.");
    }
    return task;
  };
}

/**
 * Wraps pdfjsLib.getDocument so that a loaded document's promise only
 * resolves once the render hooks are installed. Must run before viewer.mjs
 * captures getDocument.
 */
export function hookDocumentLoading(lib = globalThis.pdfjsLib) {
  const getDocument = lib.getDocument;
  lib.getDocument = function () {
    const task = getDocument.apply(this, arguments);
    const ready = task.promise.then(async pdf => {
      try {
        installPageHooks(await pdf.getPage(1));
      } catch (ex) {
        console.error("[Dark PDF] Could not install render hooks:", ex);
      }
      return pdf;
    });
    Object.defineProperty(task, "promise", { configurable: true, get: () => ready });
    return task;
  };
}
