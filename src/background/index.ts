import browser from "webextension-polyfill";

import {
  BannerOpts,
  buildCheckUrl,
  ExtensionSettings,
  formatTime,
  getExtentionSettings,
  Int,
  isArchivable,
  normalizeUrl,
  Page,
  request,
  session_storage_delete,
  session_storage_get,
  session_storage_set,
  sha256,
  Status,
  Url,
  Result,
  getEndpoint,
  HeadersDetails,
  ApiArchiveVersionsResponse,
  ApiCheckPendingResponse,
  PendingResponseInStorage,
  MessageType,
  MessagePayload,
  MessageData,
  MessageResponse,
  Message,
  State,
  log as rootLog,
  receiveForwardedLogsInBackground,
  ApiSuccessArchiveResponse,
} from "@common/index";
import { collectPage, pageBanner } from "./page";
import { createError, createOk, isStandardError } from "@common/error";
import { WebRequest } from "webextension-polyfill";

/* ── per-subsystem child loggers (context tag "background" is added automatically) ── */
const log = rootLog.child("bg");
const logMsg = log.child("msg");
const logWebReq = log.child("webrequest");
const logBadge = log.child("badge");
const logCheck = log.child("check");
const logPending = log.child("pending");
const logArchive = log.child("archive");
const logCapture = log.child("capture");

/* Popup/options pages forward their log entries here so everything shows up
   in this (service worker) console. */
receiveForwardedLogsInBackground();

const ENGINE = typeof browser.tabs.captureTab === "function" ? "gecko" : "blink";
const EXTENSION_VERSION = browser.runtime.getManifest().version;

log.info("Service worker / background script initialized", {
  version: EXTENSION_VERSION,
  engine: ENGINE,
});

const ALARM = "refresh-pending";
const SENSITIVE = new Set(["cookie", "authorization", "proxy-authorization", "set-cookie"]);
const busyTabs = new Set<Int>();
const inflight = new Map<`${Int}|${Url}`, Promise<Result<Status>>>();
const sleep = (ms: Int) => new Promise((resolve) => setTimeout(resolve, ms));

const headerMemory = new Map<Int, Partial<HeadersDetails>>();

async function injectBanner(tabId: Int, opts: BannerOpts): Promise<void> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, func: pageBanner, args: [opts] });
  } catch {
    log.warn("restricted page, cannot inject banner", { tabId, mode: opts.mode });
  }
}

function headersToObject(
  headerList: WebRequest.HttpHeaders | null | undefined,
  keepSensitive: boolean = false,
): Record<string, string> {
  const headersMap: Record<string, string> = {};

  for (const { name, value } of headerList || []) {
    const lowerName = name.toLowerCase();
    const headerValue = !keepSensitive && SENSITIVE.has(lowerName) ? "[redacted]" : (value ?? "");

    if (name in headersMap) {
      const separator = lowerName === "set-cookie" ? "\n" : ", ";
      headersMap[name] = `${headersMap[name]}${separator}${headerValue}`;
    } else {
      headersMap[name] = headerValue;
    }
  }

  return headersMap;
}

/**
 *
 */
function patchHeaders(tabId: Int, requestId: string, patch: Partial<HeadersDetails>): void {
  const current = headerMemory.get(tabId);
  const next: Partial<HeadersDetails> = {
    ...(current && current.requestId === requestId ? current : { requestId }),
    ...patch,
  };
  headerMemory.set(tabId, next);
  session_storage_set(`hdr:${tabId}`, next).catch(() => {});
}

async function getHeadersWithDetails(tabId: Int): Promise<Partial<HeadersDetails> | null> {
  return headerMemory.get(tabId) ?? (await session_storage_get(`hdr:${tabId}`)) ?? null;
}

/**
 * Update the extension action badge text with the number of archive versions
 */
