import browser from "webextension-polyfill";

import { toaster } from "./toaster";
import { log as rootLog } from "@common/log";
import {
  DEFAULT_SETTINGS,
  ExtensionSettings,
  getExtensionSettings,
  saveSettings,
} from "@common/settings";
import { getElementById, setElementText } from "@common/document";
import { sendToBackground } from "@common/messaging";
import { Vec } from "@common/types";
import { createError, createOk, Result } from "@common/error";
const log = rootLog.child("options");

function elFromDataKey<T extends HTMLElement>(key: string): T {
  return document.querySelector(`[data-key=${key}`) as T;
}

// DOM Elements
const form = document.getElementById("options-form") as HTMLFormElement;
const btnTest = document.getElementById("btn-test") as HTMLButtonElement;
const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const btnSave = document.getElementById("btn-save") as HTMLButtonElement;

const inputServerUrl = elFromDataKey<HTMLInputElement>("server-url");
const inputAuthToken = elFromDataKey<HTMLInputElement>("auth-token");
const inputIncludeScreenshot = elFromDataKey<HTMLInputElement>("include-screenshot");
const selectScreenshotFormat = elFromDataKey<HTMLSelectElement>("screenshot-format");
const inputJpegQuality = elFromDataKey<HTMLInputElement>("jpeg-quality");
const inputFullPageScreenshot = elFromDataKey<HTMLInputElement>("full-page-screenshot");
const inputIncludeRequestHeaders = elFromDataKey<HTMLInputElement>("include-request-headers");
const inputIncludeResponseHeaders = elFromDataKey<HTMLInputElement>("include-response-headers");
const inputIncludeSensitiveHeaders = elFromDataKey<HTMLInputElement>("include-sensitive-headers");
const inputSensitiveHeaders = elFromDataKey<HTMLInputElement>("sensitive-headers");
const inputRequestTimeoutSec = elFromDataKey<HTMLInputElement>("request-timeout-sec");
const inputAutoCheck = elFromDataKey<HTMLInputElement>("auto-check");
const inputPendingRefreshMinutes = elFromDataKey<HTMLInputElement>("pending-refresh-minutes");
const inputPendingLimit = elFromDataKey<HTMLInputElement>("pending-limit");
const selectDirectArchiveMode = elFromDataKey<HTMLSelectElement>("direct-archive-mode");
const inputDirectArchiveDelaySec = elFromDataKey<HTMLInputElement>("direct-archive-delay-sec");
const selectTheme = elFromDataKey<HTMLSelectElement>("select-theme");
const inputDefaultTags = elFromDataKey<HTMLInputElement>("default-tags");
const inputShowBadge = elFromDataKey<HTMLInputElement>("show-badge");
const selectLogLevel = elFromDataKey<HTMLSelectElement>("select-log-level");

/**
 * Apply theme to document body
 */
function applyTheme(theme: "auto" | "light" | "dark"): void {
  if (theme === "auto") {
    document.body.removeAttribute("data-theme");
  } else {
    document.body.setAttribute("data-theme", theme);
  }
}

/**
 * Load settings and populate form
 */
async function loadSettings(): Promise<void> {
  try {
    const settings = await getExtensionSettings();
    log.debug("Settings loaded", Object.keys(settings));
    fillForm(settings);
  } catch (err) {
    log.error("Failed to load settings", err);
    toaster.error(`Failed to load settings: ${err}`);
  }
}

/**
 * Read form
 */
function readForm(): Result<ExtensionSettings> {
  const sensitiveHeaders = new Set(
    inputSensitiveHeaders.value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  );
  const defaultTags = inputDefaultTags.value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => {
      let s = v.split(":", 2);
      return {
        name: s[0],
        color: s[1] ? s[1] : null,
      };
    });

  const serverUrl = URL.parse(inputServerUrl.value.trim());

  if (!serverUrl) {
    return createError({
      logger: log,
      message: `Invalid server url: ${inputServerUrl.value.trim()}`,
    });
  }

  return createOk({
    serverUrl,
    token: inputAuthToken.value,
    includeScreenshot: inputIncludeScreenshot.checked,
    screenshotFormat: selectScreenshotFormat.value as ExtensionSettings["screenshotFormat"],
    jpegQuality: Number(inputJpegQuality.value),
    fullPageScreenshot: inputFullPageScreenshot.checked,
    includeRequestHeaders: inputIncludeRequestHeaders.checked,
    includeResponseHeaders: inputIncludeResponseHeaders.checked,
    includeSensitiveHeaders: inputIncludeSensitiveHeaders.checked,
    requestTimeoutSec: Number(inputRequestTimeoutSec.value),
    autoCheck: inputAutoCheck.checked,
    pendingRefreshMinutes: Number(inputPendingRefreshMinutes.value),
    pendingLimit: Number(inputPendingLimit.value),
    directArchiveMode: selectDirectArchiveMode.value as ExtensionSettings["directArchiveMode"],
    directArchiveDelaySec: Number(inputDirectArchiveDelaySec.value),
    theme: selectTheme.value as ExtensionSettings["theme"],
    showBadge: inputShowBadge.checked,
    logLevel: selectLogLevel.value as ExtensionSettings["logLevel"],
    sensitiveHeaders,
    defaultTags,
  });
}

/**
 * Populate form with settings values
 */
