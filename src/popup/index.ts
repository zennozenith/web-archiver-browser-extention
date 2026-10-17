import { formatTime, isArchivable, normalizeUrl, timeAgo } from "@common/index";
import { MessageType, Url } from "@common/types";
import browser from "webextension-polyfill";

const $app = document.getElementById("app") as HTMLDivElement;

const send = (type: MessageType, extra = {}) =>
  browser.runtime.sendMessage<any, any>({ type, ...extra });

function createElement(tag: string, props: Record<string, any> = {}, ...kids: any[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat())
    if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}

const openTab = (url: Url) => {
  browser.tabs.create({ url });
  window.close();
};

let tab: browser.Tabs.Tab | null = null,
  state: any = null,
  hasPerm = true,
  shortcut = "",
  checking = false,
  archiving = false,
  refreshing = false,
  flash = "";

async function initPopup() {
  const optionsButton = document.getElementById("btn-options");
  if (optionsButton === null) return;

  optionsButton.onclick = () => {
    browser.runtime.openOptionsPage();
    window.close();
  };
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    hasPerm = await browser.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    hasPerm = true;
  }
  try {
    shortcut =
      (await browser.commands.getAll()).find((c) => c.name === "archive-page")?.shortcut || "";
  } catch {}
  state = await send("GET_STATE", { tabId: tab?.id });
  render();
  const stale =
    !state.status ||
    state.status.url !== normalizeUrl(tab?.url ?? "") ||
    Date.now() - (state.status.checkedAt || 0) > 60000;
  if (tab && isArchivable(tab.url ?? "") && state.configured.check && stale) recheck();
  if (
    state.configured.pending &&
    (!state.pending || Date.now() - (state.pending.fetchedAt || 0) > 60000)
  )
    doRefresh();
  browser.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.pending) {
      state.pending = ch.pending.newValue;
      render();
    }
  });
}

async function recheck() {
  checking = true;
  render();
  const r = await send("CHECK_TAB", { tabId: tab!.id });
  checking = false;
  if (r?.status) state.status = r.status;
  render();
}
async function doRefresh() {
  refreshing = true;
  render();
  await send("REFRESH_PENDING");
  state = { ...state, ...(await send("GET_STATE", { tabId: tab?.id })) };
  refreshing = false;
  render();
}
async function doArchive() {
  archiving = true;
  flash = "";
  render();
  const r = await send("ARCHIVE_TAB", { tabId: tab!.id });
  archiving = false;
  if (r?.ok) {
    state.status = r.status;
    state.archiveError = null;
    flash =
      "Archived ✓" +
      (r.warnings?.length
        ? ` (${r.warnings.length} warning${r.warnings.length > 1 ? "s" : ""}: ${r.warnings.join("; ")})`
        : "");
  } else state.archiveError = { message: r?.error || "Unknown error" };
  state = { ...state, ...(await send("GET_STATE", { tabId: tab!.id })), status: state.status };
  render();
}

const errorBox = (msg: any, onClose?: any) =>
  createElement(
    "div",
    { class: "error" },
    createElement("span", {}, msg),
    onClose && createElement("button", { onclick: onClose, title: "Dismiss" }, "✕"),
  );

function currentCard() {
  const children = [createElement("h2", {}, "Current page")];
  if (!tab || !isArchivable(tab.url)) {
    children.push(
      createElement(
        "div",
        { class: "muted" },
        "This page can't be archived (only http/https pages).",
      ),
    );
    return createElement("section", { class: "card" }, children);
  }
  children.push(
    createElement(
      "div",
      {},
      createElement("div", { class: "title", title: tab.title }, tab.title || tab.url),
      createElement("div", { class: "url", title: tab.url }, tab.url),
    ),
  );
  const s = state.status;
  const row = [];
  if (checking) row.push(createElement("span", { class: "pill muted" }, "Checking…"));
  else if (s?.state === "ok")
    row.push(
      s.archived
        ? createElement(
            "span",
            { class: "pill ok" },
            `Archived · ${s.count || s.versions.length || 1} version${(s.count || s.versions.length) === 1 ? "" : "s"}`,
          )
        : createElement("span", { class: "pill warn" }, "Not archived"),
    );
  else if (s?.state === "error")
    row.push(createElement("span", { class: "pill err" }, "Check failed"));
  else
    row.push(
      createElement(
        "span",
        { class: "pill muted" },
        state.configured.check ? "Unknown" : "Status check not configured",
      ),
    );
  if (state.configured.check)
    row.push(
      createElement(
        "button",
        { class: "sm", onclick: recheck, disabled: checking, title: "Re-check archive status" },
        "↻",
      ),
    );
  children.push(createElement("div", { class: "row" }, row));
  if (s?.state === "error" && !checking) children.push(errorBox(s.error));
  if (s?.state === "ok" && s.versions?.length) {
    const n = s.versions.length,
      total = s.count || n;
    children.push(
      createElement(
        "ul",
        { class: "versions" },
        s.versions
          .slice(0, 20)
          .map((v: any, i: any) =>
            createElement(
              "li",
              {},
              v.url
                ? createElement("a", { onclick: () => openTab(v.url) }, `v${total - i}`)
                : createElement("span", {}, `v${v.id ?? total - i}`),
              createElement("span", {}, formatTime(v.time)),
              createElement("span", { class: "muted" }, timeAgo(v.time)),
            ),
          ),
      ),
    );
    if (total > 20)
      children.push(
        createElement("div", { class: "muted small" }, `Showing newest 20 of ${total}`),
      );
  } else if (s?.state === "ok" && s.archived && s.last)
    children.push(
      createElement(
        "div",
        { class: "muted small" },
        `Last archived ${formatTime(s.last)} (${timeAgo(s.last)})`,
      ),
    );
  if (state.archiveError)
    children.push(
      errorBox("Archive failed: " + state.archiveError.message, async () => {
        await send("CLEAR_ARCHIVE_ERROR", { tabId: tab!.id });
        state.archiveError = null;
        render();
      }),
    );
  if (flash && !state.archiveError)
    children.push(createElement("div", { class: "success" }, flash));
  children.push(
    createElement(
      "button",
      { class: "primary", onclick: doArchive, disabled: archiving || !state.configured.archive },
      archiving ? "Archiving…" : s?.archived ? "Archive new version" : "Archive this page",
      shortcut && !archiving
        ? createElement(
            "span",
            { class: "small", style: "font-weight:400;opacity:.85" },
            `  (${shortcut})`,
          )
        : null,
    ),
  );
  return createElement("section", { class: "card" }, children);
}

