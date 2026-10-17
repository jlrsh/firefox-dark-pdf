// Color math for dark-mode recoloring.
//
// All remapping happens in OKLab so that changing a color's lightness keeps
// its perceived hue. Black and white are mapped exactly onto the configured
// foreground and background; grays fall on the line between them.

const CHROMA_LO = 0.02; // below this a color is treated as gray
const CHROMA_HI = 0.06; // above this a color is treated as fully chromatic
const MIN_TEXT_CONTRAST = 0.6; // fraction of |L(fg) - L(bg)| colored text must keep
const MIN_VECTOR_CONTRAST = 0.12; // lightness gap kept between preserved art and bg
const DARK_BACKDROP_L = 0.4; // page-sized fills darker than this are left alone

export function parseColor(input) {
  if (typeof input !== "string") {
    return null;
  }
  const str = input.trim().toLowerCase();
  if (str[0] === "#") {
    const hex = str.slice(1);
    if (/^[0-9a-f]{3,4}$/.test(hex)) {
      return [0, 1, 2].map(i => parseInt(hex[i] + hex[i], 16));
    }
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) {
      return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    }
    return null;
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(str);
  return m ? [m[1], m[2], m[3]].map(v => Math.min(255, Number(v))) : null;
}

export function toHex([r, g, b]) {
  const hex = v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToOklab([r8, g8, b8]) {
  const r = toLinear(r8 / 255);
  const g = toLinear(g8 / 255);
  const b = toLinear(b8 / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// Returns linear-light sRGB; components may fall outside [0, 1].
function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = rgb => rgb.every(c => c >= -1e-4 && c <= 1 + 1e-4);

// Converts to sRGB, reducing chroma (never lightness or hue) until the color
// fits in gamut.
export function oklabToRgb([L, a, b]) {
  L = Math.min(1, Math.max(0, L));
  let rgb = oklabToLinear([L, a, b]);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear([L, a * mid, b * mid]))) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    rgb = oklabToLinear([L, a * lo, b * lo]);
  }
  return rgb.map(c => 255 * fromLinear(Math.min(1, Math.max(0, c))));
}

const chroma = lab => Math.hypot(lab[1], lab[2]);

export function chromaWeight(lab) {
  const t = Math.min(1, Math.max(0, (chroma(lab) - CHROMA_LO) / (CHROMA_HI - CHROMA_LO)));
  return t * t * (3 - 2 * t);
}

const mix = (p, q, t) => [0, 1, 2].map(i => p[i] + (q[i] - p[i]) * t);

/**
 * Builds the color transforms used by selective dark mode. Every method takes
 * and returns CSS color strings; inputs it cannot parse (patterns,
 * "transparent") are returned untouched. Results are memoized.
 */
export function createColorMapper({ background = "#1e1e1e", foreground = "#dcdcdc", vectorPolicy = "preserve" } = {}) {
  const bg = rgbToOklab(parseColor(background) ?? [30, 30, 30]);
  const fg = rgbToOklab(parseColor(foreground) ?? [220, 220, 220]);
  const span = fg[0] - bg[0];
  const towardFg = Math.sign(span) || 1;
  const preserveChromatic = vectorPolicy !== "adapt";

  // Grays: black lands on fg, white on bg, carrying their tints along.
  const gray = lab => mix(fg, bg, lab[0]);
  // Chromatic: reverse lightness along the same ramp, keep hue and chroma.
  const invert = lab => [fg[0] - span * lab[0], lab[1], lab[2]];
  // Keep the original lightness or the reversed one, whichever stands out more
  // from the background, but never closer than the minimum text contrast.
  const readable = lab => {
    const reversed = fg[0] - span * lab[0];
    let L = Math.abs(reversed - bg[0]) > Math.abs(lab[0] - bg[0]) ? reversed : lab[0];
    const minGap = MIN_TEXT_CONTRAST * Math.abs(span);
    if ((L - bg[0]) * towardFg < minGap) {
      L = bg[0] + minGap * towardFg;
    }
    return [L, lab[1], lab[2]];
  };
  const lift = lab => {
    if (Math.abs(lab[0] - bg[0]) >= MIN_VECTOR_CONTRAST) {
      return lab;
    }
    return [bg[0] + MIN_VECTOR_CONTRAST * towardFg, lab[1], lab[2]];
  };

  const memo = fn => {
    const cache = new Map();
    return color => {
      let out = cache.get(color);
      if (out === undefined) {
        const rgb = parseColor(color);
        out = rgb ? fn(rgbToOklab(rgb), color) : null;
        cache.set(color, out);
      }
      return out;
    };
  };

  const adaptLab = lab => mix(gray(lab), invert(lab), chromaWeight(lab));

  const text = memo(lab => toHex(oklabToRgb(mix(gray(lab), readable(lab), chromaWeight(lab)))));

  const vector = memo((lab, original) => {
    const w = chromaWeight(lab);
    if (preserveChromatic && w >= 0.5) {
      const lifted = lift(lab);
      return { color: lifted === lab ? original : toHex(oklabToRgb(lifted)), keep: true };
    }
    return { color: toHex(oklabToRgb(adaptLab(lab))), keep: false };
  });

  // Page-sized fills are page backgrounds whatever their hue. Already-dark
  // ones (slides with a black background) are left as they are.
  const background_ = memo((lab, original) => {
    if (lab[0] < DARK_BACKDROP_L && towardFg > 0) {
      return { color: original, keep: true };
    }
    return { color: toHex(oklabToRgb(adaptLab(lab))), keep: false };
  });

  const isGrayColor = memo(lab => chromaWeight(lab) < 0.5);

  return {
    text: color => text(color) ?? color,
    vector: color => vector(color) ?? { color, keep: false },
    background: color => background_(color) ?? { color, keep: false },
    /**
     * Maps gradient stops ([offset, color] pairs). Returns null when the
     * gradient should keep its original colors.
     */
    gradientStops(stops, force = false) {
      const colors = stops.map(([, c]) => c);
      if (!force && preserveChromatic && !colors.every(c => isGrayColor(c) ?? true)) {
        return null;
      }
      return stops.map(([offset, c]) => [offset, (force ? background_(c) : vector(c))?.color ?? c]);
    },
  };
}
