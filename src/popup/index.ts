import { log as rootLog } from "@common/log";
import { getElementById, q } from "@common/document";
import { SendToBackground, sendToBackground } from "@common/messaging";
import { settingsFromStorageSetting } from "@common/settings";
import { ApiCaptureSummary, ApiPageDetail } from "@src/background/page";
import { Int64, Page, UrlStr } from "@common/types";
import { formatTimeFromSec, timeAgoFromSec, toDateFromSec } from "@common/time";
import { IdLessTag, TagStore } from "@src/background/tags";

const log = rootLog.child("popup");

function openTab(url: UrlStr) {
  browser.tabs.create({ url });
  window.close();
}

class Loading {
  private static spinnerEl = document.getElementById("spinner") as HTMLDivElement;
  // private static hidden = Loading.spinnerEl.classList.contains("hidden");
  private static changedCounter = 0;

  public static show() {
    const changeCounter = Loading.changedCounter;
    setTimeout(() => {
      if (changeCounter === Loading.changedCounter) {
        Loading.spinnerEl.classList.remove("hidden");
        // Loading.changedCounter += 1;
      }
    }, 300);
  }

  public static hide() {
    Loading.spinnerEl.classList.add("hidden");
    Loading.changedCounter += 1;
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

class ErrorUi {
  // TODO
  public static push(...args: any[]) {
    log.error(...args);
  }
}

class CurrentPage {
  // private section = getElementById("card-current-section", HTMLDivElement);
  private unarchivable = getElementById("current-unarchivable", HTMLDivElement);

  private meta = getElementById("current-meta", HTMLDivElement);
  private title = getElementById("current-title", HTMLDivElement);
  private url = getElementById("current-url", HTMLDivElement);
  private statusContainer = getElementById("current-status-pill-container", HTMLDivElement);
  private statusPill = getElementById("current-status-pill", HTMLSpanElement);
  private recheck = getElementById("current-btn-recheck", HTMLButtonElement);

  private errorContainer = getElementById("current-error-container", HTMLDivElement);
  private versionItemTpl = getElementById("template-version", HTMLTemplateElement);
  private versionList = getElementById("current-versions-list", HTMLUListElement);
  private versionOverflow = getElementById("current-versions-overflow", HTMLDivElement);
  private lastArchived = getElementById("current-last-archived", HTMLDivElement);
  // // private flash = getElementById("current-flash", HTMLDivElement);

  private archiveBtn = getElementById("btn-archive", HTMLButtonElement);
  private archiveBtnText = getElementById("btn-archive-text", HTMLSpanElement);
  private archiveBtnShortcut = getElementById("btn-archive-shortcut", HTMLSpanElement);

  // private tagsContainer = getElementById("current-tags", HTMLDivElement);
  //

  // private isArchivable: boolean = false;

  constructor(
    tab: chrome.tabs.Tab,
    pageResult: SendToBackground<"PAGE_LOOKUP_FULL">,
    archiveShortcut: string,
  ) {
    let isArchivable = true;
    let hideStatusPill = false;
    let statusPillClass: "ok" | "err" | "warn" | "muted" = "muted";
    let statusPillText: string = "Status check not configured";
    let hideRecheck = false;
    let archiveButtonText = "";
    // let versions

    const [pageAndVersion, error] = pageResult;
    const [page, versions] = pageAndVersion ?? [null, null];

    if (error) {
      switch (error.reason) {
        case "tab_url_unarchivable":
          hideRecheck = true;
          hideStatusPill = true;
          isArchivable = false;
          statusPillClass = "err";
          break;
        case "not_found":
          isArchivable = true;
          statusPillClass = "warn";
          statusPillText = "Not archived";
          break;
        default:
          hideRecheck = true;
          hideStatusPill = true;
          isArchivable = false;
          statusPillClass = "err";
          statusPillText = error.reason;
          break;
      }
    }

    if (error && !isArchivable) {
      this.errorContainer.innerHTML = error.detail;
      // this.errorContainer.innerHTML = "";
      // this.errorContainer.appendChild(errorBox(archiveStatus.error));
    }

    if (page) {
      const count = page.captureCount;
      statusPillClass = "ok";
      statusPillText = `Archived · ${count} version${count === 1 ? "" : "s"}`;

      this.lastArchived.classList.remove("hidden");
      if (page.lastCapturedAt) {
        this.lastArchived.textContent = `Last archived ${formatTimeFromSec(page.lastCapturedAt)} (${timeAgoFromSec(page.lastCapturedAt)})`;
      }
      archiveButtonText = "Archive new version";
    } else {
      archiveButtonText = "Archive this page";
    }

    this.recheck.disabled = !isArchivable;

    this.archiveBtn.disabled = !isArchivable;
    this.archiveBtnText.textContent = archiveButtonText;
    this.archiveBtnShortcut.textContent = archiveShortcut;

    this.statusContainer.classList.toggle("hidden", hideStatusPill);
    this.statusPill.className = `pill ${statusPillClass}`;
    this.statusPill.textContent = statusPillText;

    this.recheck.classList.toggle("hidden", hideRecheck);
    this.recheck.disabled = !isArchivable;

    this.unarchivable.classList.toggle("hidden", isArchivable);
    this.meta.classList.toggle("hidden", !isArchivable);

    this.title.textContent = page?.title || page?.url || tab.title || tab.url || "No Title";
    this.title.title = page?.title || page?.url || tab.title || tab.url || "No Title";
    this.url.textContent = page?.url || tab.url || "No Url";
    this.url.title = page?.url || tab.url || "No Url";

    this.versionList.innerHTML = "";

    if (!versions) {
      this.versionList.classList.add("hidden");
      this.versionOverflow.classList.add("hidden");
      this.lastArchived.classList.add("hidden");
    } else {
      if (versions.items.length > 20) {
        this.versionOverflow.classList.remove("hidden");
        this.versionOverflow.textContent = `Showing newest 20 of ${versions.items.length}`;
      } else {
        this.versionOverflow.classList.add("hidden");
      }

      const total = versions.items.length > 20 ? 20 : versions.items.length;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < total; i++) {
        frag.appendChild(this.renderVersion(versions.items[i], i, total));
      }
      this.versionList.appendChild(frag);
    }
  }

  private renderVersion(version: ApiCaptureSummary, index: number, total: number): HTMLLIElement {
    const frag = this.versionItemTpl.content.cloneNode(true) as DocumentFragment;
    const li = q<HTMLLIElement>(frag, "li");
    const link = q<HTMLAnchorElement>(frag, ".ver-link");
    const timeEl = q<HTMLTimeElement>(frag, ".ver-time");
    const agoEl = q<HTMLSpanElement>(frag, ".ver-ago");

    const label = `${total - index}`;

    if (version.id) {
      // TODO: actual url
      link.textContent = label;
      link.href = String(version.id); // TODO: actual url
      link.addEventListener("click", (e) => {
        e.preventDefault();
        openTab(""); // TODO: actual url
      });
    } else {
      // static variant: keep the <a>, drop href → styled as non-link via :not([href])
      link.removeAttribute("href");
      link.textContent = String(version.version) || `v${label}`;
      link.setAttribute("aria-disabled", "true");
    }

    timeEl.textContent = formatTimeFromSec(version.capturedAt);
    timeEl.title = toDateFromSec(version.capturedAt).toISOString();
    timeEl.setAttribute("datetime", toDateFromSec(version.capturedAt).toISOString());

    agoEl.textContent = timeAgoFromSec(version.capturedAt);
    agoEl.title = toDateFromSec(version.capturedAt).toISOString();

    return li;
  }
}

class Pending {
  private heading = getElementById("pending-heading", HTMLHeadingElement);
  private fetchedTime = getElementById("pending-fetched-time", HTMLSpanElement);
  private btnRefresh = getElementById("btn-refresh-pending", HTMLButtonElement);
  private refreshIcon = getElementById("refresh-icon", HTMLSpanElement);
  private errorContainer = getElementById("pending-error-container", HTMLDivElement);
  private empty = getElementById("pending-empty", HTMLDivElement);
  private list = getElementById("pending-list", HTMLUListElement);
  private overflow = getElementById("pending-overflow", HTMLDivElement);
  private itemTemplate = getElementById("template-pending-list-item", HTMLTemplateElement);