async function updateBadge({
  text,
  force = false,
  color,
  tabId,
  title,
}: {
  text: string;
  title?: string;
  color?: string;
  tabId?: number;
  force?: boolean;
}): Promise<void> {
  try {
    const extentionSettings = await getExtentionSettings();

    if (!extentionSettings.showBadge && !force) {
      await browser.action.setBadgeText({ text: "", tabId });
      return;
    }

    await browser.action.setBadgeText({ tabId, text });
    if (color) await browser.action.setBadgeBackgroundColor({ tabId, color });
    if (title) await browser.action.setTitle({ tabId, title });
    logBadge.debug("Badge updated", { tabId, text });
  } catch (err) {
    logBadge.warn("Could not update badge", { tabId, text }, err);
  }
}

function applyStatusBadge(tabId: Int, status: Status | null): Promise<void> {
  if (!status || status.state === "unsupported" || status.state === "unconfigured") {
    return updateBadge({
      tabId,
      text: "",
      title:
        status?.state === "unconfigured" ? "URL Archiver — server not configured" : "URL Archiver",
    });
  }
  if (status.state === "error")
    return updateBadge({
      tabId,
      text: "!",
      color: "#d93025",
      title: `Status check failed: ${status.error}`,
    });
  if (status.archived) {
    const n = status.count || status.versions?.length || 0;
    const when = status.versions?.[0]?.archivedAt ?? status.lastArchivedAt;
    return updateBadge({
      tabId,
      text: n ? (n > 99 ? "99+" : String(n)) : "✓",
      color: "#188038",
      title: `Archived${n ? ` — ${n} version${n === 1 ? "" : "s"}` : ""}${when ? `\nLast: ${formatTime(when)}` : ""}`,
    });
  }
  return updateBadge({
    tabId,
    text: "",
    title: "URL Archiver — not archived yet",
  });
}

/* ================= capture + archive ================= */

async function checkArchiveVersion(tabId: Int): Promise<Result<Status>> {
  let tab: browser.Tabs.Tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch (e) {
    return createError({
      log: logCheck,
      message: `Cannot check tab with id: ${tabId}`,
      extra: e,
    });
  }

  if (!isArchivable(tab.url)) {
    logCheck.debug("URL not archivable, clearing status", { tabId, url: tab.url });
    await session_storage_delete(`status:${tabId}`);
    applyStatusBadge(tabId, null);
    return createOk({ state: "unsupported", url: tab.url as Url, checkedAt: Date.now() });
  }

  const extentionSettings = await getExtentionSettings();
  const endpoint = getEndpoint(extentionSettings);
  const url = normalizeUrl(tab.url as Url);

  if (!endpoint.check) {
    logCheck.debug("Check endpoint not configured", { tabId, url });
    const status: Status = { state: "unconfigured", url, checkedAt: Date.now() };
    await session_storage_set(`status:${tabId}`, status);
    applyStatusBadge(tabId, status);
    return createOk(status);
  }

  const key = `${tabId}|${url}` as const;
  if (inflight.has(key)) {
    logCheck.debug("Joining in-flight status check", { tabId, url });
    const status = await inflight.get(key)!;
    return status;
  }

  const inflightStatusPromise: Promise<Result<Status>> = (async () => {
    let status: Status;
    logCheck.debug("Checking archive status", { tabId, url });
    const done = logCheck.time("status check");
    try {
      const data = await request<ApiArchiveVersionsResponse>(buildCheckUrl(endpoint.check, url), {
        token: extentionSettings.apiToken,
        timeoutMs: 20000,
      });
      if (data.ok === false) {
        status = { state: "error", url, checkedAt: Date.now(), error: data.error.message };
      } else {
        status = { state: "ok", url, checkedAt: Date.now(), ...data.data };
      }
      done(status.state);
    } catch (e) {
      const errorMessage = isStandardError(e) ? e.message : String(e);
      status = {
        state: "error",
        url,
        error: errorMessage,
        checkedAt: Date.now(),
      };
    }

    logCheck[status.state === "error" ? "warn" : "debug"](
      `Archive status: ${status.state}`,
      status,
    );
    await session_storage_set("status:" + tabId, status);
    applyStatusBadge(tabId, status);
    return createOk(status);
  })().finally(() => inflight.delete(key));

  inflight.set(key, inflightStatusPromise);
  return inflightStatusPromise;
}

