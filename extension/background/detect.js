// Pure helpers that decide whether a top-level response is a PDF the
// extension should take over. No WebExtension APIs here, so it is unit
// testable under Node.

export const VIEWER_PATH = "pdfjs/web/viewer.html";

const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
// Servers that mislabel PDFs typically use one of these.
const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/download", "application/force-download", "application/x-download"]);

export function getHeader(headers, name) {
  const lower = name.toLowerCase();
  const header = headers?.find(h => h.name.toLowerCase() === lower);
  return header ? (header.value ?? "") : null;
}

function mimeType(headers) {
  return (getHeader(headers, "content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

export function urlLooksLikePdf(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

export function dispositionFilenameIsPdf(disposition) {
  return /filename\*?\s*=\s*(?:[\w-]+'[\w-]*')?"?[^";]*\.pdf(?:"|\s*;|\s*$)/i.test(disposition ?? "");
}

export function isPdfResponse(url, headers) {
  const type = mimeType(headers);
  if (PDF_TYPES.has(type)) {
    return true;
  }
  if (GENERIC_TYPES.has(type)) {
    return urlLooksLikePdf(url) || dispositionFilenameIsPdf(getHeader(headers, "content-disposition"));
  }
  return false;
}

export function isAttachment(headers) {
  return /^\s*attachment/i.test(getHeader(headers, "content-disposition") ?? "");
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True when `url`'s host is one of `hosts` or a subdomain of one. */
export function isHostBypassed(url, hosts = []) {
  const host = hostOf(url);
  return !!host && hosts.some(h => host === h || host.endsWith(`.${h}`));
}

/**
 * Decides whether a webRequest.onHeadersReceived event should be redirected
 * into the viewer. Returns { intercept, reason }.
 */
export function interceptDecision(details, settings) {
  const { url, method, statusCode, type, responseHeaders } = details;
  const skip = reason => ({ intercept: false, reason });
  if (!settings.interceptEnabled) {
    return skip("disabled");
  }
  if (type && type !== "main_frame") {
    return skip("not-top-level");
  }
  if (method && method !== "GET") {
    // The viewer re-requests the URL with GET; a POST result can't be refetched.
    return skip("not-get");
  }
  if (statusCode && (statusCode < 200 || statusCode >= 300)) {
    return skip("status");
  }
  if (!/^https?:/i.test(url)) {
    return skip("scheme");
  }
  if (!isPdfResponse(url, responseHeaders)) {
    return skip("not-pdf");
  }
  if (!settings.interceptAttachments && isAttachment(responseHeaders)) {
    return skip("attachment");
  }
  if (isHostBypassed(url, settings.bypassHosts)) {
    return skip("site-bypassed");
  }
  return { intercept: true, reason: "pdf" };
}

/**
 * Whether a tab currently showing `tabUrl` has a page worth keeping when a
 * PDF loads in it. Blank and new-tab pages don't: the PDF can replace them
 * instead of leaving an empty tab behind.
 */
export function tabHasPageToKeep(tabUrl) {
  return /^(https?|file|moz-extension):/i.test(tabUrl ?? "");
}

export function buildViewerUrl(viewerBase, pdfUrl) {
  const hashAt = pdfUrl.indexOf("#");
  const file = hashAt === -1 ? pdfUrl : pdfUrl.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : pdfUrl.slice(hashAt);
  return `${viewerBase}?file=${encodeURIComponent(file)}${hash}`;
}

/** Recovers the original PDF URL from a viewer URL, or null. */
export function pdfUrlFromViewerUrl(viewerUrl, viewerBase) {
  if (!viewerUrl?.startsWith(viewerBase)) {
    return null;
  }
  try {
    return new URL(viewerUrl).searchParams.get("file");
  } catch {
    return null;
  }
}
