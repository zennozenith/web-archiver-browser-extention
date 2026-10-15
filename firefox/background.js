"use strict";

/*
 * Firefox MV3 event page: may be unloaded at any time, so per-tab state lives in
 * storage.session and the pending list cache in storage.local. All listeners are
 * registered synchronously at top level.
 */

const DEFAULTS = {
  serverUrl: "",
  pendingUrl: "",
  refreshMinutes: 5,
  showBadge: true,
  promptAfterOpen: true,
  authMode: "none", // none | bearer | custom
  authHeaderName: "X-API-Key",
  authToken: "",
  // includeHtml: true,
  includeRequestHeaders: true,
  includeResponseHeaders: true,
  includeCookies: false,
  includeScreenshot: false,
  redactHeaders: "authorization, proxy-authorization",
  tags: "",
  timeoutSec: 30,
};

const ALARM = "refresh-pending";
const getSettings = () => browser.storage.local.get(DEFAULTS);
const reqKey = (tabId) => "req:" + tabId; // recorded request/response headers
const ptKey = (tabId) => "pt:" + tabId; // tab opened from pending list, awaiting prompt
const safe = (p) => Promise.resolve(p).catch(() => {});
const stripHash = (u) => String(u).split("#")[0];

// Serialize read-modify-write operations on storage.session
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.error(e)));

/* ================= header recording ================= */
browser.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    enqueue(() =>
      browser.storage.session.set({
        [reqKey(d.tabId)]: {
          url: d.url,
          method: d.method,
          requestId: d.requestId,
          timeStamp: d.timeStamp,
          requestHeaders: d.requestHeaders || [],
          responseHeaders: null,
        },
      }),
    );
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["requestHeaders"],
);

browser.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    enqueue(async () => {
      const k = reqKey(d.tabId);
      const r = (await browser.storage.session.get(k))[k];
      if (!r || r.requestId !== d.requestId) return;
      r.responseHeaders = d.responseHeaders || [];
      r.statusCode = d.statusCode;
      r.statusLine = d.statusLine;
      r.ip = d.ip || null;
      r.fromCache = d.fromCache;
      await browser.storage.session.set({ [k]: r });
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"],
);

browser.tabs.onRemoved.addListener((id) =>
  enqueue(() => browser.storage.session.remove([reqKey(id), ptKey(id)])),
);

/* ================= helpers ================= */
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

function authHeaders(s, json) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  if (s.authToken) {
    if (s.authMode === "bearer") h["Authorization"] = "Bearer " + s.authToken;
    else if (s.authMode === "custom" && s.authHeaderName) h[s.authHeaderName] = s.authToken;
  }
  return h;
}

// Per-tab status flash on the toolbar button. Resets to the global (pending-count) badge afterwards.
function flash(tabId, text, color, ms = 3000, title = null) {
  safe(browser.action.setBadgeBackgroundColor({ tabId, color }));
  safe(browser.action.setBadgeText({ tabId, text }));
  if (title) safe(browser.action.setTitle({ tabId, title }));
  if (ms) {
    setTimeout(() => {
      safe(browser.action.setBadgeText({ tabId, text: null }));
      safe(browser.action.setBadgeBackgroundColor({ tabId, color: null }));
      safe(browser.action.setTitle({ tabId, title: null }));
    }, ms);
  }
}

