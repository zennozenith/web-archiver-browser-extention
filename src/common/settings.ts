import type { IdLessTag, Int, Vec } from "./types";
import type { LevelSetting, Logger } from "./logger";
import { local_storage_get, local_storage_set } from "./storage";
import { log as rootLog } from "./log.ts";
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
  saveAssets: boolean;
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

/**
 * The JSON-safe shape written to `storage.local`.
 *
 * `URL` and `Set` are not reliably serialized by the WebExtensions storage API,
 * so they are stored as a string and an array respectively.
 */
export interface StorageExtensionSettings extends Omit<
  ExtensionSettings,
  "serverUrl" | "sensitiveHeaders"
> {
  serverUrl: string;
  sensitiveHeaders: string[];
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: new URL("https://example.com"),
  logLevel: "info",
  token: "",
  autoCheck: true,
  directArchiveDelaySec: 2,
  directArchiveMode: "prompt", // prompt | auto
  saveAssets: true,
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
 * Retrieve user settings from browser.storage.local, hydrating the non-JSON
 * values (`URL`, `Set`) and filling in anything missing with defaults.
 */
export async function getExtensionSettings(): Promise<ExtensionSettings> {
  const stored =
    ((await local_storage_get(EXTENSION_SETTINGS_SESSION_KEY)) as
      | Partial<StorageExtensionSettings>
      | undefined) ?? {};

  const { serverUrl, sensitiveHeaders, ...rest } = stored;
  const parsedServerUrl =
    typeof serverUrl === "string" ? (URL.parse(serverUrl) ?? DEFAULT_SETTINGS.serverUrl) : null;

  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    serverUrl: parsedServerUrl ?? DEFAULT_SETTINGS.serverUrl,
    // Older builds stored a Set, which serializes to `{}`; fall back to defaults.
    sensitiveHeaders: new Set(
      Array.isArray(sensitiveHeaders) ? sensitiveHeaders : DEFAULT_SETTINGS.sensitiveHeaders,
    ),
    defaultTags: Array.isArray(rest.defaultTags)
      ? rest.defaultTags
      : [...DEFAULT_SETTINGS.defaultTags],
  };
}

export function storageSettingsFromSetting(
  extensionSettings: ExtensionSettings,
): StorageExtensionSettings {
  const { serverUrl, sensitiveHeaders, ...rest } = extensionSettings;
  return {
    ...rest,
    serverUrl: serverUrl.toString(),
    sensitiveHeaders: [...sensitiveHeaders],
  };
}

export function settingsFromStorageSetting(storageSettings: StorageExtensionSettings) {
  const { serverUrl, sensitiveHeaders, ...rest } = storageSettings;
  const url = URL.parse(serverUrl);

  if (!url)
    return err({
      logger: log,
      reason: "server_url_parse",
      detail: `server url cannot be converted to URL: ${serverUrl}`,
    });
  return ok<ExtensionSettings>({
    ...DEFAULT_SETTINGS,
    ...rest,
    serverUrl: url,
    sensitiveHeaders: new Set(
      Array.isArray(sensitiveHeaders) ? sensitiveHeaders : DEFAULT_SETTINGS.sensitiveHeaders,
    ),
  });
}

/**
 * Save user settings to browser.storage.local.
 */
export async function saveSettings(
  settings: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await getExtensionSettings();
  const { serverUrl: newServerUrl, ...newSetting } = settings;
  const updated: ExtensionSettings = {
    ...current,
    ...newSetting,
    serverUrl: newServerUrl ?? current.serverUrl,
  };
  await local_storage_set(EXTENSION_SETTINGS_SESSION_KEY, storageSettingsFromSetting(updated));
  log.info("Settings saved", Object.keys(settings));
  return updated;
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
