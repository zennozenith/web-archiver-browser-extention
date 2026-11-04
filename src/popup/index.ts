// popup.ts
import { log as rootLog } from "@common/log";
import { getElementById, q } from "@common/document";
import { SendToBackground, sendToBackground } from "@common/messaging";
import { isServerConfigured, settingsFromStorageSetting } from "@common/settings";
import type { ApiCaptureSummary, ApiPageDetail } from "@src/background/page";
import type { ApiCollection } from "@src/background/collections";
import type { PendingDto } from "@src/background/pending";
import { type IdLessTag, TagStore } from "@src/background/tags";
import type { Option, Int64, Page } from "@common/types";
import { formatTimeFromSec, timeAgoFromSec, toDateFromSec } from "@common/time";

const log = rootLog.child("popup");

const MAX_VERSIONS_SHOWN = 20;
const SPINNER_DELAY_MS = 300;

/** Remembers the "Also archive a snapshot" checkbox between popup opens. */
const ARCHIVE_PREF_KEY = "archiveOnSave";
/** One-shot message shown after the popup reloads itself following a save. */
const FLASH_KEY = "popup-flash";

/** Set once settings are loaded; used to build links to archived captures. */
let serverUrl: URL | undefined;

type LookupResult = SendToBackground<"PAGE_LOOKUP_FULL">;
type PendingResult = SendToBackground<"GET_PENDING">;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openTab(url: string) {
  void browser.tabs.create({ url });
  window.close();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function setTextWithTitle(el: HTMLElement, text: string) {
  el.textContent = text;
  el.title = text;
}

function show(el: HTMLElement, visible: boolean) {
  el.classList.toggle("hidden", !visible);
}

/** hostname + pathname, falling back to the raw string if it isn't a valid URL. */
function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.hostname + u.pathname;
  } catch {
    return raw;
  }
}

/** Parses "name" or "name:color" into a tag. Returns null for an empty name. */
function parseTagInput(raw: string): IdLessTag | null {
  const sep = raw.indexOf(":");
  const name = (sep === -1 ? raw : raw.slice(0, sep)).trim();
  if (!name) return null;
  const color = sep === -1 ? null : raw.slice(sep + 1).trim() || null;
  return { name, color };
}

function tagsKey(tags: readonly IdLessTag[]): string {
  return tags
    .map((t) => `${t.name.toLowerCase()}:${t.color ?? ""}`)
    .sort()
    .join("|");
}

/** The page lookup, interpreted once for the whole popup. */
type LookupState =
  | { kind: "saved"; page: ApiPageDetail; versions: Page<ApiCaptureSummary> }
  | { kind: "not_saved" }
  | { kind: "unavailable"; reason: string; detail: string };

function toLookupState([data, error]: LookupResult): LookupState {
  if (error) {
    return error.reason === "not_found"
      ? { kind: "not_saved" }
      : { kind: "unavailable", reason: error.reason, detail: error.detail };
  }
  const [page, versions] = data;
  return { kind: "saved", page, versions };
}

/** Link to the archived (rewritten) HTML of one capture. */
function captureHref(version: ApiCaptureSummary): string | null {
  if (!serverUrl) return null;
  return new URL(`/api/capture/${version.id}/html`, serverUrl).toString();
}

async function readArchivePref(): Promise<boolean> {
  try {
    const stored = await browser.storage.local.get(ARCHIVE_PREF_KEY);
    return stored[ARCHIVE_PREF_KEY] !== false; // default on
  } catch {
    return true;
  }
}

function writeArchivePref(value: boolean) {
  void browser.storage.local.set({ [ARCHIVE_PREF_KEY]: value }).catch(() => {});
}

