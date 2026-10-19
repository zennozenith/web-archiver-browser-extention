import { EventBus } from "./event-bus.js";
import { formatTime, timeAgo } from "./time.js";
import { sendToBackground } from "./messaging.js";
import { ArchiveOkStatus, ArchiveStatus, Configured, Url } from "./types.js";

export const isHttp = (url?: Url) => /^https?:\/\//i.test(url || "");
export const isArchivable = isHttp;

function openTab(url: Url) {
  // const yes = window.confirm(`Open url?: ${url}`);
  // if (!yes) {
  //   return;
  // }
  window.open(url, "_blank");
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

interface UiEvents {
  "render:notice": void;
  "render:currentPage": void;
  "render:archive": void;
  "render:archive:ok": { warnings: string[] };
  "render:archive:error": { errorMessage: string };
  "render:archive:checking": void;
  "render:archive:checking:error": { archiveStatus: Exclude<ArchiveStatus, ArchiveOkStatus> };
  "render:archive:checking:ok": { archiveStatus: ArchiveOkStatus };
  "error:any": { message: string };
  "error:any:clear": void;
}

interface AppEvents {
  loading: void;
  loaded: void;
  "configured:get": void;
  archive: void;
  "archive:check": void;
  "pending:check": void;
  "pending:refresh": void;
}

const appBus = new EventBus<AppEvents>();
const uiBus = new EventBus<UiEvents>();

const appEl = document.getElementById("app") as HTMLElement;
const spinnerEl = document.getElementById("spinner") as HTMLDivElement;
const noticePermissionEl = document.getElementById("notice-permission") as HTMLDivElement;
const btnGrantPermission = document.getElementById("btn-grant-permission") as HTMLButtonElement;
const errorEndpointEl = document.getElementById("error-endpoint") as HTMLDivElement;
const errorAnyEl = document.getElementById("error-any") as HTMLDivElement;
const noticeNoServerEl = document.getElementById("notice-no-server") as HTMLDivElement;

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

let tab: { id: number; url: Url; title: string },
  configured: Configured,
  hasPermission = true,
  shortcut = "";

/* ------------------------------------------------------------------ */
/* App event handlers                                                 */
/* ------------------------------------------------------------------ */

appBus.on("loading", () => {
  console.log("Loading...");
  spinnerEl.classList.remove("hidden");
  appEl.classList.add("hidden");
});

appBus.on("loaded", () => {
  spinnerEl.classList.add("hidden");
  appEl.classList.remove("hidden");
  console.log("Loaded");
});

appBus.on("configured:get", async () => {
  const stateResult = await sendToBackground("GET_CONFIGURED");
  if (stateResult.ok === true) {
    configured = stateResult.data;

    uiBus.emit("error:any:clear");
    uiBus.emitAsync("render:notice");
    uiBus.emitAsync("render:currentPage");

    const archivable = tab && isArchivable(tab.url);
    if (archivable) {
      appBus.emit("archive:check");
    }
  } else {
    console.error("Cannot get state,", stateResult.messages.toString());
    uiBus.emit("error:any", { message: stateResult.messages.toString() });
  }

  appBus.emit("loaded");
});

appBus.on("pending:check", async () => {
  const pendingResult = await sendToBackground("GET_PENDING");
  if (pendingResult.ok === false) {
    console.error("Cannot get pending, ", pendingResult.messages.toString());
    uiBus.emit("error:any", { message: pendingResult.messages.toString() });

    currentStatusPill.className = "pill err";
    currentStatusPill.textContent = "Pending check failed";

    pendingFetchedTime.classList.add("hidden");
    return;
  }
  const pending = pendingResult.data;

  pendingHeading.textContent = `Pending(${pending.total})`;

  pendingFetchedTime.textContent = timeAgo(pending.fetchedAt);
  pendingFetchedTime.title = formatTime(pending.fetchedAt);
  pendingFetchedTime.classList.remove("hidden");

  pendingUnconfigured.classList.toggle("hidden", configured.pending);

  if (!configured.pending) {
    pendingErrorContainer.innerHTML = "";
    pendingEmpty.classList.add("hidden");
    pendingList.innerHTML = "";
    pendingOverflow.classList.add("hidden");
    return;
  }

  // Pending Error
  pendingErrorContainer.innerHTML = "";
  if (pending.error) {
    pendingErrorContainer.appendChild(errorBox("Pending list: " + pending.error));
  }

  // Pending Empty Check
  const isEmpty = pending && !pending.items.length && !pending.error;
  pendingEmpty.classList.toggle("hidden", !isEmpty);

  // Pending Items List
  pendingList.innerHTML = "";
  if (pending.items.length) {
    pending.items.forEach((it: any) => {
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
        console.debug("Pending list archive requested", { url: it.url });
        await sendToBackground("OPEN_AND_ARCHIVE", { url: it.url });
        window.close();
      });
      li.appendChild(actionBtn);
      pendingList.appendChild(li);
    });
  }

  // Overflow notice
  const hasOverflow = pending.total > pending.items.length;
  pendingOverflow.classList.toggle("hidden", !hasOverflow);
  if (hasOverflow) {
    pendingOverflow.textContent = `+${pending.total - pending.items.length} more not shown (see list limit in preferences)`;
  }
});

