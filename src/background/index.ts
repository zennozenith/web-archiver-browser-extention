import browser from "webextension-polyfill";

import {
  ArchiveTabPayload,
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
  bgLog as log,
  Result,
  getEndpoint,
  HeadersDetails,
  ApiSuccessResponse,
  ApiArchiveVersionsResponse,
  ApiCheckPendingResponse,
  PendingResponseInStorage,
} from "@common/index";
import { collectPage, pageBanner } from "./page";
import { createError, createOk, isStandardError } from "@common/error";
import { WebRequest } from "webextension-polyfill";

log.info("Service worker / background script initialized");

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
    log.warn("restricted page! cannot inject banner");
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
  } catch (err) {
    log.warn("[Background] Could not update badge:", err);
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
    const when = status.versions?.[0]?.time ?? status.last;
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
      log,
      message: `Cannot check tab with id: ${tabId}`,
      extra: e,
    });
  }

  if (!isArchivable(tab.url)) {
    await session_storage_delete(`status:${tabId}`);
    applyStatusBadge(tabId, null);
    return createOk({ state: "unsupported", url: tab.url as Url });
  }

  const extentionSettings = await getExtentionSettings();
  const endpoint = getEndpoint(extentionSettings);
  const url = normalizeUrl(tab.url as Url);

  if (!endpoint.check) {
    const status: Status = { state: "unconfigured", url };
    await session_storage_set(`status:${tabId}`, status);
    applyStatusBadge(tabId, status);
    return createOk(status);
  }

  const key = `${tabId}|${url}` as const;
  if (inflight.has(key)) {
    const status = await inflight.get(key)!;
    return status;
  }

  const inflightStatusPromise: Promise<Result<Status>> = (async () => {
    let status: Status;
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
    } catch (e) {
      const errorMessage = isStandardError(e) ? e.message : String(e);
      status = {
        state: "error",
        url,
        error: errorMessage,
        checkedAt: Date.now(),
      };
    }

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
      await browser.storage.local.set({
        pending: { items: [], total: 0, fetchedAt: Date.now(), error: null },
      });
      return null;
    }
    try {
      const data = await request<ApiCheckPendingResponse>(endpoint.pending, {
        token: extentionSettings.apiToken,
        timeoutMs: 20000,
      });
      if (data.ok === false) {
        return data;
      }

      const pending = data.data;
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
      await browser.storage.local.set({
        pending: {
          items: previousPending?.items || [],
          total: previousPending?.total || 0,
          fetchedAt: previousPending?.fetchedAt || null,
          error: errorMessage,
        },
      });
      return createError({
        log,
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
    response: string | { ok: boolean };
    warnings: string[];
  }>
> {
  if (busyTabs.has(tabId)) {
    return createError({ log, message: "An archive is already in progress for this tab" });
  }

  busyTabs.add(tabId);

  try {
    await session_storage_delete(`archiveError:${tabId}`);

    const extensionSettings = await getExtentionSettings();
    if (!extensionSettings.serverUrl) {
      return createError({
        log,
        message: "Server URL is not configured. Open the extension preferences.",
      });
    }

    const tab = await browser.tabs.get(tabId);
    if (!isArchivable(tab.url)) {
      return createError({
        log,
        message: "Only http(s) pages can be archived.",
        extra: { url: tab.url },
      });
    }

    await updateBadge({
      tabId,
      text: "…",
      color: "#5f6368",
      title: "Archiving…",
    });

    let results: browser.Scripting.InjectionResult[];
    try {
      results = await browser.scripting.executeScript({ target: { tabId }, func: collectPage });
    } catch (e) {
      const errorMessage = isStandardError(e) ? e.message : e;
      return createError({
        log,
        message: `Could not read the page (${errorMessage}). If this is Firefox, make sure site access is granted in the preferences.`,
      });
    }
    const page = results?.[0]?.result as Page | undefined;
    if (!page) {
      return createError({
        log,
        message: "Could not read the page content.",
      });
    }

    const warnings: string[] = [];
    let screenshot = null;

    if (extensionSettings.includeScreenshot) {
      try {
        screenshot = await takeScreenshot(tab, extensionSettings, page, warnings);
      } catch (e) {
        const errorMessage = isStandardError(e) ? e.message : e;
        log.warn(`Screenshot failed: ${errorMessage}`);
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

    const endpoint = getEndpoint(extensionSettings);
    const response = await request<ApiSuccessResponse>(endpoint.server, {
      method: "POST",
      body: formData,
      token: extensionSettings.apiToken,
      timeoutMs: (Number(extensionSettings.requestTimeoutSec) || 120) * 1000,
    });

    const resultStatus = await checkArchiveVersion(tabId); // refresh version info/badge
    if (resultStatus.ok === false) {
      return createError({
        log,
        ...resultStatus.error,
      });
    }
    refreshPending(); // refresh pending list after archive (not awaited)
    return createOk({ status: resultStatus.data, response, warnings });
  } catch (e) {
    log.error("Archive request failed", e);
    return createError({
      log,
      message: "Archive request failed",
      extra: e,
    });
  } finally {
    busyTabs.delete(tabId);
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
        log,
        ...result.error,
      });
    }

    if (result.data.status?.state !== "ok") {
      return createError({
        log,
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
      log,
      message: errorMessage,
      extra: e,
    });
  }
}

/* ================= direct archive from pending list ================= */
async function openAndArchive(url: Url) {
  const tab = await browser.tabs.create({ url, active: true });
  await session_storage_set("open:" + tab.id, { url, at: Date.now() });
}
async function handleOpened(tabId: Int) {
  await session_storage_delete("open:" + tabId);
  const s = await getExtentionSettings();
  await sleep(Math.max(0, Number(s.directArchiveDelaySec) || 0) * 1000);
  try {
    await browser.tabs.get(tabId);
  } catch {
    return;
  }
  if (s.directArchiveMode === "auto") archiveWithFeedback(tabId, { toast: true });
  else injectBanner(tabId, { kind: "", mode: "prompt", text: "Archive this page?" });
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
  if (change.status === "complete" && (await session_storage_get("open:" + tabId)))
    handleOpened(tabId);
  const extentionSettings = await getExtentionSettings();
  if (extentionSettings.autoCheck) checkArchiveVersion(tabId);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const st = await session_storage_get("status:" + tabId);
  if (st) return;
  const extentionSettings = await getExtentionSettings();
  if (extentionSettings.autoCheck) checkArchiveVersion(tabId);
});

browser.tabs.onRemoved.addListener((tabId) => {
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
  if (tab) archiveWithFeedback(tab.id as number, { toast: true });
});

browser.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refreshPending();
});