function describeError(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Loading spinner (only shown if loading takes longer than SPINNER_DELAY_MS)
// ---------------------------------------------------------------------------

class Loading {
  private static spinner = getElementById("spinner", HTMLDivElement);
  private static timer: number | undefined;

  static show() {
    clearTimeout(Loading.timer);
    Loading.timer = window.setTimeout(
      () => Loading.spinner.classList.remove("hidden"),
      SPINNER_DELAY_MS,
    );
  }

  static hide() {
    clearTimeout(Loading.timer);
    Loading.spinner.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// Notices & global errors
// ---------------------------------------------------------------------------

class Notice {
  private static permission = getElementById("notice-permission", HTMLDivElement);
  private static noServer = getElementById("notice-no-server", HTMLDivElement);
  private static noTabId = getElementById("notice-no-tab-id", HTMLDivElement);

  static init(opts: { hasPermission: boolean; serverConfigured: boolean; hasTabId: boolean }) {
    show(Notice.permission, !opts.hasPermission);
    show(Notice.noTabId, !opts.hasTabId);
    show(Notice.noServer, !opts.serverConfigured);
  }
}

class ErrorUi {
  private static container = getElementById("popup-error", HTMLDivElement);

  static init() {
    ErrorUi.container.title = "Click to dismiss";
    ErrorUi.container.addEventListener("click", () => ErrorUi.clear());
  }

  static push(...args: unknown[]) {
    log.error(...args);
    const message = args
      .map(describeError)
      .filter((part) => part.length > 0)
      .join(" ");
    if (!message) return;
    ErrorUi.container.textContent = message;
    show(ErrorUi.container, true);
  }

  static clear() {
    ErrorUi.container.textContent = "";
    show(ErrorUi.container, false);
  }
}

// ---------------------------------------------------------------------------
// Save-link form (current page)
// ---------------------------------------------------------------------------

/** What the form edits. `collectionId: null` means Unsorted. */
interface Draft {
  title: string;
  description: string;
  collectionId: Option<Int64>;
  pinned: boolean;
  tags: IdLessTag[];
}

class LinkForm {
  private unsupported = getElementById("current-unsupported", HTMLDivElement);
  private form = getElementById("current-form", HTMLDivElement);
  private titleInput = getElementById("current-title", HTMLInputElement);
  private urlEl = getElementById("current-url", HTMLDivElement);
  private notes = getElementById("current-notes", HTMLTextAreaElement);
  private collection = getElementById("current-collection", HTMLSelectElement);
  private pinBtn = getElementById("btn-pin", HTMLButtonElement);

  private statusPill = getElementById("current-status-pill", HTMLSpanElement);
  private recheck = getElementById("current-btn-recheck", HTMLButtonElement);

  private tagList = getElementById("current-tags", HTMLDivElement);
  // private tagError = getElementById("current-tags-error", HTMLDivElement);
  private tagInput = getElementById("current-tag-input", HTMLInputElement);
  private tagAddBtn = getElementById("current-tag-add", HTMLButtonElement);
  private tagSuggestions = getElementById("tag-options", HTMLDataListElement);
  private chipTpl = getElementById("template-tag-chip", HTMLTemplateElement);
  private emptyTpl = getElementById("template-tags-empty", HTMLTemplateElement);

  private archiveOption = getElementById("archive-option", HTMLLabelElement);
  private archiveCheck = getElementById("archive-with-save", HTMLInputElement);

  private errorEl = getElementById("current-error-container", HTMLDivElement);
  private flash = getElementById("current-flash", HTMLDivElement);

  private saveBtn = getElementById("btn-save", HTMLButtonElement);
  private archiveBtn = getElementById("btn-archive", HTMLButtonElement);
  private archiveBtnText = getElementById("btn-archive-text", HTMLSpanElement);
  private archiveBtnShortcut = getElementById("btn-archive-shortcut", HTMLSpanElement);

  private tagStore = new TagStore();
  /** Server-known tags (name -> color), most used first. */
  private known = new Map<string, Option<string>>();

  private readonly page: ApiPageDetail | null;
  private readonly url: string;
  private pinned: boolean;
  private initialCollectionId: Option<Int64>;
  private collectionsLoaded = false;
  private baseline: Draft;
  private busy = false;

  constructor(
    private readonly tabId: number,
    tab: chrome.tabs.Tab,
    readonly state: LookupState,
    shortcut: string,
    archiveDefault: boolean,
  ) {
    this.page = state.kind === "saved" ? state.page : null;
    this.url = this.page?.url ?? tab.url ?? "";
    this.pinned = this.page?.pinned ?? false;
    this.initialCollectionId = this.page?.collectionId ?? null;

    const usable = state.kind !== "unavailable";
    show(this.unsupported, !usable);
    show(this.form, usable);
    this.errorEl.textContent = state.kind === "unavailable" ? state.detail : "";

    this.renderStatus(state);

    this.titleInput.value = this.page?.displayTitle || tab.title || "";
    setTextWithTitle(this.urlEl, this.url || "No URL");
    this.notes.value = this.page?.description ?? "";
    if (this.page) this.tagStore.tags = this.page.tags;
    this.archiveCheck.checked = archiveDefault;
    this.archiveBtnShortcut.textContent = shortcut;

    this.renderPin();
    this.renderChips();
    this.renderButtons();
    this.baseline = this.draft();
    this.updateSaveState();

    const savedFlash = sessionStorage.getItem(FLASH_KEY);
    if (savedFlash) {
      sessionStorage.removeItem(FLASH_KEY);
      this.showFlash(savedFlash);
    }

    if (usable) this.bind();
  }

  // ----- wiring ------------------------------------------------------------

  private bind() {
    this.recheck.addEventListener("click", () => location.reload());

    for (const el of [this.titleInput, this.notes]) {
      el.addEventListener("input", () => this.updateSaveState());
    }
    this.collection.addEventListener("change", () => this.updateSaveState());

    this.pinBtn.addEventListener("click", () => {
      this.pinned = !this.pinned;
      this.renderPin();
      this.updateSaveState();
    });

    this.tagAddBtn.addEventListener("click", () => this.addTags(this.tagInput.value));
    this.tagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        this.addTags(this.tagInput.value);
      }
    });

    this.archiveCheck.addEventListener("change", () => writeArchivePref(this.archiveCheck.checked));

    this.saveBtn.addEventListener("click", () => void this.save());
    this.archiveBtn.addEventListener("click", () => void this.archiveVersion());

    // Ctrl/Cmd+Enter saves from the free-text fields.
    const submitShortcut = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void this.save();
      }
    };
    this.titleInput.addEventListener("keydown", submitShortcut);
    this.notes.addEventListener("keydown", submitShortcut);
  }

  // ----- data loading ------------------------------------------------------

  /** Not-yet-saved pages may already have tags chosen via the queue. */
  async loadLocalTags() {
    const [tags, error] = await sendToBackground("GET_LOCAL_TAGS", { url: this.url });
    if (error) {
      ErrorUi.push("Cannot load local tags,", error.detail);
      return;
    }
    this.tagStore.tags = tags;
    this.baseline = { ...this.baseline, tags: this.draft().tags };
    this.renderChips();
    this.updateSaveState();
  }

  /** Best-effort: without collections the link stays Unsorted. */
  async loadCollections() {
    const [collections, error] = await sendToBackground("LIST_COLLECTIONS");
    if (error) {
      log.warn("Cannot load collections,", error.detail);
      this.collection.disabled = this.page !== null; // can't safely edit an existing assignment
      return;
    }

    const options = collections.map((c: ApiCollection) => {
      const option = document.createElement("option");
      option.value = String(c.id);
      option.textContent = `${c.emoji} ${c.name}`;
      return option;
    });
    this.collection.append(...options);
    this.collectionsLoaded = true;
    this.collection.value =
      this.initialCollectionId === null ? "" : String(this.initialCollectionId);
    this.updateSaveState();
  }

  /** Best-effort: a failure only means no autocomplete. */
  async loadSuggestions() {
    const [tags, error] = await sendToBackground("LIST_TAGS");
    if (error) {
      log.warn("Cannot load tag suggestions,", error.detail);
      return;
    }
    const byUsage = [...tags].sort((a, b) => b.pages - a.pages);
    this.known = new Map(byUsage.map((t) => [t.name, t.color]));
    this.renderSuggestions();
  }

  // ----- draft & dirty tracking ---------------------------------------------

  private draft(): Draft {
    let collectionId = this.initialCollectionId;
    if (this.collectionsLoaded) {
      collectionId = this.collection.value === "" ? null : (Number(this.collection.value) as Int64);
    }
    return {
      title: this.titleInput.value.trim(),
      description: this.notes.value.trim(),
      collectionId,
      pinned: this.pinned,
      tags: this.tagStore.tags.map(({ name, color }) => ({ name, color })),
    };
  }

  /** Only the page fields that differ from the baseline (sent as PATCH body). */
  private patch(draft: Draft) {
    const patch: {
      title?: string;
      description?: string;
      collectionId?: Option<Int64>;
      pinned?: boolean;
    } = {};
    if (draft.title !== this.baseline.title) patch.title = draft.title;
    if (draft.description !== this.baseline.description) patch.description = draft.description;
    if (draft.collectionId !== this.baseline.collectionId) patch.collectionId = draft.collectionId;
    if (draft.pinned !== this.baseline.pinned) patch.pinned = draft.pinned;
    return patch;
  }

  private tagsChanged(draft: Draft): boolean {
    return tagsKey(draft.tags) !== tagsKey(this.baseline.tags);
  }

  private updateSaveState() {
    const draft = this.draft();
    const dirty =
      this.page === null || Object.keys(this.patch(draft)).length > 0 || this.tagsChanged(draft);
    this.saveBtn.disabled = this.busy || !dirty;
  }

  // ----- actions -------------------------------------------------------------

  private async save() {
    if (this.busy || this.saveBtn.disabled) return;
    const draft = this.draft();

    this.setBusy(true);
    this.clearMessages();
    this.showFlash("Saving…");

    try {
      if (this.page === null) await this.saveNew(draft);
      else await this.saveExisting(this.page, draft);
    } finally {
      this.setBusy(false);
    }
  }

  private async saveNew(draft: Draft) {
    const [result, error] = await sendToBackground("SAVE_LINK", {
      tabId: this.tabId,
      title: draft.title || undefined,
      description: draft.description || undefined,
      collectionId: draft.collectionId,
      pinned: draft.pinned,
      tags: draft.tags,
      archive: this.archiveCheck.checked,
    });

    if (error) return this.fail(`Couldn't save link: ${error.detail}`);
    this.reloadWithFlash(result.archived ? "Saved and archived ✓" : "Saved ✓", result.warnings);
  }

  private async saveExisting(page: ApiPageDetail, draft: Draft) {
    const patch = this.patch(draft);

    if (Object.keys(patch).length > 0) {
      const [, error] = await sendToBackground("UPDATE_PAGE", { id: page.id, patch });
      if (error) return this.fail(`Couldn't save changes: ${error.detail}`);
    }

    if (this.tagsChanged(draft)) {
      const [saved, error] = await sendToBackground("SET_PAGE_TAGS", {
        idOrUrl: page.id,
        url: this.url,
        tags: draft.tags,
      });
      if (error) {
        // Page fields were already saved; keep their baseline so only tags stay dirty.
        this.baseline = { ...draft, tags: this.baseline.tags };
        return this.fail(`Saved, but couldn't update tags: ${error.detail}`);
      }
      this.tagStore.tags = saved;
      for (const t of saved) if (!this.known.has(t.name)) this.known.set(t.name, t.color);
      this.renderChips();
      this.renderSuggestions();
    }

    this.baseline = this.draft();
    this.showFlash("Saved ✓");
  }

  private async archiveVersion() {
    if (this.busy) return;
    this.setBusy(true);
    this.clearMessages();
    this.showFlash("Archiving…");

    try {
      const [archive, error] = await sendToBackground("ARCHIVE_TAB", {
        tabId: this.tabId,
        tags: this.draft().tags,
      });
      if (error) return this.fail(`Couldn't archive: ${error.detail}`);
      this.reloadWithFlash("Archived ✓", archive.warnings);
    } finally {
      this.setBusy(false);
    }
  }

  // ----- feedback ------------------------------------------------------------

  private fail(message: string) {
    log.error(message);
    show(this.flash, false);
    this.errorEl.textContent = message;
    show(this.errorEl, true);
  }

  private clearMessages() {
    this.errorEl.textContent = "";
    show(this.errorEl, false);
    show(this.flash, false);
  }

  private showFlash(text: string) {
    this.flash.textContent = text;
    show(this.flash, true);
  }

  /** Re-lookup after the page's saved/archived state changed; the flash survives the reload. */
  private reloadWithFlash(text: string, warnings: readonly string[]) {
    const suffix = warnings.length
      ? ` (${plural(warnings.length, "warning")}: ${warnings.join("; ")})`
      : "";
    sessionStorage.setItem(FLASH_KEY, text + suffix);
    location.reload();
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    for (const el of [
      this.titleInput,
      this.notes,
      this.collection,
      this.pinBtn,
      this.tagInput,
      this.tagAddBtn,
      this.archiveCheck,
      this.archiveBtn,
    ]) {
      el.disabled = busy;
    }
    this.renderChips(); // refreshes the chips' disabled state
    this.updateSaveState();
  }

  // ----- rendering -------------------------------------------------------------

  private renderStatus(state: LookupState) {
    show(this.statusPill, state.kind !== "unavailable");
    show(this.recheck, state.kind !== "unavailable");

    if (state.kind === "saved") {
      const n = state.page.captureCount;
      this.statusPill.className = "pill ok";
      this.statusPill.textContent = n > 0 ? `Saved · ${plural(n, "snapshot")}` : "Saved";
    } else if (state.kind === "not_saved") {
      this.statusPill.className = "pill warn";
      this.statusPill.textContent = "Not saved";
    }
  }

  private renderButtons() {
    const saved = this.page !== null;
    this.saveBtn.textContent = saved ? "Save changes" : "Save link";
    show(this.archiveOption, !saved);
    show(this.archiveBtn, saved);
    this.archiveBtnText.textContent =
      saved && this.page!.captureCount === 0 ? "Archive a snapshot" : "Archive new version";
  }

  private renderPin() {
    this.pinBtn.setAttribute("aria-pressed", String(this.pinned));
    this.pinBtn.title = this.pinned ? "Unpin this link" : "Pin this link";
    this.pinBtn.setAttribute("aria-label", this.pinBtn.title);
  }

  // ----- tags --------------------------------------------------------------------

  private addTags(raw: string) {
    const added = raw
      .split(",")
      .map(parseTagInput)
      .filter((t): t is IdLessTag => t !== null);
    if (added.length === 0) return;

    for (const parsed of added) {
      this.tagStore.upsertTag({
        ...parsed,
        color: parsed.color ?? this.known.get(parsed.name) ?? null,
      });
    }
    this.tagInput.value = "";
    this.tagInput.focus();
    this.renderChips();
    this.renderSuggestions();
    this.updateSaveState();
  }

  private removeTag(name: string) {
    this.tagStore.removeTag(name);
    this.renderChips();
    this.renderSuggestions();
    this.updateSaveState();
  }

  private renderSuggestions() {
    const applied = new Set(this.tagStore.tags.map((t) => t.name));
    const options: HTMLOptionElement[] = [];
    for (const name of this.known.keys()) {
      if (applied.has(name)) continue;
      const option = document.createElement("option");
      option.value = name;
      options.push(option);
    }
    this.tagSuggestions.replaceChildren(...options);
  }

  private renderChips() {
    if (this.tagStore.length === 0) {
      this.tagList.replaceChildren(this.emptyTpl.content.cloneNode(true));
      return;
    }

    const frag = document.createDocumentFragment();
    for (const t of this.tagStore.tags) frag.appendChild(this.renderChip(t.name));
    this.tagList.replaceChildren(frag);
  }

  private renderChip(name: string): HTMLElement {
    const frag = this.chipTpl.content.cloneNode(true) as DocumentFragment;
    const chip = q<HTMLElement>(frag, ".tag-chip");
    const nameEl = q<HTMLSpanElement>(frag, ".tag-chip-name");
    const removeBtn = q<HTMLButtonElement>(frag, ".tag-chip-remove");

    nameEl.textContent = name;
    removeBtn.title = `Remove tag "${name}"`;
    removeBtn.setAttribute("aria-label", removeBtn.title);
    removeBtn.disabled = this.busy;
    removeBtn.addEventListener("click", () => this.removeTag(name));

    return chip;
  }
}

