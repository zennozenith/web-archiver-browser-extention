"use strict";
/* Shared by background, popup and options. Works in Firefox and Chrome. */

if (typeof globalThis.browser === "undefined") globalThis.browser = globalThis.chrome;

const DEFAULTS = {
  hostUrl: "", // e.g. https://archive.example.com/
  // Endpoint overrides. Empty = derived from hostUrl.
  archiveUrl: "",
  pendingUrl: "",
  statusUrl: "",
  refreshMinutes: 5,
  showBadge: true,
  promptAfterOpen: true,
  checkOnLoad: true,
  authMode: "none", // none | bearer | custom
  authHeaderName: "X-API-Key",
  authToken: "",
  includeRequestHeaders: true,
  includeResponseHeaders: true,
  includeCookies: false,
  includeScreenshot: false,
  redactHeaders: "authorization, proxy-authorization",
  tags: "",
  timeoutSec: 30,
};

const DERIVED_PATHS = { archive: "api/archive", pending: "api/pending", status: "api/status" };

function deriveUrl(hostUrl, path) {
  if (!hostUrl) return "";
  try {
    const b = new URL(hostUrl);
    if (!b.pathname.endsWith("/")) b.pathname += "/";
    b.search = "";
    b.hash = "";
    return new URL(path, b).href;
  } catch {
    return "";
  }
}

// Effective endpoints: explicit override wins, otherwise derived from the host URL.
function endpoints(s) {
  return {
    archive: s.archiveUrl || deriveUrl(s.hostUrl, DERIVED_PATHS.archive),
    pending: s.pendingUrl || deriveUrl(s.hostUrl, DERIVED_PATHS.pending),
    status: s.statusUrl || deriveUrl(s.hostUrl, DERIVED_PATHS.status),
  };
}

function authHeaders(s, json) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  if (s.authToken) {
    if (s.authMode === "bearer") h["Authorization"] = "Bearer " + s.authToken;
    else if (s.authMode === "custom" && s.authHeaderName) h[s.authHeaderName] = s.authToken;
  }
  return h;
}

async function fetchT(url, opts, sec) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, Number(sec) || 30) * 1000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Build a readable message from a failed HTTP response (uses the server's error body if any)
async function httpError(res) {
  let detail = "";
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      detail = j.error || j.message || j.detail || j.msg || "";
      if (typeof detail !== "string") detail = JSON.stringify(detail);
    } catch {
      detail = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
  } catch {
    /* ignore */
  }
  const head = `Server responded ${res.status} ${res.statusText}`.trim();
  return detail ? `${head}: ${detail.slice(0, 300)}` : head;
}

function errMsg(e) {
  if (e && e.name === "AbortError") return "Request timed out";
  const m = (e && e.message) || String(e);
  if (e instanceof TypeError) return "Network error – server unreachable or blocked (" + m + ")";
  return m;
}
