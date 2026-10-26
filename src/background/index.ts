import browser from "webextension-polyfill";

import { createOk, isStandardError, Result } from "@common/error";
import {
  archiveWithFeedback,
  deleteHeaderMemory,
  pageLookup,
  handleOpened,
  patchHeaders,
} from "./archive";
import { refreshPending } from "./pending";
import { bgRootlog as log, receiveForwardedLogsInBackground } from "@common/log";
import { session_storage_delete, session_storage_get } from "@common/storage";
import { canonicalizeUrl, extractTabUrl, isArchivable, sha256 } from "@common/index";
import { Message, MessageData, MessagePayload, MessageType } from "@common/messaging";
import {
  errorIfServerUnconfigured,
  EXTENSION_SETTINGS_SESSION_KEY,
  getExtensionSettings,
  isServerConfigured,
  storageSettingsFromSetting,
} from "@common/settings";
import { applyStatusBadge } from "./badge";

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
    browser.alarms.create(ALARM, { periodInMinutes: mins, delayInMinutes: mins });
}

/* ================= events ================= */
browser.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  const loaded = change.status === "complete" || (change.url && tab.status === "complete");

  if (!loaded || tab.url === undefined || !isArchivable(tab.url)) return;
  logWebReq.debug("Page load complete", { tabId, url: tab.url });
  if (change.status === "complete" && (await session_storage_get(`open:${tabId}`))) {
    handleOpened(tabId);
  }

  const { serverUrl, autoCheck } = await getExtensionSettings();
  const serverUnconfigured = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return serverUnconfigured;

  if (autoCheck) pageLookup(tabId);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const st = await session_storage_get(`status:${tabId}`);
  if (st) return;

  logCheck.debug("Tab activated with no cached status, re-checking", { tabId });

  const { serverUrl, autoCheck } = await getExtensionSettings();
  const serverUnconfigured = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return serverUnconfigured;

  if (autoCheck) {
    pageLookup(tabId);
  }
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  const urlResult = await extractTabUrl(tabId, log);
  let url = urlResult.ok ? canonicalizeUrl(urlResult.data) : "";
  const urlShaHash = await sha256(url);

  logWebReq.debug("Tab removed", { tabId });
  deleteHeaderMemory(tabId);
  session_storage_delete(
    `hdr:${tabId}`,
    `status:${urlShaHash}`,
    `archiveError:${tabId}`,
    `open:${tabId}`,
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
    refreshPending();
  }
});

browser.runtime.onInstalled.addListener(async (d) => {
  log.info("Extension installed/updated", d.reason);
  await ensureAlarm(true);
  refreshPending();
  const extensionSettings = await getExtensionSettings();
  if (d.reason === "install" && isServerConfigured(extensionSettings)) {
    log.info("First install, opening options page to configure the server");
    browser.runtime.openOptionsPage();
  }
});

browser.runtime.onStartup.addListener(() => {
  log.debug("Browser startup");
  ensureAlarm();
  refreshPending();
});

browser.storage.onChanged.addListener(async (changes, namespace) => {
  if (namespace !== "local" || !changes[EXTENSION_SETTINGS_SESSION_KEY]) return;
  log.debug("Settings changed, refreshing pending list and status", Object.keys(changes));
  await ensureAlarm(true);
  await refreshPending();

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (tab.id !== undefined) await pageLookup(tab.id);
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
  ) => Result<MessageData<K>> | Promise<Result<MessageData<K>>>;
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
      } catch (err) {
        logMsg.error(`message:${raw.type} handler failed`, err);
        return {
          ok: false,
          messages: [isStandardError(err) ? err.message : String(err)],
          extra: isStandardError(err) ? [] : [err],
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
  GET_EXTENSION_SETTINGS: async () => {
    return createOk(storageSettingsFromSetting(await getExtensionSettings()));
  },
  // TODO: better tests
  TEST_ENDPOINTS: async ({ serverUrl: _t, token: _a }) => {
    const result = await Promise.all([
      // TODO:
      // testPending(endpoints.pending, token),
      // testPageStatus(endpoints.check, { token, queryUrl: "https://example.com/" }),
    ]);
    return createOk(result);
  },
  PAGE_LOOKUP: async ({ tabId }) => {
    const lookupResult = await pageLookup(tabId);
    applyStatusBadge(tabId, lookupResult);
    return lookupResult;
  },

  // GET_PENDING: async () => {
  //   const { pending } = (await browser.storage.local.get({ pending: null })) as {
  //     pending: PendingInStorage;
  //   };
  //   return createOk<PendingInStorage>(pending);
  // },
  // REFRESH_PENDING: async () => {
  //   const t = await refreshPending();
  //   return createOk({ ok: t === null ? false : t.ok });
  // },
  // // TODO: rename update pending
  // SET_PENDING_TAGS: async ({ id, tags }) => {
  //   return await updatePendingTags(id, { tags });
  // },
  // ARCHIVE_TAB: async ({ tabId, tags }) => {
  //   // `tags` is optional: when given, they are sent along with the archive request
  //   // (the server merges them into the site's existing tags, creating unknown ones).
  //   return await archiveWithFeedback(tabId, { toast: false, tags });
  // },

  // SET_SITE_TAGS: async ({ url, tags }, sender) => {
  //   const result = await setSiteTags(url, tags);
  //   // Tags are site-wide: after changing them, refresh the cached status so the
  //   // next GET_ARCHIVE for this tab returns the new tag list.
  //   if (result.ok === true && sender?.tab?.id !== undefined) {
  //     await session_storage_delete(`status:${sender.tab.id}`);
  //   }
  //   return result;
  // },
  // OPEN_AND_ARCHIVE: async ({ url, tags }) => {
  //   // Optional tags ride along on the opened-tab flag; pending-queue tags merge
  //   // inside archiveTab regardless.
  //   await openAndArchive(url, tags ?? []);
  //   return createOk(undefined);
  // },
  // ARCHIVE_FROM_PAGE: async ({ tags }, sender) => {
  //   if (sender.tab?.id === undefined) {
  //     return createError({
  //       logger: log,
  //       message: "Tab id undefined in ARCHIVE_FROM_PAGE",
  //     });
  //   }

  //   const result = await archiveWithFeedback(sender.tab.id, { toast: false, tags });
  //   if (result.ok === false) {
  //     return result;
  //   }

  //   return await getArchiveStatus(sender.tab.id);
  // },
});
