import browser from "webextension-polyfill";

import { createError, createOk, Result } from "@common/error";
import { log as rootLog } from "@common/log";
import {
  DEFAULT_SETTINGS,
  ExtensionSettings,
  getEndpoint,
  getExtentionSettings,
  saveSettings,
} from "@common/settings";
import { getElementById, setElementText } from "@common/document";
import { sendToBackground } from "@common/messaging";
const log = rootLog.child("options");

// DOM Elements
const form = document.getElementById("options-form") as HTMLFormElement;
const btnTest = document.getElementById("btn-test") as HTMLButtonElement;
const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const btnSave = document.getElementById("btn-save") as HTMLButtonElement;
const toast = document.getElementById("toast") as HTMLDivElement;

const inputServerUrl = document.querySelector("[data-key=server-url") as HTMLInputElement;
const inputApiToken = document.querySelector("[data-key=api-token") as HTMLInputElement;
const inputArchiverUrl = document.querySelector("[data-key=archive-url") as HTMLInputElement;
const inputPendingUrl = document.querySelector("[data-key=pending-url") as HTMLInputElement;
const inputCheckUrl = document.querySelector("[data-key=check-url") as HTMLInputElement;
const inputTagsUrl = document.querySelector("[data-key=tags-url") as HTMLInputElement;
const inputSitesTagsUrl = document.querySelector("[data-key=sites-tags-url") as HTMLInputElement;
const inputIncludeScreenshot = document.querySelector(
  "[data-key=include-screenshot",
) as HTMLInputElement;
const selectScreenshotFormat = document.querySelector(
  "[data-key=screenshot-format",
) as HTMLSelectElement;
const inputJpegQuality = document.querySelector("[data-key=jpeg-quality") as HTMLInputElement;
const inputFullPageScreenshot = document.querySelector(
  "[data-key=full-page-screenshot",
) as HTMLInputElement;
const inputIncludeRequestHeaders = document.querySelector(
  "[data-key=include-request-headers",
) as HTMLInputElement;
const inputIncludeResponseHeaders = document.querySelector(
  "[data-key=include-response-headers",
) as HTMLInputElement;
const inputIncludeSensitiveHeaders = document.querySelector(
  "[data-key=include-sensitive-headers",
) as HTMLInputElement;
const inputSensitiveHeaders = document.querySelector(
  "[data-key=sensitive-headers",
) as HTMLInputElement;
const inputRequestTimeoutSec = document.querySelector(
  "[data-key=request-timeout-sec",
) as HTMLInputElement;
const inputAutoCheck = document.querySelector("[data-key=auto-check") as HTMLInputElement;
const inputPendingRefreshMinutes = document.querySelector(
  "[data-key=pending-refresh-minutes",
) as HTMLInputElement;
const inputPendingLimit = document.querySelector("[data-key=pending-limit") as HTMLInputElement;
const selectDirectArchiveMode = document.querySelector(
  "[data-key=direct-archive-mode",
) as HTMLSelectElement;
const inputDirectArchiveDelaySec = document.querySelector(
  "[data-key=direct-archive-delay-sec",
) as HTMLInputElement;
const selectTheme = document.querySelector("[data-key=select-theme") as HTMLSelectElement;
const inputDefaultTags = document.querySelector("[data-key=default-tags") as HTMLInputElement;
const inputShowBadge = document.querySelector("[data-key=show-badge") as HTMLInputElement;
const selectLogLevel = document.querySelector("[data-key=select-log-level") as HTMLSelectElement;

let toastTimeout: ReturnType<typeof setTimeout> | null = null;

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
 * Show temporary toast message
 */
function showToast(message: string, type: "success" | "error" = "success"): void {
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }

  toast.textContent = message;
  toast.className = `toast show ${type === "success" ? "toast-success" : "toast-error"}`;

  toastTimeout = setTimeout(() => {
    toast.className = "toast";
  }, 3000);
}

/**
 * Load settings and populate form
 */
async function loadSettings(): Promise<void> {
  try {
    const settings = await getExtentionSettings();
    log.debug("Settings loaded", Object.keys(settings));
    fillForm(settings);
  } catch (err) {
    log.error("Failed to load settings", err);
    showToast(`Failed to load settings: ${err}`, "error");
  }
}

