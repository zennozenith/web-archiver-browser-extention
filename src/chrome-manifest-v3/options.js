"use strict";
const DEFAULTS = {
  serverUrl: "", authMode: "none", authHeaderName: "X-API-Key", authToken: "",
  includeHtml: true, includeRequestHeaders: true, includeResponseHeaders: true,
  includeCookies: false, includeScreenshot: false,
  redactHeaders: "authorization, proxy-authorization", tags: "", timeoutSec: 30
};
const $ = (id) => document.getElementById(id);
const status = (msg, cls = "") => { $("status").textContent = msg; $("status").className = cls; };

function toggleAuthRows() {
  const m = $("authMode").value;
  $("customName").style.display = m === "custom" ? "" : "none";
  $("tokenRow").style.display = m === "none" ? "none" : "";
}

function readForm() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const el = $(k);
    out[k] = el.type === "checkbox" ? el.checked
           : el.type === "number" ? Number(el.value) || DEFAULTS[k]
           : el.value.trim();
  }
  return out;
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) {
    const el = $(k);
    if (el.type === "checkbox") el.checked = s[k]; else el.value = s[k];
  }
  toggleAuthRows();
}

$("authMode").addEventListener("change", toggleAuthRows);

// Must request optional permission from a user gesture (the click itself)
$("includeCookies").addEventListener("change", async (e) => {
  if (e.target.checked) {
    const granted = await chrome.permissions.request({ permissions: ["cookies"] });
    if (!granted) { e.target.checked = false; status("Cookie permission denied.", "err"); }
  }
});

$("save").addEventListener("click", async () => {
  const s = readForm();
  if (s.serverUrl) {
    try { new URL(s.serverUrl); } catch { return status("Invalid server URL.", "err"); }
  }
  await chrome.storage.local.set(s);
  status("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  const s = readForm();
  if (!s.serverUrl) return status("Enter a server URL first.", "err");
  const headers = {};
  if (s.authToken) {
    if (s.authMode === "bearer") headers["Authorization"] = "Bearer " + s.authToken;
    else if (s.authMode === "custom" && s.authHeaderName) headers[s.authHeaderName] = s.authToken;
  }
  status("Testing…");
  try {
    const res = await fetch(s.serverUrl, { method: "GET", headers });
    // Any HTTP response proves the server is reachable; 405 is common for POST-only endpoints.
    const note = res.status === 405 ? " (POST-only endpoint – reachable)" : "";
    status(`Reached server: HTTP ${res.status}${note}`, res.status < 500 ? "ok" : "err");
  } catch (e) {
    status("Connection failed: " + e.message, "err");
  }
});

load();
