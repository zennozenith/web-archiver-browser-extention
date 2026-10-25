import type { Int, OverrideUrl, Url } from "./types";
import type { LevelSetting } from "./logger";
import { local_storage_get, local_storage_set } from "./storage";
import { log as rootLog } from "./log.ts";
import { IdLessTag } from "@src/background/tags.ts";

const log = rootLog.child("settings");

export interface ExtensionSettings {
  logLevel: LevelSetting;
  apiToken: string;
  autoCheck: boolean;
  archiveUrl: OverrideUrl;
  checkUrl: OverrideUrl;
  tagsUrl: OverrideUrl;
  sitesTagsUrl: OverrideUrl;
  directArchiveDelaySec: Int;
  directArchiveMode: "prompt" | "auto";
  fullPageScreenshot: boolean; // Firefox only
  includeRequestHeaders: boolean;
  includeResponseHeaders: boolean;
  includeScreenshot: boolean;
  includeSensitiveHeaders: boolean;
  jpegQuality: Int;
  pendingLimit: Int;
  pendingRefreshMinutes: Int; // 0 = off
  pendingUrl: OverrideUrl;
  requestTimeoutSec: Int;
  screenshotFormat: "png" | "jpeg";
  serverUrl: Url;
  showBadge: boolean;
  theme: "auto" | "light" | "dark";
  sensitiveHeaders: Set<string>;
  defaultTags: Array<IdLessTag>;
}

export interface Endpoint {
  server: Url;
  archive: Url;
  pending: Url;
  check: Url;
  tags: Url;
  sitesTags: Url;
}

export interface Configured {
  endpoint: Endpoint;
  server: boolean;
  archive: boolean;
  pending: boolean;
  check: boolean;
  tags: boolean;
  sitesTags: boolean;
  pendingLimit: number;
  logLevel: LevelSetting;
  sensitiveHeaders: Set<string>;
  defaultTags: Array<IdLessTag>;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  logLevel: "info",
  apiToken: "",
  autoCheck: true,
  archiveUrl: { override: false, url: "" },
  checkUrl: { override: false, url: "" },
  tagsUrl: { override: false, url: "" },
  sitesTagsUrl: { override: false, url: "" },
  directArchiveDelaySec: 2,
  directArchiveMode: "prompt", // prompt | auto
  fullPageScreenshot: false, // Firefox only
  includeRequestHeaders: true,
  includeResponseHeaders: true,
  includeScreenshot: true,
  includeSensitiveHeaders: false,
  jpegQuality: 85,
  pendingLimit: 200,
  pendingRefreshMinutes: 5, // 0 = off
  pendingUrl: { override: false, url: "" },
  requestTimeoutSec: 120,
  screenshotFormat: "png", // png | jpeg
  serverUrl: "",
  showBadge: true,
  theme: "auto",
  sensitiveHeaders: new Set(["cookie", "authorization", "proxy-authorization", "set-cookie"]),
  defaultTags: [{ color: "default", name: "read-later" }],
};

export const EXTENSION_SETTINGS_SESSION_KEY = "extension_settings" as const;

export function getEndpoint({
  checkUrl,
  pendingUrl,
  serverUrl,
  archiveUrl,
  sitesTagsUrl,
  tagsUrl,
}: {
  checkUrl: OverrideUrl;
  archiveUrl: OverrideUrl;
  pendingUrl: OverrideUrl;
  tagsUrl: OverrideUrl;
  sitesTagsUrl: OverrideUrl;
  serverUrl: Url;
}): Endpoint {
  const baseUrl = (serverUrl ?? "").trim().replace(/\/+\$/, "").replace(/\/$/, "");

  const derivedUrls =
    baseUrl !== ""
      ? {
          archive: `${baseUrl}/api/archive`,
          pending: `${baseUrl}/api/pending`,
          check: `${baseUrl}/api/check`,
          tags: `${baseUrl}/api/tags`,
          sitesTags: `${baseUrl}/api/sites/tags`,
        }
      : {
          archive: "",
          pending: "",
          check: "",
          tags: "",
          sitesTags: "",
        };

  return {
    server: baseUrl,
    archive: archiveUrl.override ? archiveUrl.url : derivedUrls.archive,
    pending: pendingUrl.override ? pendingUrl.url : derivedUrls.pending,
    check: checkUrl.override ? checkUrl.url : derivedUrls.check,
    tags: tagsUrl.override ? tagsUrl.url : derivedUrls.tags,
    sitesTags: sitesTagsUrl.override ? sitesTagsUrl.url : derivedUrls.sitesTags,
  };
}

/**
 * Retrieve user settings from browser.storage.sync or in memory map
 */
export async function getExtentionSettings(): Promise<ExtensionSettings> {
  const stored =
    ((await local_storage_get(EXTENSION_SETTINGS_SESSION_KEY)) as Partial<ExtensionSettings>) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

/**
 * Save user settings to browser.storage.sync
 */
export async function saveSettings(
  settings: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await getExtentionSettings();
  const updated: ExtensionSettings = { ...current, ...settings };
  // Object.assign(RUNTIME_EXTENTION_SETTING, updated);
  await local_storage_set(EXTENSION_SETTINGS_SESSION_KEY, updated);
  log.info("Settings saved", Object.keys(settings));
  return updated;
}