// ---------------------------------------------------------------------------
// Snapshots (collapsed list of saved versions)
// ---------------------------------------------------------------------------

class Snapshots {
  private root = getElementById("snapshots", HTMLDetailsElement);
  private summary = getElementById("snapshots-summary", HTMLElement);
  private lastArchived = getElementById("current-last-archived", HTMLDivElement);
  private list = getElementById("current-versions-list", HTMLUListElement);
  private overflow = getElementById("current-versions-overflow", HTMLDivElement);
  private itemTpl = getElementById("template-version", HTMLTemplateElement);

  constructor(state: LookupState) {
    const visible = state.kind === "saved" && state.page.captureCount > 0;
    show(this.root, visible);
    if (state.kind !== "saved" || !visible) return;

    const { page, versions } = state;
    this.summary.textContent = `Snapshots (${page.captureCount})`;

    const ts = page.lastCapturedAt;
    show(this.lastArchived, !!ts);
    if (ts) {
      this.lastArchived.textContent = `Last archived ${formatTimeFromSec(ts)} (${timeAgoFromSec(ts)})`;
    }

    // Assumes the API returns versions newest-first.
    const shown = versions.items.slice(0, MAX_VERSIONS_SHOWN);
    const hasMore = page.captureCount > shown.length;
    show(this.overflow, hasMore);
    if (hasMore)
      this.overflow.textContent = `Showing newest ${shown.length} of ${page.captureCount}`;

    const frag = document.createDocumentFragment();
    for (const version of shown) frag.appendChild(this.renderVersion(version));
    this.list.replaceChildren(frag);
  }

