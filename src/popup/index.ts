import {
  formatTime,
  isArchivable,
  log,
  normalizeUrl,
  PendingResponseInStorage,
  sendToBackground,
  timeAgo,
} from "@common/index";
import type { Int, State, Url } from "@common/types";
import browser from "webextension-polyfill";

// DOM References
const noticePermissionEl = document.getElementById("notice-permission") as HTMLDivElement;
const btnGrantPermission = document.getElementById("btn-grant-permission") as HTMLButtonElement;
const noticeNoServerEl = document.getElementById("notice-no-server") as HTMLDivElement;
const btnOpenOptions = document.getElementById("btn-open-options") as HTMLButtonElement;
const errorEndpointEl = document.getElementById("error-endpoint") as HTMLDivElement;

// Current Section DOM Nodes
const currentUnarchivable = document.getElementById("current-unarchivable") as HTMLDivElement;
const currentMeta = document.getElementById("current-meta") as HTMLDivElement;
const currentTitle = document.getElementById("current-title") as HTMLDivElement;
const currentUrl = document.getElementById("current-url") as HTMLDivElement;
const currentStatusPill = document.getElementById("current-status-pill") as HTMLSpanElement;
const btnRecheck = document.getElementById("btn-recheck") as HTMLButtonElement;
const currentErrorContainer = document.getElementById("current-error-container") as HTMLDivElement;
const currentVersionsList = document.getElementById("current-versions-list") as HTMLUListElement;
const currentVersionsOverflow = document.getElementById(
  "current-versions-overflow",
) as HTMLDivElement;
const currentLastArchived = document.getElementById("current-last-archived") as HTMLDivElement;
const currentFlash = document.getElementById("current-flash") as HTMLDivElement;
const btnArchive = document.getElementById("btn-archive") as HTMLButtonElement;
const btnArchiveText = document.getElementById("btn-archive-text") as HTMLSpanElement;
const btnArchiveShortcut = document.getElementById("btn-archive-shortcut") as HTMLSpanElement;

// Pending Section DOM Nodes
const pendingHeading = document.getElementById("pending-heading") as HTMLHeadingElement;
const pendingFetchedTime = document.getElementById("pending-fetched-time") as HTMLSpanElement;
const btnRefreshPending = document.getElementById("btn-refresh-pending") as HTMLButtonElement;
const refreshIcon = document.getElementById("refresh-icon") as HTMLSpanElement;
const pendingUnconfigured = document.getElementById("pending-unconfigured") as HTMLDivElement;
const pendingErrorContainer = document.getElementById("pending-error-container") as HTMLDivElement;
const pendingEmpty = document.getElementById("pending-empty") as HTMLDivElement;
const pendingList = document.getElementById("pending-list") as HTMLUListElement;
const pendingOverflow = document.getElementById("pending-overflow") as HTMLDivElement;

function openTab(url: Url) {
  browser.tabs.create({ url });
  window.close();
}

let tab: browser.Tabs.Tab,
  state: State,
  hasPermission = true,
  shortcut = "",
  checking = false,
  archiving = false,
  refreshing = false,
  flash = "";

async function recheck() {
  checking = true;
  render();
  const messageResponse = await sendToBackground("CHECK_ARCHIVE", { tabId: tab.id as Int });
  checking = false;

  if (messageResponse.success === true && messageResponse.data.ok === true) {
    state.status = messageResponse.data.data;
  }
  render();
}

async function doRefresh() {
  refreshing = true;
  render();
  await sendToBackground("REFRESH_PENDING", undefined);

  state = {
    ...state,
    ...(await sendToBackground("GET_STATE", { tabId: tab.id as Int })),
  };
  refreshing = false;
  render();
}

async function doArchive() {
  archiving = true;
  flash = "";
  render();
  const result = await sendToBackground("ARCHIVE_TAB", { tabId: tab.id as Int });
  log.info(result);
  archiving = false;

  if (result.success === true && result.data.ok === true) {
    state.status = result.data.data.status;
    state.archiveError = null;
    flash =
      "Archived ✓" +
      (result.data.data.warnings.length
        ? ` (${result.data.data.warnings.length} warning${result.data.data.warnings.length > 1 ? "s" : ""}: ${result.data.data.warnings.join("; ")})`
        : "");
  } else if (result.success === false) {
    state.archiveError = { message: result.error || "Unknown error", time: Date.now() };
  }

  state = {
    ...state,
    ...(await sendToBackground("GET_STATE", { tabId: tab.id as Int })),
    status: state.status,
  };
  render();
}

function errorBox(msg: string, onClose: () => void = () => {}) {
  const errDiv = document.createElement("div");
  errDiv.className = "error";

  const span = document.createElement("span");
  span.textContent = msg;
  errDiv.appendChild(span);

  if (onClose) {
    const btn = document.createElement("button");
    btn.textContent = "✕";
    btn.title = "Dismiss";
    btn.addEventListener("click", onClose);
    errDiv.appendChild(btn);
  }
  return errDiv;
}

