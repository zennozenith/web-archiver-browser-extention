"use strict";
const $ = (s) => document.querySelector(s);
const inputs = [...document.querySelectorAll("[data-key]")];

function readForm() {
  const o = {};
  for (const el of inputs) {
    const k = el.dataset.key;
    o[k] =
      el.type === "checkbox"
        ? el.checked
        : el.type === "number"
          ? el.value === ""
            ? DEFAULTS[k]
            : Number(el.value)
          : el.value.trim();
  }
  return o;
}
function fillForm(s) {
  for (const el of inputs) {
    const v = s[el.dataset.key];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v ?? "";
  }
}
function preview() {
  const ep = deriveEndpoints(readForm());
  for (const k of ["archive", "pending", "check"])
    document.querySelector(`[data-key=${k}Url]`).placeholder =
      ep.derived[k] || "(derived from server URL)";
  const tb = $("#effective tbody");
  tb.replaceChildren();
  for (const k of ["archive", "pending", "check"]) {
    const tr = document.createElement("tr");
    for (const t of [k, ep[k] || "—", ep.source[k]]) {
      const td = document.createElement("td");
      td.textContent = t;
      tr.append(td);
    }
    tb.append(tr);
  }
}
function validate(s) {
  for (const k of ["serverUrl", "archiveUrl", "pendingUrl"]) {
    if (s[k]) {
      try {
        const u = new URL(s[k]);
        if (!/^https?:$/.test(u.protocol)) throw 0;
      } catch {
        return `${k} must be a valid http(s) URL`;
      }
    }
  }
  if (s.checkUrl) {
    try {
      new URL(s.checkUrl.replace("{url}", "x"));
    } catch {
      return "checkUrl must be a valid URL";
    }
  }
  return null;
}
function msg(el, text, cls) {
  el.textContent = text;
  el.className = cls || "";
}

async function save() {
  const s = readForm(),
    err = validate(s);
  if (err) return msg($("#save-result"), err, "err");
  await api.storage.local.set({ settings: s });
  msg($("#save-result"), "Saved ✓", "ok");
  setTimeout(() => msg($("#save-result"), ""), 3000);
}

async function test() {
  const s = readForm(),
    ep = deriveEndpoints(s),
    out = $("#test-result");
  const err = validate(s);
  if (err) return msg(out, err, "err");
  msg(out, "Testing…");
  const lines = [];
  let bad = false;
  if (ep.pending) {
    try {
      const d = await request(ep.pending, { token: s.apiToken, timeoutMs: 15000 });
      lines.push(`pending ✓ (${normalizePending(d).length} items)`);
    } catch (e) {
      bad = true;
      lines.push("pending ✗ " + e.message);
    }
  } else lines.push("pending: not configured");
  if (ep.check) {
    try {
      const d = await request(buildCheckUrl(ep.check, "https://example.com/"), {
        token: s.apiToken,
        timeoutMs: 15000,
      });
      lines.push(`check ✓ (${typeof d === "object" ? "JSON ok" : "non-JSON response!"})`);
    } catch (e) {
      bad = true;
      lines.push("check ✗ " + e.message);
    }
  } else lines.push("check: not configured");
  lines.push(
    ep.archive
      ? `archive: ${ep.archive} (not tested — POST creates data)`
      : "archive: not configured",
  );
  msg(out, lines.join("\n"), bad ? "err" : "ok");
}

async function init() {
  fillForm(await getSettings());
  preview();
  inputs.forEach((el) => el.addEventListener("input", preview));
  $("#btn-save").onclick = save;
  $("#btn-test").onclick = test;
  try {
    const ok = await api.permissions.contains({ origins: ["<all_urls>"] });
    $("#perm").hidden = ok;
    $("#btn-perm").onclick = async () => {
      const g = await api.permissions.request({ origins: ["<all_urls>"] });
      $("#perm").hidden = g;
    };
  } catch {}
  try {
    const c = (await api.commands.getAll()).find((c) => c.name === "archive-page");
    $("#shortcut").textContent = c?.shortcut || "not set";
  } catch {
    $("#shortcut").textContent = "unknown";
  }
  $("#btn-shortcut").onclick = async () => {
    if (typeof api.commands.openShortcutSettings === "function")
      return api.commands.openShortcutSettings();
    const help = $("#shortcut-help");
    help.hidden = false;
    if (typeof api.tabs.captureTab === "function")
      help.textContent = "Open about:addons → gear icon → Manage Extension Shortcuts.";
    else {
      help.textContent = "Opening chrome://extensions/shortcuts …";
      api.tabs.create({ url: "chrome://extensions/shortcuts" });
    }
  };
}
init();
