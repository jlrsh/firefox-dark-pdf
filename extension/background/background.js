// Redirects top-level PDF navigations into the bundled viewer, in the same tab.
//
// We act in onHeadersReceived rather than onBeforeRequest because the
// Content-Type header is the only reliable signal (arxiv.org/pdf/<id> has no
// ".pdf" suffix). Redirecting there cancels the original response before
// Firefox's own PDF viewer ever sees the body.

import { buildViewerUrl, interceptDecision, VIEWER_PATH } from "./detect.js";
import { DEFAULT_SETTINGS, loadSettings, watchSettings } from "../shared/settings.js";

const VIEWER_BASE = browser.runtime.getURL(VIEWER_PATH);
// How long an "open in Firefox's viewer" request stays armed for its tab.
const NATIVE_BYPASS_MS = 30_000;

let settings = { ...DEFAULT_SETTINGS };
loadSettings().then(s => (settings = s));
watchSettings(s => (settings = s));

// tabId -> expiry time. The next PDF response in that tab is left to Firefox.
// Keyed by tab, not URL, because the PDF URL may redirect before it lands.
const nativeBypass = new Map();

function consumeNativeBypass(tabId) {
  const expiry = nativeBypass.get(tabId);
  if (expiry === undefined) {
    return false;
  }
  nativeBypass.delete(tabId);
  return expiry >= Date.now();
}

browser.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0 || !interceptDecision(details, settings).intercept) {
      return undefined;
    }
    if (consumeNativeBypass(details.tabId)) {
      return undefined;
    }
    return { redirectUrl: buildViewerUrl(VIEWER_BASE, details.url) };
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["blocking", "responseHeaders"]
);

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "open-native") {
    const tabId = message.tabId ?? sender.tab?.id;
    if (typeof tabId === "number") {
      nativeBypass.set(tabId, Date.now() + NATIVE_BYPASS_MS);
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: false });
  }
  return undefined;
});

browser.tabs.onRemoved.addListener(tabId => nativeBypass.delete(tabId));