function renderNotice() {
  noticePermissionEl.classList.toggle("hidden", hasPermission);

  const isNotConfiguredAtAll =
    !state.configured.server && !state.configured.pending && !state.configured.check;
  noticeNoServerEl.classList.toggle("hidden", !isNotConfiguredAtAll);

  const isMissingServer = !state.configured.server && !isNotConfiguredAtAll;
  errorEndpointEl.classList.toggle("hidden", !isMissingServer);
}

function renderCurrentPage() {
  const archivable = tab && isArchivable(tab.url);
  currentUnarchivable.classList.toggle("hidden", archivable);
  currentMeta.classList.toggle("hidden", !archivable);

  if (archivable) {
    currentTitle.textContent = tab.title || tab.url || "No Title";
    currentTitle.title = tab.title || tab.url || "No Title";
    currentUrl.textContent = tab.url || "No Url";
    currentUrl.title = tab.url || "No Url";

    // Status Pill & Recheck Button
    const s = state.status;
    if (checking) {
      currentStatusPill.className = "pill muted";
      currentStatusPill.textContent = "Checking…";
    } else if (s?.state === "ok") {
      if (s.archived) {
        const count = s.count || s.versions?.length || 1;
        currentStatusPill.className = "pill ok";
        currentStatusPill.textContent = `Archived · ${count} version${count === 1 ? "" : "s"}`;
      } else {
        currentStatusPill.className = "pill warn";
        currentStatusPill.textContent = "Not archived";
      }
    } else if (s?.state === "error") {
      currentStatusPill.className = "pill err";
      currentStatusPill.textContent = "Check failed";
    } else {
      currentStatusPill.className = "pill muted";
      currentStatusPill.textContent = state.configured.check
        ? "Unknown"
        : "Status check not configured";
    }

    btnRecheck.classList.toggle("hidden", !state.configured.check);
    btnRecheck.disabled = checking;

    // Current Error Box
    currentErrorContainer.innerHTML = "";
    if (s?.state === "error" && !checking && s.error) {
      currentErrorContainer.appendChild(errorBox(s.error));
    }

    // Versions List
    currentVersionsList.innerHTML = "";
    if (s?.state === "ok" && s.versions?.length) {
      currentVersionsList.classList.remove("hidden");
      const n = s.versions.length;
      const total = s.count || n;

      s.versions.slice(0, 20).forEach((v: any, i: any) => {
        const li = document.createElement("li");

        if (v.url) {
          const a = document.createElement("a");
          a.textContent = `v${total - i}`;
          a.addEventListener("click", () => openTab(v.url));
          li.appendChild(a);
        } else {
          const span = document.createElement("span");
          span.textContent = `v${v.id ?? total - i}`;
          li.appendChild(span);
        }

        const timeSpan = document.createElement("span");
        timeSpan.textContent = formatTime(v.time);
        li.appendChild(timeSpan);

        const agoSpan = document.createElement("span");
        agoSpan.className = "muted";
        agoSpan.textContent = timeAgo(v.time);
        li.appendChild(agoSpan);

        currentVersionsList.appendChild(li);
      });

      if (total > 20) {
        currentVersionsOverflow.classList.remove("hidden");
        currentVersionsOverflow.textContent = `Showing newest 20 of ${total}`;
      } else {
        currentVersionsOverflow.classList.add("hidden");
      }
    } else {
      currentVersionsList.classList.add("hidden");
      currentVersionsOverflow.classList.add("hidden");
    }

    // Last Archived notice
    if (!(s?.state === "ok" && s.versions?.length) && s?.state === "ok" && s.archived && s.last) {
      currentLastArchived.classList.remove("hidden");
      currentLastArchived.textContent = `Last archived ${formatTime(s.last)} (${timeAgo(s.last)})`;
    } else {
      currentLastArchived.classList.add("hidden");
    }
  }

  // Archive Error Handling
  if (state.archiveError) {
    currentErrorContainer.innerHTML = "";
    currentErrorContainer.appendChild(
      errorBox("Archive failed: " + state.archiveError.message, async () => {
        state.archiveError = null;
        render();
      }),
    );
  }

  // Flash Message
  if (flash && !state.archiveError) {
    currentFlash.classList.remove("hidden");
    currentFlash.textContent = flash;
  } else {
    currentFlash.classList.add("hidden");
  }

  // Archive Button states
  btnArchive.disabled = archiving || !state.configured.server;
  if (archiving) {
    btnArchiveText.textContent = "Archiving…";
  } else if (state.status?.state === "ok" && state.status.archived) {
    btnArchiveText.textContent = "Archive new version";
  } else {
    btnArchiveText.textContent = "Archive this page";
  }

  if (shortcut && !archiving) {
    btnArchiveShortcut.textContent = `  (${shortcut})`;
  } else {
    btnArchiveShortcut.textContent = "";
  }
}

