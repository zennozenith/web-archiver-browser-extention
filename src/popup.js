"use strict";
const $app = document.getElementById("app");
const send = (type, extra = {}) => api.runtime.sendMessage({ type, ...extra });
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
const openTab = url => { api.tabs.create({ url }); window.close(); };

let tab = null, st = null, hasPerm = true, shortcut = "", checking = false, archiving = false, refreshing = false, flash = "";

async function init() {
  document.getElementById("btn-options").onclick = () => { api.runtime.openOptionsPage(); window.close(); };
  [tab] = await api.tabs.query({ active: true, currentWindow: true });
  try { hasPerm = await api.permissions.contains({ origins: ["<all_urls>"] }); } catch { hasPerm = true; }
  try { shortcut = (await api.commands.getAll()).find(c => c.name === "archive-page")?.shortcut || ""; } catch {}
  st = await send("getState", { tabId: tab?.id });
  render();
  const stale = !st.status || st.status.url !== normalizeUrl(tab?.url) || Date.now() - (st.status.checkedAt || 0) > 60000;
  if (tab && isArchivable(tab.url) && st.configured.check && stale) recheck();
  if (st.configured.pending && (!st.pending || Date.now() - (st.pending.fetchedAt || 0) > 60000)) doRefresh();
  api.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.pending) { st.pending = ch.pending.newValue; render(); }
  });
}

async function recheck() {
  checking = true; render();
  const r = await send("checkTab", { tabId: tab.id });
  checking = false;
  if (r?.status) st.status = r.status;
  render();
}
async function doRefresh() {
  refreshing = true; render();
  await send("refreshPending");
  st = { ...st, ...(await send("getState", { tabId: tab?.id })) };
  refreshing = false; render();
}
async function doArchive() {
  archiving = true; flash = ""; render();
  const r = await send("archiveTab", { tabId: tab.id });
  archiving = false;
  if (r?.ok) { st.status = r.status; st.archiveError = null; flash = "Archived ✓" + (r.warnings?.length ? ` (${r.warnings.length} warning${r.warnings.length > 1 ? "s" : ""}: ${r.warnings.join("; ")})` : ""); }
  else st.archiveError = { message: r?.error || "Unknown error" };
  st = { ...st, ...(await send("getState", { tabId: tab.id })), status: st.status };
  render();
}

const errorBox = (msg, onClose) => h("div", { class: "error" }, h("span", {}, msg), onClose && h("button", { onclick: onClose, title: "Dismiss" }, "✕"));

function currentCard() {
  const children = [h("h2", {}, "Current page")];
  if (!tab || !isArchivable(tab.url)) {
    children.push(h("div", { class: "muted" }, "This page can't be archived (only http/https pages)."));
    return h("section", { class: "card" }, children);
  }
  children.push(h("div", {}, h("div", { class: "title", title: tab.title }, tab.title || tab.url), h("div", { class: "url", title: tab.url }, tab.url)));
  const s = st.status;
  const row = [];
  if (checking) row.push(h("span", { class: "pill muted" }, "Checking…"));
  else if (s?.state === "ok") row.push(s.archived
    ? h("span", { class: "pill ok" }, `Archived · ${s.count || s.versions.length || 1} version${(s.count || s.versions.length) === 1 ? "" : "s"}`)
    : h("span", { class: "pill warn" }, "Not archived"));
  else if (s?.state === "error") row.push(h("span", { class: "pill err" }, "Check failed"));
  else row.push(h("span", { class: "pill muted" }, st.configured.check ? "Unknown" : "Status check not configured"));
  if (st.configured.check) row.push(h("button", { class: "sm", onclick: recheck, disabled: checking, title: "Re-check archive status" }, "↻"));
  children.push(h("div", { class: "row" }, row));
  if (s?.state === "error" && !checking) children.push(errorBox(s.error));
  if (s?.state === "ok" && s.versions?.length) {
    const n = s.versions.length, total = s.count || n;
    children.push(h("ul", { class: "versions" }, s.versions.slice(0, 20).map((v, i) => h("li", {},
      v.url ? h("a", { onclick: () => openTab(v.url) }, `v${total - i}`) : h("span", {}, `v${v.id ?? total - i}`),
      h("span", {}, formatTime(v.time)), h("span", { class: "muted" }, timeAgo(v.time))))));
    if (total > 20) children.push(h("div", { class: "muted small" }, `Showing newest 20 of ${total}`));
  } else if (s?.state === "ok" && s.archived && s.last) children.push(h("div", { class: "muted small" }, `Last archived ${formatTime(s.last)} (${timeAgo(s.last)})`));
  if (st.archiveError) children.push(errorBox("Archive failed: " + st.archiveError.message, async () => { await send("clearArchiveError", { tabId: tab.id }); st.archiveError = null; render(); }));
  if (flash && !st.archiveError) children.push(h("div", { class: "success" }, flash));
  children.push(h("button", { class: "primary", onclick: doArchive, disabled: archiving || !st.configured.archive },
    archiving ? "Archiving…" : s?.archived ? "Archive new version" : "Archive this page", shortcut && !archiving ? h("span", { class: "small", style: "font-weight:400;opacity:.85" }, `  (${shortcut})`) : null));
  return h("section", { class: "card" }, children);
}

