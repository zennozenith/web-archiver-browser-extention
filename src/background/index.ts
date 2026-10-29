import browser from "webextension-polyfill";

import { ok, Result, err, wrapErr } from "@common/error";
import {
  archiveWithFeedback,
  deleteHeaderMemory,
  handleOpened,
  openAndArchive,
  patchHeaders,
  testPageStatus,
} from "./archive";
import { getPendingFromStorage, refreshPending, testPending, updatePendingTags } from "./pending";
import { bgRootlog as log, receiveForwardedLogsInBackground } from "@common/log";
import { session_storage_delete, session_storage_get } from "@common/storage";
import { canonicalizeUrl, isArchivable } from "@common/index";
import { Message, MessageData, MessagePayload, MessageType } from "@common/messaging";
import {
  errorIfServerUnconfigured,
  EXTENSION_SETTINGS_SESSION_KEY,
  getExtensionSettings,
  isServerConfigured,
  storageSettingsFromSetting,
} from "@common/settings";
import { applyStatusBadge } from "./badge";
import { testHealth, testStats } from "./api";
import { TestEndpointResponse } from "./reqwest";
import { pageLookupFull, statusCacheKey } from "./page";
import { getLocalPageTags, setLocalPageTag, setRemotePageTag, listTags } from "./tags";

/* Popup/options pages forward their log entries here so everything shows up
   in this (service worker) console. */
receiveForwardedLogsInBackground();

const ENGINE = typeof browser.tabs.captureTab === "function" ? "gecko" : "blink";
const EXTENSION_VERSION = browser.runtime.getManifest().version;
const ALARM = "refresh-pending";

/* ── per-subsystem child loggers (context tag "background" is added automatically) ── */
const logWebReq = log.child("webrequest");
const logMsg = log.child("msg");
const logCheck = log.child("check");

log.info("Service worker / background script initialized", {
  version: EXTENSION_VERSION,
  engine: ENGINE,
});

async function ensureAlarm(force: boolean = false) {
  const extensionSettings = await getExtensionSettings();
  const mins = Math.max(1, Number(extensionSettings.pendingRefreshMinutes) || 0);
  if (!Number(extensionSettings.pendingRefreshMinutes)) {
    await browser.alarms.clear(ALARM);
    return;
  }
  const alarm = await browser.alarms.get(ALARM);
  if (force || !alarm || alarm.periodInMinutes !== mins)
    void browser.alarms.create(ALARM, { periodInMinutes: mins, delayInMinutes: mins });
}

/* ================= events ================= */
browser.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  const loaded = change.status === "complete" || (change.url && tab.status === "complete");

  if (!loaded || tab.url === undefined || !isArchivable(tab.url)) return;
  logWebReq.debug("Page load complete", { tabId, url: tab.url });
  if (change.status === "complete" && (await session_storage_get(`open:${tabId}`))) {
    void handleOpened(tabId);
  }

  const { serverUrl, autoCheck } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  if (autoCheck) void pageLookupFull(tabId);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const st = await session_storage_get(`status:${tabId}`);
  if (st) return;

  logCheck.debug("Tab activated with no cached status, re-checking", { tabId });

  const { serverUrl, autoCheck } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  if (autoCheck) {
    void pageLookupFull(tabId);
  }
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  const statusKey = (await session_storage_get(`statusKey:${tabId}`)) as string | undefined;

  logWebReq.debug("Tab removed", { tabId });
  deleteHeaderMemory(tabId);
  const keys = [`hdr:${tabId}`, `statusKey:${tabId}`, `archiveError:${tabId}`, `open:${tabId}`];
  if (statusKey) keys.push(statusKey);
  session_storage_delete(...keys).catch(() => {});
});

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "archive-page") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    log.info("Keyboard shortcut received", { command: cmd, tabId: tab.id });
    void archiveWithFeedback(tab.id as number, { toast: true });
  }
});

browser.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) {
    void refreshPending();
  }
});

