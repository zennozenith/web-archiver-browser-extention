import { log as rootLog } from "@common/log";
import { getElementById } from "@common/document";
import { sendToBackground } from "@common/messaging";
import { settingsFromStorageSetting } from "@common/settings";
import { ApiPageDetail } from "@src/background/archive";
import { Result } from "@common/error";

const log = rootLog.child("popup");

class Loading {
  private static spinnerEl = document.getElementById("spinner") as HTMLDivElement;

  public static show() {
    Loading.spinnerEl.classList.remove("hidden");
  }

  public static hide() {
    Loading.spinnerEl.classList.remove("hidden");
  }
}

class Notice {
  private static noticePermissionEl = document.getElementById(
    "notice-permission",
  ) as HTMLDivElement;
  private static noticeNoServerEl = document.getElementById("notice-no-server") as HTMLDivElement;
  private static noticeNoTabId = document.getElementById("notice-no-tab-id") as HTMLDivElement;

  public static init({
    hasPermission,
    serverUrl,
    hasTabId,
  }: {
    hasPermission: boolean;
    serverUrl?: URL;
    hasTabId: boolean;
  }) {
    Notice.noticePermissionEl.classList.toggle("hidden", hasPermission);
    Notice.noticeNoTabId.classList.toggle("hidden", hasTabId);
    Notice.noticeNoServerEl.classList.toggle("hidden", serverUrl !== undefined);
  }

  // noticePermissionEl.classList.toggle("hidden", hasPermission);
  // noticeNoServerEl.classList.toggle("hidden", !isNotConfiguredAtAll);

  //
  //   // Last Archived notice
  //   currentLastArchived.classList.remove("hidden");
  //   currentLastArchived.textContent = `Last archived ${formatTime(archiveStatus?.lastArchivedAt)} (${timeAgo(archiveStatus?.lastArchivedAt)})`;
  //
  //
  //     // Overflow notice
  //     const hasOverflow = pending.total > pending.items.length;
  //     Pending.pendingOverflow.classList.toggle("hidden", !hasOverflow);
  //     if (hasOverflow) {
  //       Pending.pendingOverflow.textContent = `+${pending.total - pending.items.length} more not shown (see list limit in preferences)`;
  //     }
  //
  // uiBus.on("render:notice", () => {
  //   noticePermissionEl.classList.toggle("hidden", hasPermission);
  //   const isNotConfiguredAtAll =
  //     !extensionSettings.server &&
  //     !extensionSettings.archive &&
  //     !extensionSettings.pending &&
  //     !extensionSettings.check;
  //   noticeNoServerEl.classList.toggle("hidden", !isNotConfiguredAtAll);
  //   const isMissingServer = !extensionSettings.server && !isNotConfiguredAtAll;
  //   errorEndpointEl.classList.toggle("hidden", !isMissingServer);
  // });
  //
}

// class ErrorUi {
//   // TODO
// }

class CurrentPage {
  // private section = getElementById("card-current-section", HTMLDivElement);
  private unarchivable = getElementById("current-unarchivable", HTMLDivElement);

  private meta = getElementById("current-meta", HTMLDivElement);
  private title = getElementById("current-title", HTMLDivElement);
  private url = getElementById("current-url", HTMLDivElement);
  // private statusContainer = getElementById("current-status-pill-container", HTMLDivElement);
  private statusPill = getElementById("current-status-pill", HTMLSpanElement);
  // private recheck = getElementById("current-btn-recheck", HTMLButtonElement);

  private errorContainer = getElementById("current-error-container", HTMLDivElement);
  // private versionList = getElementById("current-versions-list", HTMLUListElement);
  // // <div id="rent-versions-overflow" class="muted small hidden"></div>
  // private lastArchived = getElementById("current-last-archived", HTMLDivElement);
  // private flash = getElementById("current-flash", HTMLDivElement);

  // private archiveBtn = getElementById("btn-archive", HTMLButtonElement);
  // private archiveBtnText = getElementById("btn-archive-text", HTMLSpanElement);
  // private archiveBtnShortcut = getElementById("btn-archive-shortcut", HTMLSpanElement);

  // private tagsContainer = getElementById("current-tags", HTMLDivElement);
  //

  // private isArchivable: boolean = false;