/**
 * Read form
 */
function readForm(): ExtensionSettings {
  const sensitiveHeaders = new Set(
    inputSensitiveHeaders.value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  );
  const defaultTags = new Set(
    inputDefaultTags.value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  );
  return {
    serverUrl: inputServerUrl.value,
    apiToken: inputApiToken.value,
    archiveUrl: { override: inputArchiverUrl.value !== "", url: inputArchiverUrl.value },
    pendingUrl: { override: inputPendingUrl.value !== "", url: inputPendingUrl.value },
    checkUrl: { override: inputCheckUrl.value !== "", url: inputCheckUrl.value },
    tagsUrl: { override: inputTagsUrl.value !== "", url: inputTagsUrl.value },
    sitesTagsUrl: { override: inputSitesTagsUrl.value !== "", url: inputSitesTagsUrl.value },
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
  };
}

/**
 * Populate form with settings values
 */
function fillForm(extentionSettings: ExtensionSettings): void {
  inputServerUrl.value = extentionSettings.serverUrl;
  inputApiToken.value = extentionSettings.apiToken;
  inputIncludeScreenshot.checked = extentionSettings.includeScreenshot;
  selectScreenshotFormat.value = extentionSettings.screenshotFormat;
  inputJpegQuality.value = String(extentionSettings.jpegQuality);
  inputFullPageScreenshot.checked = extentionSettings.fullPageScreenshot;
  inputIncludeRequestHeaders.checked = extentionSettings.includeRequestHeaders;
  inputIncludeResponseHeaders.checked = extentionSettings.includeResponseHeaders;
  inputIncludeSensitiveHeaders.checked = extentionSettings.includeSensitiveHeaders;
  inputSensitiveHeaders.value = Array.from(extentionSettings.sensitiveHeaders).join(", ");
  inputDefaultTags.value = Array.from(extentionSettings.defaultTags).join(", ");
  inputRequestTimeoutSec.value = String(extentionSettings.requestTimeoutSec);
  inputAutoCheck.checked = extentionSettings.autoCheck;
  inputPendingRefreshMinutes.value = String(extentionSettings.pendingRefreshMinutes);
  inputPendingLimit.value = String(extentionSettings.pendingLimit);
  selectDirectArchiveMode.value = extentionSettings.directArchiveMode;
  inputDirectArchiveDelaySec.value = String(extentionSettings.directArchiveDelaySec);
  selectTheme.value = extentionSettings.theme;
  inputShowBadge.checked = extentionSettings.showBadge;
  selectLogLevel.value = extentionSettings.logLevel;

  const endpoint = getEndpoint(extentionSettings);

  if (extentionSettings.archiveUrl.override) {
    inputArchiverUrl.value = endpoint.archive;
  } else {
    inputArchiverUrl.placeholder = endpoint.archive;
  }

  if (extentionSettings.pendingUrl.override) {
    inputPendingUrl.value = endpoint.pending;
  } else {
    inputPendingUrl.placeholder = endpoint.pending;
  }

  if (extentionSettings.checkUrl.override) {
    inputCheckUrl.value = endpoint.check;
  } else {
    inputCheckUrl.placeholder = endpoint.check;
  }

  if (extentionSettings.tagsUrl.override) {
    inputTagsUrl.value = endpoint.tags;
  } else {
    inputTagsUrl.placeholder = endpoint.tags;
  }

  if (extentionSettings.sitesTagsUrl.override) {
    inputSitesTagsUrl.value = endpoint.sitesTags;
  } else {
    inputSitesTagsUrl.placeholder = endpoint.sitesTags;
  }

  applyTheme(extentionSettings.theme);
}

/**
 * Preview derived urls
 */
