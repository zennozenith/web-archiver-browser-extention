import { log as rootLog } from "@common/log";
import { getElementById, q } from "@common/document";
import { SendToBackground, sendToBackground } from "@common/messaging";
import { settingsFromStorageSetting } from "@common/settings";
import { ApiCaptureSummary, ApiPageDetail } from "@src/background/page";
import type { PendingDto } from "@src/background/pending";
import { IdLessTag, TagStore } from "@src/background/tags";
import type { Option, Int64, Page, UrlStr } from "@common/types";
import { formatTimeFromSec, timeAgoFromSec, toDateFromSec } from "@common/time";

const log = rootLog.child("popup");

const MAX_VERSIONS_SHOWN = 20;
const SPINNER_DELAY_MS = 300;

type LookupResult = SendToBackground<"PAGE_LOOKUP_FULL">;
type PendingResult = SendToBackground<"GET_PENDING">;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openTab(url: UrlStr) {
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

/** Single place that interprets the lookup result for the whole popup. */
type LookupState =
  | { kind: "archived"; page: ApiPageDetail; versions: Page<ApiCaptureSummary> }
  | { kind: "not_archived" }
  | { kind: "unavailable"; reason: string; detail: string };

function toLookupState([data, error]: LookupResult): LookupState {
  if (error) {
    return error.reason === "not_found"
      ? { kind: "not_archived" }
      : { kind: "unavailable", reason: error.reason, detail: error.detail };
  }
  const [page, versions] = data;
  return { kind: "archived", page, versions };
}

/** TODO: build the real capture URL once the server route is known. */
function captureHref(_version: ApiCaptureSummary): UrlStr | null {
  return null;
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
// Notices
// ---------------------------------------------------------------------------

class Notice {
  private static permission = getElementById("notice-permission", HTMLDivElement);
  private static noServer = getElementById("notice-no-server", HTMLDivElement);
  private static noTabId = getElementById("notice-no-tab-id", HTMLDivElement);

  static init(opts: { hasPermission: boolean; serverUrl?: URL; hasTabId: boolean }) {
    show(Notice.permission, !opts.hasPermission);
    show(Notice.noTabId, !opts.hasTabId);
    show(Notice.noServer, opts.serverUrl === undefined);
  }
}

class ErrorUi {
  // TODO: surface errors in the UI
  static push(...args: unknown[]) {
    log.error(...args);
  }
}

// ---------------------------------------------------------------------------
// Current page
// ---------------------------------------------------------------------------

class CurrentPage {
  private unarchivable = getElementById("current-unarchivable", HTMLDivElement);
  private meta = getElementById("current-meta", HTMLDivElement);
  private title = getElementById("current-title", HTMLDivElement);
  private url = getElementById("current-url", HTMLDivElement);

  private statusContainer = getElementById("current-status-pill-container", HTMLDivElement);
  private statusPill = getElementById("current-status-pill", HTMLSpanElement);
  private recheck = getElementById("current-btn-recheck", HTMLButtonElement);

  private errorContainer = getElementById("current-error-container", HTMLDivElement);
  private lastArchived = getElementById("current-last-archived", HTMLDivElement);
  private flash = getElementById("current-flash", HTMLDivElement);

  private versionItemTpl = getElementById("template-version", HTMLTemplateElement);
  private versionList = getElementById("current-versions-list", HTMLUListElement);
  private versionOverflow = getElementById("current-versions-overflow", HTMLDivElement);

  private archiveBtn = getElementById("btn-archive", HTMLButtonElement);
  private archiveBtnText = getElementById("btn-archive-text", HTMLSpanElement);
  private archiveBtnShortcut = getElementById("btn-archive-shortcut", HTMLSpanElement);

  constructor(
    tab: chrome.tabs.Tab,
    state: LookupState,
    archiveShortcut: string,
    private readonly getTags: () => readonly IdLessTag[],
  ) {
    const archivable = state.kind !== "unavailable";
    const page = state.kind === "archived" ? state.page : null;

    this.renderHeader(tab, page);
    this.renderStatus(state);
    this.renderArchiveButton(archivable, page !== null, archiveShortcut);
    this.renderLastArchived(page);
    this.renderVersions(state);

    show(this.unarchivable, !archivable);
    show(this.meta, archivable);
    // textContent, not innerHTML: error details are not trusted HTML
    this.errorContainer.textContent = state.kind === "unavailable" ? state.detail : "";

    if (archivable && tab.id !== undefined) this.bindActions(tab.id);
  }

  private bindActions(tabId: number) {
    this.recheck.addEventListener("click", () => location.reload());

    this.archiveBtn.addEventListener("click", async () => {
      let flashText = "Archiving...";

      this.flash.textContent = flashText;
      this.archiveBtn.disabled = true;
      show(this.errorContainer, false);
      show(this.flash, true);

      // Read at click time so tags edited just before archiving are included.
      const [archive, error] = await sendToBackground("ARCHIVE_TAB", {
        tabId,
        tags: [...this.getTags()],
      });

      if (error) {
        ErrorUi.push("Cannot archive page,", error.detail);
        this.errorContainer.textContent = `Couldn't archive: ${error.detail}`;
        show(this.errorContainer, true);
        this.archiveBtn.disabled = false;
        return;
      }

      const { warnings } = archive;
      flashText =
        "Archived ✓" +
        (warnings.length
          ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""}: ${warnings.join("; ")})`
          : "");

      // Flash Message
      this.flash.textContent = flashText;

      location.reload(); // re-lookup to show the new version
    });
  }

  private renderHeader(tab: chrome.tabs.Tab, page: ApiPageDetail | null) {
    setTextWithTitle(this.title, page?.title || page?.url || tab.title || tab.url || "No Title");
    setTextWithTitle(this.url, page?.url || tab.url || "No Url");
  }

  private renderStatus(state: LookupState) {
    const unavailable = state.kind === "unavailable";
    show(this.statusContainer, !unavailable);
    show(this.recheck, !unavailable);
    this.recheck.disabled = unavailable;

    if (state.kind === "archived") {
      this.statusPill.className = "pill ok";
      this.statusPill.textContent = `Archived · ${plural(state.page.captureCount, "version")}`;
    } else if (state.kind === "not_archived") {
      this.statusPill.className = "pill warn";
      this.statusPill.textContent = "Not archived";
    }
  }

  private renderArchiveButton(archivable: boolean, isArchived: boolean, shortcut: string) {
    this.archiveBtn.disabled = !archivable;
    this.archiveBtnText.textContent = isArchived ? "Archive new version" : "Archive this page";
    this.archiveBtnShortcut.textContent = shortcut;
  }

  private renderLastArchived(page: ApiPageDetail | null) {
    const ts = page?.lastCapturedAt;
    show(this.lastArchived, !!ts);
    if (ts) {
      this.lastArchived.textContent = `Last archived ${formatTimeFromSec(ts)} (${timeAgoFromSec(ts)})`;
    }
  }

  private renderVersions(state: LookupState) {
    this.versionList.replaceChildren();

    if (state.kind !== "archived") {
      show(this.versionList, false);
      show(this.versionOverflow, false);
      return;
    }

    show(this.versionList, true);

    // Assumes the API returns versions newest-first.
    const shown = state.versions.items.slice(0, MAX_VERSIONS_SHOWN);

    // captureCount is the real total; items may be paginated.
    const total = state.page.captureCount;
    const overflow = total > shown.length;
    show(this.versionOverflow, overflow);
    if (overflow) {
      this.versionOverflow.textContent = `Showing newest ${shown.length} of ${total}`;
    }

    const frag = document.createDocumentFragment();
    for (const version of shown) frag.appendChild(this.renderVersion(version));
    this.versionList.appendChild(frag);
  }

  private renderVersion(version: ApiCaptureSummary): HTMLLIElement {
    const frag = this.versionItemTpl.content.cloneNode(true) as DocumentFragment;
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
      // No href → styled as a non-link via :not([href])
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
// Pending list
// ---------------------------------------------------------------------------

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

  constructor(result: PendingResult) {
    this.render(result);
    this.btnRefresh.addEventListener("click", () => void this.refresh());

    // First run: nothing cached yet, so fetch automatically.
    if (result[1]?.reason === "pending_not_fetched") void this.refresh();
  }

  async refresh() {
    log.debug("Refreshing pending list");
    this.setRefreshing(true);
    try {
      const [, refreshError] = await sendToBackground("REFRESH_PENDING");
      if (refreshError) ErrorUi.push("Cannot refresh pending,", refreshError.detail);
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
        ErrorUi.push("Cannot get pending,", error.detail);
        this.errorContainer.textContent = `Couldn't load pending list: ${error.detail}`;
      }
      show(this.fetchedTime, false);
      return;
    }

    // Last refresh failed, but we still have the previous list to show.
    this.errorContainer.textContent = pending.error ? `Last refresh failed: ${pending.error}` : "";

    this.heading.textContent = `Pending(${pending.total}${pending.hasMore ? "+" : ""})`;

    this.heading.textContent = `Pending(${pending.total})`;
    this.fetchedTime.textContent = timeAgoFromSec(pending.fetchedAt);
    this.fetchedTime.title = formatTimeFromSec(pending.fetchedAt);
    show(this.fetchedTime, true);

    show(this.empty, pending.items.length === 0);

    const frag = document.createDocumentFragment();
    for (const item of pending.items) frag.appendChild(this.renderItem(item));
    this.list.replaceChildren(frag);

    show(this.overflow, pending.hasMore);
    if (pending.hasMore) {
      this.overflow.textContent = "More pending items not shown (see list limit in preferences)";
    }
  }

  private renderItem(item: PendingDto): DocumentFragment {
    const clone = this.itemTemplate.content.cloneNode(true) as DocumentFragment;
    const titleEl = q<HTMLDivElement>(clone, ".title");
    const urlEl = q<HTMLDivElement>(clone, ".url");
    const tagsEl = q<HTMLDivElement>(clone, ".small.muted");
    const actionBtn = q<HTMLButtonElement>(clone, ".sm.archive-btn");

    titleEl.title = item.title || item.url;
    titleEl.textContent = item.title || displayUrl(item.url);

    urlEl.title = item.url;
    urlEl.textContent = `${item.url} · ${timeAgoFromSec(item.createdAt)}`;

    const tagNames = item.tags.map((t) => t.name);
    tagsEl.textContent = tagNames.length ? `Tags: ${tagNames.join(", ")}` : "No tags";

    actionBtn.addEventListener("click", async () => {
      log.debug("Pending list archive requested", { url: item.url });
      await sendToBackground("OPEN_AND_ARCHIVE", { url: item.url });
      window.close();
    });

    // TODO: tag-edit and archive buttons for pending items
    return clone;
  }
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Parses "name" or "name:color" into a tag. Returns null for an empty name. */
function parseTagInput(raw: string): IdLessTag | null {
  const sep = raw.indexOf(":");
  const name = (sep === -1 ? raw : raw.slice(0, sep)).trim();
  if (!name) return null;
  const color = sep === -1 ? null : raw.slice(sep + 1).trim() || null;
  return { name, color };
}

class Tag {
  private list = getElementById("current-tags", HTMLDivElement);
  private errorEl = getElementById("current-tags-error", HTMLDivElement);
  private input = getElementById("current-tag-input", HTMLInputElement);
  private btnAddTag = getElementById("current-tag-add", HTMLButtonElement);

  private chipTpl = getElementById("template-tag-chip", HTMLTemplateElement);
  private emptyTpl = getElementById("template-tags-empty", HTMLTemplateElement);

  // fields
  private suggestions = getElementById("tag-options", HTMLDataListElement);
  /** Server-known tags (name -> color), most used first. */
  private known = new Map<string, Option<string>>();

  private tagStore = new TagStore();
  private pageId: Int64 | null = null;
  private busy = false;

  constructor(
    private readonly url: string,
    state: LookupState,
  ) {
    if (state.kind === "archived") {
      this.tagStore.tags = state.page.tags;
      this.pageId = state.page.id;
    }
    // TODO: for "not_archived", load locally stored tags (needs a background message).

    this.renderChips();

    if (state.kind === "unavailable") {
      // Can't save tags without a usable lookup; leave the UI inert.
      this.input.disabled = true;
      this.btnAddTag.disabled = true;
      return;
    }

    this.btnAddTag.addEventListener("click", () => void this.add(this.input.value));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.add(this.input.value);
      }
    });
  }

  async loadLocalTags() {
    const [tags, error] = await sendToBackground("GET_LOCAL_TAGS", { url: this.url });
    if (error) {
      ErrorUi.push("Cannot load local tags,", error.detail);
      return;
    }
    this.tagStore.tags = tags;
    this.renderChips();
  }

  /** Best-effort: a failure only means no autocomplete, so it is logged, not shown. */
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

  private renderSuggestions() {
    const applied = new Set(this.tagStore.tags.map((t) => t.name));
    const options: HTMLOptionElement[] = [];

    for (const name of this.known.keys()) {
      if (applied.has(name)) continue;
      const option = document.createElement("option");
      option.value = name;
      options.push(option);
    }
    this.suggestions.replaceChildren(...options);
  }

  get currentTags(): IdLessTag[] {
    return this.tagStore.tags; // already a copy
  }

  async add(raw: string): Promise<boolean> {
    const parsed = parseTagInput(raw);
    if (!parsed) return false;

    const tag: IdLessTag = {
      ...parsed,
      color: parsed.color ?? this.known.get(parsed.name) ?? null,
    };

    const next = new TagStore(this.tagStore.tags);
    next.upsertTag(tag);

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

  /** Persists `next`; the store only changes on success so the UI never drifts from the server. */
  private async commit(next: readonly IdLessTag[]): Promise<boolean> {
    if (this.busy) return false;
    this.showError(null);
    this.setBusy(true);

    try {
      const [saved, error] = await sendToBackground("SET_PAGE_TAGS", {
        idOrUrl: this.pageId ?? this.url,
        tags: [...next],
        url: this.url,
      });

      if (error) {
        log.error("Cannot save tags,", error.detail);
        this.showError("Couldn't save tags. Please try again.");
        return false;
      }

      this.tagStore.tags = saved;
      for (const t of saved) if (!this.known.has(t.name)) this.known.set(t.name, t.color);
      this.renderSuggestions();
      return true;
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.btnAddTag.disabled = busy;
    this.input.disabled = busy;
    this.renderChips(); // refresh the chips' disabled state
  }

  private showError(message: string | null) {
    this.errorEl.textContent = message ?? "";
    show(this.errorEl, message !== null);
  }

  private renderChips() {
    if (this.tagStore.length === 0) {
      this.list.replaceChildren(this.emptyTpl.content.cloneNode(true));
      return;
    }

    const frag = document.createDocumentFragment();
    for (const t of this.tagStore.tags) frag.appendChild(this.renderChip(t.name));
    this.list.replaceChildren(frag);
  }

  private renderChip(name: string): HTMLElement {
    const frag = this.chipTpl.content.cloneNode(true) as DocumentFragment;
    const chip = q<HTMLElement>(frag, ".tag-chip");
    const nameEl = q<HTMLSpanElement>(frag, ".tag-chip-name");
    const removeBtn = q<HTMLButtonElement>(frag, ".tag-chip-remove");

    nameEl.textContent = name;
    removeBtn.title = `Remove tag "${name}" from this site`;
    removeBtn.setAttribute("aria-label", removeBtn.title);
    removeBtn.disabled = this.busy;
    removeBtn.addEventListener("click", () => void this.remove(name));

    return chip;
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function hasAllUrlsPermission(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    return true; // TODO: should this be false?
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

  const [hasPermission, shortcut, [storageSettings, settingsError]] = await Promise.all([
    hasAllUrlsPermission(),
    getArchiveShortcut(),
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

  Notice.init({
    hasPermission,
    serverUrl: settings.serverUrl,
    hasTabId: tab?.id !== undefined,
  });
  bindChrome(settings.serverUrl);

  if (!tab || tab.id === undefined) return;

  const [lookupResult, pendingResult] = await Promise.all([
    sendToBackground("PAGE_LOOKUP_FULL", { tabId: tab.id }),
    sendToBackground("GET_PENDING"),
  ]);

  const state = toLookupState(lookupResult);

  const tagUi = tab.url ? new Tag(tab.url, state) : null;
  if (tagUi && state.kind === "not_archived") await tagUi.loadLocalTags();
  if (tagUi && settings.serverUrl) void tagUi.loadSuggestions();

  new CurrentPage(tab, state, shortcut, () => tagUi?.currentTags ?? []);
  new Pending(pendingResult);

  if (tab.url) {
    const tags = new Tag(tab.url, state);
    if (state.kind === "not_archived") await tags.loadLocalTags();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  Loading.show();
  try {
    await init();
  } catch (e) {
    ErrorUi.push("Popup init failed", e);
  } finally {
    Loading.hide(); // runs on every early return too
  }
});