/* ================= pending list ================= */
let pendingPromise: Promise<Result<ApiCheckPendingResponse> | null> | null = null;
function refreshPending(): Promise<Result<ApiCheckPendingResponse> | null> {
  if (pendingPromise) return pendingPromise;

  pendingPromise = (async () => {
    const extentionSettings = await getExtentionSettings();
    const endpoint = getEndpoint(extentionSettings);
    const { pending: previousPending } = (await browser.storage.local.get({ pending: null })) as {
      pending: PendingResponseInStorage;
    };

    if (!endpoint.pending) {
      logPending.debug("Pending endpoint not configured");
      await browser.storage.local.set({
        pending: { items: [], total: 0, fetchedAt: Date.now(), error: null },
      });
      return null;
    }
    try {
      logPending.debug("Refreshing pending list");
      const done = logPending.time("pending refresh");
      const data = await request<ApiCheckPendingResponse>(endpoint.pending, {
        token: extentionSettings.apiToken,
        timeoutMs: 20000,
      });
      if (data.ok === false) {
        return data;
      }

      const pending = data.data;
      done({
        fetched: pending.items.length,
        total: pending.total,
        limit: extentionSettings.pendingLimit,
      });
      logPending.debug(
        `Pending list refreshed: ${pending.items.length} item${pending.items.length === 1 ? "" : "s"}`,
      );
      await browser.storage.local.set({
        pending: {
          items: pending.items.slice(0, extentionSettings.pendingLimit),
          total: pending.items.length,
          fetchedAt: Date.now(),
          error: null,
        },
      });
      return data;
    } catch (e) {
      const errorMessage = isStandardError(e) ? e.message : String(e);
      logPending.warn("Pending list refresh failed", errorMessage);
      await browser.storage.local.set({
        pending: {
          items: previousPending?.items || [],
          total: previousPending?.total || 0,
          fetchedAt: previousPending?.fetchedAt || null,
          error: errorMessage,
        },
      });
      return createError({
        log: logPending,
        message: errorMessage,
        extra: e,
      });
    }
  })().finally(() => {
    pendingPromise = null;
  });
  return pendingPromise;
}

