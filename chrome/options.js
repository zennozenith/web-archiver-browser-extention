"use strict";
const DEFAULTS = {
  serverUrl: "",
  pendingUrl: "",
  refreshMinutes: 5,
  showBadge: true,
  promptAfterOpen: true,
  authMode: "none",
  authHeaderName: "X-API-Key",
  authToken: "",
  // includeHtml: true,
  includeRequestHeaders: true,
  includeResponseHeaders: true,
  includeCookies: false,
  includeScreenshot: false,
  redactHeaders: "authorization, proxy-authorization",
  tags: "",
  timeoutSec: 30,
};
const $ = (id) => document.getElementById(id);
const status = (msg, cls = "") => {
  $("status").textContent = msg;
  $("status").className = cls;
};

function toggleAuthRows() {
  const m = $("authMode").value;
  $("customName").style.display = m === "custom" ? "" : "none";
  $("tokenRow").style.display = m === "none" ? "none" : "";
}

function readForm() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const el = $(k);
    out[k] =
      el.type === "checkbox"
        ? el.checked
        : el.type === "number"
          ? Number(el.value) || DEFAULTS[k]
          : el.value.trim();
  }
  return out;
}

function authHeaders(s) {
  const h = {};
  if (s.authToken) {
    if (s.authMode === "bearer") h["Authorization"] = "Bearer " + s.authToken;
    else if (s.authMode === "custom" && s.authHeaderName) h[s.authHeaderName] = s.authToken;
  }
  return h;
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) {
    const el = $(k);
    if (el.type === "checkbox") el.checked = s[k];
    else el.value = s[k];
  }
  toggleAuthRows();
}

$("authMode").addEventListener("change", toggleAuthRows);

// Optional permissions must be requested from a user gesture (the click itself)
$("includeCookies").addEventListener("change", async (e) => {
  if (e.target.checked) {
    const granted = await chrome.permissions.request({ permissions: ["cookies"] });
    if (!granted) {
      e.target.checked = false;
      status("Cookie permission denied.", "err");
    }
  }
});

$("save").addEventListener("click", async () => {
  const s = readForm();
  for (const k of ["serverUrl", "pendingUrl"]) {
    if (s[k]) {
      try {
        new URL(s[k]);
      } catch {
        return status("Invalid URL in " + k + ".", "err");
      }
    }
  }
  s.refreshMinutes = Math.max(1, s.refreshMinutes);
  await chrome.storage.local.set(s);
  status("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  const s = readForm();
  if (!s.serverUrl) return status("Enter an archive endpoint URL first.", "err");
  status("Testing…");
  try {
    const res = await fetch(s.serverUrl, { method: "GET", headers: authHeaders(s) });
    // Any HTTP response proves the server is reachable; 405 is common for POST-only endpoints.
    const note = res.status === 405 ? " (POST-only endpoint – reachable)" : "";
    status(`Reached server: HTTP ${res.status}${note}`, res.status < 500 ? "ok" : "err");
  } catch (e) {
    status("Connection failed: " + e.message, "err");
  }
});

$("testPending").addEventListener("click", async () => {
  const s = readForm();
  if (!s.pendingUrl) return status("Enter a pending list URL first.", "err");
  status("Testing…");
  try {
    const res = await fetch(s.pendingUrl, {
      headers: { Accept: "application/json", ...authHeaders(s) },
    });
    if (!res.ok) return status(`Server responded HTTP ${res.status}`, "err");
    const data = await res.json();
    const arr = Array.isArray(data)
      ? data
      : data && (data.items || data.urls || data.pending || data.results || data.data);
    if (!Array.isArray(arr))
      return status("Reachable, but the response isn't a JSON array.", "err");
    status(`OK – ${arr.length} pending item(s).`, "ok");
  } catch (e) {
    status("Failed: " + e.message, "err");
  }
});

load();
