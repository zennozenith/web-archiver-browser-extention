import { ExtensionSettings } from "./types.ts";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiToken: "",
  archiveUrl: "", // override; empty => derived from serverUrl
  autoCheck: true,
  checkUrl: "",
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
  pendingUrl: "",
  requestTimeoutSec: 120,
  screenshotFormat: "png", // png | jpeg
  serverUrl: "",
  showBadge: true,
  theme: "auto",
};

export const STORAGE_KEYS = {
  SETTINGS: "extension_settings",
  COUNTER: "extension_counter",
} as const;