  public constructor(pendingResult: SendToBackground<"GET_PENDING">) {
    this.render(pendingResult);
  }

  async refresh() {
    log.debug("Refreshing pending list");

    this.btnRefresh.disabled = true;
    this.refreshIcon.classList.toggle("spin", true);

    await sendToBackground("REFRESH_PENDING");
    this.render(await sendToBackground("GET_PENDING"));

    this.refreshIcon.classList.toggle("spin", false);
    this.btnRefresh.disabled = false;
  }

  render(pendingResult: SendToBackground<"GET_PENDING">) {
    const [pending, error] = pendingResult;
    if (error) {
      ErrorUi.push("Cannot get pending, ", error.detail);
      this.fetchedTime.classList.add("hidden");
      this.errorContainer.innerHTML = ""; // TODO:
      // Pending Error
      // if (pending.error) {
      //   this.errorContainer.appendChild(errorBox("Pending list: " + pending.error));
      // }
      return;
    }

    this.errorContainer.innerHTML = "";

    this.heading.textContent = `Pending(${pending.total})`;
    this.fetchedTime.textContent = timeAgoFromSec(pending.fetchedAt);
    this.fetchedTime.title = formatTimeFromSec(pending.fetchedAt);
    this.fetchedTime.classList.remove("hidden");

    // Pending Empty Check
    const isEmpty = pending && !pending.items.length && !pending.error;
    this.empty.classList.toggle("hidden", !isEmpty);

    // Pending Items List
    this.list.innerHTML = "";

    const frag = document.createDocumentFragment();

    if (pending.items.length) {
      pending.items.forEach((it) => {
        // --- Compute label (same logic as before) ---
        let label = it.title;
        try {
          const u = new URL(it.url);
          label = label || u.hostname + u.pathname;
        } catch {}

        // --- Clone template ---
        const clone = this.itemTemplate.content.cloneNode(true) as DocumentFragment;

        const titleDiv = q<HTMLDivElement>(clone, ".title");
        const urlDiv = q<HTMLDivElement>(clone, ".url");
        const tagsDiv = q<HTMLDivElement>(clone, ".small.muted");
        // const tagBtn = q<HTMLButtonElement>(clone, ".tags-btn");
        // const actionBtn = q<HTMLButtonElement>(clone, ".archive-btn");

        // --- Fill text content ---
        titleDiv.title = it.title || it.url;
        titleDiv.textContent = label;

        urlDiv.title = it.url;
        urlDiv.textContent = it.url + (it.createdAt ? ` · ${timeAgoFromSec(it.createdAt)}` : "");

        const tags = it.tags.map((v) => v.name) ?? [];
        tagsDiv.textContent = tags.length ? `Tags: ${tags.join(", ")}` : "No tags";

        // TODO
        // // --- Attach listeners ---
        // tagBtn.addEventListener("click", async () => {
        //   const raw = prompt("Tags for this page (comma separated)", tags.join(", ")) ?? "";
        //   const next = raw
        //     .split(",")
        //     .map((t) => t.trim().slice(0, 64))
        //     .filter(Boolean);
        //   const result = await sendToBackground("SET_PENDING_TAGS", { id: it.id, tags: next });
        //   if (result.ok === false) {
        //     log.error("Cannot save pending tags,", result.detail);
        //     uiBus.emit("error:any", { detail: result.detail });
        //     return;
        //   }
        //   await sendToBackground("REFRESH_PENDING");
        //   appBus.emit("pending:check");
        // });

        // actionBtn.addEventListener("click", async () => {
        //   log.debug("Pending list archive requested", { url: it.url });
        //   await sendToBackground("OPEN_AND_ARCHIVE", { url: it.url });
        //   window.close();
        // });

        // --- Insert ---
        frag.appendChild(clone);
      });
      this.list.appendChild(frag);
    }

    const hasOverflow = pending.total > pending.items.length;
    this.overflow.classList.toggle("hidden", !hasOverflow);
    if (hasOverflow) {
      this.overflow.textContent = `+${pending.total - pending.items.length} more not shown (see list limit in preferences)`;
    }
  }
}

class Tag {
  private list = getElementById("current-tags", HTMLDivElement);
  private errorEl = getElementById("current-tags-error", HTMLDivElement); // add to HTML
  private input = getElementById("current-tag-input", HTMLInputElement);
  private btnAddTag = getElementById("current-tag-add", HTMLButtonElement);