  private renderVersion(version: ApiCaptureSummary): HTMLLIElement {
    const frag = this.itemTpl.content.cloneNode(true) as DocumentFragment;
    const li = q<HTMLLIElement>(frag, "li");
    const link = q<HTMLAnchorElement>(frag, ".ver-link");
    const timeEl = q<HTMLTimeElement>(frag, ".ver-time");
    const agoEl = q<HTMLSpanElement>(frag, ".ver-ago");

    link.textContent = `v${version.version}`;

    const href = captureHref(version);
    if (href) {
      link.href = href;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        openTab(href);
      });
    } else {
      link.removeAttribute("href");
      link.setAttribute("aria-disabled", "true");
    }

    const iso = toDateFromSec(version.capturedAt).toISOString();
    timeEl.textContent = formatTimeFromSec(version.capturedAt);
    timeEl.title = iso;
    timeEl.dateTime = iso;

    agoEl.textContent = timeAgoFromSec(version.capturedAt);
    agoEl.title = iso;

    return li;
  }
}

// ---------------------------------------------------------------------------
// Queue (collapsed list of pending items)
// ---------------------------------------------------------------------------

class Pending {
  private summary = getElementById("pending-heading", HTMLElement);
  private fetchedTime = getElementById("pending-fetched-time", HTMLSpanElement);
  private btnRefresh = getElementById("btn-refresh-pending", HTMLButtonElement);
  private refreshIcon = getElementById("refresh-icon", HTMLSpanElement);
  private errorContainer = getElementById("pending-error-container", HTMLDivElement);
  private empty = getElementById("pending-empty", HTMLDivElement);
  private list = getElementById("pending-list", HTMLUListElement);
  private overflow = getElementById("pending-overflow", HTMLDivElement);
  private itemTemplate = getElementById("template-pending-list-item", HTMLTemplateElement);

