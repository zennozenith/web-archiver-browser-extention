"use strict";
const $ = (id) => document.getElementById(id);
const STALE_MS = 60 * 1000;
let currentTab = null;
let cache = null;
let tabState = null;

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

/* ---------- archive status of the current page ---------- */
function renderStatus() {
  const box = $("archInfo");
  box.textContent = "";
  const btn = $("archiveNow");
  const st = tabState;
  const add = (cls, text) => {
    const d = document.createElement("div");
    d.className = "line " + cls;
    d.textContent = text;
    box.appendChild(d);
  };
  btn.textContent = st && st.archived ? "Archive new version" : "Archive this page";
  if (!st) return;

  if (st.checking) {
    add("", "Checking archive…");
  } else if (st.checkError) {
    add("err", "Status check failed: " + st.checkError);
  } else if (st.archived) {
    add("ok", `Archived · ${st.count} version${st.count === 1 ? "" : "s"}`);
    const ul = document.createElement("ul");
    ul.className = "versions";
    for (const v of (st.versions || []).slice(0, 10)) {
      const li = document.createElement("li");
      const label = (v.at ? new Date(v.at).toLocaleString() : "unknown time") + (v.id != null ? "  #" + v.id : "");
      if (v.link && /^https?:/i.test(v.link)) {
        const a = document.createElement("a");
        a.href = v.link;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = label;
        li.appendChild(a);
      } else {
        li.append(label);
      }
      if (v.at) {
        const s = document.createElement("span");
        s.className = "ago";
        s.textContent = "  (" + ago(v.at) + ")";
        li.appendChild(s);
      }
      ul.appendChild(li);
    }
    box.appendChild(ul);
  } else if (st.checked) {
    add("", "Not archived yet");
  }
  if (st.lastError) add("err", "Archive failed: " + st.lastError);
}

/* ---------- pending list ---------- */
function renderMeta() {
  const meta = $("meta");
  meta.textContent = "";
  if (!cache || cache.configured === false) {
    meta.textContent = cache ? "Set the server URL in preferences (⚙)." : "Loading…";
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
      await browser.runtime.sendMessage({ type: "openPending", item });
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
    await browser.runtime.sendMessage({ type: "refresh" });
  } catch (e) {
    cache = { ...(cache || { items: [] }), configured: true, error: e.message };
    renderList();
  } finally {
    b.classList.remove("spin");
  }
}

async function recheck() {
  if (!currentTab) return;
  const b = $("recheck");
  b.classList.add("spin");
  try {
    await browser.runtime.sendMessage({ type: "check", tabId: currentTab.id });
  } catch (e) {
    tabState = { ...(tabState || {}), checking: false, checked: true, checkError: e.message };
    renderStatus();
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
    const r = await browser.runtime.sendMessage({ type: "archiveCurrent", tabId: currentTab && currentTab.id });
    if (r && r.ok) {
      st.className = "status ok";
      st.textContent = "Archived ✓";
    } else {
      // Details are shown in the status block above (from the stored error)
      st.className = "status err";
      st.textContent = "Failed ✗";
      if (!tabState || !tabState.lastError) {
        tabState = { ...(tabState || {}), lastError: (r && r.error) || "unknown error" };
        renderStatus();
      }
    }
  } catch (e) {
    st.className = "status err";
    st.textContent = "Failed ✗";
    tabState = { ...(tabState || {}), lastError: e.message };
    renderStatus();
  }
  btn.disabled = false;
}

async function init() {
  [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
  let supported = false;
  if (currentTab) {
    $("curTitle").textContent = currentTab.title || "(untitled)";
    $("curUrl").textContent = currentTab.url || "";
    supported = /^(https?|file|ftp):/i.test(currentTab.url || "");
    if (!supported) {
      $("archiveNow").disabled = true;
      $("curStatus").textContent = "This page type can't be archived.";
    }
  }

  ({ pendingCache: cache } = await browser.storage.local.get({ pendingCache: null }));
  renderList();
  if (!cache || !cache.fetchedAt || Date.now() - cache.fetchedAt > STALE_MS) refresh();

  if (currentTab) {
    const k = "st:" + currentTab.id;
    tabState = (await browser.storage.session.get(k))[k] || null;
    renderStatus();
    // No (matching) status yet, e.g. the tab was loaded before the extension started
    if (supported && (!tabState || (!tabState.checked && !tabState.checking) || tabState.url !== currentTab.url)) {
      recheck();
    }
  }
}

$("archiveNow").addEventListener("click", archiveNow);
$("refresh").addEventListener("click", refresh);
$("recheck").addEventListener("click", recheck);
$("prefs").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});
$("filter").addEventListener("input", renderList);

// Live updates: pending list (local) and this tab's archive status/errors (session)
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.pendingCache) {
    cache = changes.pendingCache.newValue;
    renderList();
  }
  if (area === "session" && currentTab && changes["st:" + currentTab.id]) {
    tabState = changes["st:" + currentTab.id].newValue || null;
    renderStatus();
  }
});
setInterval(() => {
  renderMeta();
  renderStatus();
}, 30000);

init();
