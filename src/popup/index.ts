import { log as rootLog } from "@common/log";
import { getElementById, q } from "@common/document";
import { sendToBackground, type SendToBackground } from "@common/messaging";
import { isServerConfigured, settingsFromStorageSetting } from "@common/settings";
import type {
  CaptureHistoryResponse,
  CaptureSummary,
  CollectionRecord,
  PageDetail,
  PatchPageRequest,
  PendingItem,
} from "@common/api-types";
import type { IdLessTag, Option } from "@common/types";
import { TagStore } from "@src/background/tags";
import { formatTimeFromSec, timeAgoFromSec, toDateFromSec } from "@common/time";

const log = rootLog.child("popup");

const MAX_VERSIONS_SHOWN = 20;
const SPINNER_DELAY_MS = 300;

/** Remembers the "Also archive a snapshot" checkbox between popup opens. */
const ARCHIVE_PREF_KEY = "archiveOnSave";
/** Remembers the "Also save assets" checkbox between popup opens. */
const SAVE_ASSETS_PREF_KEY = "saveAssetsOnSave";
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
    const url = new URL(raw);
    return url.hostname + url.pathname;
  } catch {
    return raw;
  }
}

/** Parses "name" or "name:color" into a tag. Returns null for an empty name. */
function parseTagInput(raw: string): IdLessTag | null {
  const separator = raw.indexOf(":");
  const name = (separator === -1 ? raw : raw.slice(0, separator)).trim();
  if (!name) return null;
  const color = separator === -1 ? null : raw.slice(separator + 1).trim() || null;
  return { name, color };
}

