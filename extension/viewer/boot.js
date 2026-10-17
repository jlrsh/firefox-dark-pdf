// Entry point injected into PDF.js's viewer.html, between pdf.mjs and
// viewer.mjs (see scripts/fetch-pdfjs.mjs).
//
// The generic PDF.js viewer refuses ?file= URLs from another origin. Rather
// than patching that check out of viewer.mjs, we hide the parameter from it:
// it is removed from the address before the viewer starts, put back once the
// viewer has read the (empty) location, and the PDF is opened from here with
// the options we need (cookies, base URL for relative links).

import { hookDocumentLoading, configureRendering } from "./dark-render.js";
import { loadSettings, RENDER_KEYS, watchSettings } from "../shared/settings.js";
import { mountViewerUi } from "./viewer-ui.js";

const fileUrl = new URL(location.href).searchParams.get("file");
const viewerHref = location.href;
if (fileUrl) {
  const stripped = new URL(location.href);
  stripped.searchParams.delete("file");
  history.replaceState(history.state, "", stripped.href);
}

hookDocumentLoading();
const settingsReady = loadSettings();

document.addEventListener(
  "webviewerloaded",
  () => {
    const options = window.PDFViewerApplicationOptions;
    options.set("defaultUrl", "");
    options.set("isEvalSupported", false); // extension CSP forbids eval anyway
    start(window.PDFViewerApplication).catch(ex => console.error("[Dark PDF] Viewer start-up failed:", ex));
  },
  { once: true }
);

async function start(app) {
  await app.initializedPromise;
  // run() reads document.location right after initialization resolves; let it
  // do so before the file parameter is restored.
  await new Promise(resolve => setTimeout(resolve, 0));
  if (fileUrl) {
    history.replaceState(history.state, "", viewerHref);
  }

  let settings = await settingsReady;
  applySettings(app, settings);
  const ui = mountViewerUi(app, { fileUrl, settings });

  watchSettings(next => {
    const rerender = RENDER_KEYS.some(key => next[key] !== settings[key]);
    settings = next;
    applySettings(app, settings);
    ui.update(settings);
    if (rerender) {
      rerenderAll(app);
    }
  });

  if (fileUrl) {
    await app.open({
      url: fileUrl,
      originalUrl: fileUrl,
      docBaseUrl: fileUrl,
      withCredentials: true,
    });
  }
}

function applySettings(app, settings) {
  configureRendering(settings);
  const dark = settings.mode !== "off";
  const root = document.documentElement;
  root.classList.toggle("darkPdfActive", dark);
  root.style.setProperty("--dark-pdf-bg", settings.background);
  root.style.setProperty("--dark-pdf-fg", settings.foreground);
  // viewer.css themes itself with light-dark(), so color-scheme flips it.
  if (dark && settings.darkInterface) {
    root.style.setProperty("color-scheme", "dark");
  } else {
    root.style.removeProperty("color-scheme");
  }
  const viewer = app.appConfig?.viewerContainer?.querySelector(".pdfViewer") ?? document.getElementById("viewer");
  if (dark) {
    viewer?.style.setProperty("--page-bg-color", settings.background);
  } else {
    viewer?.style.removeProperty("--page-bg-color");
  }
}

function rerenderAll(app) {
  if (!app.pdfDocument) {
    return;
  }
  // refresh() keeps the old canvases on screen until the new ones are drawn.
  app.pdfViewer.refresh();
  for (const thumbnail of app.pdfThumbnailViewer?._thumbnails ?? []) {
    thumbnail.reset();
  }
  app.forceRendering();
}