/* ================= capture ================= */
async function capture(tab, { pendingId = null } = {}) {
  const s = await getSettings();
  if (!s.serverUrl) {
    browser.runtime.openOptionsPage();
    return { ok: false, error: "Server URL is not set (see preferences)" };
  }
  flash(tab.id, "…", "#777", 0);

  try {
    if (!/^(https?|file|ftp):/i.test(tab.url)) {
      throw new Error("This page type cannot be captured");
    }

    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    const page = results && results[0] && results[0].result;
    if (!page) throw new Error("No data returned from page");

    await queue; // make sure pending header writes have landed
    const req = (await browser.storage.session.get(reqKey(tab.id)))[reqKey(tab.id)];

    // If this URL is on the pending list, tell the server which entry it was
    if (pendingId == null) {
      const { pendingCache } = await browser.storage.local.get({ pendingCache: null });
      const m =
        pendingCache && pendingCache.items.find((i) => stripHash(i.url) === stripHash(page.url));
      if (m && m.id != null) pendingId = m.id;
    }

    const payload = {
      url: page.url,
      title: page.title,
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      tags: s.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      page: { ...page, html: undefined },
      html: page.html,
      tab: {
        id: tab.id,
        windowId: tab.windowId,
        incognito: tab.incognito,
        favIconUrl: tab.favIconUrl || null,
        status: tab.status,
      },
    };
    if (pendingId != null) payload.pendingId = pendingId;
    // if (s.includeHtml) payload.html = page.html;

    if (req) {
      payload.request = {
        matchesPageUrl: stripHash(req.url) === stripHash(page.url),
        url: req.url,
        method: req.method,
        timestamp: req.timeStamp,
        headers: s.includeRequestHeaders ? redact(req.requestHeaders, s.redactHeaders) : undefined,
      };
      payload.response = {
        status: req.statusCode,
        statusLine: req.statusLine,
        ip: req.ip,
        fromCache: req.fromCache,
        headers: s.includeResponseHeaders
          ? redact(req.responseHeaders, s.redactHeaders)
          : undefined,
      };
    }

    if (s.includeCookies) {
      try {
        payload.cookies = await browser.cookies.getAll({ url: page.url });
      } catch (e) {
        payload.cookiesError = String(e);
      }
    }

    if (s.includeScreenshot) {
      try {
        payload.screenshot = await browser.tabs.captureVisibleTab(tab.windowId, {
          format: "jpeg",
          quality: 70,
        });
      } catch (e) {
        payload.screenshotError = String(e);
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(1, s.timeoutSec) * 1000);
    let res;
    try {
      res = await fetch(s.serverUrl, {
        method: "POST",
        headers: authHeaders(s, true),
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Server responded ${res.status} ${res.statusText}`);

    flash(tab.id, "✓", "#2e9e4f", 3000, "Archived ✓");
    refreshPending(); // list changes after archiving; popup updates via storage change
    return { ok: true };
  } catch (err) {
    console.error("Archive failed:", err);
    const msg = err.name === "AbortError" ? "Request timed out" : err.message;
    flash(tab.id, "✗", "#d33", 8000, "Archive failed: " + msg);
    return { ok: false, error: msg };
  }
}

/* ================= pending list ================= */
function normalizePending(data) {
  const arr = Array.isArray(data)
    ? data
    : data && (data.items || data.urls || data.pending || data.results || data.data);
  if (!Array.isArray(arr)) throw new Error("Unexpected response format (expected a JSON array)");
  return arr
    .map((x) => {
      if (typeof x === "string") return { id: null, url: x, title: "" };
      const url = x && (x.url || x.link || x.href);
      if (!url) return null;
      return {
        id: x.id ?? x.pendingId ?? null,
        url,
        title: x.title || x.name || "",
        added: x.addedAt || x.createdAt || x.added || null,
      };
    })
    .filter((i) => i && /^https?:\/\//i.test(i.url));
}

async function updateBadge(count, s) {
  const show = s.showBadge && count > 0;
  await safe(browser.action.setBadgeBackgroundColor({ color: "#4f6df5" }));
  await safe(
    browser.action.setBadgeText({ text: show ? String(count > 999 ? "999+" : count) : "" }),
  );
}

let refreshing = null;
function refreshPending() {
  if (!refreshing) refreshing = doRefresh().finally(() => (refreshing = null));
  return refreshing;
}

async function doRefresh() {
  const s = await getSettings();
  const { pendingCache: prev } = await browser.storage.local.get({ pendingCache: null });

  if (!s.pendingUrl) {
    await browser.storage.local.set({
      pendingCache: { items: [], fetchedAt: null, error: null, configured: false },
    });
    await updateBadge(0, s);
    return { ok: true };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, s.timeoutSec) * 1000);
  try {
    const res = await fetch(s.pendingUrl, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders(s, false) },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Server responded ${res.status} ${res.statusText}`);
    const items = normalizePending(await res.json());
    await browser.storage.local.set({
      pendingCache: { items, fetchedAt: Date.now(), error: null, configured: true },
    });
    await updateBadge(items.length, s);
    return { ok: true, count: items.length };
  } catch (err) {
    const msg = err.name === "AbortError" ? "Request timed out" : err.message;
    await browser.storage.local.set({
      pendingCache: {
        items: prev ? prev.items : [],
        fetchedAt: prev ? prev.fetchedAt : null,
        error: msg,
        configured: true,
      },
    });
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureAlarm() {
  const s = await getSettings();
  const period = Math.max(1, Number(s.refreshMinutes) || 5);
  const existing = await browser.alarms.get(ALARM);
  if (!s.pendingUrl) {
    if (existing) await browser.alarms.clear(ALARM);
    return;
  }
  if (!existing || existing.periodInMinutes !== period) {
    await browser.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: period });
  }
}

/* ================= open from list + prompt ================= */
async function promptArchive(tabId) {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ["banner.js"] });
  } catch (e) {
    console.warn("Could not show archive prompt:", e);
  }
}