async function takeScreenshot(
  tab: browser.Tabs.Tab,
  extensionSettings: ExtensionSettings,
  page: Page,
  warnings: string[],
): Promise<{ blob: Blob; ext: "jpg" | "png" } | null> {
  const format = extensionSettings.screenshotFormat === "jpeg" ? "jpeg" : "png";
  const opts: { format: ExtensionSettings["screenshotFormat"]; quality?: number } = { format };
  if (format === "jpeg") opts.quality = Number(extensionSettings.jpegQuality) || 85;

  let dataUrl;

  if (typeof browser.tabs.captureTab === "function") {
    // Firefox
    if (extensionSettings.fullPageScreenshot) {
      try {
        dataUrl = await browser.tabs.captureTab(tab.id, {
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
        const errorMessage = isStandardError(e) ? e.message : String(e);
        warnings.push(
          `Full-page screenshot failed (${errorMessage}); captured the viewport instead`,
        );
      }
    }
    dataUrl = dataUrl || (await browser.tabs.captureTab(tab.id, opts));
  } else {
    // Chrome: only the visible tab can be captured
    if (!tab.active) {
      warnings.push("Screenshot skipped: tab is not in the foreground");
      return null;
    }
    dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, opts);
  }
  return { blob: await (await fetch(dataUrl)).blob(), ext: format === "jpeg" ? "jpg" : "png" };
}

async function archiveTab(tabId: Int): Promise<
  Result<{
    status: Status | null;
    response: Result<ApiSuccessArchiveResponse, string>;
    warnings: string[];
  }>
> {
  if (busyTabs.has(tabId)) {
    return createError({
      log: logArchive,
      message: "An archive is already in progress for this tab",
      extra: { tabId },
    });
  }

  busyTabs.add(tabId);
  const measure = logArchive.time("archive tab");

  try {
    await session_storage_delete(`archiveError:${tabId}`);

    const extensionSettings = await getExtentionSettings();
    const endpoint = getEndpoint(extensionSettings);
    if (!endpoint.server || !endpoint.archive) {
      logArchive.debug("Server/Archive URL not configured");
      return createError({
        log: logArchive,
        message: "Server/Archive URL is not configured. Open the extension preferences.",
      });
    }

    const tab = await browser.tabs.get(tabId);
    if (!isArchivable(tab.url)) {
      return createError({
        log: logArchive,
        message: "Only http(s) pages can be archived.",
        extra: { url: tab.url },
      });
    }
    logArchive.info("Archiving page", { tabId, url: tab.url, title: tab.title });

    await updateBadge({
      tabId,
      text: "…",
      color: "#5f6368",
      title: "Archiving…",
    });

    let results: browser.Scripting.InjectionResult[];
    const doneCollect = logArchive.time("collect page");
    try {
      results = await browser.scripting.executeScript({ target: { tabId }, func: collectPage });
    } catch (e) {
      const errorMessage = isStandardError(e) ? e.message : e;
      return createError({
        log: logArchive,
        message: `Could not read the page (${errorMessage}). If this is Firefox, make sure site access is granted in the preferences.`,
      });
    }
    doneCollect(`fetch ${results?.[0]?.result ? "ok" : "empty"}`);
    const page = results?.[0]?.result as Page | undefined;
    if (!page) {
      return createError({
        log: logArchive,
        message: "Could not read the page content.",
      });
    }

    const warnings: string[] = [];
    let screenshot = null;

    if (extensionSettings.includeScreenshot) {
      try {
        const doneShot = logArchive.time("screenshot");
        screenshot = await takeScreenshot(tab, extensionSettings, page, warnings);
        if (screenshot) doneShot(screenshot.ext, screenshot.blob.size);
      } catch (e) {
        const errorMessage = isStandardError(e) ? e.message : e;
        logArchive.warn(`Screenshot failed: ${errorMessage}`);
        warnings.push(`Screenshot failed: ${errorMessage}`);
      }
    }
    const headers = await getHeadersWithDetails(tabId);
    if (!headers) {
      log.warn(
        "No request headers recorded for this tab (page was loaded before the extension started)",
      );
      warnings.push(
        "No request headers recorded for this tab (page was loaded before the extension started)",
      );
    } else if (normalizeUrl(headers.url as Url) !== normalizeUrl(page.url)) {
      log.warn(
        "Recorded headers belong to a different URL (page navigated via script/history browser)",
      );
      warnings.push(
        "Recorded headers belong to a different URL (page navigated via script/history browser)",
      );
    }

    const { html, scrollWidth, scrollHeight, ...pageInfo } = page;
    const htmlBlob = new Blob([html], { type: "text/html;charset=utf-8" });
    const metadata = {
      schema: 1,
      url: page.url,
      title: page.title,
      capturedAt: new Date().toISOString(),
      page: { ...pageInfo, scroll: { width: scrollWidth, height: scrollHeight } },
      request: headers
        ? {
            method: headers.method || "GET",
            url: headers.url,
            headers: headersToObject(
              headers.requestHeaders,
              extensionSettings.includeSensitiveHeaders,
            ),
          }
        : null,
      response:
        headers && extensionSettings.includeResponseHeaders
          ? {
              statusCode: headers.statusCode ?? null,
              statusLine: headers.statusLine ?? null,
              headers: headersToObject(
                headers.responseHeaders,
                extensionSettings.includeSensitiveHeaders,
              ),
            }
          : null,
      sensitiveHeadersRedacted: !extensionSettings.includeSensitiveHeaders,
      extension: {
        name: browser.runtime.getManifest().name,
        version: browser.runtime.getManifest().version,
        browser: typeof browser.tabs.captureTab === "function" ? "firefox" : "chromium",
      },
      files: {
        html: { name: "page.html", size: htmlBlob.size, sha256: await sha256(htmlBlob) },
        screenshot: screenshot
          ? {
              name: `screenshot.${screenshot.ext}`,
              size: screenshot.blob.size,
              sha256: await sha256(screenshot.blob),
              format: screenshot.ext,
            }
          : null,
      },
      warnings,
    };

    const formData = new FormData();
    formData.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      "metadata.json",
    );
    formData.append("html", htmlBlob, "page.html");
    if (screenshot) {
      formData.append("screenshot", screenshot.blob, `screenshot.${screenshot.ext}`);
    }

    logArchive.info("Uploading archive", {
      url: page.url,
      htmlBytes: htmlBlob.size,
      screenshotBytes: screenshot?.blob.size ?? null,
    });
    const response = await request<ApiSuccessArchiveResponse>(endpoint.archive, {
      method: "POST",
      body: formData,
      token: extensionSettings.apiToken,
      timeoutMs: (Number(extensionSettings.requestTimeoutSec) || 120) * 1000,
    });

    const resultStatus = await checkArchiveVersion(tabId); // refresh version info/badge
    if (resultStatus.ok === false) {
      return createError({
        log: logArchive,
        ...resultStatus.error,
      });
    }
    refreshPending(); // refresh pending list after archive (not awaited)
    if (resultStatus.data.state === "ok") {
      logArchive.info("Page archived", {
        tabId,
        url: page.url,
        versions: resultStatus.data.count,
      });
    }
    return createOk({ status: resultStatus.data, response, warnings });
  } catch (e) {
    logArchive.error("Archive request failed", e);
    return createError({
      log: logArchive,
      message: "Archive request failed",
      extra: e,
    });
  } finally {
    busyTabs.delete(tabId);
    measure();
  }
}