function tagsKey(tags: readonly IdLessTag[]): string {
  return tags
    .map((tag) => `${tag.name.toLowerCase()}:${tag.color ?? ""}`)
    .sort()
    .join("|");
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

/** The page lookup, interpreted once for the whole popup. */
type LookupState =
  | { kind: "saved"; page: PageDetail; versions: CaptureHistoryResponse }
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
function captureHref(capture: CaptureSummary): string | null {
  if (!serverUrl) return null;
  return new URL(`/api/capture/${capture.id}/html`, serverUrl).toString();
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

async function readSaveAssetPref(): Promise<boolean> {
  try {
    const stored = await browser.storage.local.get(SAVE_ASSETS_PREF_KEY);
    return stored[SAVE_ASSETS_PREF_KEY] !== false; // default on
  } catch {
    return false;
  }
}

function writeSaveAssetPref(value: boolean) {
  void browser.storage.local.set({ [SAVE_ASSETS_PREF_KEY]: value }).catch(() => {});
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
  /** Numeric collection id as a string, matching `CreatePageRequest`. */
  collectionId: Option<string>;
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
  private tagInput = getElementById("current-tag-input", HTMLInputElement);
  private tagAddBtn = getElementById("current-tag-add", HTMLButtonElement);
  private tagSuggestions = getElementById("tag-options", HTMLDataListElement);
  private chipTpl = getElementById("template-tag-chip", HTMLTemplateElement);
  private emptyTpl = getElementById("template-tags-empty", HTMLTemplateElement);

  private archiveOption = getElementById("archive-option", HTMLLabelElement);
  private archiveCheck = getElementById("archive-with-save", HTMLInputElement);

  private saveAssetsOption = getElementById("save-assets-option", HTMLLabelElement);
  private saveAssetsCheck = getElementById("save-assets-with-archive", HTMLInputElement);

  private errorEl = getElementById("current-error-container", HTMLDivElement);
  private flash = getElementById("current-flash", HTMLDivElement);

  private saveBtn = getElementById("btn-save", HTMLButtonElement);
  private archiveBtn = getElementById("btn-archive", HTMLButtonElement);
  private archiveBtnText = getElementById("btn-archive-text", HTMLSpanElement);
  private archiveBtnShortcut = getElementById("btn-archive-shortcut", HTMLSpanElement);

  private tagStore = new TagStore();
  /** Server-known tags (name -> color), most used first. */
  private known = new Map<string, Option<string>>();

  private readonly page: PageDetail | null;
  private readonly url: string;
  private pinned: boolean;
  private readonly initialCollectionId: Option<string>;
  private collectionsLoaded = false;
  /** Set when an existing collection can't be shown safely (list load failed). */
  private collectionLocked = false;
  private baseline: Draft;
  private busy = false;

  constructor(
    private readonly tabId: number,
    tab: chrome.tabs.Tab,
    readonly state: LookupState,
    shortcut: string,
    archiveDefault: boolean,
    saveAssetDefault: boolean,
  ) {
    this.page = state.kind === "saved" ? state.page : null;
    this.url = this.page?.url ?? tab.url ?? "";
    this.pinned = this.page?.pinned ?? false;
    this.initialCollectionId =
      this.page?.collectionId != null ? String(this.page.collectionId) : null;

    const usable = state.kind !== "unavailable";
    show(this.unsupported, !usable);
    show(this.form, usable);
    if (state.kind === "unavailable") {
      this.errorEl.textContent = state.detail;
      show(this.errorEl, true);
    }

    this.renderStatus(state);

    this.titleInput.value = this.page?.displayTitle || tab.title || "";
    setTextWithTitle(this.urlEl, this.url || "No URL");
    this.notes.value = this.page?.description ?? "";
    if (this.page) this.tagStore.tags = this.page.tags;
    this.archiveCheck.checked = archiveDefault;
    this.saveAssetsCheck.checked = saveAssetDefault;
    this.archiveBtnShortcut.textContent = shortcut;

    this.renderPin();
    this.renderChips();
    this.renderButtons();
    this.baseline = this.draft();
    this.updateSaveState();

    this.restoreFlash();
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
    this.tagInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        this.addTags(this.tagInput.value);
      }
    });

    this.archiveCheck.addEventListener("change", () => {
      writeArchivePref(this.archiveCheck.checked);
      this.updateAssetsVisibility();
    });
    this.saveAssetsCheck.addEventListener("change", () =>
      writeSaveAssetPref(this.saveAssetsCheck.checked),
    );

    this.saveBtn.addEventListener("click", () => void this.save());
    this.archiveBtn.addEventListener("click", () => void this.archiveVersion());

    const submitShortcut = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
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
    // Keep anything typed while the request was in flight; only the local tags
    // belong to the initial state.
    const typed = this.tagStore.tags;
    this.tagStore.tags = tags;
    const localTags = this.tagStore.tags;
    for (const tag of typed) this.tagStore.upsertTag(tag);
    this.baseline = { ...this.baseline, tags: localTags };
    this.renderChips();
    this.updateSaveState();
  }

  /** Best-effort: without collections the link stays Unsorted. */
  async loadCollections() {
    const [collections, error] = await sendToBackground("LIST_COLLECTIONS");
    if (error) {
      log.warn("Cannot load collections,", error.detail);
      // Don't clear an existing assignment just because the list is unavailable.
      this.collectionLocked = this.page !== null;
      this.collection.disabled = this.collectionLocked;
      return;
    }

    const options = collections.map((collection: CollectionRecord) => {
      const option = document.createElement("option");
      option.value = String(collection.id);
      option.textContent = `${collection.emoji} ${collection.name}`;
      return option;
    });
    this.collection.append(...options);

    // If the saved collection is missing from the list, keep it selectable so
    // saving another field does not silently move the page to Unsorted.
    const initial = this.initialCollectionId;
    if (initial && !collections.some((collection) => String(collection.id) === initial)) {
      const fallback = document.createElement("option");
      fallback.value = initial;
      fallback.textContent = [this.page?.collectionEmoji, this.page?.collectionName]
        .filter(Boolean)
        .join(" ");
      if (!fallback.textContent) fallback.textContent = "Current collection";
      this.collection.append(fallback);
    }

    this.collectionsLoaded = true;
    this.collection.value = initial ?? "";
    this.updateSaveState();
  }

  /** Best-effort: a failure only means no autocomplete. */
  async loadSuggestions() {
    const [tags, error] = await sendToBackground("LIST_TAGS");
    if (error) {
      log.warn("Cannot load tag suggestions,", error.detail);
      return;
    }
    const byUsage = [...tags].sort((a, b) => b.pageCount - a.pageCount);
    this.known = new Map(byUsage.map((tag) => [tag.name, tag.color]));
    this.renderSuggestions();
  }

  // ----- draft & dirty tracking --------------------------------------------

  private draft(): Draft {
    const collectionId = this.collectionsLoaded
      ? this.collection.value || null
      : this.initialCollectionId;

    return {
      title: this.titleInput.value.trim(),
      description: this.notes.value.trim(),
      collectionId,
      pinned: this.pinned,
      tags: this.tagStore.tags,
    };
  }

  /** Only the page fields that differ from the baseline (sent as PATCH body). */
  private patch(draft: Draft): PatchPageRequest {
    const patch: PatchPageRequest = {};
    // The server keeps the current title when an empty one is sent, so treat an
    // empty title as "unchanged" instead of pretending it was saved.
    if (draft.title && draft.title !== this.baseline.title) patch.displayTitle = draft.title;
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

  // ----- actions -----------------------------------------------------------

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
      displayTitle: draft.title || undefined,
      description: draft.description || undefined,
      collectionId: draft.collectionId,
      pinned: draft.pinned,
      tags: draft.tags,
      archive: this.archiveCheck.checked,
      saveAssets: this.archiveCheck.checked && this.saveAssetsCheck.checked,
    });

    if (error) return this.fail(`Couldn't save link: ${error.detail}`);
    this.reloadWithFlash(result.archived ? "Saved and archived ✓" : "Saved ✓", result.warnings);
  }

  private async saveExisting(page: PageDetail, draft: Draft) {
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
      for (const tag of saved) if (!this.known.has(tag.name)) this.known.set(tag.name, tag.color);
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
      const draft = this.draft();
      const [archive, error] = await sendToBackground("ARCHIVE_TAB", {
        tabId: this.tabId,
        // Tags are applied after the capture succeeds, so unsaved tag edits are
        // kept without risking a tag rewrite when archiving fails. Only send
        // them when they actually changed to avoid a pointless extra request.
        tags: this.tagsChanged(draft) ? draft.tags : undefined,
        saveAssets: this.saveAssetsCheck.checked,
      });
      if (error) return this.fail(`Couldn't archive: ${error.detail}`);
      this.reloadWithFlash("Archived ✓", archive.warnings);
    } finally {
      this.setBusy(false);
    }
  }

  // ----- feedback -----------------------------------------------------------

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

  private restoreFlash() {
    const text = sessionStorage.getItem(FLASH_KEY);
    if (!text) return;
    sessionStorage.removeItem(FLASH_KEY);
    this.showFlash(text);
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
      this.pinBtn,
      this.tagInput,
      this.tagAddBtn,
      this.archiveCheck,
      this.saveAssetsCheck,
      this.archiveBtn,
    ]) {
      el.disabled = busy;
    }
    this.collection.disabled = busy || this.collectionLocked;
    this.renderChips(); // refreshes the chips' disabled state
    this.updateSaveState();
  }

  // ----- rendering ----------------------------------------------------------

  private renderStatus(state: LookupState) {
    show(this.statusPill, state.kind !== "unavailable");
    show(this.recheck, state.kind !== "unavailable");

    if (state.kind === "saved") {
      const count = state.page.captureCount;
      this.statusPill.className = "pill ok";
      this.statusPill.textContent = count > 0 ? `Saved · ${plural(count, "snapshot")}` : "Saved";
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
    this.updateAssetsVisibility();
  }

  /** Assets only matter when the save/archive action will take a snapshot. */
  private updateAssetsVisibility() {
    const saved = this.page !== null;
    show(this.saveAssetsOption, saved || this.archiveCheck.checked);
    this.saveAssetsCheck.disabled = this.busy;
  }

  private renderPin() {
    this.pinBtn.setAttribute("aria-pressed", String(this.pinned));
    this.pinBtn.title = this.pinned ? "Unpin this link" : "Pin this link";
    this.pinBtn.setAttribute("aria-label", this.pinBtn.title);
  }

  // ----- tags --------------------------------------------------------------

  private addTags(raw: string) {
    const added = raw
      .split(",")
      .map(parseTagInput)
      .filter((tag): tag is IdLessTag => tag !== null);
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
    const applied = new Set(this.tagStore.tags.map((tag) => tag.name));
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

    const fragment = document.createDocumentFragment();
    for (const tag of this.tagStore.tags) fragment.appendChild(this.renderChip(tag.name));
    this.tagList.replaceChildren(fragment);
  }

  private renderChip(name: string): HTMLElement {
    const fragment = this.chipTpl.content.cloneNode(true) as DocumentFragment;
    const chip = q<HTMLElement>(fragment, ".tag-chip");
    const nameEl = q<HTMLSpanElement>(fragment, ".tag-chip-name");
    const removeBtn = q<HTMLButtonElement>(fragment, ".tag-chip-remove");

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

    const lastCapturedAt = page.lastCapturedAt;
    show(this.lastArchived, lastCapturedAt > 0);
    if (lastCapturedAt > 0) {
      this.lastArchived.textContent = `Last archived ${formatTimeFromSec(lastCapturedAt)} (${timeAgoFromSec(lastCapturedAt)})`;
    }

    // The API returns captures newest-first.
    const shown = versions.items.slice(0, MAX_VERSIONS_SHOWN);
    const hasMore = page.captureCount > shown.length;
    show(this.overflow, hasMore);
    if (hasMore) {
      this.overflow.textContent = `Showing newest ${shown.length} of ${page.captureCount}`;
    }

    const fragment = document.createDocumentFragment();
    for (const capture of shown) fragment.appendChild(this.renderVersion(capture));
    this.list.replaceChildren(fragment);
  }

  private renderVersion(capture: CaptureSummary): HTMLLIElement {
    const fragment = this.itemTpl.content.cloneNode(true) as DocumentFragment;
    const item = q<HTMLLIElement>(fragment, "li");
    const link = q<HTMLAnchorElement>(fragment, ".ver-link");
    const timeEl = q<HTMLTimeElement>(fragment, ".ver-time");
    const agoEl = q<HTMLSpanElement>(fragment, ".ver-ago");

    link.textContent = `v${capture.version}`;

    const href = captureHref(capture);
    if (href) {
      link.href = href;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        openTab(href);
      });
    } else {
      link.removeAttribute("href");
      link.setAttribute("aria-disabled", "true");
    }

    const iso = toDateFromSec(capture.capturedAt).toISOString();
    timeEl.textContent = formatTimeFromSec(capture.capturedAt);
    timeEl.title = iso;
    timeEl.dateTime = iso;

    agoEl.textContent = timeAgoFromSec(capture.capturedAt);
    agoEl.title = iso;

    return item;
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

    const fragment = document.createDocumentFragment();
    for (const item of pending.items) fragment.appendChild(this.renderItem(item));
    this.list.replaceChildren(fragment);

    show(this.overflow, pending.hasMore);
    if (pending.hasMore) {
      this.overflow.textContent = "More queued items not shown (see list limit in preferences)";
    }
  }

  private renderItem(item: PendingItem): DocumentFragment {
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
      const tagNames = item.tags.map((tag) => tag.name);
      tagsEl.textContent = tagNames.length ? `Tags: ${tagNames.join(", ")}` : "No tags";
    };
    renderTags();

    actionBtn.addEventListener("click", async () => {
      log.debug("Queue archive requested", { url: item.url, pendingId: item.id });
      // The server merges the pending item's tags and dequeues it when the
      // capture carries its id.
      await sendToBackground("OPEN_AND_ARCHIVE", { url: item.url, pendingId: item.id });
      window.close();
    });

    const closeEditor = () => {
      editor.classList.add("hidden");
      errorEl.textContent = "";
      show(errorEl, false);
      tagsBtn.disabled = false;
    };

    tagsBtn.addEventListener("click", () => {
      input.value = item.tags.map((tag) => tag.name).join(", ");
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
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
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
    return commands.find((command) => command.name === "archive-page")?.shortcut || "";
  } catch {
    return "";
  }
}

function bindChrome(serverUrl: URL | undefined) {
  // Both the header button and the "no server" notice share data-key="btn-open-options".
  document.querySelectorAll<HTMLButtonElement>('[data-key="btn-open-options"]').forEach((button) =>
    button.addEventListener("click", () => {
      void browser.runtime.openOptionsPage();
      window.close();
    }),
  );

  const serverLink = getElementById("link-open-server", HTMLAnchorElement);
  if (serverUrl) {
    serverLink.href = serverUrl.href;
    show(serverLink, true);
  }

  // permissions.request must be called directly from a user gesture.
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

  const [
    hasPermission,
    shortcut,
    archiveDefault,
    saveAssetsDefault,
    [storageSettings, settingsError],
  ] = await Promise.all([
    hasAllUrlsPermission(),
    getArchiveShortcut(),
    readArchivePref(),
    readSaveAssetPref(),
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

  const form = new LinkForm(tab.id, tab, state, shortcut, archiveDefault, saveAssetsDefault);
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
