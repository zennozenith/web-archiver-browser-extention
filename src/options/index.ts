import browser from "webextension-polyfill";

import {
  $,
  DEFAULT_SETTINGS,
  deriveEndpoints,
  ExtensionSettings,
  getExtentionSettings,
  saveSettings,
  setElementText,
} from "@common/index";

// DOM Elements
const form = document.getElementById("options-form") as HTMLFormElement;
const btnTest = document.getElementById("btn-test") as HTMLButtonElement;
const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const btnSave = document.getElementById("btn-save") as HTMLButtonElement;
const toast = document.getElementById("toast") as HTMLDivElement;

const inputServerUrl = document.querySelector("[data-key=server-url") as HTMLInputElement;
const inputApiToken = document.querySelector("[data-key=api-token") as HTMLInputElement;
const inputArchiveUrl = document.querySelector("[data-key=archive-url") as HTMLInputElement;
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
    previewUrls();
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
    archiveUrl: inputArchiveUrl.value,
    pendingUrl: inputPendingUrl.value,
    checkUrl: inputCheckUrl.value,
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
function fillForm(settings: ExtensionSettings): void {
  inputServerUrl.value = settings.serverUrl;
  inputApiToken.value = settings.apiToken;
  inputArchiveUrl.value = settings.archiveUrl;
  inputPendingUrl.value = settings.pendingUrl;
  inputCheckUrl.value = settings.checkUrl;
  inputIncludeScreenshot.checked = settings.includeScreenshot;
  selectScreenshotFormat.value = settings.screenshotFormat;
  inputJpegQuality.value = String(settings.jpegQuality);
  inputFullPageScreenshot.checked = settings.fullPageScreenshot;
  inputIncludeRequestHeaders.checked = settings.includeRequestHeaders;
  inputIncludeResponseHeaders.checked = settings.includeResponseHeaders;
  inputIncludeSensitiveHeaders.checked = settings.includeSensitiveHeaders;
  inputRequestTimeoutSec.value = String(settings.requestTimeoutSec);
  inputAutoCheck.checked = settings.autoCheck;
  inputPendingRefreshMinutes.value = String(settings.pendingRefreshMinutes);
  inputPendingLimit.value = String(settings.pendingLimit);
  selectDirectArchiveMode.value = settings.directArchiveMode;
  inputDirectArchiveDelaySec.value = String(settings.directArchiveDelaySec);
  selectTheme.value = settings.theme;
  inputShowBadge.checked = settings.showBadge;

  applyTheme(settings.theme);
}

/**
 * Preview derived urls
 */
function previewUrls(): void {
  const endpoints = deriveEndpoints(readForm());

  inputArchiveUrl.placeholder = endpoints.derived["archive"] || "(derived from server URL)";
  inputPendingUrl.placeholder = endpoints.derived["pending"] || "(derived from server URL)";
  inputCheckUrl.placeholder = endpoints.derived["check"] || "(derived from server URL)";

  const tbody = $("effective tbody", HTMLTableSectionElement);

  tbody.replaceChildren();
  for (const k of ["archive", "pending", "check"] as const) {
    const tr = document.createElement("tr");
    for (const t of [k, endpoints[k] || "—", endpoints.source[k]]) {
      const td = document.createElement("td");
      td.textContent = t;
      tr.append(td);
    }
    tbody.append(tr);
  }
}

/**
 * Validate Urls
 */
function validateUrls(extensionSettings: ExtensionSettings): string | null {
  for (const urlKey of ["serverUrl", "archiveUrl", "pendingUrl"] as const) {
    if (extensionSettings[urlKey]) {
      try {
        const url = new URL(extensionSettings[urlKey]);
        if (!/^https?:$/.test(url.protocol)) throw 0;
      } catch {
        return `${urlKey} must be a valid http(s) URL`;
      }
    }
  }

  if (extensionSettings.checkUrl) {
    try {
      new URL(extensionSettings.checkUrl.replace("{url}", "x"));
    } catch {
      return "checkUrl must be a valid URL";
    }
  }
  return null;
}

// Save form submit
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  btnSave.disabled = true;

  try {
    const updatedSettings = readForm(),
      err = validateUrls(updatedSettings);

    if (err) {
      setElementText($("save-result", HTMLSpanElement), err, "err");
      throw new Error(err);
    }

    const saved = await saveSettings(updatedSettings);
    fillForm(saved);

    setElementText($("save-result", HTMLSpanElement), "✓ Preferences saved successfully!", "ok");
    setTimeout(() => setElementText($("save-result", HTMLSpanElement), ""), 3000);

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
inputArchiveUrl.addEventListener("input", previewUrls);
inputPendingUrl.addEventListener("input", previewUrls);
inputCheckUrl.addEventListener("input", previewUrls);

// Initialize on page load
document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  try {
    const ok = await browser.permissions.contains({ origins: ["<all_urls>"] });
    $("perm", HTMLDivElement).hidden = ok;
    $("btn-perm", HTMLButtonElement).onclick = async () => {
      const g = await browser.permissions.request({ origins: ["<all_urls>"] });
      $("perm", HTMLDivElement).hidden = g;
    };
  } catch {}
  try {
    const c = (await browser.commands.getAll()).find((c) => c.name === "archive-page");
    $("shortcut", HTMLElement).textContent = c?.shortcut || "not set";
  } catch {
    $("shortcut", HTMLElement).textContent = "unknown";
  }

  $("btn-shortcut", HTMLButtonElement).onclick = async () => {
    if (typeof browser.commands.openShortcutSettings === "function")
      return browser.commands.openShortcutSettings();
    const help = $("shortcut-help", HTMLParagraphElement);
    help.hidden = false;
    if (typeof browser.tabs.captureTab === "function")
      help.textContent = "Open about:addons → gear icon → Manage Extension Shortcuts.";
    else {
      help.textContent = "Opening chrome://extensions/shortcuts …";
      browser.tabs.create({ url: "chrome://extensions/shortcuts" });
    }
  };
});