  constructor(result: PendingResult) {
    this.render(result);
    this.btnRefresh.addEventListener("click", () => void this.refresh());

    // First run: nothing cached yet, so fetch automatically.
    if (result[1]?.reason === "pending_not_fetched") void this.refresh();
  }

  async refresh() {
    log.debug("Refreshing queue");
    this.setRefreshing(true);
    try {
      const [, refreshError] = await sendToBackground("REFRESH_PENDING");
      if (refreshError) ErrorUi.push("Cannot refresh queue,", refreshError.detail);
      // Render regardless: GET_PENDING reports the stored error state too.
      this.render(await sendToBackground("GET_PENDING"));
    } finally {
      this.setRefreshing(false);
    }
  }

  private setRefreshing(refreshing: boolean) {
    this.btnRefresh.disabled = refreshing;
    this.refreshIcon.classList.toggle("spin", refreshing);
  }

  private render([pending, error]: PendingResult) {
    if (error) {
      // Don't shout on first run; refresh() is already running.
      if (error.reason !== "pending_not_fetched") {
        ErrorUi.push("Cannot get queue,", error.detail);
        this.errorContainer.textContent = `Couldn't load queue: ${error.detail}`;
      }
      show(this.fetchedTime, false);
      return;
    }

    // Last refresh failed, but we still have the previous list to show.
    this.errorContainer.textContent = pending.error ? `Last refresh failed: ${pending.error}` : "";

    this.summary.textContent = `Queue (${pending.total}${pending.hasMore ? "+" : ""})`;
    this.fetchedTime.textContent = `Updated ${timeAgoFromSec(pending.fetchedAt)}`;
    this.fetchedTime.title = formatTimeFromSec(pending.fetchedAt);
    show(this.fetchedTime, true);

    show(this.empty, pending.items.length === 0);

    const frag = document.createDocumentFragment();
    for (const item of pending.items) frag.appendChild(this.renderItem(item));
    this.list.replaceChildren(frag);

    show(this.overflow, pending.hasMore);
    if (pending.hasMore) {
      this.overflow.textContent = "More queued items not shown (see list limit in preferences)";
    }
  }