function pendingCard() {
  const p = state.pending;
  const head = createElement(
    "div",
    { class: "row" },
    createElement("h2", {}, `Pending${p?.total ? ` (${p.total})` : ""}`),
    createElement(
      "div",
      { class: "row" },
      p?.fetchedAt
        ? createElement(
            "span",
            { class: "muted small", title: formatTime(p.fetchedAt) },
            timeAgo(p.fetchedAt),
          )
        : null,
      createElement(
        "button",
        {
          class: "sm",
          onclick: doRefresh,
          disabled: refreshing || !state.configured.pending,
          title: "Refresh pending list",
        },
        createElement("span", { class: refreshing ? "spin" : "" }, "↻"),
      ),
    ),
  );
  const kids = [head];
  if (!state.configured.pending)
    kids.push(createElement("div", { class: "muted" }, "Pending URL endpoint not configured."));
  else {
    if (p?.error) kids.push(errorBox("Pending list: " + p.error));
    if (p && !p.items.length && !p.error)
      kids.push(createElement("div", { class: "muted" }, "Nothing pending 🎉"));
    if (p?.items.length) {
      kids.push(
        createElement(
          "ul",
          { class: "pending" },
          p.items.map((it: any) => {
            let label = it.title;
            try {
              const u = new URL(it.url);
              label = label || u.hostname + u.pathname;
            } catch {}
            return createElement(
              "li",
              {},
              createElement(
                "div",
                { class: "grow" },
                createElement("div", { class: "title", title: it.title || it.url }, label),
                createElement(
                  "div",
                  { class: "url", title: it.url },
                  it.url + (it.addedAt ? ` · ${timeAgo(it.addedAt)}` : ""),
                ),
              ),
              createElement(
                "button",
                {
                  class: "sm",
                  title: "Open in a new tab and archive",
                  onclick: async () => {
                    await send("OPEN_AND_ARCHIVE", { url: it.url });
                    window.close();
                  },
                },
                "Archive",
              ),
            );
          }),
        ),
      );
      if (p.total > p.items.length)
        kids.push(
          createElement(
            "div",
            { class: "muted small" },
            `+${p.total - p.items.length} more not shown (see list limit in preferences)`,
          ),
        );
    }
  }
  return createElement("section", { class: "card" }, kids);
}

function render() {
  const out = [];
  if (!hasPerm)
    out.push(
      createElement(
        "div",
        { class: "notice" },
        createElement(
          "div",
          {},
          "Site access hasn't been granted yet. It's needed to read pages and request headers.",
        ),
        createElement(
          "button",
          {
            onclick: async () => {
              hasPerm = await browser.permissions.request({ origins: ["<all_urls>"] });
              render();
            },
          },
          "Grant access",
        ),
      ),
    );
  if (!state.configured.archive && !state.configured.pending && !state.configured.check)
    out.push(
      createElement(
        "div",
        { class: "notice" },
        createElement("div", {}, "No server configured yet."),
        createElement(
          "button",
          {
            onclick: () => {
              browser.runtime.openOptionsPage();
              window.close();
            },
          },
          "Open preferences",
        ),
      ),
    );
  else if (!state.configured.archive)
    out.push(errorBox("Archive endpoint is not configured. Check the preferences."));
  out.push(currentCard(), pendingCard());
  $app.replaceChildren(...out);
}

initPopup().catch((e) => {
  console.error(e);
  $app.replaceChildren(errorBox("Popup error: " + e.message));
});