browser.runtime.onInstalled.addListener(async (d) => {
  log.info("Extension installed/updated", d.reason);
  await ensureAlarm(true);
  void refreshPending();
  const extensionSettings = await getExtensionSettings();
  if (d.reason === "install" && isServerConfigured(extensionSettings)) {
    log.info("First install, opening options page to configure the server");
    void browser.runtime.openOptionsPage();
  }
});

browser.runtime.onStartup.addListener(() => {
  log.debug("Browser startup");
  void ensureAlarm();
  void refreshPending();
});

browser.storage.onChanged.addListener(async (changes, namespace) => {
  if (namespace !== "local" || !changes[EXTENSION_SETTINGS_SESSION_KEY]) return;
  log.debug("Settings changed, refreshing pending list and status", Object.keys(changes));
  await ensureAlarm(true);
  await refreshPending();

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (tab.id !== undefined) await pageLookupFull(tab.id);
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

void ensureAlarm();

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

    const handler = handlers[raw.type];

    return (async (): Promise<Result<unknown>> => {
      try {
        return await handler(raw.payload as never, sender);
      } catch (e) {
        return err({
          logger: logMsg,
          reason: "register_handler_unhandled_err",
          detail: `message:${raw.type} handler failed`,
          extra: e,
        });
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
  GET_EXTENSION_SETTINGS: async () => {
    return ok(storageSettingsFromSetting(await getExtensionSettings()));
  },
  TEST_ENDPOINTS: async ({ serverUrl, token }) => {
    const baseUrl = URL.parse(serverUrl);
    if (!baseUrl) {
      return ok<TestEndpointResponse[]>([{ ok: false, text: `Invalid server URL: ${serverUrl}` }]);
    }

    const result = await Promise.all([
      testHealth(baseUrl, token),
      testStats(baseUrl, token),
      testPending(baseUrl, token),
      testPageStatus(baseUrl, { token, queryUrl: "https://example.com/" }),
    ]);
    return ok(result);
  },
  PAGE_LOOKUP_FULL: async ({ tabId }) => {
    const lookupFullResult = await pageLookupFull(tabId);
    void applyStatusBadge(tabId, lookupFullResult);
    return lookupFullResult;
  },

  GET_PENDING: async () => {
    return await getPendingFromStorage();
  },

  REFRESH_PENDING: async () => {
    return await refreshPending();
  },
  SET_PAGE_TAGS: async ({ idOrUrl, tags, url }) => {
    if (typeof idOrUrl === "string") {
      return setLocalPageTag(idOrUrl, tags);
    }

    const result = await setRemotePageTag(idOrUrl, tags);
    const [, error] = result;

    // Tags are site-wide: drop the cached status so the next lookup sees the new list.
    if (!error) {
      try {
        await session_storage_delete(await statusCacheKey(canonicalizeUrl(url)));
      } catch (e) {
        log.warn("Cannot invalidate status cache", e);
      }
    }
    return result;
  },

  GET_LOCAL_TAGS: ({ url }) => getLocalPageTags(url),
  LIST_TAGS: () => listTags(),

  ARCHIVE_TAB: async ({ tabId, tags }) => {
    // `tags` is optional: when given, they are sent along with the archive request
    // (the server merges them into the site's existing tags, creating unknown ones).
    return await archiveWithFeedback(tabId, { toast: false, tags });
  },

  SET_PENDING_TAGS: async ({ id, tags }) => {
    return await updatePendingTags(id, tags);
  },

  OPEN_AND_ARCHIVE: async ({ url, tags }) => {
    try {
      await openAndArchive(url, tags ?? []);
      return ok(true);
    } catch (e) {
      return err({
        logger: log,
        reason: "open_and_archive_failed",
        detail: "Cannot open a tab for the pending item",
        extra: e,
      });
    }
  },
  ARCHIVE_FROM_PAGE: async ({ tags }, sender) => {
    if (sender.tab?.id === undefined) {
      return err({
        logger: log,
        reason: "no_tab_id",
        detail: "Tab id undefined in ARCHIVE_FROM_PAGE",
      });
    }

    return await archiveWithFeedback(sender.tab.id, { toast: false, tags });
  },
});
