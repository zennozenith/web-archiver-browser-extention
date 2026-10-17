import browser from "webextension-polyfill";
import {
  ArchiveTabPayload,
  BannerOpts,
  buildCheckUrl,
  deriveEndpoints,
  ErrorWithMessage,
  ExtensionSettings,
  formatTime,
  getExtentionSettings,
  HeaderItem,
  HeadersWithMeta,
  Int,
  isArchivable,
  normalizeCheck,
  normalizePending,
  normalizeUrl,
  OkStatus,
  Page,
  Pending,
  request,
  session_storage_delete,
  session_storage_get,
  session_storage_set,
  sha256,
  Status,
  Url,
} from "@common/index";

console.log("[Background] Service worker / background script initialized");

const ALARM = "refresh-pending";
const SENSITIVE = new Set(["cookie", "authorization", "proxy-authorization", "set-cookie"]);
const busyTabs = new Set<Int>();
const inflight = new Map<`${Int}|${Url}`, Promise<Status>>();
const sleep = (ms: Int) => new Promise((resolve) => setTimeout(resolve, ms));

const headerMemory = new Map<Int, HeadersWithMeta>();

/* ================= in-page banner (prompt / toast) ================= */
function pageBanner(opts: BannerOpts) {
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

  let timer: NodeJS.Timeout;

  const close = () => {
    clearTimeout(timer);
    host.remove();
  };

  function render(kind: string, text: string, buttons: any) {
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

async function injectBanner(tabId: Int, opts: BannerOpts) {
  try {
    await browser.scripting.executeScript({ target: { tabId }, func: pageBanner, args: [opts] });
  } catch {
    /* restricted page */
  }
}

function headersToObject(
  headerList: HeaderItem[] | null | undefined,
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
// function patchHeaders(tabId: Int, requestId: Int, patch) {
//   const current = headerMemory.get(tabId);
//   const next = {
//     ...(current && current.requestId === requestId ? current : { requestId }),
//     ...patch,
//   };
//   headerMemory.set(tabId, next);
//   session_storage_set(`hdr:${tabId}`, next).catch(() => {});
// }

async function getHeadersWithMeta(tabId: Int): Promise<HeadersWithMeta | null> {
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
    console.warn("[Background] Could not update badge:", err);
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

async function checkTab(tabId: Int): Promise<Promise<Status> | null> {
  let tab: browser.Tabs.Tab & { url: Url };
  try {
    tab = (await browser.tabs.get(tabId)) as browser.Tabs.Tab & { url: Url };
  } catch {
    return null;
  }

  if (!isArchivable(tab.url)) {
    await session_storage_delete(`status:${tabId}`);
    applyStatusBadge(tabId, null);
    return { state: "unsupported", url: tab.url };
  }

  const extentionSettins = await getExtentionSettings();
  const endpoints = deriveEndpoints(extentionSettins);
  const url = normalizeUrl(tab.url);

  if (!endpoints.check) {
    const status: Status = { state: "unconfigured", url };
    await session_storage_set(`status:${tabId}`, status);
    applyStatusBadge(tabId, status);
    return status;
  }

  const key = `${tabId}|${url}` as const;
  if (inflight.has(key)) {
    return inflight.get(key)!;
  }

  const inflightStatusPromise = (async () => {
    let status: Status;
    try {
      const data = await request(buildCheckUrl(endpoints.check, url), {
        token: extentionSettins.apiToken,
        timeoutMs: 20000,
      });
      if (typeof data === "string") throw new Error("Check endpoint returned non-JSON data");
      status = { state: "ok", url, checkedAt: Date.now(), ...normalizeCheck(data) };
    } catch (e) {
      status = {
        state: "error",
        url,
        error: (e as ErrorWithMessage).message,
        checkedAt: Date.now(),
      };
    }
    await session_storage_set("status:" + tabId, status);
    applyStatusBadge(tabId, status);
    return status;
  })().finally(() => inflight.delete(key));

  inflight.set(key, inflightStatusPromise);
  return inflightStatusPromise;
}

/* ================= pending list ================= */
let pendingPromise: Promise<void> | null = null;
function refreshPending() {
  if (pendingPromise) return pendingPromise;

  pendingPromise = (async () => {
    const extentionSettings = await getExtentionSettings();
    const endpoints = deriveEndpoints(extentionSettings);
    const { pending: previousPending } = (await browser.storage.local.get({ pending: null })) as {
      pending: Pending;
    };

    if (!endpoints.pending) {
      await browser.storage.local.set({
        pending: { items: [], total: 0, fetchedAt: Date.now(), error: null },
      });
      return;
    }
    try {
      const data = await request(endpoints.pending, {
        token: extentionSettings.apiToken,
        timeoutMs: 20000,
      });
      if (typeof data === "string") throw new Error("Pending endpoint returned non-JSON data");
      const pending = normalizePending(data);
      await browser.storage.local.set({
        pending: {
          items: pending.items.slice(0, extentionSettings.pendingLimit),
          total: pending.items.length,
          fetchedAt: Date.now(),
          error: null,
        },
      });
    } catch (e) {
      await browser.storage.local.set({
        pending: {
          items: previousPending?.items || [],
          total: previousPending?.total || 0,
          fetchedAt: previousPending?.fetchedAt || null,
          error: (e as ErrorWithMessage).message,
        },
      });
    }
  })().finally(() => {
    pendingPromise = null;
  });
  return pendingPromise;
}

/**
 * runs inside the page
 */
function collectPage(): Page {
  const dt = document.doctype;
  const doctype = dt
    ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ""}${!dt.publicId && dt.systemId ? " SYSTEM" : ""}${dt.systemId ? ` "${dt.systemId}"` : ""}>\n`
    : "";

  const meta: Record<string, string | null> = {};
  document.querySelectorAll("meta[name],meta[property],meta[http-equiv]").forEach((metaElement) => {
    const attributeValue =
      metaElement.getAttribute("name") ||
      metaElement.getAttribute("property") ||
      metaElement.getAttribute("http-equiv");
    if (attributeValue && !(attributeValue in meta))
      meta[attributeValue] = metaElement.getAttribute("content");
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
    canonical: document.querySelector<HTMLLinkElement>('link[rel~="canonical"]')?.href || null,
    favicon: document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href || null,
    meta,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    userAgent: navigator.userAgent,
    language: navigator.language,
  };
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
        warnings.push(
          `Full-page screenshot failed (${(e as ErrorWithMessage).message}); captured the viewport instead`,
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

async function archiveTab(tabId: Int): Promise<{
  status: Status | null;
  response: string | { ok: boolean };
  warnings: string[];
}> {
  if (busyTabs.has(tabId)) throw new Error("An archive is already in progress for this tab");
  busyTabs.add(tabId);

  try {
    await session_storage_delete(`archiveError:${tabId}`);

    const extensionSettings = await getExtentionSettings();
    const endpoints = deriveEndpoints(extensionSettings);
    if (!endpoints.archive)
      throw new Error("Server URL is not configured. Open the extension preferences.");

    const tab = await browser.tabs.get(tabId);
    if (!isArchivable(tab.url)) throw new Error("Only http(s) pages can be archived.");
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
      throw new Error(
        `Could not read the page (${(e as ErrorWithMessage).message}). If this is Firefox, make sure site access is granted in the preferences.`,
      );
    }
    const page = results?.[0]?.result as Page | undefined;
    if (!page) throw new Error("Could not read the page content.");

    const warnings: string[] = [];
    let screenshot = null;
    if (extensionSettings.includeScreenshot) {
      try {
        screenshot = await takeScreenshot(tab, extensionSettings, page, warnings);
      } catch (e) {
        warnings.push(`Screenshot failed: ${(e as ErrorWithMessage).message}`);
      }
    }

    const headers = await getHeadersWithMeta(tabId);
    if (!headers)
      warnings.push(
        "No request headers recorded for this tab (page was loaded before the extension started)",
      );
    else if (normalizeUrl(headers.url) !== normalizeUrl(page.url))
      warnings.push(
        "Recorded headers belong to a different URL (page navigated via script/history browser)",
      );

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
    if (screenshot) formData.append("screenshot", screenshot.blob, `screenshot.${screenshot.ext}`);

    const response = await request<{ ok: boolean }>(endpoints.archive, {
      method: "POST",
      body: formData,
      token: extensionSettings.apiToken,
      timeoutMs: (Number(extensionSettings.requestTimeoutSec) || 120) * 1000,
    });

    const status = await checkTab(tabId); // refresh version info/badge
    refreshPending(); // refresh pending list after archive (not awaited)
    return { status, response, warnings };
  } finally {
    busyTabs.delete(tabId);
  }
}

async function archiveWithFeedback(tabId: Int, { toast }: { toast: boolean }): Promise<any> {
  // ): Promise<{ ok: boolean } & ReturnType<typeof archiveTab>> {
  try {
    const result = await archiveTab(tabId);
    if (toast) {
      const n = (result.status as OkStatus)?.count;
      injectBanner(tabId, {
        mode: "toast",
        kind: "ok",
        text: `Archived ✓${n ? ` (${n} version${n === 1 ? "" : "s"})` : ""}`,
      });
    }
    return {
      ok: true,
      status: result.status,
      warnings: result.warnings,
      response: typeof result.response === "object" ? result.response : null,
    };
  } catch (e) {
    const err = e as ErrorWithMessage;
    await session_storage_set("archiveError:" + tabId, {
      message: err.message,
      time: Date.now(),
    });
    updateBadge({
      tabId,
      text: "!",
      color: "#d93025",
      title: `Archive failed: ${err.message}`,
    });

    if (toast)
      injectBanner(tabId, {
        mode: "toast",
        kind: "err",
        text: `Archive failed: ${err.message}`,
      });
    return { ok: false, error: err.message };
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
  if (extentionSettings.autoCheck) checkTab(tabId);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const st = await session_storage_get("status:" + tabId);
  if (st) return;
  const extentionSettings = await getExtentionSettings();
  if (extentionSettings.autoCheck) checkTab(tabId);
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
  if (d.reason === "install" && !extentionSettings.serverUrl && !extentionSettings.archiveUrl)
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
  if (tab) checkTab(tab.id as number);
});

ensureAlarm();

// Message listener: returns a Promise (native promise in Firefox, polyfilled in Chrome)
browser.runtime.onMessage.addListener(
  // async (message: unknown, sender: browser.Runtime.MessageSender): Promise<MessageResponse> => {
  async (message: unknown, sender: browser.Runtime.MessageSender): Promise<any> => {
    // const msg = message as BaseMessage;
    const msg = message as any;
    // console.log("[Background] Received message:", msg?.type, "from:", sender.id);

    try {
      switch (msg.type) {
        case "GET_STATE": {
          const extentionSettings = await getExtentionSettings();
          const endpoints = deriveEndpoints(extentionSettings);
          const { pending } = await browser.storage.local.get({ pending: null });
          return {
            ok: true,
            configured: {
              archive: !!endpoints.archive,
              pending: !!endpoints.pending,
              check: !!endpoints.check,
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
          return { ok: true, status: await checkTab(msg.tabId) };
        case "ARCHIVE_TAB": {
          const payload = msg.payload as ArchiveTabPayload;
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
