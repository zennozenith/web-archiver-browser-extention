import type { Int, UrlStr, Vec } from "./types";
import type { LevelSetting, Logger } from "./logger";
import { local_storage_get, local_storage_set } from "./storage";
import { log as rootLog } from "./log.ts";
import { IdLessTag } from "@src/background/tags.ts";
import { ok, err } from "./error.ts";

const log = rootLog.child("settings");

export interface ExtensionSettings {
  serverUrl: URL;
  logLevel: LevelSetting;
  token: string;
  autoCheck: boolean;
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
  requestTimeoutSec: Int;
  screenshotFormat: "png" | "jpeg";
  showBadge: boolean;
  theme: "auto" | "light" | "dark";
  sensitiveHeaders: Set<string>;
  defaultTags: Vec<IdLessTag>;
}

export interface StorageExtensionSettings extends Omit<ExtensionSettings, "serverUrl"> {
  serverUrl: UrlStr;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: new URL("https://example.com"),
  logLevel: "info",
  token: "",
  autoCheck: true,
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
  requestTimeoutSec: 120,
  screenshotFormat: "png", // png | jpeg
  showBadge: true,
  theme: "auto",
  sensitiveHeaders: new Set(["cookie", "authorization", "proxy-authorization", "set-cookie"]),
  defaultTags: [{ color: "default", name: "read-later" }],
};

export const EXTENSION_SETTINGS_SESSION_KEY = "extension_settings" as const;

/**
 * Retrieve user settings from browser.storage.sync or in memory map
 */
export async function getExtensionSettings(): Promise<ExtensionSettings> {
  const stored =
    ((await local_storage_get(EXTENSION_SETTINGS_SESSION_KEY)) as Partial<ExtensionSettings>) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function storageSettingsFromSetting(
  extensionSettings: ExtensionSettings,
): StorageExtensionSettings {
  const { serverUrl, ...rest } = extensionSettings;
  return {
    ...rest,
    serverUrl: serverUrl.toString(),
  };
}

export function settingsFromStorageSetting(storageSettings: StorageExtensionSettings) {
  const { serverUrl, ...rest } = storageSettings;
  let url = URL.parse(serverUrl);

  if (!url)
    return err({
      logger: log,
      reason: "server_url_parse",
      detail: `server url cannot be converted to URL: ${serverUrl}`,
    });
  return ok<ExtensionSettings>({
    ...rest,
    serverUrl: url,
  });
}

/**
 * Save user settings to browser.storage.sync
 */
export async function saveSettings(
  settings: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const { serverUrl: currentServerUrl, ...current } = await getExtensionSettings();
  const { serverUrl: newServerUrl, ...newSetting } = settings;
  const updated: StorageExtensionSettings = {
    ...current,
    ...newSetting,
    serverUrl: newServerUrl?.toString() ?? currentServerUrl.toString(),
  };
  // Object.assign(RUNTIME_EXTENTION_SETTING, updated);
  await local_storage_set(EXTENSION_SETTINGS_SESSION_KEY, updated);
  log.info("Settings saved", Object.keys(settings));
  return { ...updated, serverUrl: new URL(updated.serverUrl) };
}

export function isServerConfigured({ serverUrl }: Pick<ExtensionSettings, "serverUrl">): boolean {
  return serverUrl.host !== "example.com";
}

export function errorIfServerUnconfigured(
  { serverUrl }: Pick<ExtensionSettings, "serverUrl">,
  logger?: Logger,
) {
  if (isServerConfigured({ serverUrl })) {
    return ok(null);
  }

  return err({
    reason: "server_unconfigured",
    logger,
    detail: "Server is not configured. Open the extension preferences to set server url.",
  });
}
