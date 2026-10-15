"use strict";
const $ = (id) => document.getElementById(id);
const STALE_MS = 60 * 1000;
let currentTab = null;
let cache = null;

const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

function renderMeta() {
  const meta = $("meta");
  meta.textContent = "";
  if (!cache || cache.configured === false) {
    meta.textContent = cache ? "Set the pending list URL in preferences (⚙)." : "Loading…";
    return;
  }
  const span = document.createElement("span");
  span.textContent = "Updated " + ago(cache.fetchedAt);
  meta.appendChild(span);
  if (cache.error) {
    const e = document.createElement("div");
    e.className = "err";
    e.textContent = "Refresh failed: " + cache.error;
    meta.appendChild(e);
  }
}

function renderList() {
  const ul = $("list");
  ul.textContent = "";
  renderMeta();
  const items = (cache && cache.items) || [];
  $("count").textContent = items.length ? "(" + items.length + ")" : "";
  const q = $("filter").value.trim().toLowerCase();
  const shown = q ? items.filter((i) => (i.title + " " + i.url).toLowerCase().includes(q)) : items;

  if (!shown.length) {
    if (cache && cache.configured !== false) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = items.length ? "No matches" : "Nothing pending 🎉";
      ul.appendChild(li);
    }
    return;
  }
  for (const item of shown) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = item.title || host(item.url);
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = item.url;
    info.title = item.url;
    info.append(title, url);

    const btn = document.createElement("button");
    btn.textContent = "Open & archive";
    btn.title = "Open in a new tab, then prompt to archive once it has loaded";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await chrome.runtime.sendMessage({ type: "openPending", item });
      window.close();
    });
    li.append(info, btn);
    ul.appendChild(li);
  }
}

async function refresh() {
  const b = $("refresh");
  b.classList.add("spin");
  try {
    await chrome.runtime.sendMessage({ type: "refresh" });
  } finally {
    b.classList.remove("spin");
  }
}

async function archiveNow() {
  const btn = $("archiveNow"), st = $("curStatus");
  btn.disabled = true;
  st.className = "status";
  st.textContent = "Archiving…";
  try {
    const r = await chrome.runtime.sendMessage({ type: "archiveCurrent", tabId: currentTab && currentTab.id });
    if (r && r.ok) {
      st.className = "status ok";
      st.textContent = "Archived ✓";
    } else {
      st.className = "status err";
      st.textContent = "Failed: " + ((r && r.error) || "unknown error");
    }
  } catch (e) {
    st.className = "status err";
    st.textContent = "Failed: " + e.message;
  }
  btn.disabled = false;
}

async function init() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (currentTab) {
    $("curTitle").textContent = currentTab.title || "(untitled)";
    $("curUrl").textContent = currentTab.url || "";
    if (!/^(https?|file|ftp):/i.test(currentTab.url || "")) {
      $("archiveNow").disabled = true;
      $("curStatus").textContent = "This page type can't be archived.";
    }
  }

  ({ pendingCache: cache } = await chrome.storage.local.get({ pendingCache: null }));
  renderList();
  if (!cache || !cache.fetchedAt || Date.now() - cache.fetchedAt > STALE_MS) refresh();
}

$("archiveNow").addEventListener("click", archiveNow);
$("refresh").addEventListener("click", refresh);
$("prefs").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
$("filter").addEventListener("input", renderList);

// Live-update when the background refreshes the list (periodic, manual, or after archiving)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.pendingCache) {
    cache = changes.pendingCache.newValue;
    renderList();
  }
});
setInterval(renderMeta, 30000);

init();