appBus.on("pending:refresh", async () => {
  if (!configured.pending) {
    return;
  }

  console.debug("Refreshing pending list");

  btnRefreshPending.disabled = true;
  refreshIcon.classList.toggle("spin", true);

  await sendToBackground("REFRESH_PENDING");
  appBus.emit("pending:check");

  refreshIcon.classList.toggle("spin", false);
  btnRefreshPending.disabled = false;
});

appBus.on("archive", async () => {
  // archiving = true;

  uiBus.emit("render:archive");

  console.info("Archiving current page", { url: tab.url });
  const archiveResult = await sendToBackground("ARCHIVE_TAB", { tabId: tab.id });

  if (archiveResult.ok === false) {
    console.error("Archive failed, ", archiveResult.messages.toString());
    uiBus.emit("error:any", { message: archiveResult.messages.toString() });
    uiBus.emit("render:archive:error", {
      errorMessage: archiveResult.messages.toLocaleString() || "Unknown error",
    });

    return;
  }

  const archive = archiveResult.data;
  console.info("Archive finished", {
    archive,
    warnings: archive.warnings,
  });

  uiBus.emit("render:archive:ok", { warnings: archive.warnings });
  appBus.emit("archive:check");
});

appBus.on("archive:check", async () => {
  uiBus.emit("render:archive:checking");

  const archiveStatusResult = await sendToBackground("GET_ARCHIVE");
  if (archiveStatusResult.ok === false) {
    console.error("Cannot get archive status, ", archiveStatusResult.messages.toString());
    uiBus.emit("error:any", { message: archiveStatusResult.messages.toString() });
    return;
  }

  const archiveStatus = archiveStatusResult.data;

  // Status Pill & Recheck Button
  if (archiveStatus.state !== "ok") {
    uiBus.emit("render:archive:checking:error", { archiveStatus });
    return;
  }

  uiBus.emit("render:archive:checking:ok", { archiveStatus });
});

/* ------------------------------------------------------------------ */
/* UI event handlers                                                  */
/* ------------------------------------------------------------------ */

uiBus.on("error:any:clear", () => {
  errorAnyEl.textContent = "";
  errorAnyEl.classList.add("hidden");
});

uiBus.on("error:any", ({ message }) => {
  errorAnyEl.textContent = message;
  errorAnyEl.classList.remove("hidden");
});

uiBus.on("render:notice", async () => {
  noticePermissionEl.classList.toggle("hidden", hasPermission);

  const isNotConfiguredAtAll =
    !configured.server && !configured.archive && !configured.pending && !configured.check;
  noticeNoServerEl.classList.toggle("hidden", !isNotConfiguredAtAll);

  const isMissingServer = !configured.server && !isNotConfiguredAtAll;
  errorEndpointEl.classList.toggle("hidden", !isMissingServer);
});

uiBus.on("render:currentPage", async () => {
  const archivable = tab && isArchivable(tab.url);
  currentUnarchivable.classList.toggle("hidden", archivable);
  currentMeta.classList.toggle("hidden", !archivable);
  // btnArchive.disabled = archiving || !configured.server || !configured.archive || !archivable;

  if (shortcut) {
    btnArchiveShortcut.textContent = `  (${shortcut})`;
  } else {
    btnArchiveShortcut.textContent = "";
  }

  currentTitle.textContent = tab.title || tab.url || "No Title";
  currentTitle.title = tab.title || tab.url || "No Title";
  currentUrl.textContent = tab.url || "No Url";
  currentUrl.title = tab.url || "No Url";
});

uiBus.on("render:archive:checking", () => {
  currentStatusPill.className = "pill muted";
  currentStatusPill.textContent = "Checking…";
  btnRecheck.disabled = true;
});

