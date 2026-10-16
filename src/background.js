"use strict";
// Chrome: service worker (importScripts). Firefox: loaded after common.js via manifest "scripts".
if (typeof importScripts === "function") importScripts("common.js");

const ALARM = "refresh-pending";
const SENSITIVE = new Set(["cookie", "authorization", "proxy-authorization", "set-cookie"]);
const busy = new Set();
const inflight = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= toolbar badge ================= */
async function setBadge(tabId, text, color, title) {
  try {
    await api.action.setBadgeText({ tabId, text });
    if (color) await api.action.setBadgeBackgroundColor({ tabId, color });
    if (title) await api.action.setTitle({ tabId, title });
  } catch {
    /* tab gone */
  }
}
function applyStatusBadge(tabId, st) {
  if (!st || st.state === "unsupported" || st.state === "unconfigured") {
    return setBadge(
      tabId,
      "",
      null,
      st?.state === "unconfigured" ? "URL Archiver — server not configured" : "URL Archiver",
    );
  }
  if (st.state === "error")
    return setBadge(tabId, "!", "#d93025", `Status check failed: ${st.error}`);
  if (st.archived) {
    const n = st.count || st.versions?.length || 0;
    const when = st.versions?.[0]?.time ?? st.last;
    return setBadge(
      tabId,
      n ? (n > 99 ? "99+" : String(n)) : "✓",
      "#188038",
      `Archived${n ? ` — ${n} version${n === 1 ? "" : "s"}` : ""}${when ? `\nLast: ${formatTime(when)}` : ""}`,
    );
  }
  return setBadge(tabId, "", null, "URL Archiver — not archived yet");
}

/* ================= request/response header recording ================= */
const hdrMem = new Map();
function patchHdr(tabId, requestId, patch) {
  const cur = hdrMem.get(tabId);
  const next = { ...(cur && cur.requestId === requestId ? cur : { requestId }), ...patch };
  hdrMem.set(tabId, next);
  sset("hdr:" + tabId, next).catch(() => {});
}
async function getHdr(tabId) {
  return hdrMem.get(tabId) ?? (await sget("hdr:" + tabId)) ?? null;
}

function addWR(event, fn, extra) {
  const filter = { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] };
  try {
    event.addListener(fn, filter, [...extra, "extraHeaders"]);
  } catch {
    event.addListener(fn, filter, extra);
  }
}
addWR(
  api.webRequest.onSendHeaders,
  (d) => {
    if (d.tabId < 0) return;
    patchHdr(d.tabId, d.requestId, {
      url: d.url,
      method: d.method,
      requestHeaders: d.requestHeaders,
      responseHeaders: null,
      statusCode: null,
      time: d.timeStamp,
    });
  },
  ["requestHeaders"],
);
addWR(
  api.webRequest.onHeadersReceived,
  (d) => {
    if (d.tabId < 0) return;
    patchHdr(d.tabId, d.requestId, {
      url: d.url,
      statusCode: d.statusCode,
      statusLine: d.statusLine,
      responseHeaders: d.responseHeaders,
    });
  },
  ["responseHeaders"],
);

function headersToObject(list, keepSensitive) {
  const o = {};
  for (const { name, value } of list || []) {
    const lower = name.toLowerCase();
    const v = !keepSensitive && SENSITIVE.has(lower) ? "[redacted]" : (value ?? "");
    o[name] = name in o ? o[name] + (lower === "set-cookie" ? "\n" : ", ") + v : v;
  }
  return o;
}