function renderPending() {
  const p = state.pending;
  pendingHeading.textContent = `Pending${p?.total ? ` (\${p.total})` : ""}`;

  if (p?.fetchedAt) {
    pendingFetchedTime.textContent = timeAgo(p.fetchedAt);
    pendingFetchedTime.title = formatTime(p.fetchedAt);
    pendingFetchedTime.classList.remove("hidden");
  } else {
    pendingFetchedTime.classList.add("hidden");
  }

  btnRefreshPending.disabled = refreshing || !state.configured.pending;
  refreshIcon.classList.toggle("spin", refreshing);

  const isPendingConfigured = state.configured.pending;
  pendingUnconfigured.classList.toggle("hidden", isPendingConfigured);

  if (!isPendingConfigured) {
    pendingErrorContainer.innerHTML = "";
    pendingEmpty.classList.add("hidden");
    pendingList.innerHTML = "";
    pendingOverflow.classList.add("hidden");
    return;
  }

  // Pending Error
  pendingErrorContainer.innerHTML = "";
  if (p?.error) {
    pendingErrorContainer.appendChild(errorBox("Pending list: " + p.error));
  }

  // Pending Empty Check
  const isEmpty = p && !p.items?.length && !p.error;
  pendingEmpty.classList.toggle("hidden", !isEmpty);

  // Pending Items List
  pendingList.innerHTML = "";
  if (p?.items?.length) {
    p.items.forEach((it: any) => {
      let label = it.title;
      try {
        const u = new URL(it.url);
        label = label || u.hostname + u.pathname;
      } catch {}

      const li = document.createElement("li");

      const growDiv = document.createElement("div");
      growDiv.className = "grow";

      const titleDiv = document.createElement("div");
      titleDiv.className = "title";
      titleDiv.title = it.title || it.url;
      titleDiv.textContent = label;
      growDiv.appendChild(titleDiv);

      const urlDiv = document.createElement("div");
      urlDiv.className = "url";
      urlDiv.title = it.url;
      urlDiv.textContent = it.url + (it.addedAt ? ` · ${timeAgo(it.addedAt)}` : "");
      growDiv.appendChild(urlDiv);

      li.appendChild(growDiv);

      const actionBtn = document.createElement("button");
      actionBtn.className = "sm";
      actionBtn.title = "Open in a new tab and archive";
      actionBtn.textContent = "Archive";
      actionBtn.addEventListener("click", async () => {
        await sendToBackground("OPEN_AND_ARCHIVE", { url: it.url });
        window.close();
      });
      li.appendChild(actionBtn);

      pendingList.appendChild(li);
    });
  }

  // Overflow notice
  const hasOverflow = p?.total > p?.items?.length;
  pendingOverflow.classList.toggle("hidden", !hasOverflow);
  if (hasOverflow) {
    pendingOverflow.textContent = `+${p.total - p.items.length} more not shown (see list limit in preferences)`;
  }
}

function render() {
  renderNotice();
  renderCurrentPage();
  renderPending();
}

// Global Event Listeners Wiring
btnGrantPermission.addEventListener("click", async () => {
  hasPermission = true;
  render();
});

btnOpenOptions.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

btnRecheck.addEventListener("click", recheck);
btnRefreshPending.addEventListener("click", doRefresh);
btnArchive.addEventListener("click", doArchive);

document.addEventListener("DOMContentLoaded", async () => {
  // try {
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  try {
    hasPermission = await browser.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    hasPermission = true;
  }

  try {
    shortcut =
      (await browser.commands.getAll()).find((c) => c.name === "archive-page")?.shortcut || "";
  } catch {}
  const stateResponse = await sendToBackground("GET_STATE", { tabId: tab.id as Int });
  if (stateResponse.success === false) {
    log.error(stateResponse.error);
  } else {
    state = stateResponse.data;
  }

  render();

  const stale =
    !state.status ||
    state.status.url !== normalizeUrl(tab?.url ?? "") ||
    Date.now() - (state.status.checkedAt || 0) > 60000;

  if (tab && isArchivable(tab.url ?? "") && state.configured.check && stale) {
    recheck();
  }

  if (
    state.configured.pending &&
    (!state.pending || Date.now() - (state.pending.fetchedAt || 0) > 60000)
  ) {
    doRefresh();
  }

  browser.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.pending) {
      state.pending = ch.pending.newValue as PendingResponseInStorage;
      render();
    }
  });

  // } catch (e) {
  //   $app.replaceChildren(errorBox("Popup error: " + e.message));
  //   console.error(e);
  // }
});
