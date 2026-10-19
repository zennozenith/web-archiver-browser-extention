import { captureGlobalErrors, createLogger, isDevBuild, receiveForwardedLogs } from "./logger.ts";

/**
 * Root logger, one per extension context. The context tag
 * (background / popup / options / content) is auto-detected.
 *
 * Features wired in here:
 *  - Persisted ring buffer in storage.local (`__logger:logs:<context>`), survives MV3 restarts
 *  - Popup/options logs forwarded to the background console (call `receiveForwardedLogs` there)
 *  - Level config persisted and live-synced across contexts: set the level in one
 *    context and every other context follows.
 *  - Uncaught errors and unhandled promise rejections are captured automatically.
 */
export const log = createLogger({
  namespace: "archiver",
  storeLogs: { maxEntries: 500 },
  forwardToBackground: { minLevel: "info" },
  // DevTools: `logger.setLevel("trace")`, `logger.setNamespaceLevel("archiver:archive*", "trace")`
  ...(isDevBuild() ? { expose: "logger" as const } : {}),
});

/* Uncaught errors & unhandled rejections end up in the log in every context. */
captureGlobalErrors(log);

/**
 * Child logger for the background service worker. Pair it with
 * `receiveForwardedLogs(bgLog)` (background/index.ts) so entries forwarded from
 * the popup and options pages are replayed into background console/storage.
 */
export const bgLog = log.child("bg");

/** Convenience wrapper to start receiving forwarded logs in the background. */
export function receiveForwardedLogsInBackground(): () => void {
  return receiveForwardedLogs(bgLog);
}
