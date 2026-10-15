"use strict";
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

// Show the derived URLs as placeholders of the override fields
function updatePlaceholders() {
  const d = endpoints({ hostUrl: $("hostUrl").value.trim(), archiveUrl: "", pendingUrl: "", statusUrl: "" });
  $("archiveUrl").placeholder = d.archive || "(derived from server URL)";
  $("pendingUrl").placeholder = d.pending || "(derived from server URL)";
  $("statusUrl").placeholder = d.status || "(derived from server URL)";
}

async function load() {
  const s = await browser.storage.local.get(DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) {
    const el = $(k);
    if (el.type === "checkbox") el.checked = s[k];
    else el.value = s[k];
  }
  if (s.archiveUrl || s.pendingUrl || s.statusUrl) document.querySelector("details").open = true;
  toggleAuthRows();
  updatePlaceholders();
}

$("authMode").addEventListener("change", toggleAuthRows);
$("hostUrl").addEventListener("input", updatePlaceholders);

// Optional permissions must be requested from a user gesture (the click itself)
$("includeCookies").addEventListener("change", async (e) => {
  if (e.target.checked) {
    const granted = await browser.permissions.request({ permissions: ["cookies"] });
    if (!granted) {
      e.target.checked = false;
      status("Cookie permission denied.", "err");
    }
  }
});

$("save").addEventListener("click", async () => {
  const s = readForm();
  for (const k of ["hostUrl", "archiveUrl", "pendingUrl", "statusUrl"]) {
    if (s[k]) {
      try {
        new URL(s[k]);
      } catch {
        return status("Invalid URL in " + k + ".", "err");
      }
    }
  }
  s.refreshMinutes = Math.max(1, s.refreshMinutes);
  await browser.storage.local.set(s);
  status("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  const s = readForm();
  const ep = endpoints(s);
  if (!ep.archive) return status("Enter a server URL first.", "err");
  status("Testing " + ep.archive + " …");
  try {
    const res = await fetchT(ep.archive, { method: "GET", headers: authHeaders(s, false) }, s.timeoutSec);
    // Any HTTP response proves the server is reachable; 405 is common for POST-only endpoints.
    const note = res.status === 405 ? " (POST-only endpoint – reachable)" : "";
    status(`Reached server: HTTP ${res.status}${note}`, res.status < 500 ? "ok" : "err");
  } catch (e) {
    status("Connection failed: " + errMsg(e), "err");
  }
});

$("testPending").addEventListener("click", async () => {
  const s = readForm();
  const ep = endpoints(s);
  if (!ep.pending) return status("Enter a server URL first.", "err");
  status("Testing " + ep.pending + " …");
  try {
    const res = await fetchT(
      ep.pending,
      { headers: { Accept: "application/json", ...authHeaders(s, false) } },
      s.timeoutSec,
    );
    if (!res.ok) return status(await httpError(res), "err");
    const data = await res.json();
    const arr = Array.isArray(data)
      ? data
      : data && (data.items || data.urls || data.pending || data.results || data.data);
    if (!Array.isArray(arr)) return status("Reachable, but the response isn't a JSON array.", "err");
    status(`OK – ${arr.length} pending item(s).`, "ok");
  } catch (e) {
    status("Failed: " + errMsg(e), "err");
  }
});

$("testStatus").addEventListener("click", async () => {
  const s = readForm();
  const ep = endpoints(s);
  if (!ep.status) return status("Enter a server URL first.", "err");
  status("Testing " + ep.status + " …");
  try {
    const u = new URL(ep.status);
    u.searchParams.set("url", "https://example.com/");
    const res = await fetchT(
      u.href,
      { headers: { Accept: "application/json", ...authHeaders(s, false) } },
      s.timeoutSec,
    );
    if (res.status === 404) return status("OK – HTTP 404 (treated as 'not archived').", "ok");
    if (!res.ok) return status(await httpError(res), "err");
    await res.json();
    status("OK – status endpoint returned valid JSON.", "ok");
  } catch (e) {
    status("Failed: " + errMsg(e), "err");
  }
});

load();
