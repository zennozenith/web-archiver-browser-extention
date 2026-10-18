import browser from "webextension-polyfill";

import {
  getElementById,
  DEFAULT_SETTINGS,
  ExtensionSettings,
  getEndpoint,
  getExtentionSettings,
  Result,
  saveSettings,
  setElementText,
} from "@common/index";
import { createError, createOk } from "@common/error";

// DOM Elements
const form = document.getElementById("options-form") as HTMLFormElement;
const btnTest = document.getElementById("btn-test") as HTMLButtonElement;
const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const btnSave = document.getElementById("btn-save") as HTMLButtonElement;
const toast = document.getElementById("toast") as HTMLDivElement;

const inputServerUrl = document.querySelector("[data-key=server-url") as HTMLInputElement;
const inputApiToken = document.querySelector("[data-key=api-token") as HTMLInputElement;
const inputPendingUrl = document.querySelector("[data-key=pending-url") as HTMLInputElement;
const inputCheckUrl = document.querySelector("[data-key=check-url") as HTMLInputElement;
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
const inputShowBadge = document.querySelector("[data-key=show-badge") as HTMLInputElement;

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
    fillForm(settings);
  } catch (err) {
    showToast(`Failed to load settings: ${err}`, "error");
  }
}

/**
 * Read form
 */
function readForm(): ExtensionSettings {
  return {
    serverUrl: inputServerUrl.value,
    apiToken: inputApiToken.value,
    pendingUrl: { override: inputPendingUrl.value !== "", url: inputPendingUrl.value },
    checkUrl: { override: inputCheckUrl.value !== "", url: inputCheckUrl.value },
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
  inputRequestTimeoutSec.value = String(extentionSettings.requestTimeoutSec);
  inputAutoCheck.checked = extentionSettings.autoCheck;
  inputPendingRefreshMinutes.value = String(extentionSettings.pendingRefreshMinutes);
  inputPendingLimit.value = String(extentionSettings.pendingLimit);
  selectDirectArchiveMode.value = extentionSettings.directArchiveMode;
  inputDirectArchiveDelaySec.value = String(extentionSettings.directArchiveDelaySec);
  selectTheme.value = extentionSettings.theme;
  inputShowBadge.checked = extentionSettings.showBadge;

  const endpoint = getEndpoint(extentionSettings);
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

  applyTheme(extentionSettings.theme);
}

/**
 * Preview derived urls
 */
function previewUrls(): void {
  const { checkUrl, serverUrl, pendingUrl } = readForm();
  let endpoint = getEndpoint({ checkUrl, serverUrl, pendingUrl });

  if (serverUrl === "") {
    const placeholderEndpoints = getEndpoint({
      checkUrl,
      pendingUrl,
      serverUrl: inputServerUrl.placeholder,
    });

    endpoint = placeholderEndpoints;
  }

  inputPendingUrl.placeholder = endpoint.pending;
  inputCheckUrl.placeholder = endpoint.check;

  const tr1 = getElementById("effective1", HTMLTableRowElement);
  tr1.children[0].textContent = "pending";
  tr1.children[1].textContent = endpoint.pending;
  tr1.children[2].textContent = pendingUrl.override ? "override" : "derived";

  const tr2 = getElementById("effective2", HTMLTableRowElement);
  tr2.children[0].textContent = "check";
  tr2.children[1].textContent = endpoint.check;
  tr2.children[2].textContent = checkUrl.override ? "override" : "derived";
}

/**
 * Validate Urls
 */
function validateUrls(extensionSettings: ExtensionSettings): Result<null> {
  // "serverUrl",
  const { check, pending } = getEndpoint(extensionSettings);

  if (pending !== "") {
    try {
      const url = new URL(pending);
      if (!/^https?:$/.test(url.protocol))
        return createError({
          message: "Pending url must have protocol http/https",
          extra: { url: pending },
        });
    } catch {
      return createError({
        message: "Pending url must be a valid http(s) URL",
        extra: { url: pending },
      });
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
      setElementText(getElementById("save-result", HTMLSpanElement), err.error.message, "err");
      return;
    }

    const saved = await saveSettings(updatedSettings);
    fillForm(saved);

    setElementText(
      getElementById("save-result", HTMLSpanElement),
      "✓ Preferences saved successfully!",
      "ok",
    );
    setTimeout(() => setElementText(getElementById("save-result", HTMLSpanElement), ""), 3000);

    showToast("✓ Preferences saved successfully!", "success");
  } catch (err) {
    showToast(`Error saving settings: ${err}`, "error");
  } finally {
    btnSave.disabled = false;
  }
});

/**
 * Test Endpoints
 * TODO:
 */
btnTest.addEventListener("click", async () => {
  //  const settings = readForm(),
  //    endpoints = deriveEndpoints(settings),
  //    out = $("test-result", HTMLSpanElement);
  //
  //  const err = validateUrls(settings);
  //
  //  if (err) return msg(out, err, "err");
  //  msg(out, "Testing…");
  //
  //  const lines = [];
  //  let bad = false;
  //  if (endpoints.pending) {
  //    try {
  //      const responseData = await request<Record<string, any[]>>(endpoints.pending, {
  //        token: settings.apiToken,
  //        timeoutMs: 15000,
  //      });
  //      if (typeof responseData === "string") {
  //        throw new Error(`Responded with string instead of json object: ${responseData}`);
  //      }
  //      lines.push(`pending ✓ (${normalizePending(responseData).length} items)`);
  //    } catch (e) {
  //      bad = true;
  //      lines.push("pending ✗ " + (e as { message: string }).message);
  //    }
  //  } else {
  //    lines.push("pending: not configured");
  //  }
  //
  //  if (endpoints.check) {
  //    try {
  //      const responseData = await request(buildCheckUrl(endpoints.check, "https://example.com/"), {
  //        token: settings.apiToken,
  //        timeoutMs: 15000,
  //      });
  //      lines.push(
  //        `check ✓ (${typeof responseData === "object" ? "JSON ok" : "non-JSON response!"})`,
  //      );
  //    } catch (e) {
  //      bad = true;
  //      lines.push("check ✗ " + (e as { message: string }).message);
  //    }
  //  } else {
  //    lines.push("check: not configured");
  //  }
  //
  //  lines.push(
  //    endpoints.archive
  //      ? `archive: ${endpoints.archive} (not tested — POST creates data)`
  //      : "archive: not configured",
  //  );
  //
  //  msg(out, lines.join("\n"), bad ? "err" : "ok");
});

// Reset to default settings
btnReset.addEventListener("click", async () => {
  btnReset.disabled = true;
  try {
    const saved = await saveSettings(DEFAULT_SETTINGS);
    fillForm(saved);
    showToast("Preferences reset to default values", "success");
  } catch (err) {
    showToast(`Error resetting settings: ${err}`, "error");
  } finally {
    btnReset.disabled = false;
  }
});

// Update theme dynamically when theme select changes
selectTheme.addEventListener("change", () => {
  applyTheme(selectTheme.value as "auto" | "light" | "dark");
});

inputServerUrl.addEventListener("input", previewUrls);
inputPendingUrl.addEventListener("input", previewUrls);
inputCheckUrl.addEventListener("input", previewUrls);

// Initialize on page load
document.addEventListener("DOMContentLoaded", async () => {
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
