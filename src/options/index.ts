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
import type { IdLessTag } from "@common/types";
import { err, ok } from "@common/error";
const log = rootLog.child("options");

function elFromDataKey<T extends HTMLElement>(key: string): T {
  return document.querySelector(`[data-key="${key}"]`) as T;
}

/** Format a tag for the comma-separated input: `name` or `name:color`. */
function formatTag(tag: IdLessTag): string {
  return tag.color ? `${tag.name}:${tag.color}` : tag.name;
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
const saveAssets = elFromDataKey<HTMLInputElement>("save-assets");
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
    toaster.error(`Failed to load settings: ${String(err)}`);
  }
}

/**
 * Read form
 */
function readForm() {
  const sensitiveHeaders = new Set(
    inputSensitiveHeaders.value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  );
  const defaultTags: IdLessTag[] = inputDefaultTags.value
    .split(",")
    .map((value) => {
      const sep = value.indexOf(":");
      const name = (sep === -1 ? value : value.slice(0, sep)).trim();
      if (!name) return null;
      const color = sep === -1 ? null : value.slice(sep + 1).trim() || null;
      return { name, color };
    })
    .filter((tag): tag is IdLessTag => tag !== null);

  const serverUrl = URL.parse(inputServerUrl.value.trim());

  if (!serverUrl) {
    return err({
      reason: "form_invalid_server_url",
      logger: log,
      detail: `Invalid server url: ${inputServerUrl.value.trim()}`,
    });
  }

  return ok<ExtensionSettings>({
    serverUrl,
    token: inputAuthToken.value,
    includeScreenshot: inputIncludeScreenshot.checked,
    screenshotFormat: selectScreenshotFormat.value as ExtensionSettings["screenshotFormat"],
    jpegQuality: Number(inputJpegQuality.value),
    saveAssets: saveAssets.checked,
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
  saveAssets.checked = extensionSettings.saveAssets;
  inputFullPageScreenshot.checked = extensionSettings.fullPageScreenshot;
  inputIncludeRequestHeaders.checked = extensionSettings.includeRequestHeaders;
  inputIncludeResponseHeaders.checked = extensionSettings.includeResponseHeaders;
  inputIncludeSensitiveHeaders.checked = extensionSettings.includeSensitiveHeaders;
  inputSensitiveHeaders.value = [...extensionSettings.sensitiveHeaders].join(", ");
  inputDefaultTags.value = extensionSettings.defaultTags.map(formatTag).join(", ");
  inputRequestTimeoutSec.value = String(extensionSettings.requestTimeoutSec);
  inputAutoCheck.checked = extensionSettings.autoCheck;
  inputPendingRefreshMinutes.value = String(extensionSettings.pendingRefreshMinutes);
  inputPendingLimit.value = String(extensionSettings.pendingLimit);
  selectDirectArchiveMode.value = extensionSettings.directArchiveMode;
  inputDirectArchiveDelaySec.value = String(extensionSettings.directArchiveDelaySec);
  selectTheme.value = extensionSettings.theme;
  inputShowBadge.checked = extensionSettings.showBadge;
  selectLogLevel.value = extensionSettings.logLevel;

  syncSensitiveHeadersInput();
  applyTheme(extensionSettings.theme);
}

function syncSensitiveHeadersInput() {
  inputSensitiveHeaders.disabled = inputIncludeSensitiveHeaders.checked;
}

// Save form submit
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  btnSave.disabled = true;

  try {
    const [updatedSettings, error] = readForm();

    if (error) {
      toaster.error(error.detail);
      return;
    }

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
    toaster.error(`Error saving settings: ${String(err)}`);
  } finally {
    btnSave.disabled = false;
  }
});

/**
 * Test Endpoints
 */
btnTest.addEventListener("click", async () => {
  const [updatedSettings, error] = readForm();

  if (error) {
    toaster.error(error.detail);
    return;
  }

  const out = getElementById("test-result", HTMLDivElement);
  const { serverUrl, token } = updatedSettings;

  out.replaceChildren();
  setElementText(out, "Testing…");
  btnTest.disabled = true;

  try {
    const [res, resError] = await sendToBackground("TEST_ENDPOINTS", {
      serverUrl: serverUrl.toString(),
      token,
    });
    out.replaceChildren();

    if (resError) {
      setElementText(out, resError.detail, "err");
      return;
    }

    res.forEach(({ ok, text }) => {
      const div = document.createElement("div");
      div.classList.add(ok ? "ok" : "err");
      div.textContent = text;
      out.appendChild(div);
    });
  } finally {
    btnTest.disabled = false;
  }
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
    toaster.error(`Error resetting settings: ${String(err)}`);
  } finally {
    btnReset.disabled = false;
  }
});

// Update theme dynamically when theme select changes
selectTheme.addEventListener("change", () => {
  applyTheme(selectTheme.value as "auto" | "light" | "dark");
});

inputIncludeSensitiveHeaders.addEventListener("change", () => {
  syncSensitiveHeadersInput();
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
      void browser.tabs.create({ url: "chrome://extensions/shortcuts" });
    }
  };
});