async function openPending(item) {
  if (!item || !/^https?:\/\//i.test(item.url)) return { ok: false, error: "Invalid URL" };
  const s = await getSettings();
  const tab = await browser.tabs.create({ url: item.url, active: true });
  if (s.promptAfterOpen) {
    await browser.storage.session.set({ [ptKey(tab.id)]: { id: item.id ?? null, url: item.url } });
    // In case the page finished loading before the entry above was stored
    const t = await safe(browser.tabs.get(tab.id));
    if (t && t.status === "complete" && t.url && t.url !== "about:blank") promptArchive(tab.id);
  }
  return { ok: true };
}

browser.tabs.onUpdated.addListener(
  async (tabId, info) => {
    if (info.status !== "complete") return;
    const v = (await browser.storage.session.get(ptKey(tabId)))[ptKey(tabId)];
    if (v) promptArchive(tabId);
  },
  { properties: ["status"] },
);

/* ================= wiring ================= */
browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg && msg.type) {
    case "archiveCurrent":
      return (async () => {
        let tab = null;
        if (msg.tabId != null) tab = await safe(browser.tabs.get(msg.tabId));
        if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
        return tab ? capture(tab) : { ok: false, error: "No active tab" };
      })();
    case "refresh":
      return refreshPending();
    case "openPending":
      return openPending(msg.item);
    case "archiveFromBanner":
      return (async () => {
        const tab = sender.tab;
        if (!tab) return { ok: false, error: "No tab" };
        const pt = (await browser.storage.session.get(ptKey(tab.id)))[ptKey(tab.id)];
        const r = await capture(tab, { pendingId: pt ? pt.id : null });
        if (r.ok) await browser.storage.session.remove(ptKey(tab.id));
        return r;
      })();
    case "dismissBanner":
      return sender.tab
        ? browser.storage.session.remove(ptKey(sender.tab.id)).then(() => ({ ok: true }))
        : undefined;
  }
});

// Keyboard shortcut: quick archive of the current tab (no popup)
browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "archive-page") return;
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) capture(tab);
});

browser.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refreshPending();
});
browser.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  refreshPending();
});
browser.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshPending();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const watch = [
    "pendingUrl",
    "refreshMinutes",
    "authMode",
    "authHeaderName",
    "authToken",
    "showBadge",
  ];
  if (watch.some((k) => k in changes)) {
    ensureAlarm();
    refreshPending();
  }
});

ensureAlarm(); // re-create the alarm if the browser dropped it