function pendingCard() {
  const p = st.pending;
  const head = h("div", { class: "row" },
    h("h2", {}, `Pending${p?.total ? ` (${p.total})` : ""}`),
    h("div", { class: "row" },
      p?.fetchedAt ? h("span", { class: "muted small", title: formatTime(p.fetchedAt) }, timeAgo(p.fetchedAt)) : null,
      h("button", { class: "sm", onclick: doRefresh, disabled: refreshing || !st.configured.pending, title: "Refresh pending list" }, h("span", { class: refreshing ? "spin" : "" }, "↻"))));
  const kids = [head];
  if (!st.configured.pending) kids.push(h("div", { class: "muted" }, "Pending URL endpoint not configured."));
  else {
    if (p?.error) kids.push(errorBox("Pending list: " + p.error));
    if (p && !p.items.length && !p.error) kids.push(h("div", { class: "muted" }, "Nothing pending 🎉"));
    if (p?.items.length) {
      kids.push(h("ul", { class: "pending" }, p.items.map(it => {
        let label = it.title; try { const u = new URL(it.url); label = label || u.hostname + u.pathname; } catch {}
        return h("li", {},
          h("div", { class: "grow" }, h("div", { class: "title", title: it.title || it.url }, label), h("div", { class: "url", title: it.url }, it.url + (it.addedAt ? ` · ${timeAgo(it.addedAt)}` : ""))),
          h("button", { class: "sm", title: "Open in a new tab and archive", onclick: async () => { await send("openAndArchive", { url: it.url }); window.close(); } }, "Archive"));
      })));
      if (p.total > p.items.length) kids.push(h("div", { class: "muted small" }, `+${p.total - p.items.length} more not shown (see list limit in preferences)`));
    }
  }
  return h("section", { class: "card" }, kids);
}

function render() {
  const out = [];
  if (!hasPerm) out.push(h("div", { class: "notice" }, h("div", {}, "Site access hasn't been granted yet. It's needed to read pages and request headers."),
    h("button", { onclick: async () => { hasPerm = await api.permissions.request({ origins: ["<all_urls>"] }); render(); } }, "Grant access")));
  if (!st.configured.archive && !st.configured.pending && !st.configured.check)
    out.push(h("div", { class: "notice" }, h("div", {}, "No server configured yet."), h("button", { onclick: () => { api.runtime.openOptionsPage(); window.close(); } }, "Open preferences")));
  else if (!st.configured.archive) out.push(errorBox("Archive endpoint is not configured. Check the preferences."));
  out.push(currentCard(), pendingCard());
  $app.replaceChildren(...out);
}

init().catch(e => { $app.replaceChildren(errorBox("Popup error: " + e.message)); });
