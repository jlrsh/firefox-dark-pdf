// Sends top-level PDF navigations to the bundled viewer.
//
// We act in onHeadersReceived rather than onBeforeRequest because the
// Content-Type header is the only reliable signal (arxiv.org/pdf/<id> has no
// ".pdf" suffix). Acting there stops the original response before Firefox's
// own PDF viewer ever sees the body.
//
// By default the viewer opens in a new tab next to the original one, and the
// original navigation is cancelled so that tab keeps the page it was on. A
// tab with nothing to keep (new-tab page, a link that already opened a fresh
// tab) is redirected in place instead.

import { buildViewerUrl, interceptDecision, tabHasPageToKeep, VIEWER_PATH } from "./detect.js";
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

async function openViewerTab(tab, viewerUrl) {
  const props = { url: viewerUrl, windowId: tab.windowId, index: tab.index + 1, openerTabId: tab.id, active: true };
  // Keep container tabs in their container, so the viewer fetches the PDF
  // with the same cookies the page had.
  if (tab.cookieStoreId && !tab.incognito && tab.cookieStoreId !== "firefox-default") {
    props.cookieStoreId = tab.cookieStoreId;
  }
  await browser.tabs.create(props);
}

async function sendToViewer(details, viewerUrl) {
  let tab;
  try {
    tab = await browser.tabs.get(details.tabId);
  } catch {
    return { redirectUrl: viewerUrl };
  }
  if (!tabHasPageToKeep(tab.url)) {
    return { redirectUrl: viewerUrl };
  }
  try {
    await openViewerTab(tab, viewerUrl);
  } catch (ex) {
    console.error("[Dark PDF] Could not open the viewer tab:", ex);
    return { redirectUrl: viewerUrl };
  }
  return { cancel: true };
}

browser.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0 || !interceptDecision(details, settings).intercept) {
      return undefined;
    }
    if (consumeNativeBypass(details.tabId)) {
      return undefined;
    }
    const viewerUrl = buildViewerUrl(VIEWER_BASE, details.url);
    return settings.openInNewTab ? sendToViewer(details, viewerUrl) : { redirectUrl: viewerUrl };
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