  private renderItem(item: PendingDto): DocumentFragment {
    const clone = this.itemTemplate.content.cloneNode(true) as DocumentFragment;
    const titleEl = q<HTMLDivElement>(clone, ".title");
    const urlEl = q<HTMLDivElement>(clone, ".url");
    const tagsEl = q<HTMLDivElement>(clone, ".tags-line");
    const tagsBtn = q<HTMLButtonElement>(clone, ".tags-btn");
    const actionBtn = q<HTMLButtonElement>(clone, ".archive-btn");
    const editor = q<HTMLDivElement>(clone, ".pending-tag-editor");
    const input = q<HTMLInputElement>(clone, ".pending-tag-input");
    const saveBtn = q<HTMLButtonElement>(clone, ".pending-tag-save");
    const cancelBtn = q<HTMLButtonElement>(clone, ".pending-tag-cancel");
    const errorEl = q<HTMLDivElement>(clone, ".pending-tag-error");

    // Queue items have no title yet; show host + path instead.
    setTextWithTitle(titleEl, displayUrl(item.url));
    urlEl.title = item.url;
    urlEl.textContent = `Queued ${timeAgoFromSec(item.createdAt)}`;

    const renderTags = () => {
      const tagNames = item.tags.map((t) => t.name);
      tagsEl.textContent = tagNames.length ? `Tags: ${tagNames.join(", ")}` : "No tags";
    };
    renderTags();

    actionBtn.addEventListener("click", async () => {
      log.debug("Queue archive requested", { url: item.url });
      await sendToBackground("OPEN_AND_ARCHIVE", { url: item.url });
      window.close();
    });

    const closeEditor = () => {
      editor.classList.add("hidden");
      errorEl.textContent = "";
      show(errorEl, false);
      tagsBtn.disabled = false;
    };

    tagsBtn.addEventListener("click", () => {
      input.value = item.tags.map((t) => t.name).join(", ");
      editor.classList.remove("hidden");
      tagsBtn.disabled = true;
      input.focus();
    });

    cancelBtn.addEventListener("click", closeEditor);

    const save = async () => {
      saveBtn.disabled = true;
      input.disabled = true;
      errorEl.textContent = "";
      show(errorEl, false);

      const tags = input.value
        .split(",")
        .map(parseTagInput)
        .filter((tag): tag is IdLessTag => tag !== null);

      const [saved, error] = await sendToBackground("SET_PENDING_TAGS", { id: item.id, tags });

      saveBtn.disabled = false;
      input.disabled = false;

      if (error) {
        errorEl.textContent = `Couldn't save tags: ${error.detail}`;
        show(errorEl, true);
        return;
      }

      item.tags = saved;
      renderTags();
      closeEditor();
    };

    saveBtn.addEventListener("click", () => void save());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void save();
      }
    });

    return clone;
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function hasAllUrlsPermission(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: ["<all_urls>"] });
  } catch (e) {
    log.warn("Cannot check site access permission", e);
    return false;
  }
}