  private chipTpl = getElementById("template-tag-chip", HTMLTemplateElement);
  private emptyTpl = getElementById("template-tags-empty", HTMLTemplateElement);

  private tagStore = new TagStore();
  private pageId: Int64 | null = null;
  private url: string;
  private busy = false;

  constructor(url: string, pageResult: SendToBackground<"PAGE_LOOKUP_FULL">) {
    this.url = url;
    const [pageAndVersions, error] = pageResult;

    if (error) {
      if (error.reason !== "not_found") {
      }
      // unrecoverable: leave UI inert
    } else {
      const [page] = pageAndVersions;
      this.tagStore.tags = page.tags;
      this.pageId = page.id;
    }

    this.renderTagChips();

    this.btnAddTag.addEventListener("click", () => void this.add(this.input.value));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.add(this.input.value);
      }
    });
  }

  private renderTagChips(): void {
    this.list.replaceChildren();

    if (this.tagStore.length === 0) {
      this.list.appendChild(this.emptyTpl.content.cloneNode(true));
      return;
    }

    const frag = document.createDocumentFragment();
    for (const t of this.tagStore.tags) {
      frag.appendChild(this.renderTagChip(t.name, () => void this.remove(t.name)));
    }
    this.list.appendChild(frag);
  }

  private renderTagChip(name: string, onRemove: () => void): HTMLElement {
    const frag = this.chipTpl.content.cloneNode(true) as DocumentFragment;
    const chip = q<HTMLElement>(frag, ".tag-chip");
    const nameEl = q<HTMLSpanElement>(frag, ".tag-chip-name");
    const rm = q<HTMLButtonElement>(frag, ".tag-chip-remove");

    nameEl.textContent = name;
    rm.title = `Remove tag "${name}" from this site`;
    rm.setAttribute("aria-label", rm.title);
    rm.disabled = this.busy;
    rm.addEventListener("click", onRemove);

    return chip;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.btnAddTag.disabled = busy;
    this.input.disabled = busy;
    this.renderTagChips(); // refresh chips' disabled state
  }

  private showError(message: string | null): void {
    this.errorEl.textContent = message ?? "";
    this.errorEl.hidden = message === null;
    this.errorEl.classList.toggle("hidden", message === null);
  }

  /** Persist `next`. The store is only updated if the save succeeds,
   *  so a failure leaves the UI consistent with the server. */
  private async commit(next: readonly IdLessTag[]): Promise<boolean> {
    if (this.busy) return false;
    this.showError(null);
    this.setBusy(true);

    try {
      const [saved, error] = await sendToBackground("SET_PAGE_TAGS", {
        idOrUrl: this.pageId ?? this.url,
        tags: [...next],
      });

      if (error) {
        log.error("Cannot save tags,", error.detail);
        this.showError("Couldn't save tags. Please try again.");
        return false;
      }

      this.tagStore.tags = saved;
      return true;
    } finally {
      this.setBusy(false); // also re-renders
    }
  }

  async add(raw: string): Promise<boolean> {
    const sep = raw.indexOf(":");
    const name = (sep === -1 ? raw : raw.slice(0, sep)).trim();
    const color = sep === -1 ? null : raw.slice(sep + 1).trim() || null;
    if (!name) return false;

    const next = new TagStore(this.tagStore.tags);
    next.upsertTag({ name, color });

    const ok = await this.commit(next.tags);
    if (ok) {
      this.input.value = "";
      this.input.focus();
    }
    return ok;
  }

  async remove(name: string): Promise<boolean> {
    const next = new TagStore(this.tagStore.tags);
    next.removeTag(name);
    return this.commit(next.tags);
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

  let shortcut: string = "";
  try {
    shortcut =
      (await browser.commands.getAll()).find((c) => c.name === "archive-page")?.shortcut || "";
  } catch {}

  const [storageExtensionSettings, error] = await sendToBackground("GET_EXTENSION_SETTINGS");

  if (error) {
    // TODO:
    return;
  }

  const [extensionSetting, error2] = settingsFromStorageSetting(storageExtensionSettings);
  if (error2) {
    // TODO:
    return;
  }

  const { serverUrl } = extensionSetting;

  Notice.init({
    hasPermission,
    serverUrl,
    hasTabId: tab.id !== undefined,
  });

  if (tab.id === undefined) {
    return;
  }

  const pageLookupResult = await sendToBackground("PAGE_LOOKUP_FULL", { tabId: tab.id });
  const pendingResult = await sendToBackground("GET_PENDING");

  handlePageLookupResult(pageLookupResult);

  new CurrentPage(tab, pageLookupResult, shortcut);
  new Pending(pendingResult);
  if (tab.url) {
    new Tag(tab.url, pageLookupResult);
  }

  Loading.hide();
});

type ArchiveState =
  | ({ isArchivable: true } & (
      | { isArchived: true; page: ApiPageDetail; versions: Page<ApiCaptureSummary> }
      | { isArchived: false }
    ))
  | { isArchivable: false; reason: string; detail: string };

function handlePageLookupResult(pageResult: SendToBackground<"PAGE_LOOKUP_FULL">): ArchiveState {
  const [pageAndVersion, error] = pageResult;

  if (error) {
    switch (error.reason) {
      case "no_tab_url":
      case "no_tab_id":
      case "tab_url_unarchivable":
      case "tab_url_parse":
        return {
          isArchivable: false,
          detail: error.detail,
          reason: error.reason,
        };
      case "not_found":
        return {
          isArchivable: true,
          isArchived: false,
        };

      default:
        return {
          isArchivable: true,
          isArchived: false,
        };
    }
  }

  const [page, versions] = pageAndVersion ?? [null, null];
  return {
    isArchivable: true,
    isArchived: true,
    page,
    versions,
  };
}