async function archiveWithFeedback(
  tabId: Int,
  { toast }: { toast: boolean },
): ReturnType<typeof archiveTab> {
  try {
    const result = await archiveTab(tabId);
    if (result.ok === false) {
      return createError({
        log: logArchive,
        ...result.error,
      });
    }

    if (result.data.status?.state !== "ok") {
      return createError({
        log: logArchive,
        message: result.data.status?.state ?? "status not ok",
        extra: result.data,
      });
    }

    if (toast) {
      const n = result.data.status.count;
      injectBanner(tabId, {
        mode: "toast",
        kind: "ok",
        text: `Archived ✓${n ? ` (${n} version${n === 1 ? "" : "s"})` : ""}`,
      });
    }
    return createOk(result.data);
  } catch (e) {
    const errorMessage = isStandardError(e) ? e.message : String(e);
    logArchive.error("Archive failed", errorMessage, e);

    await session_storage_set("archiveError:" + tabId, {
      message: errorMessage,
      time: Date.now(),
    });
    updateBadge({
      tabId,
      text: "!",
      color: "#d93025",
      title: `Archive failed: ${errorMessage}`,
    });

    if (toast)
      injectBanner(tabId, {
        mode: "toast",
        kind: "err",
        text: `Archive failed: ${errorMessage}`,
      });

    return createError({
      log: logArchive,
      message: errorMessage,
      extra: e,
    });
  }
}

/* ================= direct archive from pending list ================= */
async function openAndArchive(url: Url) {
  const tab = await browser.tabs.create({ url, active: true });
  logCapture.info("Opened new tab for direct archive", { url, tabId: tab.id });
  await session_storage_set(`open:${tab.id}`, { url, at: Date.now() });
}

async function handleOpened(tabId: Int) {
  await session_storage_delete(`open:${tabId}`);
  const s = await getExtentionSettings();
  await sleep(Math.max(0, Number(s.directArchiveDelaySec) || 0) * 1000);
  try {
    await browser.tabs.get(tabId);
  } catch {
    logCapture.debug("Direct-archive tab closed before archiving", { tabId });
    return;
  }
  logCapture.debug(`Direct-archive mode: ${s.directArchiveMode}`, { tabId });
  if (s.directArchiveMode === "auto") {
    archiveWithFeedback(tabId, { toast: true });
  } else {
    injectBanner(tabId, { kind: "", mode: "prompt", text: "Archive this page?" });
  }
}

