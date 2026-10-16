"use strict";
// Shared by background, popup and options. `browser` (Firefox) and `chrome` both support promises in MV3.
const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  serverUrl: "",
  archiveUrl: "",   // override; empty => derived from serverUrl
  pendingUrl: "",
  checkUrl: "",
  apiToken: "",
  includeScreenshot: true,
  screenshotFormat: "png",     // png | jpeg
  jpegQuality: 85,
  fullPageScreenshot: false,   // Firefox only
  includeSensitiveHeaders: false,
  includeResponseHeaders: true,
  autoCheck: true,
  pendingRefreshMinutes: 5,    // 0 = off
  pendingLimit: 200,
  directArchiveMode: "prompt", // prompt | auto
  directArchiveDelaySec: 2,
  requestTimeoutSec: 120
};

async function getSettings() {
  const { settings } = await api.storage.local.get({ settings: {} });
  return { ...DEFAULTS, ...settings };
}

function deriveEndpoints(s) {
  const base = String(s.serverUrl || "").trim().replace(/\/+$/, "");
  const derived = base
    ? { archive: `${base}/api/archive`, pending: `${base}/api/pending`, check: `${base}/api/check` }
    : { archive: "", pending: "", check: "" };
  const out = { derived, source: {} };
  for (const k of ["archive", "pending", "check"]) {
    const o = String(s[k + "Url"] || "").trim();
    out[k] = o || derived[k];
    out.source[k] = o ? "override" : derived[k] ? "derived" : "none";
  }
  return out;
}

/* ---------- session storage with in-memory fallback ---------- */
const _mem = new Map();
async function sget(key) {
  if (api.storage.session) return (await api.storage.session.get(key))[key];
  return _mem.get(key);
}
async function sset(key, val) {
  if (api.storage.session) await api.storage.session.set({ [key]: val });
  else _mem.set(key, val);
}
async function sdel(...keys) {
  if (api.storage.session) await api.storage.session.remove(keys);
  else keys.forEach(k => _mem.delete(k));
}

/* ---------- HTTP ---------- */
async function request(url, { method = "GET", body, headers = {}, token, timeoutMs = 30000 } = {}) {
  try { new URL(url); } catch { throw new Error(`Invalid URL: "${url}"`); }
  const h = { Accept: "application/json", ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetch(url, { method, body, headers: h, signal: ctrl.signal, cache: "no-store", credentials: "omit" });
    text = await res.text();
  } catch (e) {
    throw new Error(e.name === "AbortError"
      ? `Request timed out after ${Math.round(timeoutMs / 1000)}s (${url})`
      : `Cannot reach server at ${url}: ${e.message}`);
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const m = data && (data.error || data.message || data.detail);
    const msg = m ? (typeof m === "string" ? m : JSON.stringify(m)) : (text || res.statusText).slice(0, 300);
    throw new Error(`Server error ${res.status}: ${msg}`);
  }
  return data ?? text;
}

/* ---------- helpers ---------- */
const isHttp = u => /^https?:\/\//i.test(u || "");
const isArchivable = isHttp;

function normalizeUrl(u) {
  try { const x = new URL(u); x.hash = ""; return x.toString(); } catch { return u; }
}
function buildCheckUrl(checkUrl, pageUrl) {
  if (checkUrl.includes("{url}")) return checkUrl.replace("{url}", encodeURIComponent(pageUrl));
  const u = new URL(checkUrl);
  u.searchParams.set("url", pageUrl);
  return u.toString();
}

function toDate(t) {
  if (t == null || t === "") return null;
  if (typeof t === "number") return new Date(t < 1e12 ? t * 1000 : t);
  if (/^\d+(\.\d+)?$/.test(String(t))) return toDate(Number(t));
  const d = new Date(t);
  return isNaN(d) ? null : d;
}
const formatTime = t => { const d = toDate(t); return d ? d.toLocaleString() : String(t ?? "unknown time"); };
function timeAgo(t) {
  const d = toDate(t); if (!d) return "";
  const s = Math.max(0, Math.round((Date.now() - d) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const dd = Math.round(h / 24); if (dd < 30) return `${dd}d ago`;
  const mo = Math.round(dd / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(dd / 365)}y ago`;
}

// Tolerant parsers: accept several common response shapes.
function normalizeCheck(d) {
  if (!d || typeof d !== "object") return { archived: false, count: 0, versions: [] };
  let list = d.versions || d.snapshots || d.archives || d.items || [];
  if (!Array.isArray(list)) list = [];
  let versions = list.map(v => (typeof v === "object" && v)
    ? { id: v.id ?? v.version ?? null, time: v.archivedAt ?? v.archived_at ?? v.created_at ?? v.createdAt ?? v.timestamp ?? v.time ?? v.date ?? null, url: v.url ?? v.link ?? null }
    : { id: null, time: v, url: null });
  versions.sort((a, b) => (toDate(b.time) || 0) - (toDate(a.time) || 0));
  const count = Number(d.count ?? d.versionCount ?? d.version_count ?? d.versions_count ?? versions.length) || 0;
  const archived = Boolean(d.archived ?? d.exists ?? d.found ?? count > 0);
  const last = d.lastArchivedAt ?? d.last_archived_at ?? d.latest ?? versions[0]?.time ?? null;
  return { archived, count, versions, last };
}
function normalizePending(d) {
  let arr = Array.isArray(d) ? d : (d && (d.urls || d.items || d.pending || d.results || d.data)) || [];
  if (!Array.isArray(arr)) arr = [];
  return arr.map(x => typeof x === "string" ? { url: x } : {
    url: x.url || x.href || x.link,
    title: x.title || x.name || "",
    addedAt: x.addedAt ?? x.added_at ?? x.created_at ?? x.createdAt ?? null
  }).filter(x => isHttp(x.url));
}

async function sha256(x) {
  const buf = typeof x === "string" ? new TextEncoder().encode(x) : await x.arrayBuffer();
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