/* ================= status check ================= */
async function checkTab(tabId) {
  let tab;
  try {
    tab = await api.tabs.get(tabId);
  } catch {
    return null;
  }
  if (!isArchivable(tab.url)) {
    await sdel("status:" + tabId);
    applyStatusBadge(tabId, null);
    return { state: "unsupported", url: tab.url };
  }
  const s = await getSettings();
  const ep = deriveEndpoints(s);
  const url = normalizeUrl(tab.url);
  if (!ep.check) {
    const st = { state: "unconfigured", url };
    await sset("status:" + tabId, st);
    applyStatusBadge(tabId, st);
    return st;
  }
  const key = tabId + "|" + url;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let st;
    try {
      const data = await request(buildCheckUrl(ep.check, url), {
        token: s.apiToken,
        timeoutMs: 20000,
      });
      if (typeof data === "string") throw new Error("Check endpoint returned non-JSON data");
      st = { state: "ok", url, checkedAt: Date.now(), ...normalizeCheck(data) };
    } catch (e) {
      st = { state: "error", url, error: e.message, checkedAt: Date.now() };
    }
    await sset("status:" + tabId, st);
    applyStatusBadge(tabId, st);
    return st;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ================= pending list ================= */
let pendingPromise = null;
function refreshPending() {
  if (pendingPromise) return pendingPromise;
  pendingPromise = (async () => {
    const s = await getSettings();
    const ep = deriveEndpoints(s);
    const { pending: prev } = await api.storage.local.get({ pending: null });
    if (!ep.pending) {
      await api.storage.local.set({
        pending: { items: [], total: 0, fetchedAt: Date.now(), error: null },
      });
      return;
    }
    try {
      const data = await request(ep.pending, { token: s.apiToken, timeoutMs: 20000 });
      if (typeof data === "string") throw new Error("Pending endpoint returned non-JSON data");
      const all = normalizePending(data);
      await api.storage.local.set({
        pending: {
          items: all.slice(0, s.pendingLimit),
          total: all.length,
          fetchedAt: Date.now(),
          error: null,
        },
      });
    } catch (e) {
      await api.storage.local.set({
        pending: {
          items: prev?.items || [],
          total: prev?.total || 0,
          fetchedAt: prev?.fetchedAt || null,
          error: e.message,
        },
      });
    }
  })().finally(() => {
    pendingPromise = null;
  });
  return pendingPromise;
}
async function ensureAlarm(force) {
  const s = await getSettings();
  const mins = Math.max(1, Number(s.pendingRefreshMinutes) || 0);
  if (!Number(s.pendingRefreshMinutes)) {
    await api.alarms.clear(ALARM);
    return;
  }
  const ex = await api.alarms.get(ALARM);
  if (force || !ex || ex.periodInMinutes !== mins)
    api.alarms.create(ALARM, { periodInMinutes: mins, delayInMinutes: mins });
}

/* ================= capture + archive ================= */
function collectPage() {
  // runs inside the page
  const dt = document.doctype;
  const doctype = dt
    ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ""}${!dt.publicId && dt.systemId ? " SYSTEM" : ""}${dt.systemId ? ` "${dt.systemId}"` : ""}>\n`
    : "";
  const meta = {};
  document.querySelectorAll("meta[name],meta[property],meta[http-equiv]").forEach((m) => {
    const k = m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("http-equiv");
    if (k && !(k in meta)) meta[k] = m.getAttribute("content");
  });
  return {
    html: doctype + document.documentElement.outerHTML,
    url: location.href,
    title: document.title,
    referrer: document.referrer,
    lang: document.documentElement.lang || null,
    charset: document.characterSet,
    contentType: document.contentType,
    lastModified: document.lastModified,
    canonical: document.querySelector('link[rel~="canonical"]')?.href || null,
    favicon: document.querySelector('link[rel~="icon"]')?.href || null,
    meta,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    userAgent: navigator.userAgent,
    language: navigator.language,
  };
}

async function takeScreenshot(tab, s, page, warnings) {
  const fmt = s.screenshotFormat === "jpeg" ? "jpeg" : "png";
  const opts = { format: fmt };
  if (fmt === "jpeg") opts.quality = Number(s.jpegQuality) || 85;
  let dataUrl;
  if (typeof api.tabs.captureTab === "function") {
    // Firefox
    if (s.fullPageScreenshot) {
      try {
        dataUrl = await api.tabs.captureTab(tab.id, {
          ...opts,
          scale: 1,
          rect: {
            x: 0,
            y: 0,
            width: Math.min(page.scrollWidth, 16384),
            height: Math.min(page.scrollHeight, 16384),
          },
        });
      } catch (e) {
        warnings.push(`Full-page screenshot failed (${e.message}); captured the viewport instead`);
      }
    }
    dataUrl = dataUrl || (await api.tabs.captureTab(tab.id, opts));
  } else {
    // Chrome: only the visible tab can be captured
    if (!tab.active) {
      warnings.push("Screenshot skipped: tab is not in the foreground");
      return null;
    }
    dataUrl = await api.tabs.captureVisibleTab(tab.windowId, opts);
  }
  return { blob: await (await fetch(dataUrl)).blob(), ext: fmt === "jpeg" ? "jpg" : "png" };
}

async function archiveTab(tabId) {
  if (busy.has(tabId)) throw new Error("An archive is already in progress for this tab");
  busy.add(tabId);
  try {
    await sdel("archiveError:" + tabId);
    const s = await getSettings();
    const ep = deriveEndpoints(s);
    if (!ep.archive)
      throw new Error("Server URL is not configured. Open the extension preferences.");
    const tab = await api.tabs.get(tabId);
    if (!isArchivable(tab.url)) throw new Error("Only http(s) pages can be archived.");
    await setBadge(tabId, "…", "#5f6368", "Archiving…");

    let results;
    try {
      results = await api.scripting.executeScript({ target: { tabId }, func: collectPage });
    } catch (e) {
      throw new Error(
        `Could not read the page (${e.message}). If this is Firefox, make sure site access is granted in the preferences.`,
      );
    }
    const page = results?.[0]?.result;
    if (!page) throw new Error("Could not read the page content.");

    const warnings = [];
    let shot = null;
    if (s.includeScreenshot) {
      try {
        shot = await takeScreenshot(tab, s, page, warnings);
      } catch (e) {
        warnings.push(`Screenshot failed: ${e.message}`);
      }
    }

    const hdr = await getHdr(tabId);
    if (!hdr)
      warnings.push(
        "No request headers recorded for this tab (page was loaded before the extension started)",
      );
    else if (normalizeUrl(hdr.url) !== normalizeUrl(page.url))
      warnings.push(
        "Recorded headers belong to a different URL (page navigated via script/history API)",
      );

    const htmlBlob = new Blob([page.html], { type: "text/html;charset=utf-8" });
    const { html, scrollWidth, scrollHeight, ...pageInfo } = page;
    const metadata = {
      schema: 1,
      url: page.url,
      title: page.title,
      capturedAt: new Date().toISOString(),
      page: { ...pageInfo, scroll: { width: scrollWidth, height: scrollHeight } },
      request: hdr
        ? {
            method: hdr.method || "GET",
            url: hdr.url,
            headers: headersToObject(hdr.requestHeaders, s.includeSensitiveHeaders),
          }
        : null,
      response:
        hdr && s.includeResponseHeaders
          ? {
              statusCode: hdr.statusCode ?? null,
              statusLine: hdr.statusLine ?? null,
              headers: headersToObject(hdr.responseHeaders, s.includeSensitiveHeaders),
            }
          : null,
      sensitiveHeadersRedacted: !s.includeSensitiveHeaders,
      extension: {
        name: api.runtime.getManifest().name,
        version: api.runtime.getManifest().version,
        browser: typeof api.tabs.captureTab === "function" ? "firefox" : "chromium",
      },
      files: {
        html: { name: "page.html", size: htmlBlob.size, sha256: await sha256(htmlBlob) },
        screenshot: shot
          ? {
              name: `screenshot.${shot.ext}`,
              size: shot.blob.size,
              sha256: await sha256(shot.blob),
              format: shot.ext,
            }
          : null,
      },
      warnings,
    };

    const fd = new FormData();
    fd.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      "metadata.json",
    );
    fd.append("html", htmlBlob, "page.html");
    if (shot) fd.append("screenshot", shot.blob, `screenshot.${shot.ext}`);

    const response = await request(ep.archive, {
      method: "POST",
      body: fd,
      token: s.apiToken,
      timeoutMs: (Number(s.requestTimeoutSec) || 120) * 1000,
    });

    const status = await checkTab(tabId); // refresh version info/badge
    refreshPending(); // refresh pending list after archive (not awaited)
    return { status, response, warnings };
  } finally {
    busy.delete(tabId);
  }
}

async function archiveWithFeedback(tabId, { toast }) {
  try {
    const r = await archiveTab(tabId);
    if (toast) {
      const n = r.status?.count;
      injectBanner(tabId, {
        mode: "toast",
        kind: "ok",
        text: `Archived ✓${n ? ` (${n} version${n === 1 ? "" : "s"})` : ""}`,
      });
    }
    return {
      ok: true,
      status: r.status,
      warnings: r.warnings,
      response: typeof r.response === "object" ? r.response : null,
    };
  } catch (e) {
    await sset("archiveError:" + tabId, { message: e.message, time: Date.now() });
    setBadge(tabId, "!", "#d93025", `Archive failed: ${e.message}`);
    if (toast)
      injectBanner(tabId, { mode: "toast", kind: "err", text: `Archive failed: ${e.message}` });
    return { ok: false, error: e.message };
  }
}

/* ================= in-page banner (prompt / toast) ================= */
function pageBanner(opts) {
  // self-contained: serialized into the page
  const api = globalThis.browser ?? globalThis.chrome;
  const ID = "__url_archiver_banner__";
  document.getElementById(ID)?.remove();
  const host = document.createElement("div");
  host.id = ID;
  host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent =
    ".b{font:14px/1.4 system-ui,sans-serif;color:#fff;background:#1f2937;border-radius:10px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:340px;display:flex;flex-direction:column;gap:10px;word-break:break-word}.b.ok{background:#15803d}.b.err{background:#b91c1c}.r{display:flex;gap:8px;justify-content:flex-end}button{font:inherit;border:0;border-radius:6px;padding:5px 12px;cursor:pointer;background:#fff;color:#111}button.p{background:#3b82f6;color:#fff}";
  const box = document.createElement("div");
  root.append(style, box);
  let timer;
  const close = () => {
    clearTimeout(timer);
    host.remove();
  };
  function render(kind, text, buttons) {
    box.className = "b " + (kind || "");
    box.replaceChildren();
    const t = document.createElement("div");
    t.textContent = text;
    box.append(t);
    if (buttons && buttons.length) {
      const row = document.createElement("div");
      row.className = "r";
      for (const [label, fn, primary] of buttons) {
        const b = document.createElement("button");
        b.textContent = label;
        if (primary) b.className = "p";
        b.onclick = fn;
        row.append(b);
      }
      box.append(row);
    }
  }
  const archive = () => {
    render("", "Archiving…", []);
    api.runtime
      .sendMessage({ type: "archiveFromPage" })
      .then((r) => {
        if (r && r.ok) {
          const n = r.status && r.status.count;
          render("ok", "Archived ✓" + (n ? ` (${n} version${n === 1 ? "" : "s"})` : ""), [
            ["Close", close],
          ]);
          timer = setTimeout(close, 5000);
        } else
          render("err", "Archive failed: " + ((r && r.error) || "unknown error"), [
            ["Close", close],
          ]);
      })
      .catch((e) => render("err", "Archive failed: " + e.message, [["Close", close]]));
  };
  if (opts.mode === "prompt")
    render("", opts.text || "Archive this page?", [
      ["Dismiss", close],
      ["Archive now", archive, true],
    ]);
  else {
    render(opts.kind, opts.text, [["Close", close]]);
    if (opts.kind === "ok") timer = setTimeout(close, 5000);
  }
  document.documentElement.append(host);
}
async function injectBanner(tabId, opts) {
  try {
    await api.scripting.executeScript({ target: { tabId }, func: pageBanner, args: [opts] });
  } catch {
    /* restricted page */
  }
}

/* ================= direct archive from pending list ================= */
async function openAndArchive(url) {
  const tab = await api.tabs.create({ url, active: true });
  await sset("open:" + tab.id, { url, at: Date.now() });
}
async function handleOpened(tabId) {
  await sdel("open:" + tabId);
  const s = await getSettings();
  await sleep(Math.max(0, Number(s.directArchiveDelaySec) || 0) * 1000);
  try {
    await api.tabs.get(tabId);
  } catch {
    return;
  }
  if (s.directArchiveMode === "auto") archiveWithFeedback(tabId, { toast: true });
  else injectBanner(tabId, { mode: "prompt", text: "Archive this page?" });
}

/* ================= events ================= */
api.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  const loaded = change.status === "complete" || (change.url && tab.status === "complete");
  if (!loaded || !isArchivable(tab.url)) return;
  if (change.status === "complete" && (await sget("open:" + tabId))) handleOpened(tabId);
  const s = await getSettings();
  if (s.autoCheck) checkTab(tabId);
});
api.tabs.onActivated.addListener(async ({ tabId }) => {
  const st = await sget("status:" + tabId);
  if (st) return;
  const s = await getSettings();
  if (s.autoCheck) checkTab(tabId);
});
api.tabs.onRemoved.addListener((tabId) => {
  hdrMem.delete(tabId);
  sdel("hdr:" + tabId, "status:" + tabId, "archiveError:" + tabId, "open:" + tabId).catch(() => {});
});

api.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "archive-page") return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) archiveWithFeedback(tab.id, { toast: true });
});

api.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refreshPending();
});
api.runtime.onInstalled.addListener(async (d) => {
  await ensureAlarm(true);
  refreshPending();
  const s = await getSettings();
  if (d.reason === "install" && !s.serverUrl && !s.archiveUrl) api.runtime.openOptionsPage();
});
api.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshPending();
});
api.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  await ensureAlarm(true);
  await refreshPending();
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) checkTab(tab.id);
});
ensureAlarm();

/* ================= messages from popup / banner ================= */
async function handle(msg, sender) {
  switch (msg.type) {
    case "getState": {
      const s = await getSettings();
      const ep = deriveEndpoints(s);
      const { pending } = await api.storage.local.get({ pending: null });
      return {
        ok: true,
        configured: { archive: !!ep.archive, pending: !!ep.pending, check: !!ep.check },
        status: msg.tabId != null ? ((await sget("status:" + msg.tabId)) ?? null) : null,
        archiveError:
          msg.tabId != null ? ((await sget("archiveError:" + msg.tabId)) ?? null) : null,
        pending,
        pendingLimit: s.pendingLimit,
      };
    }
    case "checkTab":
      return { ok: true, status: await checkTab(msg.tabId) };
    case "archiveTab":
      return archiveWithFeedback(msg.tabId, { toast: false });
    case "archiveFromPage":
      return archiveWithFeedback(sender.tab.id, { toast: false });
    case "refreshPending":
      await refreshPending();
      return { ok: true };
    case "openAndArchive":
      await openAndArchive(msg.url);
      return { ok: true };
    case "clearArchiveError":
      await sdel("archiveError:" + msg.tabId);
      applyStatusBadge(msg.tabId, await sget("status:" + msg.tabId));
      return { ok: true };
    default:
      return { ok: false, error: "Unknown message " + msg.type };
  }
}
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
