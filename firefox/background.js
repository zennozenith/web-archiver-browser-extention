"use strict";

const DEFAULTS = {
  serverUrl: "",
  authMode: "none", // none | bearer | custom
  authHeaderName: "X-API-Key",
  authToken: "",
  includeHtml: true,
  includeRequestHeaders: true,
  includeResponseHeaders: true,
  includeCookies: false,
  includeScreenshot: false,
  redactHeaders: "authorization, proxy-authorization",
  tags: "",
  timeoutSec: 30,
};

// tabId -> info about the latest main-frame request
const tabRequests = new Map();

const getSettings = () => browser.storage.local.get(DEFAULTS);

/* ---------- record main-frame request/response headers ---------- */
browser.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    tabRequests.set(d.tabId, {
      url: d.url,
      method: d.method,
      requestId: d.requestId,
      timeStamp: d.timeStamp,
      requestHeaders: d.requestHeaders || [],
      responseHeaders: null,
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["requestHeaders"],
);

browser.webRequest.onHeadersReceived.addListener(
  (d) => {
    const r = tabRequests.get(d.tabId);
    if (!r || r.requestId !== d.requestId) return;
    r.responseHeaders = d.responseHeaders || [];
    r.statusCode = d.statusCode;
    r.statusLine = d.statusLine;
    r.ip = d.ip || null;
    r.fromCache = d.fromCache;
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"],
);

browser.tabs.onRemoved.addListener((id) => tabRequests.delete(id));

/* ---------- helpers ---------- */
function redact(headers, list) {
  const block = new Set(
    list
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return (headers || []).map((h) =>
    block.has(h.name.toLowerCase())
      ? { name: h.name, value: "[REDACTED]" }
      : { name: h.name, value: h.value },
  );
}

function badge(tabId, text, color, ms = 3000) {
  browser.browserAction.setBadgeBackgroundColor({ tabId, color });
  browser.browserAction.setBadgeText({ tabId, text });
  if (ms)
    setTimeout(() => browser.browserAction.setBadgeText({ tabId, text: "" }).catch(() => {}), ms);
}

function buildHeaders(s) {
  const h = { "Content-Type": "application/json" };
  if (s.authToken) {
    if (s.authMode === "bearer") h["Authorization"] = "Bearer " + s.authToken;
    else if (s.authMode === "custom" && s.authHeaderName) h[s.authHeaderName] = s.authToken;
  }
  return h;
}

/* ---------- capture ---------- */
async function capture(tab) {
  const s = await getSettings();
  if (!s.serverUrl) {
    browser.runtime.openOptionsPage();
    return;
  }
  badge(tab.id, "…", "#777", 0);

  try {
    if (!/^(https?|file|ftp):/i.test(tab.url)) {
      throw new Error("This page type cannot be captured: " + tab.url);
    }

    const [page] = await browser.tabs.executeScript(tab.id, { file: "content.js" });
    if (!page) throw new Error("No data returned from page");

    const req = tabRequests.get(tab.id);
    const payload = {
      url: page.url,
      title: page.title,
      captured_at: new Date().toISOString(),
      user_agent: navigator.userAgent,
      tags: s.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      page: { ...page, html: undefined },
      tab: {
        id: tab.id,
        windowId: tab.windowId,
        incognito: tab.incognito,
        favIconUrl: tab.favIconUrl || null,
        status: tab.status,
      },
    };
    if (s.includeHtml) payload.html = page.html;

    if (req) {
      payload.request = {
        // false for SPA navigations where the address changed without a new document request
        matches_page_url: req.url === page.url || req.url.split("#")[0] === page.url.split("#")[0],
        url: req.url,
        method: req.method,
        timestamp: req.timeStamp,
        headers: s.includeRequestHeaders ? redact(req.requestHeaders, s.redactHeaders) : undefined,
      };
      payload.response = {
        status: req.statusCode,
        status_line: req.statusLine,
        ip: req.ip,
        from_cache: req.fromCache,
        headers: s.includeResponseHeaders
          ? redact(req.responseHeaders, s.redactHeaders)
          : undefined,
      };
    }

    if (s.includeCookies) {
      try {
        payload.cookies = await browser.cookies.getAll({ url: page.url });
      } catch (e) {
        payload.cookies_error = String(e);
      }
    }

    if (s.includeScreenshot) {
      try {
        payload.screenshot = await browser.tabs.captureVisibleTab(tab.windowId, {
          format: "jpeg",
          quality: 70,
        });
      } catch (e) {
        payload.screenshot_error = String(e);
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(1, s.timeoutSec) * 1000);
    let res;
    try {
      res = await fetch(s.serverUrl, {
        method: "POST",
        headers: buildHeaders(s),
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Server responded ${res.status} ${res.statusText}`);

    badge(tab.id, "✓", "#2e9e4f");
    browser.browserAction.setTitle({ tabId: tab.id, title: "Archived ✓ (click to archive again)" });
  } catch (err) {
    console.error("Archive failed:", err);
    badge(tab.id, "✗", "#d33");
    browser.browserAction.setTitle({ tabId: tab.id, title: "Archive failed: " + err.message });
  }
}

browser.browserAction.onClicked.addListener(capture);