/* ================= ================= ================= */

// // Lifecycle: onInstalled
// browser.runtime.onInstalled.addListener(async (details) => {
//   console.log("[Background] Extension installed/updated, reason:", details.reason);

//   const initialSettings = await getExtentionSettings();
//   await browser.storage.sync.set({
//     [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, ...initialSettings },
//   });

//   const count = await getCounter();
//   await updateBadge(count);
// });

// // Storage changes: keep badge synchronized
// browser.storage.onChanged.addListener((changes, namespace) => {
//   if (namespace === "local" && changes[STORAGE_KEYS.COUNTER]) {
//     const rawValue = changes[STORAGE_KEYS.COUNTER].newValue;
//     const newCount = typeof rawValue === "number" ? rawValue : 0;
//     updateBadge(newCount);
//   } else if (namespace === "sync" && changes[STORAGE_KEYS.SETTINGS]) {
//     getCounter().then(updateBadge);
//   }
// });

/* ================= ================= ================= */
async function ensureAlarm(force: boolean = false) {
  const extentionSettings = await getExtentionSettings();
  const mins = Math.max(1, Number(extentionSettings.pendingRefreshMinutes) || 0);
  if (!Number(extentionSettings.pendingRefreshMinutes)) {
    await browser.alarms.clear(ALARM);
    return;
  }
  const alarm = await browser.alarms.get(ALARM);
  if (force || !alarm || alarm.periodInMinutes !== mins)
    browser.alarms.create(ALARM, { periodInMinutes: mins, delayInMinutes: mins });
}

/* ================= events ================= */
browser.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  const loaded = change.status === "complete" || (change.url && tab.status === "complete");
  if (!loaded || !isArchivable(tab.url)) return;
  logWebReq.debug("Page load complete", { tabId, url: tab.url });
  if (change.status === "complete" && (await session_storage_get(`open:${tabId}`))) {
    handleOpened(tabId);
  }
  const extentionSettings = await getExtentionSettings();
  if (extentionSettings.autoCheck) checkArchiveVersion(tabId);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const st = await session_storage_get("status:" + tabId);
  if (st) return;

  logCheck.debug("Tab activated with no cached status, re-checking", { tabId });

  const extentionSettings = await getExtentionSettings();
  const tab = await browser.tabs.get(tabId);

  if (extentionSettings.autoCheck && tab.url !== "") {
    checkArchiveVersion(tabId);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  logWebReq.debug("Tab removed", { tabId });
  headerMemory.delete(tabId);
  session_storage_delete(
    "hdr:" + tabId,
    "status:" + tabId,
    "archiveError:" + tabId,
    "open:" + tabId,
  ).catch(() => {});
});

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "archive-page") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    log.info("Keyboard shortcut received", { command: cmd, tabId: tab.id });
    archiveWithFeedback(tab.id as number, { toast: true });
  }
});

browser.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) {
    logPending.debug("Periodic refresh alarm fired");
    refreshPending();
  }
});

browser.runtime.onInstalled.addListener(async (d) => {
  log.info("Extension installed/updated", d.reason);
  await ensureAlarm(true);
  refreshPending();
  const extentionSettings = await getExtentionSettings();
  if (d.reason === "install" && extentionSettings.serverUrl === "") {
    log.info("First install, opening options page to configure the server");
    browser.runtime.openOptionsPage();
  }
});

browser.runtime.onStartup.addListener(() => {
  log.debug("Browser startup");
  ensureAlarm();
  refreshPending();
});

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  log.debug("Settings changed, refreshing pending list and status", Object.keys(changes));
  await ensureAlarm(true);
  await refreshPending();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) checkArchiveVersion(tab.id as number);
});

