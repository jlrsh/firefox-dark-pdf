// Preferences shared by the background script, viewer, popup and options
// page. Everything lives in browser.storage.local.

export const MODES = ["off", "basic", "selective"];

export const DEFAULT_SETTINGS = Object.freeze({
  // Interception
  interceptEnabled: true,
  interceptAttachments: false,
  bypassHosts: [],
  // Rendering
  mode: "selective",
  lastDarkMode: "selective",
  background: "#1e1e1e",
  foreground: "#dcdcdc",
  vectorPolicy: "preserve", // "preserve" colored vector art, or "adapt" it
  keepColorsOverImages: true,
  swapBlendModes: true,
  darkInterface: true,
});

// Settings that change how pages are painted; the viewer re-renders when one
// of these changes.
export const RENDER_KEYS = ["mode", "background", "foreground", "vectorPolicy", "keepColorsOverImages", "swapBlendModes"];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  if (!MODES.includes(s.mode)) {
    s.mode = DEFAULT_SETTINGS.mode;
  }
  if (!MODES.includes(s.lastDarkMode) || s.lastDarkMode === "off") {
    s.lastDarkMode = DEFAULT_SETTINGS.lastDarkMode;
  }
  for (const key of ["background", "foreground"]) {
    if (!HEX_COLOR.test(s[key])) {
      s[key] = DEFAULT_SETTINGS[key];
    }
  }
  if (s.vectorPolicy !== "adapt") {
    s.vectorPolicy = "preserve";
  }
  s.bypassHosts = Array.isArray(s.bypassHosts) ? [...new Set(s.bypassHosts.map(normalizeHost).filter(Boolean))] : [];
  return s;
}

export function normalizeHost(host) {
  return String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/:].*$/, "")
    .replace(/^\*\./, "")
    .replace(/\.$/, "");
}

export async function loadSettings() {
  return normalizeSettings(await browser.storage.local.get(null));
}

export function saveSettings(patch) {
  return browser.storage.local.set(patch);
}

export function resetSettings() {
  return browser.storage.local.clear();
}

/** Calls `callback(settings)` with the full, normalized settings after any change. */
export function watchSettings(callback) {
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area === "local") {
      callback(await loadSettings());
    }
  });
}
