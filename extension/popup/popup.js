import { loadSettings, saveSettings, watchSettings } from "../shared/settings.js";
import { hostOf, pdfUrlFromViewerUrl, VIEWER_PATH } from "../background/detect.js";

const $ = id => document.getElementById(id);
const VIEWER_BASE = browser.runtime.getURL(VIEWER_PATH);

const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
const pdfUrl = pdfUrlFromViewerUrl(tab?.url, VIEWER_BASE);
const pageUrl = pdfUrl ?? tab?.url ?? "";
const host = /^https?:/i.test(pageUrl) ? hostOf(pageUrl) : "";

let settings = await loadSettings();

function matchingEntries(hosts) {
  return hosts.filter(h => host === h || host.endsWith(`.${h}`));
}

function render() {
  for (const input of document.querySelectorAll("input[name=mode]")) {
    input.checked = input.value === settings.mode;
  }
  $("interceptEnabled").checked = settings.interceptEnabled;
  $("siteRow").hidden = !host;
  $("siteName").textContent = host;
  $("siteBypass").checked = matchingEntries(settings.bypassHosts).length > 0;
  $("openNative").hidden = !pdfUrl;
}

$("modes").addEventListener("change", event => {
  const mode = event.target.value;
  saveSettings(mode === "off" ? { mode } : { mode, lastDarkMode: mode });
});

$("interceptEnabled").addEventListener("change", event => {
  saveSettings({ interceptEnabled: event.target.checked });
});

$("siteBypass").addEventListener("change", event => {
  const others = settings.bypassHosts.filter(h => !matchingEntries([h]).length);
  saveSettings({ bypassHosts: event.target.checked ? [...others, host] : others });
});

$("openNative").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "open-native", tabId: tab.id });
  await browser.tabs.update(tab.id, { url: pdfUrl });
  window.close();
});

$("openOptions").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

watchSettings(next => {
  settings = next;
  render();
});
render();