async function getArchiveShortcut(): Promise<string> {
  try {
    const commands = await browser.commands.getAll();
    return commands.find((c) => c.name === "archive-page")?.shortcut || "";
  } catch {
    return "";
  }
}

function bindChrome(serverUrl: URL | undefined) {
  // Both the header button and the "no server" notice share data-key="btn-open-options".
  document.querySelectorAll<HTMLButtonElement>('[data-key="btn-open-options"]').forEach((btn) =>
    btn.addEventListener("click", () => {
      void browser.runtime.openOptionsPage();
      window.close();
    }),
  );

  const serverLink = getElementById("link-open-server", HTMLAnchorElement);
  if (serverUrl) {
    serverLink.href = serverUrl.href;
    show(serverLink, true);
  }

  // permissions.request must be called directly from a user gesture
  getElementById("btn-grant-permission", HTMLButtonElement).addEventListener("click", async () => {
    try {
      if (await browser.permissions.request({ origins: ["<all_urls>"] })) location.reload();
    } catch (e) {
      ErrorUi.push("Cannot request permission", e);
    }
  });
}

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  log.debug("Popup opened", { tabId: tab?.id, url: tab?.url, title: tab?.title });

  const [hasPermission, shortcut, archiveDefault, [storageSettings, settingsError]] =
    await Promise.all([
      hasAllUrlsPermission(),
      getArchiveShortcut(),
      readArchivePref(),
      sendToBackground("GET_EXTENSION_SETTINGS"),
    ]);

  if (settingsError) {
    ErrorUi.push("Cannot load extension settings,", settingsError.detail);
    return;
  }

  const [settings, parseError] = settingsFromStorageSetting(storageSettings);
  if (parseError) {
    ErrorUi.push("Cannot parse extension settings,", parseError.detail);
    return;
  }

  const configured = isServerConfigured(settings);
  serverUrl = configured ? settings.serverUrl : undefined;

  Notice.init({
    hasPermission,
    serverConfigured: configured,
    hasTabId: tab?.id !== undefined,
  });
  bindChrome(serverUrl);

  if (!tab || tab.id === undefined) return;

  const [lookupResult, pendingResult] = await Promise.all([
    sendToBackground("PAGE_LOOKUP_FULL", { tabId: tab.id }),
    sendToBackground("GET_PENDING"),
  ]);

  const state = toLookupState(lookupResult);

  const form = new LinkForm(tab.id, tab, state, shortcut, archiveDefault);
  new Snapshots(state);
  new Pending(pendingResult);

  if (state.kind === "not_saved") await form.loadLocalTags();
  if (state.kind !== "unavailable") void form.loadCollections();
  if (configured) void form.loadSuggestions();
}

document.addEventListener("DOMContentLoaded", async () => {
  ErrorUi.init();
  Loading.show();
  try {
    await init();
  } catch (e) {
    ErrorUi.push("Popup init failed", e);
  } finally {
    Loading.hide(); // runs on every early return too
  }
});