browser.webRequest.onSendHeaders.addListener(
  (tab) => {
    if (tab.tabId < 0) return;
    logWebReq.debug("→ onSendHeaders", { tabId: tab.tabId, url: tab.url, method: tab.method });
    patchHeaders(tab.tabId, tab.requestId, {
      tabId: tab.tabId,
      requestId: tab.requestId,
      url: tab.url,
      method: tab.method,
      requestHeaders: tab.requestHeaders,
      timeStamp: tab.timeStamp,
    });
  },
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["main_frame"],
  },
  ENGINE === "gecko" ? ["requestHeaders"] : ["requestHeaders", "extraHeaders"],
);

browser.webRequest.onHeadersReceived.addListener(
  (tab) => {
    if (tab.tabId < 0) return;
    logWebReq.debug("← onHeadersReceived", {
      tabId: tab.tabId,
      url: tab.url,
      statusCode: tab.statusCode,
    });
    patchHeaders(tab.tabId, tab.requestId, {
      requestId: tab.requestId,
      tabId: tab.tabId,
      url: tab.url,
      statusCode: tab.statusCode,
      statusLine: tab.statusLine,
      responseHeaders: tab.responseHeaders,
    });
  },
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["main_frame"],
  },
  ENGINE === "gecko" ? ["responseHeaders"] : ["responseHeaders", "extraHeaders"],
);

ensureAlarm();

type Handlers = {
  [K in MessageType]: (
    payload: MessagePayload<K>,
    sender: browser.Runtime.MessageSender,
  ) => MessageData<K> | Promise<MessageData<K>>;
};

/** Requires a handler for every message type (compile error if one is missing). */
export function registerHandlers(handlers: Handlers): void {
  browser.runtime.onMessage.addListener((raw: unknown, sender: browser.Runtime.MessageSender) => {
    if (!isMessage(raw, handlers)) return undefined; // not ours (includes forwarded log entries)

    logMsg.debug("→ On message", raw.type, raw.payload, { senderTabId: sender?.tab?.id ?? null });

    const handler = handlers[raw.type] as (
      payload: unknown,
      sender: browser.Runtime.MessageSender,
    ) => unknown;

    return (async (): Promise<MessageResponse<unknown>> => {
      try {
        return { success: true, data: await handler(raw.payload, sender) };
      } catch (err) {
        logMsg.error(`message:${raw.type} handler failed`, err);
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })();
  });
}

function isMessage(raw: unknown, handlers: Handlers): raw is Message {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "type" in raw &&
    typeof raw.type === "string" &&
    Object.hasOwn(handlers, raw.type)
  );
}

registerHandlers({
  GET_STATE: async ({ tabId }) => {
    const extentionSettings = await getExtentionSettings();
    const endpoint = getEndpoint(extentionSettings);
    const { pending } = (await browser.storage.local.get({ pending: null })) as {
      pending: PendingResponseInStorage;
    };
    return {
      ok: true,
      configured: {
        server: endpoint.server !== "",
        archive: endpoint.archive !== "",
        pending: endpoint.pending !== "",
        check: endpoint.check !== "",
      },
      status: tabId != null ? ((await session_storage_get("status:" + tabId)) ?? null) : null,
      archiveError:
        tabId != null ? ((await session_storage_get("archiveError:" + tabId)) ?? null) : null,
      pending,
      pendingLimit: extentionSettings.pendingLimit,
    } satisfies State;
  },
  ARCHIVE_TAB: async ({ tabId }) => {
    return await archiveWithFeedback(tabId, { toast: false });
  },
  CHECK_ARCHIVE: async ({ tabId }) => await checkArchiveVersion(tabId),
  ARCHIVE_FROM_PAGE: async (_, sender) =>
    await archiveWithFeedback(sender.tab!.id as Int, { toast: false }),
  REFRESH_PENDING: async () => {
    const t = await refreshPending();
    return { ok: t === null ? false : t.ok };
  },
  OPEN_AND_ARCHIVE: async ({ url }) => {
    await openAndArchive(url);
  },
  CLEAR_ARCHIVE_ERROR: async ({ tabId }) => {
    await session_storage_delete(`archiveError:${tabId}`);
    applyStatusBadge(tabId, await session_storage_get(`status:${tabId}`));
    return { ok: true };
  },
});