  constructor(tab: chrome.tabs.Tab, pageResult: Result<ApiPageDetail | null>) {
    const isArchivable = pageResult.ok;
    const page = pageResult.ok ? pageResult.data : null;

    this.unarchivable.classList.toggle("hidden", isArchivable);
    this.meta.classList.toggle("hidden", !isArchivable);
    // this.statusContainer.classList.toggle("hidden", !isArchivable);
    // this.statusPill.classList.toggle("hidden", !isArchivable);
    // this.recheck.classList.toggle("hidden", !isArchivable);

    this.title.textContent = page?.title || page?.url || tab.title || tab.url || "No Title";
    this.title.title = page?.title || page?.url || tab.title || tab.url || "No Title";
    this.url.textContent = page?.url || tab.url || "No Url";
    this.url.title = page?.url || tab.url || "No Url";

    if (!pageResult.ok) {
      this.statusPill.className = "pill err";
      this.statusPill.textContent = pageResult.messages.toString();

      this.errorContainer.innerHTML = "";
      // this.errorContainer.appendChild(errorBox(archiveStatus.error));
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  Loading.show();

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  log.debug("Popup opened", { tabId: tab.id, url: tab.url, title: tab.title });

  let hasPermission: boolean;
  try {
    hasPermission = await browser.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    hasPermission = true; // TODO: false?
  }

  // let shortcut: string;
  // try {
  //   shortcut =
  //     (await browser.commands.getAll()).find((c) => c.name === "archive-page")?.shortcut || "";
  // } catch {}
  //
  const storageExtensionSettingsResult = await sendToBackground("GET_EXTENSION_SETTINGS");

  if (!storageExtensionSettingsResult.ok) {
    // TODO:
    return;
  }

  const extensionSettingResult = settingsFromStorageSetting(storageExtensionSettingsResult.data);
  if (!extensionSettingResult.ok) {
    // TODO:
    return;
  }

  const { serverUrl } = extensionSettingResult.data;

  Notice.init({
    hasPermission,
    serverUrl,
    hasTabId: tab.id !== undefined,
  });

  if (tab.id === undefined) {
    return;
  }

  const pageLookupResult = await sendToBackground("PAGE_LOOKUP", { tabId: tab.id });

  if (!pageLookupResult.ok) {
    // TODO: handle error
  }
  new CurrentPage(tab, pageLookupResult);

  Loading.hide();
});

// import browser from "webextension-polyfill";

// import { EventBus } from "@common/event-bus";
// import { formatTime, formatTimeFromSec, timeAgo, timeAgoFromSec } from "@common/time";
// import type { Url, Vec } from "@common/types";
// import { ArchiveOkStatus, ArchiveStatus } from "@src/background/archive";
// import { sendToBackground } from "@common/messaging";
// import { isArchivable } from "@common/index";
// import { log as rootLog } from "@common/log";
// import { ApiTag, IdLessTag } from "@src/background/tags";
// import { createOk, Result } from "@common/error";
// import { ExtensionSettings } from "@common/settings";
// const log = rootLog.child("popup");

// interface UiEvents {
//   "render:anchorServer": void;
//   "render:notice": void;
//   "render:currentPage": void;
//   "render:archive": void;
//   "render:archive:ok": { warnings: string[] };
//   "render:archive:error": { errorMessage: string };
//   "render:archive:checking": void;
//   "render:archive:checking:error": { archiveStatus: Exclude<ArchiveStatus, ArchiveOkStatus> };
//   "render:archive:checking:ok": { archiveStatus: ArchiveOkStatus };
//   "render:tags": { archiveStatus: ArchiveOkStatus | null };
//   "tags:set": { url: Url; tags: Array<IdLessTag> };
//   "tags:set:ok": { tags: Array<IdLessTag> };
//   "tags:set:error": { message: string };
//   /* Seed a not-yet-archived site with the user's default tags (once per URL). */
//   "tags:seed:defaults": { url: Url; existing: Array<IdLessTag> };
//   "error:any": { message: string };
//   "error:any:clear": void;
// }

// interface AppEvents {
//   archive: void;
//   "archive:check": void;
// }

// const appBus = new EventBus<AppEvents>();
// const uiBus = new EventBus<UiEvents>();

// const appEl = document.getElementById("app") as HTMLElement;
// const spinnerEl = document.getElementById("spinner") as HTMLDivElement;
// const noticePermissionEl = document.getElementById("notice-permission") as HTMLDivElement;
// const btnGrantPermission = document.getElementById("btn-grant-permission") as HTMLButtonElement;
// const btnOpenOptions = document.querySelectorAll<HTMLButtonElement>("[data-key=btn-open-options");
// const serverOpen = document.querySelector("[data-key=anchor-open-server") as HTMLAnchorElement;
// const noticeNoServerEl = document.getElementById("notice-no-server") as HTMLDivElement;

// // Current Section DOM Nodes
// const currentUnarchivable = document.getElementById("current-unarchivable") as HTMLDivElement;
// const currentMeta = document.getElementById("current-meta") as HTMLDivElement;
// const currentTitle = document.getElementById("current-title") as HTMLDivElement;
// const currentUrl = document.getElementById("current-url") as HTMLDivElement;
// const currentStatusPill = document.getElementById("current-status-pill") as HTMLSpanElement;
// const btnRecheck = document.getElementById("btn-recheck") as HTMLButtonElement;
// const currentVersionsList = document.getElementById("current-versions-list") as HTMLUListElement;
// const currentVersionsOverflow = document.getElementById(
//   "current-versions-overflow",
// ) as HTMLDivElement;
// const currentFlash = document.getElementById("current-flash") as HTMLDivElement;

// // Tag Section DOM Nodes
// const tagOptions = document.getElementById("tag-options") as HTMLDataListElement;

// let tab: browser.Tabs.Tab,
//   extensionSettings: ExtensionSettings,
//   hasPermission = true,
//   shortcut = "";

// /* Site-wide tags for the current page's URL + global tag names for the (<datalist>) suggestions. */
// let tagsUrl: Url | null = null;
// /* URLs whose default tags were already offered this popup session
//  * (prevents re-adding them on every status re-check). */
// const defaultsSeeded = new Set<string>();

// async function setExtensionSetting(): Promise<boolean> {
//   const extensionSettingsResult = await sendToBackground("GET_EXTENSION_SETTINGS");
//   if (!extensionSettingsResult.ok) {
//     log.error("Cannot get state,", extensionSettingsResult.messages.toString());
//     UiError.any(extensionSettingsResult.messages.toString());
//     return false;
//   }

//   extensionSettings = extensionSettingsResult.data;
//   log.setLevel(extensionSettings.logLevel);

//   return true;
// }

// function isServerConfigured(): boolean {
//   return extensionSettings && extensionSettings.serverUrl !== "";
// }

// class Tag {
//   private static currentTagsBlock = document.getElementById("current-tags-block") as HTMLDivElement;
//   private static currentTagsList = document.getElementById("current-tags") as HTMLDivElement;
//   private static currentTagsError = document.getElementById("current-tags-error") as HTMLDivElement;
//   private static currentTagInput = document.getElementById("current-tag-input") as HTMLInputElement;
//   private static btnAddTag = document.getElementById("current-tag-add") as HTMLButtonElement;

//   private static tags: Array<IdLessTag> = [];
//   private static knownTags: Array<ApiTag> = [];
//   private static archiveOkStatus: ArchiveOkStatus | null = null;

//   private static render() {
//     if (Tag.archiveOkStatus) {
//       // Not archived yet (and no tags on the server): show the default tags as
//       // provisional chips until they have been persisted.
//       Tag.tags = Tag.archiveOkStatus.tags;
//     }

//     Tag.currentTagInput.disabled = !isServerConfigured();
//     Tag.btnAddTag.disabled = Tag.currentTagInput.disabled;
//     Tag.renderTagChips();
//     Tag.renderTagSuggestions();
//   }

//   private static renderTagChips() {
//     Tag.currentTagsList.innerHTML = "";
//     for (const t of Tag.tags) {
//       const chip = document.createElement("span");
//       chip.className = "tag-chip";

//       const name = document.createElement("span");
//       name.textContent = t.name;
//       chip.appendChild(name);

//       const rm = document.createElement("button");
//       rm.className = "sm";
//       rm.textContent = "×";
//       rm.title = `Remove tag "${t.name}" from this site`;
//       rm.disabled = !extensionSettings.defaultTags;
//       rm.addEventListener("click", () => {
//         const remaining = Tag.tags.filter((x) => x.name !== t.name);
//         uiBus.emit("tags:set", { url: tagsUrl as Url, tags: remaining });
//       });
//       chip.appendChild(rm);

//       Tag.currentTagsList.appendChild(chip);
//     }
//     if (!Tag.tags.length) {
//       const none = document.createElement("span");
//       none.className = "muted small";
//       none.textContent = "No tags yet";
//       Tag.currentTagsList.appendChild(none);
//     }
//   }
//   private static renderTagSuggestions() {
//     const current = new Set(Tag.tags.map((t) => t.name.toLowerCase()));
//     tagOptions.innerHTML = "";
//     for (const tag of Tag.knownTags.filter((tag) => !current.has(tag.name.toLowerCase()))) {
//       const opt = document.createElement("option");
//       opt.value = tag.name;
//       tagOptions.appendChild(opt);
//     }
//   }

//   // TODO: wtf is this function in later half
//   // static async setupKnowTags() {
//   //   const tagsResult = await sendToBackground("GET_KNOWN_TAGS");

//   //   if (!tagsResult.ok) {
//   //     log.debug("Cannot load tag suggestions,", tagsResult.messages.toString());
//   //     return;
//   //   }

//   //   Tag.knownTags = tagsResult.data;

//   //   // Known tag names for the <datalist> suggestions (requires the tags endpoint).
//   //   tagsResult.data.map((t: { name: string }) => t.name);
//   //   const current = new Set(tags.map((t) => t.name.toLowerCase()));

//   //   tagOptions.innerHTML = "";
//   //   for (const tag of tags.filter((n) => !current.has(n.name.toLowerCase()))) {
//   //     const opt = document.createElement("option");
//   //     opt.value = tag.name;
//   //     tagOptions.appendChild(opt);
//   //   }

//   //   Tag.currentTagsList.innerHTML = "";

//   //   for (const t of tags) {
//   //     const chip = document.createElement("span");
//   //     chip.className = "tag-chip";

//   //     const name = document.createElement("span");
//   //     name.textContent = t.name;
//   //     chip.appendChild(name);

//   //     const rm = document.createElement("button");
//   //     rm.className = "sm";
//   //     rm.textContent = "×";
//   //     rm.title = `Remove tag "${t.name}" from this site`;
//   //     rm.disabled = !tagsUrl || !extensionSettings.defaultTags;
//   //     rm.addEventListener("click", () => {
//   //       const remaining = tags.filter((x) => x.name !== t.name);
//   //       uiBus.emit("tags:set", { url: tagsUrl as Url, tags: remaining });
//   //     });
//   //     chip.appendChild(rm);

//   //     Tag.currentTagsList.appendChild(chip);
//   //   }
//   //   if (!tags.length) {
//   //     const none = document.createElement("span");
//   //     none.className = "muted small";
//   //     none.textContent = "No tags yet";
//   //     Tag.currentTagsList.appendChild(none);
//   //   }
//   // }

//   // static async set({ url, tags }) {
//   //   currentTagsError.innerHTML = "";

//   //   btnAddTag.disabled = true;

//   //   const result = await sendToBackground("SET_SITE_TAGS", { url, tags });
//   //   if (result.ok === false) {
//   //     log.error("Cannot save tags,", result.messages.toString());
//   //     uiBus.emit("tags:set:error", { message: result.messages.toString() });
//   //     // Allow the default-tags seeding to retry on the next status check.
//   //     defaultsSeeded.clear();
//   //     renderTagChips();
//   //     btnAddTag.disabled = !extensionSettings.sitesTags || tagsUrl === null;
//   //     return;
//   //   }

//   //   siteTags = result.data;
//   //   currentTagInput.value = "";
//   //   uiBus.emit("tags:set:ok", { tags: siteTags });
//   //   renderTagChips();
//   //   renderTagSuggestions();
//   //   btnAddTag.disabled = !extensionSettings.sitesTags || tagsUrl === null;
//   // }
// }

// class UiError {
//   // private static errorEndpointEl = document.getElementById("error-endpoint") as HTMLDivElement;
//   // private static errorAnyEl = document.getElementById("error-any") as HTMLDivElement;
//   // private static currentErrorContainer = document.getElementById(
//   //   "current-error-container",
//   // ) as HTMLDivElement;

//   static errorBox(msg: string, onClose: () => void = () => {}) {
//     const errDiv = document.createElement("div");
//     errDiv.className = "error";

//     const span = document.createElement("span");
//     span.textContent = msg;
//     errDiv.appendChild(span);

//     if (onClose) {
//       const btn = document.createElement("button");
//       btn.textContent = "✕";
//       btn.title = "Dismiss";
//       btn.addEventListener("click", onClose);
//       errDiv.appendChild(btn);
//     }
//     return errDiv;
//   }

//   static any(message: string) {}
// }

// class Pending {
//   // Pending Section DOM Nodes
//   private static pendingErrorContainer = document.getElementById(
//     "pending-error-container",
//   ) as HTMLDivElement;
//   private static pendingHeading = document.getElementById("pending-heading") as HTMLHeadingElement;
//   private static pendingFetchedTime = document.getElementById(
//     "pending-fetched-time",
//   ) as HTMLSpanElement;
//   private static btnRefreshPending = document.getElementById(
//     "btn-refresh-pending",
//   ) as HTMLButtonElement;
//   private static refreshIcon = document.getElementById("refresh-icon") as HTMLSpanElement;
//   private static pendingUnconfigured = document.getElementById(
//     "pending-unconfigured",
//   ) as HTMLDivElement;
//   private static pendingEmpty = document.getElementById("pending-empty") as HTMLDivElement;
//   private static pendingList = document.getElementById("pending-list") as HTMLUListElement;
//   private static pendingOverflow = document.getElementById("pending-overflow") as HTMLDivElement;
//   private static pendingItemTemplate = document.getElementById(
//     "template-pending-list-item",
//   ) as HTMLTemplateElement;

//   static async get() {
//     const pendingResult = await sendToBackground("GET_PENDING");
//     if (pendingResult.ok === false) {
//       log.error("Cannot get pending, ", pendingResult.messages.toString());
//       uiBus.emit("error:any", { message: pendingResult.messages.toString() });

//       // TODO: move error render in seperate event
//       currentStatusPill.className = "pill err";
//       currentStatusPill.textContent = "Pending check failed";

//       Pending.pendingFetchedTime.classList.add("hidden");
//       return;
//     }
//     const pending = pendingResult.data;

//     Pending.pendingHeading.textContent = `Pending(${pending.total})`;

//     Pending.pendingFetchedTime.textContent = timeAgoFromSec(pending.fetched_at);
//     Pending.pendingFetchedTime.title = formatTimeFromSec(pending.fetched_at);
//     Pending.pendingFetchedTime.classList.remove("hidden");

//     Pending.pendingUnconfigured.classList.toggle("hidden", extensionSettings.pending);

//     if (!extensionSettings.pending) {
//       Pending.pendingErrorContainer.innerHTML = "";
//       Pending.pendingEmpty.classList.add("hidden");
//       Pending.pendingList.innerHTML = "";
//       Pending.pendingOverflow.classList.add("hidden");
//       return;
//     }

//     // Pending Error
//     Pending.pendingErrorContainer.innerHTML = "";
//     if (pending.error) {
//       Pending.pendingErrorContainer.appendChild(errorBox("Pending list: " + pending.error));
//     }

//     // Pending Empty Check
//     const isEmpty = pending && !pending.items.length && !pending.error;
//     Pending.pendingEmpty.classList.toggle("hidden", !isEmpty);

//     // Pending Items List
//     Pending.pendingList.innerHTML = "";
//     Pending.pendingList.innerHTML = "";
//     if (pending.items.length) {
//       pending.items.forEach((it) => {
//         // --- Compute label (same logic as before) ---
//         let label = it.title;
//         try {
//           const u = new URL(it.url);
//           label = label || u.hostname + u.pathname;
//         } catch {}

//         // --- Clone template ---
//         const clone = Pending.pendingItemTemplate.content.cloneNode(true) as DocumentFragment;

//         const titleDiv = clone.querySelector(".title") as HTMLDivElement;
//         const urlDiv = clone.querySelector(".url") as HTMLDivElement;
//         const tagsDiv = clone.querySelector(".small.muted") as HTMLDivElement;
//         const tagBtn = clone.querySelector(".tags-btn") as HTMLButtonElement;
//         const actionBtn = clone.querySelector(".archive-btn") as HTMLButtonElement;

//         // --- Fill text content ---
//         titleDiv.title = it.title || it.url;
//         titleDiv.textContent = label;

//         urlDiv.title = it.url;
//         urlDiv.textContent = it.url + (it.created_at ? ` · ${timeAgoFromSec(it.created_at)}` : "");

//         const tags = it.tags.map((v) => v.name) ?? [];
//         tagsDiv.textContent = tags.length ? `Tags: ${tags.join(", ")}` : "No tags";

//         // --- Attach listeners ---
//         tagBtn.addEventListener("click", async () => {
//           const raw = prompt("Tags for this page (comma separated)", tags.join(", ")) ?? "";
//           const next = raw
//             .split(",")
//             .map((t) => t.trim().slice(0, 64))
//             .filter(Boolean);
//           const result = await sendToBackground("SET_PENDING_TAGS", { id: it.id, tags: next });
//           if (result.ok === false) {
//             log.error("Cannot save pending tags,", result.messages.toString());
//             uiBus.emit("error:any", { message: result.messages.toString() });
//             return;
//           }
//           await sendToBackground("REFRESH_PENDING");
//           appBus.emit("pending:check");
//         });

//         actionBtn.addEventListener("click", async () => {
//           log.debug("Pending list archive requested", { url: it.url });
//           await sendToBackground("OPEN_AND_ARCHIVE", { url: it.url });
//           window.close();
//         });

//         // --- Insert ---
//         Pending.pendingList.appendChild(clone);
//       });
//     }

//     // Overflow notice
//     const hasOverflow = pending.total > pending.items.length;
//     Pending.pendingOverflow.classList.toggle("hidden", !hasOverflow);
//     if (hasOverflow) {
//       Pending.pendingOverflow.textContent = `+${pending.total - pending.items.length} more not shown (see list limit in preferences)`;
//     }
//   }

//   static async refresh() {
//     if (!isServerConfigured()) {
//       return;
//     }

//     log.debug("Refreshing pending list");

//     Pending.btnRefreshPending.disabled = true;
//     Pending.refreshIcon.classList.toggle("spin", true);

//     await sendToBackground("REFRESH_PENDING");
//     appBus.emit("pending:check");

//     Pending.refreshIcon.classList.toggle("spin", false);
//     Pending.btnRefreshPending.disabled = false;
//   }
// }

// function openTab(url: Url) {
//   browser.tabs.create({ url });
//   window.close();
// }

// async function addTagFromInput() {
//   const value = currentTagInput.value.trim().slice(0, 64);
//   if (!value || !tagsUrl) return;
//   await uiBus.emitAsync("tags:set", {
//     url: tagsUrl,
//     tags: [...siteTags, { color: null, name: value }],
//   });
// }

// /** Default tags from the settings that the site does not have yet (as provisional chips). */
// // function missingDefaultTags(existing: { name: string }[] = []): Vec<TagRef> {
// //   const have = new Set(existing.map((t) => t.name.toLowerCase()));
// //   return Vec.from(configured.defaultTags)
// //     .filter((n) => {
// //       const name = n.trim().slice(0, 64);
// //       return name && !have.has(name.toLowerCase());
// //     })
// //     .map((name) => ({ name, color: null }));
// // }

// /* ------------------------------------------------------------------ */
// /* App event handlers                                                 */
// /* ------------------------------------------------------------------ */

// class Archive {
//   private static btnArchive = document.getElementById("btn-archive") as HTMLButtonElement;
//   private static btnArchiveText = document.getElementById("btn-archive-text") as HTMLSpanElement;
//   private static btnArchiveShortcut = document.getElementById(
//     "btn-archive-shortcut",
//   ) as HTMLSpanElement;
//   private static currentLastArchived = document.getElementById(
//     "current-last-archived",
//   ) as HTMLDivElement;

//   static async archive() {
//     if (tab.id === undefined) {
//       return;
//     }

//     Archive.btnArchiveText.textContent = "Archiving…";
//     // btnArchive.disabled = archiving || !configured.server || !configured.archive || !archivable;
//     Archive.btnArchive.disabled = true;

//     log.info("Archiving current page", { url: tab.url });
//     const archiveResult = await sendToBackground("ARCHIVE_TAB", {
//       tabId: tab.id,
//       tags: siteTags,
//     });

//     if (archiveResult.ok === false) {
//       log.error("Archive failed, ", archiveResult.messages.toString());
//       uiBus.emit("error:any", { message: archiveResult.messages.toString() });
//       uiBus.emit("render:archive:error", {
//         errorMessage: archiveResult.messages.toLocaleString() || "Unknown error",
//       });

//       return;
//     }

//     const archive = archiveResult.data;
//     log.info("Archive finished", {
//       archive,
//       warnings: structuredClone(archive.warnings),
//     });

//     uiBus.emit("render:archive:ok", { warnings: archive.warnings });
//     await appBus.emitAsync("archive:check");
//   }
// }

// appBus.on("archive:check", async () => {
//   if (tab.id === undefined) {
//     return;
//   }

//   uiBus.emit("render:archive:checking");

//   const archiveStatusResult = await sendToBackground("GET_ARCHIVE", { tabId: tab.id });
//   if (archiveStatusResult.ok === false) {
//     log.error("Cannot get archive status, ", archiveStatusResult.messages.toString());
//     uiBus.emit("error:any", { message: archiveStatusResult.messages.toString() });
//     return;
//   }

//   const archiveStatus = archiveStatusResult.data;

//   const okStatus = archiveStatus.state === "ok" ? archiveStatus : null;
//   uiBus.emit("render:tags", { archiveStatus: okStatus });

//   // Page not archived yet: offer the user's default tags (persisted via
//   // SET_SITE_TAGS, which creates unknown tag names server-side).
//   if (archiveStatus.state === "ok") {
//     uiBus.emit("tags:seed:defaults", {
//       url: archiveStatus.url,
//       existing: archiveStatus.page_detail.tags ?? [],
//     });
//   }

//   // Status Pill & Recheck Button
//   if (archiveStatus.state !== "ok") {
//     uiBus.emit("render:archive:checking:error", { archiveStatus });
//     return;
//   }

//   uiBus.emit("render:archive:checking:ok", { archiveStatus });
// });

// /* ------------------------------------------------------------------ */
// /* UI event handlers                                                  */
// /* ------------------------------------------------------------------ */

// uiBus.on("error:any:clear", () => {
//   errorAnyEl.textContent = "";
//   errorAnyEl.classList.add("hidden");
// });

// uiBus.on("error:any", ({ message }) => {
//   errorAnyEl.textContent = message;
//   errorAnyEl.classList.remove("hidden");
// });

// uiBus.on("render:notice", () => {
//   noticePermissionEl.classList.toggle("hidden", hasPermission);

//   const isNotConfiguredAtAll =
//     !extensionSettings.server &&
//     !extensionSettings.archive &&
//     !extensionSettings.pending &&
//     !extensionSettings.check;
//   noticeNoServerEl.classList.toggle("hidden", !isNotConfiguredAtAll);

//   const isMissingServer = !extensionSettings.server && !isNotConfiguredAtAll;
//   errorEndpointEl.classList.toggle("hidden", !isMissingServer);
// });

// uiBus.on("render:anchorServer", () => {
//   serverOpen.href = extensionSettings.endpoint.server;
// });

// uiBus.on("render:currentPage", () => {
//   if (tab.url === undefined) {
//     return;
//   }

//   const archivable = tab && isArchivable(tab.url);
//   currentUnarchivable.classList.toggle("hidden", archivable);
//   currentMeta.classList.toggle("hidden", !archivable);
//   btnArchive.disabled = !archivable || !extensionSettings.server || !extensionSettings.archive;

//   if (shortcut) {
//     btnArchiveShortcut.textContent = `  (${shortcut})`;
//   } else {
//     btnArchiveShortcut.textContent = "";
//   }

//   currentTitle.textContent = tab.title || tab.url || "No Title";
//   currentTitle.title = tab.title || tab.url || "No Title";
//   currentUrl.textContent = tab.url || "No Url";
//   currentUrl.title = tab.url || "No Url";
// });

// uiBus.on("render:archive:checking", () => {
//   currentStatusPill.className = "pill muted";
//   currentStatusPill.textContent = "Checking…";
//   btnRecheck.disabled = true;
// });

// uiBus.on("render:archive:checking:error", ({ archiveStatus }) => {
//   btnRecheck.disabled = false;

//   switch (archiveStatus.state) {
//     case "error":
//       currentStatusPill.className = "pill err";
//       currentStatusPill.textContent = archiveStatus.error;

//       currentErrorContainer.innerHTML = "";
//       currentErrorContainer.appendChild(errorBox(archiveStatus.error));
//       break;
//     case "unsupported":
//       currentStatusPill.className = "pill muted";
//       currentStatusPill.textContent = extensionSettings.check
//         ? "Unknown"
//         : "Status check unsupported";
//       break;
//     case "unconfigured":
//       currentStatusPill.className = "pill muted";
//       currentStatusPill.textContent = extensionSettings.check
//         ? "Unknown"
//         : "Archive status check unconfigured";
//       break;
//   }
// });

// uiBus.on("render:archive:checking:ok", ({ archiveStatus }) => {
//   btnRecheck.disabled = false;

//   const count = archiveStatus.capture_count;
//   currentStatusPill.className = "pill ok";
//   currentStatusPill.textContent = `Archived · ${count} version${count === 1 ? "" : "s"}`;

//   // Versions List
//   currentVersionsList.innerHTML = "";

//   if (archiveStatus.versions.length === 0 || !archiveStatus.archived) {
//     currentVersionsList.classList.add("hidden");
//     currentVersionsOverflow.classList.add("hidden");
//     currentLastArchived.classList.add("hidden");
//     btnArchiveText.textContent = "Archive this page";
//     return;
//   }

//   currentVersionsList.classList.remove("hidden");
//   const total = archiveStatus.capture_count;

//   archiveStatus.versions.slice(0, 20).forEach((version, i) => {
//     const li = document.createElement("li");

//     if (version.url) {
//       const a = document.createElement("a");
//       a.textContent = `${total - i}`;
//       a.addEventListener("click", () => openTab(version.url));
//       li.appendChild(a);
//     } else {
//       const span = document.createElement("span");
//       span.textContent = version.id ?? `v${total - i}`;
//       li.appendChild(span);
//     }

//     const timeSpan = document.createElement("span");
//     timeSpan.textContent = formatTime(version.archivedAt);
//     li.appendChild(timeSpan);

//     const agoSpan = document.createElement("span");
//     agoSpan.className = "muted";
//     agoSpan.textContent = timeAgo(version.archivedAt);
//     li.appendChild(agoSpan);

//     currentVersionsList.appendChild(li);
//   });

//   if (total > 20) {
//     currentVersionsOverflow.classList.remove("hidden");
//     currentVersionsOverflow.textContent = `Showing newest 20 of ${total}`;
//   } else {
//     currentVersionsOverflow.classList.add("hidden");
//   }

//   // Last Archived notice
//   currentLastArchived.classList.remove("hidden");
//   currentLastArchived.textContent = `Last archived ${formatTime(archiveStatus?.lastArchivedAt)} (${timeAgo(archiveStatus?.lastArchivedAt)})`;
//   btnArchiveText.textContent = "Archive new version";
// });

// uiBus.on("render:tags", ({ archiveStatus }) => {
//   currentTagsBlock.classList.toggle("hidden", !extensionSettings.sitesTags);

//   if (archiveStatus) {
//     tagsUrl = archiveStatus.url;
//     // Not archived yet (and no tags on the server): show the default tags as
//     // provisional chips until they have been persisted.
//     siteTags = (archiveStatus.tags ?? []).length
//       ? (archiveStatus.tags ?? [])
//       : Vec.from(extensionSettings.defaultTags);
//   } else {
//     siteTags = [];
//     tagsUrl = null;
//   }

//   currentTagInput.disabled = !extensionSettings.sitesTags || tagsUrl === null;
//   btnAddTag.disabled = currentTagInput.disabled;
//   renderTagChips();
//   renderTagSuggestions();
// });

// /* Persist default tags on a not-yet-archived site (once per URL per popup session). */
// uiBus.on("tags:seed:defaults", async ({ url, existing }) => {
//   const defaults = Vec.from(extensionSettings.defaultTags);
//   if (!extensionSettings.sitesTags || !defaults.length || defaultsSeeded.has(url)) return;
//   defaultsSeeded.add(url);

//   await uiBus.emitAsync("tags:set", {
//     url,
//     tags: [...existing, ...defaults],
//   });
// });

// uiBus.on("tags:set:error", ({ message }) => {
//   currentTagsError.innerHTML = "";
//   currentTagsError.appendChild(
//     errorBox(`Tags: ${message}`, () => {
//       currentTagsError.innerHTML = "";
//     }),
//   );
// });

// uiBus.on("tags:set:ok", () => {
//   currentTagsError.innerHTML = "";
// });

// /* Replace the site's tag set on the server, then re-check status (which re-renders tags). */
// // uiBus.on("tags:set", async ({ url, tags }) => {
// //   btnAddTag.disabled = true;

// //   const result = await sendToBackground("SET_SITE_TAGS", { url, tags });
// //   if (result.ok === false) {
// //     log.error("Cannot save tags,", result.messages.toString());
// //     uiBus.emit("tags:set:error", { message: result.messages.toString() });
// //     // Allow the default-tags seeding to retry on the next status check.
// //     defaultsSeeded.clear();
// //     renderTagChips();
// //     btnAddTag.disabled = !extensionSettings.sitesTags || tagsUrl === null;
// //     return;
// //   }

// //   siteTags = result.data;
// //   currentTagInput.value = "";
// //   uiBus.emit("tags:set:ok", { tags: siteTags });
// //   renderTagChips();
// //   renderTagSuggestions();
// //   btnAddTag.disabled = !extensionSettings.sitesTags || tagsUrl === null;
// // });

// // uiBus.on("render:archive", () => {
// //   btnArchiveText.textContent = "Archiving…";
// //   // btnArchive.disabled = archiving || !configured.server || !configured.archive || !archivable;
// //   btnArchive.disabled = true;
// // });

// uiBus.on("render:archive:error", ({ errorMessage }) => {
//   btnArchive.disabled = false;
//   currentStatusPill.className = "pill err";
//   currentStatusPill.textContent = "Archive Failed";
//   btnArchiveText.textContent = "Archive Failed";

//   currentErrorContainer.innerHTML = "";
//   currentErrorContainer.appendChild(errorBox(`Archive failed: ${errorMessage}`));
//   // failedAt: Date.now(),
// });

// uiBus.on("render:archive:ok", ({ warnings }) => {
//   btnArchive.disabled = false;
//   btnArchiveText.textContent = "Archive new version";

//   const flash =
//     "Archived ✓" +
//     (warnings.length
//       ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""}: ${warnings.join("; ")})`
//       : "");

//   // Flash Message
//   if (flash) {
//     currentFlash.classList.remove("hidden");
//     currentFlash.textContent = flash;
//   } else {
//     currentFlash.classList.add("hidden");
//   }
// });

// btnGrantPermission.addEventListener("click", async () => {
//   hasPermission = true;
//   uiBus.emit("render:notice");
// });
// btnRecheck.addEventListener("click", async () => await appBus.emitAsync("archive:check"));
// btnRefreshPending.addEventListener("click", async () => await appBus.emitAsync("pending:refresh"));
// btnArchive.addEventListener("click", async () => await appBus.emitAsync("archive"));
// btnOpenOptions.forEach((v) => {
//   v.addEventListener("click", () => {
//     browser.runtime.openOptionsPage();
//     window.close();
//   });
// });
// btnAddTag.addEventListener("click", addTagFromInput);
// currentTagInput.addEventListener("keydown", async (e) => {
//   if (e.key !== "Enter" || e.isComposing) return;
//   e.preventDefault();
//   await addTagFromInput();
// });

// document.addEventListener("DOMContentLoaded", async () => {
//   spinnerEl.classList.remove("hidden");
//   appEl.classList.add("hidden");

//   [tab] = await browser.tabs.query({ active: true, currentWindow: true });
//   if (tab) {
//     log.debug("Popup opened", { tabId: tab.id, url: tab.url, title: tab.title });
//   }

//   try {
//     hasPermission = await browser.permissions.contains({ origins: ["<all_urls>"] });
//   } catch {
//     hasPermission = true; // TODO: false?
//   }

//   try {
//     shortcut =
//       (await browser.commands.getAll()).find((c) => c.name === "archive-page")?.shortcut || "";
//   } catch {}

//   const ok = await setExtensionSetting();
//   spinnerEl.classList.add("hidden");
//   appEl.classList.remove("hidden");

//   if (!ok) return;

//   // await Tag.setupKnowTags();

//   uiBus.emit("error:any:clear");
//   uiBus.emit("render:anchorServer");
//   uiBus.emit("render:notice");
//   uiBus.emit("render:currentPage");

//   const archivable = tab && tab.url !== undefined && isArchivable(tab.url);

//   if (archivable) {
//     await appBus.emitAsync("archive:check");
//   }

//   Pending.get();
// });
