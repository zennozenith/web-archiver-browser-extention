import browser from "webextension-polyfill";

import { EventBus } from "@common/event-bus";
import { formatTime, timeAgo } from "@common/time";
import type { Url } from "@common/types";
import { ArchiveOkStatus, ArchiveStatus } from "@src/background/archive";
import { Configured } from "@common/settings";
import { sendToBackground } from "@common/messaging";
import { isArchivable } from "@common/index";
import { log as rootLog } from "@common/log";
const log = rootLog.child("popup");

interface UiEvents {
  "render:anchorServer": void;
  "render:notice": void;
  "render:currentPage": void;
  "render:archive": void;
  "render:archive:ok": { warnings: string[] };
  "render:archive:error": { errorMessage: string };
  "render:archive:checking": void;
  "render:archive:checking:error": { archiveStatus: Exclude<ArchiveStatus, ArchiveOkStatus> };
  "render:archive:checking:ok": { archiveStatus: ArchiveOkStatus };
  "render:tags": { archiveStatus: ArchiveOkStatus | null };
  "tags:set": { url: Url; tags: string[] };
  "tags:set:ok": { tags: { id: string; name: string }[] };
  "tags:set:error": { message: string };
  /* Seed a not-yet-archived site with the user's default tags (once per URL). */
  "tags:seed:defaults": { url: Url; existing: string[] };
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
const btnOpenOptions = document.querySelectorAll<HTMLButtonElement>("[data-key=btn-open-options");
const serverOpen = document.querySelector("[data-key=anchor-open-server") as HTMLAnchorElement;
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

// Tag Section DOM Nodes
const currentTagsBlock = document.getElementById("current-tags-block") as HTMLDivElement;
const currentTagsList = document.getElementById("current-tags") as HTMLDivElement;
const currentTagsError = document.getElementById("current-tags-error") as HTMLDivElement;
const currentTagInput = document.getElementById("current-tag-input") as HTMLInputElement;
const btnAddTag = document.getElementById("current-tag-add") as HTMLButtonElement;
const tagOptions = document.getElementById("tag-options") as HTMLDataListElement;

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

let tab: browser.Tabs.Tab,
  configured: Configured,
  hasPermission = true,
  shortcut = "";

/* Site-wide tags for the current page's URL + global tag names for the (<datalist>) suggestions. */
let siteTags: { id: string; name: string }[] = [];
let tagsUrl: Url | null = null;
let knownTags: string[] = [];
/* URLs whose default tags were already offered this popup session
 * (prevents re-adding them on every status re-check). */
const defaultsSeeded = new Set<string>();

function openTab(url: Url) {
  browser.tabs.create({ url });
  window.close();
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

/* ------------------------------------------------------------------ */
/* Tags (site-wide: shared by every version of this URL)               */
/* ------------------------------------------------------------------ */

function renderTagChips() {
  currentTagsList.innerHTML = "";
  for (const t of siteTags) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";

    const name = document.createElement("span");
    name.textContent = t.name;
    chip.appendChild(name);

    const rm = document.createElement("button");
    rm.className = "sm";
    rm.textContent = "×";
    rm.title = `Remove tag "${t.name}" from this site`;
    rm.disabled = !tagsUrl || !configured.sitesTags;
    rm.addEventListener("click", () => {
      const remaining = siteTags.filter((x) => x.id !== t.id).map((x) => x.name);
      uiBus.emit("tags:set", { url: tagsUrl as Url, tags: remaining });
    });
    chip.appendChild(rm);

    currentTagsList.appendChild(chip);
  }
  if (!siteTags.length) {
    const none = document.createElement("span");
    none.className = "muted small";
    none.textContent = "No tags yet";
    currentTagsList.appendChild(none);
  }
}

function renderTagSuggestions() {
  const current = new Set(siteTags.map((t) => t.name.toLowerCase()));
  tagOptions.innerHTML = "";
  for (const name of knownTags.filter((n) => !current.has(n.toLowerCase()))) {
    const opt = document.createElement("option");
    opt.value = name;
    tagOptions.appendChild(opt);
  }
}

async function addTagFromInput() {
  const value = currentTagInput.value.trim().slice(0, 64);
  if (!value || !tagsUrl) return;
  await uiBus.emitAsync("tags:set", {
    url: tagsUrl,
    tags: [...siteTags.map((t) => t.name), value],
  });
}

/** Default tags from the settings that the site does not have yet (as provisional chips). */
function missingDefaultTags(existing: { name: string }[] = []): { id: string; name: string }[] {
  const have = new Set(existing.map((t) => t.name.toLowerCase()));
  return Array.from(configured.defaultTags)
    .filter((n) => {
      const name = n.trim().slice(0, 64);
      return name && !have.has(name.toLowerCase());
    })
    .map((name) => ({ id: name, name }));
}

/* ------------------------------------------------------------------ */
/* App event handlers                                                 */
/* ------------------------------------------------------------------ */

appBus.on("loading", () => {
  log.debug("appBus:Loading");
  spinnerEl.classList.remove("hidden");
  appEl.classList.add("hidden");
});

appBus.on("loaded", () => {
  spinnerEl.classList.add("hidden");
  appEl.classList.remove("hidden");
  log.debug("appBus:Loaded");
});

appBus.once("configured:get", async () => {
  const stateResult = await sendToBackground("GET_CONFIGURED");
  if (stateResult.ok === true) {
    configured = stateResult.data;
    log.setLevel(configured.logLevel);

    // Known tag names for the <datalist> suggestions (requires the tags endpoint).
    if (configured.tags) {
      const tagsResult = await sendToBackground("GET_TAGS");
      if (tagsResult.ok === true) {
        knownTags = tagsResult.data.map((t: { name: string }) => t.name);
        renderTagSuggestions();
      } else {
        log.debug("Cannot load tag suggestions,", tagsResult.messages.toString());
      }
    }

    uiBus.emit("error:any:clear");
    uiBus.emit("render:anchorServer");
    uiBus.emit("render:notice");
    uiBus.emit("render:currentPage");

    const archivable = tab && tab.url !== undefined && isArchivable(tab.url);

    if (archivable) {
      await appBus.emitAsync("archive:check");
    }
  } else {
    log.error("Cannot get state,", stateResult.messages);
    uiBus.emit("error:any", { message: stateResult.messages.toString() });
  }
});

appBus.on("pending:check", async () => {
  const pendingResult = await sendToBackground("GET_PENDING");
  if (pendingResult.ok === false) {
    log.error("Cannot get pending, ", pendingResult.messages.toString());
    uiBus.emit("error:any", { message: pendingResult.messages.toString() });

    // TODO: move error render in seperate event
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
      // Tags queued for this URL (attached to the site on first archive).
      const tags = (it.tags ?? []) as string[];
      const tagsDiv = document.createElement("div");
      tagsDiv.className = "small muted";
      tagsDiv.textContent = tags.length ? `Tags: ${tags.join(", ")}` : "No tags";
      growDiv.appendChild(tagsDiv);
      li.appendChild(growDiv);

      // Tag editor
      const tagBtn = document.createElement("button");
      tagBtn.className = "sm";
      tagBtn.title = "Edit tags for this queued page";
      tagBtn.textContent = "Tags";
      tagBtn.addEventListener("click", async () => {
        const raw = prompt("Tags for this page (comma separated)", tags.join(", ")) ?? "";
        const next = raw
          .split(",")
          .map((t) => t.trim().slice(0, 64))
          .filter(Boolean);
        const result = await sendToBackground("SET_PENDING_TAGS", { id: it.id, tags: next });
        if (result.ok === false) {
          log.error("Cannot save pending tags,", result.messages.toString());
          uiBus.emit("error:any", { message: result.messages.toString() });
          return;
        }
        await sendToBackground("REFRESH_PENDING");
        appBus.emit("pending:check");
      });
      li.appendChild(tagBtn);

      const actionBtn = document.createElement("button");
      actionBtn.className = "sm";
      actionBtn.title = "Open in a new tab and archive";
      actionBtn.textContent = "Archive";
      actionBtn.addEventListener("click", async () => {
        log.debug("Pending list archive requested", { url: it.url });
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

  log.debug("Refreshing pending list");

  btnRefreshPending.disabled = true;
  refreshIcon.classList.toggle("spin", true);

  await sendToBackground("REFRESH_PENDING");
  appBus.emit("pending:check");

  refreshIcon.classList.toggle("spin", false);
  btnRefreshPending.disabled = false;
});

appBus.on("archive", async () => {
  if (tab.id === undefined) {
    return;
  }

  uiBus.emit("render:archive");

  log.info("Archiving current page", { url: tab.url });
  const archiveResult = await sendToBackground("ARCHIVE_TAB", {
    tabId: tab.id,
    tags: siteTags.map((t) => t.name),
  });

  if (archiveResult.ok === false) {
    log.error("Archive failed, ", archiveResult.messages.toString());
    uiBus.emit("error:any", { message: archiveResult.messages.toString() });
    uiBus.emit("render:archive:error", {
      errorMessage: archiveResult.messages.toLocaleString() || "Unknown error",
    });

    return;
  }

  const archive = archiveResult.data;
  log.info("Archive finished", {
    archive,
    warnings: structuredClone(archive.warnings),
  });

  uiBus.emit("render:archive:ok", { warnings: archive.warnings });
  await appBus.emitAsync("archive:check");
});

appBus.on("archive:check", async () => {
  if (tab.id === undefined) {
    return;
  }

  uiBus.emit("render:archive:checking");

  const archiveStatusResult = await sendToBackground("GET_ARCHIVE", { tabId: tab.id });
  if (archiveStatusResult.ok === false) {
    log.error("Cannot get archive status, ", archiveStatusResult.messages.toString());
    uiBus.emit("error:any", { message: archiveStatusResult.messages.toString() });
    return;
  }

  const archiveStatus = archiveStatusResult.data;

  const okStatus = archiveStatus.state === "ok" ? archiveStatus : null;
  uiBus.emit("render:tags", { archiveStatus: okStatus });

  // Page not archived yet: offer the user's default tags (persisted via
  // SET_SITE_TAGS, which creates unknown tag names server-side).
  if (archiveStatus.state === "ok" && !archiveStatus.archived) {
    uiBus.emit("tags:seed:defaults", {
      url: archiveStatus.url,
      existing: (archiveStatus.tags ?? []).map((t) => t.name),
    });
  }

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

uiBus.on("render:notice", () => {
  noticePermissionEl.classList.toggle("hidden", hasPermission);

  const isNotConfiguredAtAll =
    !configured.server && !configured.archive && !configured.pending && !configured.check;
  noticeNoServerEl.classList.toggle("hidden", !isNotConfiguredAtAll);

  const isMissingServer = !configured.server && !isNotConfiguredAtAll;
  errorEndpointEl.classList.toggle("hidden", !isMissingServer);
});

uiBus.on("render:anchorServer", () => {
  serverOpen.href = configured.endpoint.server;
});

uiBus.on("render:currentPage", () => {
  if (tab.url === undefined) {
    return;
  }

  const archivable = tab && isArchivable(tab.url);
  currentUnarchivable.classList.toggle("hidden", archivable);
  currentMeta.classList.toggle("hidden", !archivable);
  btnArchive.disabled = !archivable || !configured.server || !configured.archive;

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

uiBus.on("render:tags", ({ archiveStatus }) => {
  currentTagsBlock.classList.toggle("hidden", !configured.sitesTags);

  if (archiveStatus) {
    tagsUrl = archiveStatus.url;
    // Not archived yet (and no tags on the server): show the default tags as
    // provisional chips until they have been persisted.
    siteTags = (archiveStatus.tags ?? []).length
      ? (archiveStatus.tags ?? [])
      : missingDefaultTags();
  } else {
    siteTags = [];
    tagsUrl = null;
  }

  currentTagInput.disabled = !configured.sitesTags || tagsUrl === null;
  btnAddTag.disabled = currentTagInput.disabled;
  renderTagChips();
  renderTagSuggestions();
});

/* Persist default tags on a not-yet-archived site (once per URL per popup session). */
uiBus.on("tags:seed:defaults", async ({ url, existing }) => {
  const defaults = missingDefaultTags(existing.map((name) => ({ id: "", name })));
  if (!configured.sitesTags || !defaults.length || defaultsSeeded.has(url)) return;
  defaultsSeeded.add(url);

  await uiBus.emitAsync("tags:set", {
    url,
    tags: [...existing, ...defaults.map((d) => d.name)],
  });
});

uiBus.on("tags:set:error", ({ message }) => {
  currentTagsError.innerHTML = "";
  currentTagsError.appendChild(
    errorBox(`Tags: ${message}`, () => {
      currentTagsError.innerHTML = "";
    }),
  );
});

uiBus.on("tags:set:ok", () => {
  currentTagsError.innerHTML = "";
});

/* Replace the site's tag set on the server, then re-check status (which re-renders tags). */
uiBus.on("tags:set", async ({ url, tags }) => {
  btnAddTag.disabled = true;

  const result = await sendToBackground("SET_SITE_TAGS", { url, tags });
  if (result.ok === false) {
    log.error("Cannot save tags,", result.messages.toString());
    uiBus.emit("tags:set:error", { message: result.messages.toString() });
    // Allow the default-tags seeding to retry on the next status check.
    defaultsSeeded.clear();
    renderTagChips();
    btnAddTag.disabled = !configured.sitesTags || tagsUrl === null;
    return;
  }

  siteTags = result.data;
  currentTagInput.value = "";
  uiBus.emit("tags:set:ok", { tags: siteTags });
  renderTagChips();
  renderTagSuggestions();
  btnAddTag.disabled = !configured.sitesTags || tagsUrl === null;
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
btnRecheck.addEventListener("click", async () => await appBus.emitAsync("archive:check"));
btnRefreshPending.addEventListener("click", async () => await appBus.emitAsync("pending:refresh"));
btnArchive.addEventListener("click", async () => await appBus.emitAsync("archive"));
btnOpenOptions.forEach((v) => {
  v.addEventListener("click", () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
});
btnAddTag.addEventListener("click", addTagFromInput);
currentTagInput.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  await addTagFromInput();
});

document.addEventListener("DOMContentLoaded", async () => {
  await appBus.emitAsync("loading");

  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    log.debug("Popup opened", { tabId: tab.id, url: tab.url, title: tab.title });
  }

  try {
    hasPermission = await browser.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    hasPermission = true; // TODO: false?
  }

  try {
    shortcut =
      (await browser.commands.getAll()).find((c) => c.name === "archive-page")?.shortcut || "";
  } catch {}

  await appBus.emitAsync("configured:get");
  await appBus.emitAsync("pending:check");

  appBus.emit("loaded");
});
