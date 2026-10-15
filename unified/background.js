"use strict";

/*
 * Firefox: MV3 event page. Chrome: MV3 service worker. Both may be unloaded at any time,
 * so per-tab state lives in storage.session and the pending list cache in storage.local.
 * All listeners are registered synchronously at top level.
 */
if (typeof importScripts === "function") importScripts("common.js");

const ALARM = "refresh-pending";
const getSettings = () => browser.storage.local.get(DEFAULTS);
const reqKey = (tabId) => "req:" + tabId; // recorded request/response headers
const ptKey = (tabId) => "pt:" + tabId; // tab opened from pending list, awaiting prompt
const stKey = (tabId) => "st:" + tabId; // archive status / errors shown in toolbar + popup
const safe = (p) => Promise.resolve(p).catch(() => {});
const stripHash = (u) => String(u).split("#")[0];

// Serialize read-modify-write operations on storage.session
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.error(e)));

/* ================= header recording ================= */
function addWebRequest(event, fn, spec) {
  const filter = { urls: ["<all_urls>"], types: ["main_frame"] };
  try {
    event.addListener(fn, filter, [...spec, "extraHeaders"]); // Chrome needs this for some headers
  } catch {
    event.addListener(fn, filter, spec); // Firefox rejects unknown spec values
  }
}

addWebRequest(
  browser.webRequest.onSendHeaders,
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
  ["requestHeaders"],
);

addWebRequest(
  browser.webRequest.onHeadersReceived,
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
  ["responseHeaders"],
);

browser.tabs.onRemoved.addListener((id) =>
  enqueue(() => browser.storage.session.remove([reqKey(id), ptKey(id), stKey(id)])),
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

function bodyFile(contentType) {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  const map = {
    "application/xhtml+xml": ["page.xhtml", ct],
    "image/svg+xml": ["page.svg", ct],
    "text/xml": ["page.xml", ct],
    "application/xml": ["page.xml", ct],
  };
  const [name, type] = map[ct] || ["page.html", "text/html"];
  return { name, type: type + "; charset=utf-8" };
}

/* ================= per-tab status + toolbar badge ================= */
async function badgeCtx() {
  const s = await getSettings();
  const { pendingCache } = await browser.storage.local.get({ pendingCache: null });
  return { s, pending: pendingCache && pendingCache.items ? pendingCache.items.length : 0 };
}

const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : "unknown time");

async function applyBadge(tabId, st, ctx) {
  ctx = ctx || (await badgeCtx());
  let text = "";
  let color = "#4f6df5";
  let title = "URL Archiver";
  if (st && st.busy) {
    text = "…";
    color = "#777";
    title = "Archiving…";
  } else if (st && st.lastError) {
    text = "!";
    color = "#d33";
    title = "Archive failed: " + st.lastError;
  } else if (st && st.checkError) {
    text = "!";
    color = "#e08a00";
    title = "Archive status check failed: " + st.checkError;
  } else if (st && st.archived) {
    text = String(st.count > 999 ? "999+" : st.count);
    color = "#2e9e4f";
    const v = (st.versions || []).slice(0, 5).map((x, i) => `  ${i + 1}. ${fmt(x.at)}`);
    title =
      `Archived: ${st.count} version${st.count === 1 ? "" : "s"}` +
      (v.length ? "\nMost recent:\n" + v.join("\n") : "");
  } else {
    if (ctx.s.showBadge && ctx.pending > 0) text = ctx.pending > 999 ? "999+" : String(ctx.pending);
    if (st && st.checked) title = "Not archived yet";
  }
  await safe(browser.action.setBadgeBackgroundColor({ tabId, color }));
  await safe(browser.action.setBadgeText({ tabId, text }));
  await safe(browser.action.setTitle({ tabId, title }));
}

// Merge a patch into the tab's state (or replace it) and refresh the toolbar button
function patchState(tabId, patch, replace = false) {
  return enqueue(async () => {
    const k = stKey(tabId);
    const cur = replace ? {} : (await browser.storage.session.get(k))[k] || {};
    const next = { ...cur, ...patch };
    await browser.storage.session.set({ [k]: next });
    await applyBadge(tabId, next);
  });
}

async function reapplyAll() {
  const ctx = await badgeCtx();
  const all = (await safe(browser.storage.session.get(null))) || {};
  const tabs = (await safe(browser.tabs.query({}))) || [];
  for (const t of tabs) await applyBadge(t.id, all[stKey(t.id)], ctx);
}

/* ================= "already archived?" check ================= */
const toMs = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n; // seconds vs milliseconds
  }
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
};