uiBus.on("render:archive:checking:error", ({ archiveStatus }) => {
  btnRecheck.disabled = false;

  switch (archiveStatus.state) {
    case "error":
      currentStatusPill.className = "pill err";
      currentStatusPill.textContent = archiveStatus.error;

      currentErrorContainer.innerHTML = "";
      currentErrorContainer.appendChild(errorBox(archiveStatus.error));
      break;
    case "unsupported":
      currentStatusPill.className = "pill muted";
      currentStatusPill.textContent = configured.check ? "Unknown" : "Status check unsupported";
      break;
    case "unconfigured":
      currentStatusPill.className = "pill muted";
      currentStatusPill.textContent = configured.check
        ? "Unknown"
        : "Archive status check unconfigured";
      break;
  }
});

uiBus.on("render:archive:checking:ok", ({ archiveStatus }) => {
  btnRecheck.disabled = false;

  if (archiveStatus.archived) {
    const count = archiveStatus.count || archiveStatus.versions.length || 1;
    currentStatusPill.className = "pill ok";
    currentStatusPill.textContent = `Archived · ${count} version${count === 1 ? "" : "s"}`;
  } else {
    currentStatusPill.className = "pill warn";
    currentStatusPill.textContent = "Not archived";
  }

  // Versions List
  currentVersionsList.innerHTML = "";

  if (archiveStatus.versions.length === 0 || !archiveStatus.archived) {
    currentVersionsList.classList.add("hidden");
    currentVersionsOverflow.classList.add("hidden");
    currentLastArchived.classList.add("hidden");
    btnArchiveText.textContent = "Archive this page";
    return;
  }

  currentVersionsList.classList.remove("hidden");
  const n = archiveStatus.versions.length;
  const total = archiveStatus.count || n;

  archiveStatus.versions.slice(0, 20).forEach((version, i) => {
    const li = document.createElement("li");

    if (version.url) {
      const a = document.createElement("a");
      a.textContent = `${total - i}`;
      a.addEventListener("click", () => openTab(version.url));
      li.appendChild(a);
    } else {
      const span = document.createElement("span");
      span.textContent = version.id ?? `v${total - i}`;
      li.appendChild(span);
    }

    const timeSpan = document.createElement("span");
    timeSpan.textContent = formatTime(version.archivedAt);
    li.appendChild(timeSpan);

    const agoSpan = document.createElement("span");
    agoSpan.className = "muted";
    agoSpan.textContent = timeAgo(version.archivedAt);
    li.appendChild(agoSpan);

    currentVersionsList.appendChild(li);
  });

  if (total > 20) {
    currentVersionsOverflow.classList.remove("hidden");
    currentVersionsOverflow.textContent = `Showing newest 20 of ${total}`;
  } else {
    currentVersionsOverflow.classList.add("hidden");
  }

  // Last Archived notice
  currentLastArchived.classList.remove("hidden");
  currentLastArchived.textContent = `Last archived ${formatTime(archiveStatus?.lastArchivedAt)} (${timeAgo(archiveStatus?.lastArchivedAt)})`;
  btnArchiveText.textContent = "Archive new version";
});

uiBus.on("render:archive", () => {
  btnArchiveText.textContent = "Archiving…";
  // btnArchive.disabled = archiving || !configured.server || !configured.archive || !archivable;
  btnArchive.disabled = true;
});

uiBus.on("render:archive:error", ({ errorMessage }) => {
  btnArchive.disabled = false;
  currentStatusPill.className = "pill err";
  currentStatusPill.textContent = "Archive Failed";
  btnArchiveText.textContent = "Archive Failed";

  currentErrorContainer.innerHTML = "";
  currentErrorContainer.appendChild(errorBox(`Archive failed: ${errorMessage}`));
  // failedAt: Date.now(),
});

uiBus.on("render:archive:ok", ({ warnings }) => {
  btnArchive.disabled = false;
  btnArchiveText.textContent = "Archive new version";

  const flash =
    "Archived ✓" +
    (warnings.length
      ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""}: ${warnings.join("; ")})`
      : "");

  // Flash Message
  if (flash) {
    currentFlash.classList.remove("hidden");
    currentFlash.textContent = flash;
  } else {
    currentFlash.classList.add("hidden");
  }
});

btnGrantPermission.addEventListener("click", async () => {
  hasPermission = true;
  uiBus.emit("render:notice");
});
btnRecheck.addEventListener("click", () => appBus.emit("archive:check"));
btnRefreshPending.addEventListener("click", () => appBus.emit("pending:refresh"));
btnArchive.addEventListener("click", () => appBus.emit("archive"));

document.addEventListener("DOMContentLoaded", async () => {
  appBus.emit("loading");
  // await sleep(1000);

  tab = { id: 1, url: "https://example.com", title: "Example title" };
  hasPermission = !true; // TODO: false?
  shortcut = "Alt + Shift + A";

  appBus.emitAsync("configured:get");
  appBus.emitAsync("pending:check");
});
