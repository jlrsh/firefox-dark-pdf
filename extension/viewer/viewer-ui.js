// Controls added to the PDF.js toolbar: a dark-mode selector, and two entries
// in the secondary ("Tools") menu.

import { MODES, saveSettings } from "../shared/settings.js";

const MODE_LABELS = {
  off: "Original colors",
  basic: "Basic dark",
  selective: "Selective dark",
};

export function mountViewerUi(app, { fileUrl, settings }) {
  const select = document.createElement("select");
  select.id = "darkPdfMode";
  select.title = "Dark mode";
  select.setAttribute("aria-label", "Dark mode");
  for (const mode of MODES) {
    select.append(new Option(MODE_LABELS[mode], mode));
  }
  select.value = settings.mode;
  select.addEventListener("change", () => {
    const mode = select.value;
    saveSettings(mode === "off" ? { mode } : { mode, lastDarkMode: mode });
  });

  const container = document.createElement("span");
  container.id = "darkPdfModeContainer";
  container.className = "dropdownToolbarButton";
  container.append(select);
  const separator = document.createElement("div");
  separator.className = "verticalToolbarSeparator";
  document.getElementById("toolbarViewerRight")?.prepend(container, separator);

  const openNative = menuButton("darkPdfOpenNative", "Open in Firefox’s PDF viewer", async () => {
    try {
      await browser.runtime.sendMessage({ type: "open-native" });
    } catch (ex) {
      console.warn("[Dark PDF] Could not reach the background script:", ex);
    }
    location.href = fileUrl;
  });
  openNative.hidden = !fileUrl;
  const openSettings = menuButton("darkPdfSettings", "Dark PDF Viewer settings", () => browser.runtime.openOptionsPage());
  const menuSeparator = document.createElement("div");
  menuSeparator.className = "horizontalToolbarSeparator";
  document.getElementById("secondaryOpenFile")?.after(menuSeparator, openNative, openSettings);

  function menuButton(id, label, onClick) {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = "toolbarButton labeled";
    button.title = label;
    const span = document.createElement("span");
    span.textContent = label;
    button.append(span);
    button.addEventListener("click", () => {
      app.secondaryToolbar?.close();
      onClick();
    });
    return button;
  }

  return {
    update(next) {
      select.value = next.mode;
    },
  };
}