/*
 * Accepted status responses (GET <status>?url=<page url>), e.g.
 *   {"archived":true,"count":3,"versions":[{"id":"..","archivedAt":"2025-01-01T10:00:00Z"}, ...]}
 *   or just an array of versions / timestamps. HTTP 404 = not archived.
 */
function normalizeStatus(d) {
  const obj = d && !Array.isArray(d) ? d : {};
  const raw = Array.isArray(d)
    ? d
    : obj.versions || obj.snapshots || obj.archives || obj.items || obj.history || [];
  const versions = (Array.isArray(raw) ? raw : [])
    .map((x) =>
      typeof x === "object" && x
        ? {
            id: x.id ?? x.version ?? null,
            at: toMs(x.archivedAt ?? x.createdAt ?? x.capturedAt ?? x.timestamp ?? x.time ?? x.at ?? x.added),
            link: x.url || x.link || x.viewUrl || null,
          }
        : { id: null, at: toMs(x), link: null },
    )
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const last = toMs(obj.lastArchivedAt ?? obj.archivedAt);
  if (!versions.length && last) versions.push({ id: null, at: last, link: null });
  const declared = Number(obj.count ?? obj.total ?? obj.versionCount);
  let count = Number.isFinite(declared) && obj.count != null ? declared : versions.length;
  let archived = typeof (obj.archived ?? obj.exists) === "boolean" ? obj.archived ?? obj.exists : count > 0;
  if (archived && !count) count = versions.length || 1;
  if (!archived) count = 0;
  return { archived, count, versions: versions.slice(0, 20) };
}

const checkSeq = {};
async function checkStatus(tabId, url, { fresh = false } = {}) {
  const s = await getSettings();
  const ep = endpoints(s);
  if (!s.checkOnLoad || !ep.status || !/^https?:/i.test(url || "")) {
    await patchState(tabId, { url, checking: false, checked: false, archived: false, count: 0, versions: [], checkError: null }, fresh);
    return;
  }
  const my = (checkSeq[tabId] = (checkSeq[tabId] || 0) + 1);
  await patchState(tabId, { url, checking: true }, fresh);
  try {
    const u = new URL(ep.status);
    u.searchParams.set("url", stripHash(url));
    const res = await fetchT(
      u.href,
      { headers: { Accept: "application/json", ...authHeaders(s, false) }, cache: "no-store" },
      s.timeoutSec,
    );
    let info;
    if (res.status === 404) info = { archived: false, count: 0, versions: [] };
    else {
      if (!res.ok) throw new Error(await httpError(res));
      info = normalizeStatus(await res.json());
    }
    if (checkSeq[tabId] !== my) return;
    await patchState(tabId, { ...info, checking: false, checked: true, checkedAt: Date.now(), checkError: null });
  } catch (err) {
    if (checkSeq[tabId] !== my) return;
    await patchState(tabId, { checking: false, checked: true, archived: false, count: 0, versions: [], checkError: errMsg(err) });
  }
}