browser.runtime.onInstalled.addListener(async (d) => {
  await ensureAlarm(true);
  refreshPending();
  const extentionSettings = await getExtentionSettings();
  if (d.reason === "install" && extentionSettings.serverUrl === "")
    browser.runtime.openOptionsPage();
});

browser.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshPending();
});

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  await ensureAlarm(true);
  await refreshPending();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) checkArchiveVersion(tab.id as number);
});

browser.webRequest.onSendHeaders.addListener(
  (tab) => {
    if (tab.tabId < 0) return;
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
  ["requestHeaders", "extraHeaders"],
);

browser.webRequest.onHeadersReceived.addListener(
  (tab) => {
    if (tab.tabId < 0) return;
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
  ["responseHeaders", "extraHeaders"],
);

ensureAlarm();

// Message listener: returns a Promise (native promise in Firefox, polyfilled in Chrome)
browser.runtime.onMessage.addListener(
  // async (message: unknown, sender: browser.Runtime.MessageSender): Promise<MessageResponse> => {
  async (message: unknown, sender: browser.Runtime.MessageSender): Promise<any> => {
    // const msg = message as BaseMessage;
    const msg = message as any;
    log.debug(msg);
    // console.log("[Background] Received message:", msg?.type, "from:", sender.id);

    try {
      switch (msg.type) {
        case "GET_STATE": {
          const extentionSettings = await getExtentionSettings();
          const endpoint = getEndpoint(extentionSettings);
          const { pending } = await browser.storage.local.get({ pending: null });
          return {
            ok: true,
            configured: {
              server: endpoint.server !== "",
              pending: endpoint.pending !== "",
              check: endpoint.check !== "",
            },
            status:
              msg.tabId != null
                ? ((await session_storage_get("status:" + msg.tabId)) ?? null)
                : null,
            archiveError:
              msg.tabId != null
                ? ((await session_storage_get("archiveError:" + msg.tabId)) ?? null)
                : null,
            pending,
            pendingLimit: extentionSettings.pendingLimit,
          };
        }
        case "CHECK_TAB":
          return { ok: true, status: await checkArchiveVersion(msg.tabId) };
        case "ARCHIVE_TAB": {
          const payload = msg as ArchiveTabPayload;
          return await archiveWithFeedback(payload.tabId, { toast: false });
        }
        case "ARCHIVE_FROM_PAGE":
          return archiveWithFeedback(sender.tab!.id as Int, { toast: false });
        case "REFRESH_PENDING":
          await refreshPending();
          return { ok: true };
        case "OPEN_AND_ARCHIVE":
          await openAndArchive(msg.url);
          return { ok: true };
        case "CLEAR_ARCHIVE_ERROR":
          await session_storage_delete("archiveError:" + msg.tabId);
          applyStatusBadge(msg.tabId, await session_storage_get("status:" + msg.tabId));
          return { ok: true };
        default:
          return {
            success: false,
            error: `Unknown message type: ${msg?.type}`,
          };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
);