function previewUrls(): void {
  const { checkUrl, serverUrl, pendingUrl, archiveUrl, tagsUrl, sitesTagsUrl } = readForm();
  let endpoint = getEndpoint({
    checkUrl,
    serverUrl,
    pendingUrl,
    archiveUrl,
    tagsUrl,
    sitesTagsUrl,
  });

  if (serverUrl === "") {
    const placeholderEndpoints = getEndpoint({
      archiveUrl,
      checkUrl,
      pendingUrl,
      sitesTagsUrl,
      tagsUrl,
      serverUrl: inputServerUrl.placeholder,
    });

    endpoint = placeholderEndpoints;
  }

  inputArchiverUrl.placeholder = endpoint.archive;
  inputPendingUrl.placeholder = endpoint.pending;
  inputCheckUrl.placeholder = endpoint.check;
  inputTagsUrl.placeholder = endpoint.tags;
  inputSitesTagsUrl.placeholder = endpoint.sitesTags;

  const orderedKeys = [
    ["archive", endpoint.archive, archiveUrl.override ? "override" : "derived"],
    ["pending", endpoint.pending, pendingUrl.override ? "override" : "derived"],
    ["check", endpoint.check, checkUrl.override ? "override" : "derived"],
    ["tags", endpoint.tags, tagsUrl.override ? "override" : "derived"],
    ["sites tags", endpoint.sitesTags, sitesTagsUrl.override ? "override" : "derived"],
  ] as const;

  document
    .querySelectorAll<HTMLTableRowElement>("table[id=effective] > tbody > tr")
    .forEach((el, index) => {
      el.children[0].textContent = orderedKeys[index][0];
      el.children[1].textContent = orderedKeys[index][1];
      el.children[2].textContent = orderedKeys[index][2];
    });
}

/**
 * Validate Urls
 */
function validateUrls(extensionSettings: ExtensionSettings): Result<null> {
  // "serverUrl",
  const { check, pending, tags, sitesTags } = getEndpoint(extensionSettings);

  for (const urlValue of [
    [pending, "Pending"],
    [tags, "Tags"],
    [sitesTags, "Sites Tags"],
  ] as const) {
    if (urlValue[0] !== "") {
      try {
        const url = new URL(urlValue[0]);
        if (!/^https?:$/.test(url.protocol))
          return createError({
            message: `${urlValue[1]} url must have protocol http/https`,
            extra: { url: urlValue[0] },
          });
      } catch {
        return createError({
          message: `${urlValue[1]} url must be a valid http(s) URL`,
          extra: { url: [0] },
        });
      }
    }
  }

  if (extensionSettings.checkUrl) {
    try {
      new URL(check.replace("{url}", "x"));
    } catch {
      return createError({
        message: "checkUrl must be a valid URL",
        extra: { url: pending },
      });
    }
  }
  return createOk(null);
}

// Save form submit
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  btnSave.disabled = true;

  try {
    const updatedSettings = readForm(),
      err = validateUrls(updatedSettings);

    if (err.ok === false) {
      setElementText(
        getElementById("save-result", HTMLSpanElement),
        err.messages.toString(),
        "err",
      );
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

    showToast("✓ Preferences saved successfully!", "success");
  } catch (err) {
    log.error("Failed to save settings", err);
    showToast(`Error saving settings: ${err}`, "error");
  } finally {
    btnSave.disabled = false;
  }
});

/**
 * Test Endpoints
 */
btnTest.addEventListener("click", async () => {
  const settings = readForm(),
    endpoints = getEndpoint(settings),
    out = getElementById("test-result", HTMLDivElement);

  const err = validateUrls(settings);

  if (!err.ok) return setElementText(out, err.messages.toString(), "err");

  setElementText(out, "Testing…");
  const result = await sendToBackground("TEST_ENDPOINTS", { endpoints, token: settings.apiToken });
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
    showToast("Preferences reset to default values", "success");
  } catch (err) {
    log.error("Failed to reset settings", err);
    showToast(`Error resetting settings: ${err}`, "error");
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
inputServerUrl.addEventListener("input", previewUrls);
inputArchiverUrl.addEventListener("input", previewUrls);
inputPendingUrl.addEventListener("input", previewUrls);
inputCheckUrl.addEventListener("input", previewUrls);
inputTagsUrl.addEventListener("input", previewUrls);
inputSitesTagsUrl.addEventListener("input", previewUrls);

// Initialize on page load
document.addEventListener("DOMContentLoaded", async () => {
  log.debug("Options page opened");
  await loadSettings();
  previewUrls();

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