/* ================= capture ================= */
async function capture(tab, { pendingId = null } = {}) {
  const s = await getSettings();
  const ep = endpoints(s);
  if (!ep.archive) {
    browser.runtime.openOptionsPage();
    const m = "Server URL is not set (see preferences)";
    await patchState(tab.id, { busy: false, lastError: m });
    return { ok: false, error: m };
  }
  await patchState(tab.id, { busy: true, lastError: null });

  try {
    if (!/^(https?|file|ftp):/i.test(tab.url)) throw new Error("This page type cannot be captured");

    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    const page = results && results[0] && results[0].result;
    if (!page) throw new Error("No data returned from page");
    const { html, ...pageInfo } = page;

    await queue; // make sure pending header writes have landed
    const req = (await browser.storage.session.get(reqKey(tab.id)))[reqKey(tab.id)];

    // If this URL is on the pending list, tell the server which entry it was
    if (pendingId == null) {
      const { pendingCache } = await browser.storage.local.get({ pendingCache: null });
      const m = pendingCache && pendingCache.items.find((i) => stripHash(i.url) === stripHash(page.url));
      if (m && m.id != null) pendingId = m.id;
    }

    const body = bodyFile(page.contentType);
    const meta = {
      url: page.url,
      title: page.title,
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      tags: s.tags.split(",").map((t) => t.trim()).filter(Boolean),
      page: pageInfo,
      tab: {
        id: tab.id,
        windowId: tab.windowId,
        incognito: tab.incognito,
        favIconUrl: tab.favIconUrl || null,
        status: tab.status,
      },
      files: { html: body.name, screenshot: null },
    };
    if (pendingId != null) meta.pendingId = pendingId;

    if (req) {
      meta.request = {
        matchesPageUrl: stripHash(req.url) === stripHash(page.url),
        url: req.url,
        method: req.method,
        timestamp: req.timeStamp,
        headers: s.includeRequestHeaders ? redact(req.requestHeaders, s.redactHeaders) : undefined,
      };
      meta.response = {
        status: req.statusCode,
        statusLine: req.statusLine,
        ip: req.ip,
        fromCache: req.fromCache,
        headers: s.includeResponseHeaders ? redact(req.responseHeaders, s.redactHeaders) : undefined,
      };
    }

    if (s.includeCookies) {
      try {
        meta.cookies = await browser.cookies.getAll({ url: page.url });
      } catch (e) {
        meta.cookiesError = String(e);
      }
    }

    let shotBlob = null;
    if (s.includeScreenshot) {
      try {
        const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
        shotBlob = await (await fetch(dataUrl)).blob();
        meta.files.screenshot = "screenshot.jpg";
      } catch (e) {
        meta.screenshotError = String(e);
      }
    }

    // multipart/form-data: metadata (JSON), html (file), screenshot (file, optional)
    const fd = new FormData();
    fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }), "metadata.json");
    fd.append("html", new Blob([html], { type: body.type }), body.name);
    if (shotBlob) fd.append("screenshot", shotBlob, "screenshot.jpg");

    // No Content-Type header: the browser sets multipart boundary itself
    const res = await fetchT(ep.archive, { method: "POST", headers: authHeaders(s, false), body: fd }, s.timeoutSec);
    if (!res.ok) throw new Error(await httpError(res));

    await patchState(tab.id, { busy: false, lastError: null });
    refreshPending(); // pending list changes after archiving
    checkStatus(tab.id, page.url); // new version count
    return { ok: true };
  } catch (err) {
    console.error("Archive failed:", err);
    const msg = errMsg(err);
    await patchState(tab.id, { busy: false, lastError: msg });
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
  await safe(browser.action.setBadgeText({ text: show ? String(count > 999 ? "999+" : count) : "" }));
  await reapplyAll(); // tabs have their own badge state
}

let refreshing = null;
function refreshPending() {
  if (!refreshing) refreshing = doRefresh().finally(() => (refreshing = null));
  return refreshing;
}

async function doRefresh() {
  const s = await getSettings();
  const ep = endpoints(s);
  const { pendingCache: prev } = await browser.storage.local.get({ pendingCache: null });

  if (!ep.pending) {
    await browser.storage.local.set({
      pendingCache: { items: [], fetchedAt: null, error: null, configured: false },
    });
    await updateBadge(0, s);
    return { ok: true };
  }

  try {
    const res = await fetchT(
      ep.pending,
      { method: "GET", headers: { Accept: "application/json", ...authHeaders(s, false) }, cache: "no-store" },
      s.timeoutSec,
    );
    if (!res.ok) throw new Error(await httpError(res));
    const items = normalizePending(await res.json());
    await browser.storage.local.set({
      pendingCache: { items, fetchedAt: Date.now(), error: null, configured: true },
    });
    await updateBadge(items.length, s);
    return { ok: true, count: items.length };
  } catch (err) {
    const msg = errMsg(err);
    await browser.storage.local.set({
      pendingCache: {
        items: prev ? prev.items : [],
        fetchedAt: prev ? prev.fetchedAt : null,
        error: msg,
        configured: true,
      },
    });
    return { ok: false, error: msg };
  }
}

async function ensureAlarm() {
  const s = await getSettings();
  const period = Math.max(1, Number(s.refreshMinutes) || 5);
  const existing = await browser.alarms.get(ALARM);
  if (!endpoints(s).pending) {
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

browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  checkStatus(tabId, tab && tab.url, { fresh: true });
  const v = (await browser.storage.session.get(ptKey(tabId)))[ptKey(tabId)];
  if (v) promptArchive(tabId);
});

/* ================= wiring ================= */
function handleMessage(msg, sender) {
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
    case "check":
      return (async () => {
        const tab = await safe(browser.tabs.get(msg.tabId));
        if (!tab) return { ok: false, error: "No tab" };
        await checkStatus(tab.id, tab.url);
        return { ok: true };
      })();
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
}

// sendResponse style works in both Firefox and Chrome (returning a Promise does not work in Chrome)
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const p = handleMessage(msg, sender);
  if (!p) return false;
  Promise.resolve(p).then(sendResponse, (e) => sendResponse({ ok: false, error: errMsg(e) }));
  return true;
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
    "hostUrl", "archiveUrl", "pendingUrl", "statusUrl", "refreshMinutes",
    "authMode", "authHeaderName", "authToken", "showBadge",
  ];
  if (watch.some((k) => k in changes)) {
    ensureAlarm();
    refreshPending();
  }
});

ensureAlarm(); // re-create the alarm if the browser dropped it