function fillForm(extensionSettings: ExtensionSettings): void {
  inputServerUrl.value = extensionSettings.serverUrl.toString();
  inputAuthToken.value = extensionSettings.token;
  inputIncludeScreenshot.checked = extensionSettings.includeScreenshot;
  selectScreenshotFormat.value = extensionSettings.screenshotFormat;
  inputJpegQuality.value = String(extensionSettings.jpegQuality);
  inputFullPageScreenshot.checked = extensionSettings.fullPageScreenshot;
  inputIncludeRequestHeaders.checked = extensionSettings.includeRequestHeaders;
  inputIncludeResponseHeaders.checked = extensionSettings.includeResponseHeaders;
  inputIncludeSensitiveHeaders.checked = extensionSettings.includeSensitiveHeaders;
  inputSensitiveHeaders.value = Vec.from(extensionSettings.sensitiveHeaders).join(", ");
  inputDefaultTags.value = Vec.from(extensionSettings.defaultTags).join(", ");
  inputRequestTimeoutSec.value = String(extensionSettings.requestTimeoutSec);
  inputAutoCheck.checked = extensionSettings.autoCheck;
  inputPendingRefreshMinutes.value = String(extensionSettings.pendingRefreshMinutes);
  inputPendingLimit.value = String(extensionSettings.pendingLimit);
  selectDirectArchiveMode.value = extensionSettings.directArchiveMode;
  inputDirectArchiveDelaySec.value = String(extensionSettings.directArchiveDelaySec);
  selectTheme.value = extensionSettings.theme;
  inputShowBadge.checked = extensionSettings.showBadge;
  selectLogLevel.value = extensionSettings.logLevel;

  applyTheme(extensionSettings.theme);
}

// Save form submit
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  btnSave.disabled = true;

  try {
    const updatedSettingsResult = readForm();

    if (!updatedSettingsResult.ok) {
      toaster.error(updatedSettingsResult.messages.toString());
      return;
    }

    const updatedSettings = updatedSettingsResult.data;
    log.setLevel(updatedSettings.logLevel);
    const saved = await saveSettings(updatedSettings);
    fillForm(saved);

    log.info("Preferences saved", { keys: Object.keys(updatedSettings) });
    setElementText(
      getElementById("save-result", HTMLSpanElement),
      "✓ Preferences saved successfully!",
      "ok",
    );
    setTimeout(() => setElementText(getElementById("save-result", HTMLSpanElement), ""), 3000);
    toaster.success("Preferences saved successfully!");
  } catch (err) {
    log.error("Failed to save settings", err);
    toaster.error(`Error saving settings: ${err}`);
  } finally {
    btnSave.disabled = false;
  }
});

/**
 * Test Endpoints
 */
btnTest.addEventListener("click", async () => {
  const updatedSettingsResult = readForm();

  if (!updatedSettingsResult.ok) {
    toaster.error(updatedSettingsResult.messages.toString());
    return;
  }

  const out = getElementById("test-result", HTMLDivElement);
  const { serverUrl, token } = updatedSettingsResult.data;

  setElementText(out, "Testing…");
  // TODO: reutrn health, stats response
  const result = await sendToBackground("TEST_ENDPOINTS", {
    serverUrl: serverUrl.toString(),
    token,
  });
  setElementText(out, "");

  if (!result.ok) {
    setElementText(out, result.messages.toString(), "err");
    return;
  }

  result.data.forEach(({ ok, text }) => {
    const div = document.createElement("div");
    div.classList.add(ok ? "ok" : "err");
    div.textContent = text;
    out.appendChild(div);
  });
});

// Reset to default settings
btnReset.addEventListener("click", async () => {
  btnReset.disabled = true;
  try {
    const saved = await saveSettings(DEFAULT_SETTINGS);
    fillForm(saved);
    log.info("Preferences reset to defaults");
    toaster.success("Preferences reset to default values");
  } catch (err) {
    log.error("Failed to reset settings", err);
    toaster.error(`Error resetting settings: ${err}`);
  } finally {
    btnReset.disabled = false;
  }
});

// Update theme dynamically when theme select changes
selectTheme.addEventListener("change", () => {
  applyTheme(selectTheme.value as "auto" | "light" | "dark");
});

inputIncludeSensitiveHeaders.addEventListener("change", (e) => {
  const disabled = (e.target as HTMLInputElement).checked === true;
  inputSensitiveHeaders.disabled = disabled;
});

// Initialize on page load
document.addEventListener("DOMContentLoaded", async () => {
  log.debug("Options page opened");
  await loadSettings();

  try {
    const ok = await browser.permissions.contains({ origins: ["<all_urls>"] });
    getElementById("perm", HTMLDivElement).hidden = ok;
    getElementById("btn-perm", HTMLButtonElement).onclick = async () => {
      const g = await browser.permissions.request({ origins: ["<all_urls>"] });
      getElementById("perm", HTMLDivElement).hidden = g;
    };
  } catch {}
  try {
    const c = (await browser.commands.getAll()).find((c) => c.name === "archive-page");
    getElementById("shortcut", HTMLElement).textContent = c?.shortcut || "not set";
  } catch {
    getElementById("shortcut", HTMLElement).textContent = "unknown";
  }

  getElementById("btn-shortcut", HTMLButtonElement).onclick = async () => {
    if (typeof browser.commands.openShortcutSettings === "function")
      return browser.commands.openShortcutSettings();
    const help = getElementById("shortcut-help", HTMLParagraphElement);
    help.hidden = false;
    if (typeof browser.tabs.captureTab === "function")
      help.textContent = "Open about:addons → gear icon → Manage Extension Shortcuts.";
    else {
      help.textContent = "Opening chrome://extensions/shortcuts …";
      browser.tabs.create({ url: "chrome://extensions/shortcuts" });
    }
  };
});
