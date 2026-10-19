#!/usr/bin/env bun
/**
 * Web archiver self-hosted archive server (Bun + bun:sqlite, zero dependencies).
 *
 *   GET    /                         Web UI (index.html)
 *   POST   /api/archive              multipart/form-data: html, screenshot, metadata (+ optional url, title)
 *   GET    /api/check?url=           Archive status + version history for one URL (alias: /api/status)
 *   GET    /api/archives             All archived URLs, grouped, with versions
 *   DELETE /api/archives?url=        Delete every version of a URL
 *   DELETE /api/archives/:id         Delete a single version
 *   GET    /api/pending              Pending queue -> { items, total }
 *   POST   /api/pending              { url, title? } add to the queue
 *   DELETE /api/pending/:id          Remove from the queue
 *   POST   /api/pending/complete     { id?, url? } mark done (extension compatible)
 *   GET    /api/health               Stats
 *   GET    /archives/:folder/:file   page.html | screenshot.[png|jpg] | metadata.json
 *
 * Env: PORT (3000), HOST (127.0.0.1), DATA_DIR (script dir), MAX_BODY_MB (256)
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_DIR = resolve(process.env.DATA_DIR ?? import.meta.dir);
const ARCHIVES_DIR = join(DATA_DIR, "archives");
const MAX_BODY = Number(process.env.MAX_BODY_MB ?? 256) * 1024 * 1024;

mkdirSync(ARCHIVES_DIR, { recursive: true });

// ---------- Database ----------

const db = new Database(join(DATA_DIR, "db.sqlite"), { create: true });
db.run(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS archives (
    id             TEXT PRIMARY KEY,
    url            TEXT NOT NULL,
    title          TEXT NOT NULL,
    folder         TEXT NOT NULL UNIQUE,
    archived_at    TEXT NOT NULL,
    html_size      INTEGER NOT NULL DEFAULT 0,
    has_screenshot INTEGER NOT NULL DEFAULT 0,
    metadata       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_archives_url ON archives (url, archived_at DESC);
  CREATE TABLE IF NOT EXISTS pending (
    id       TEXT PRIMARY KEY,
    url      TEXT NOT NULL UNIQUE,
    title    TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL
  );
`);

type ArchiveRow = {
  id: string;
  url: string;
  title: string;
  folder: string;
  archived_at: string;
  html_size: number;
  has_screenshot: number;
};
type PendingRow = { id: string; url: string; title: string; added_at: string };

const toVersion = (r: ArchiveRow) => ({
  id: r.id,
  archivedAt: r.archived_at,
  url: r.url,
  folder: r.folder,
  title: r.title,
  htmlSize: r.html_size,
  hasScreenshot: !!r.has_screenshot,
});

const toPending = (r: PendingRow) => ({
  id: r.id,
  url: r.url,
  title: r.title,
  addedAt: r.added_at,
});

const sql = {
  allArchives: db.query<ArchiveRow, []>("SELECT * FROM archives ORDER BY archived_at DESC"),
  byUrl: db.query<ArchiveRow, [string]>(
    "SELECT * FROM archives WHERE url = ? ORDER BY archived_at DESC",
  ),
  byId: db.query<ArchiveRow, [string]>("SELECT * FROM archives WHERE id = ?"),
  insertArchive: db.query(
    `INSERT INTO archives (id, url, title, folder, archived_at, html_size, has_screenshot, metadata)
     VALUES ($id, $url, $title, $folder, $archivedAt, $htmlSize, $hasScreenshot, $metadata)`,
  ),
  deleteArchive: db.query("DELETE FROM archives WHERE id = ?"),
  allPending: db.query<PendingRow, []>("SELECT * FROM pending ORDER BY added_at DESC"),
  pendingById: db.query<PendingRow, [string]>("SELECT * FROM pending WHERE id = ?"),
  pendingByUrl: db.query<PendingRow, [string]>("SELECT * FROM pending WHERE url = ?"),
  insertPending: db.query(
    "INSERT OR IGNORE INTO pending (id, url, title, added_at) VALUES (?, ?, ?, ?)",
  ),
  deletePendingById: db.query("DELETE FROM pending WHERE id = ?"),
  deletePendingByUrl: db.query("DELETE FROM pending WHERE url = ?"),
  count: db.query<{ urls: number; versions: number; pending: number }, []>(
    `SELECT (SELECT COUNT(DISTINCT url) FROM archives) AS urls,
            (SELECT COUNT(*) FROM archives) AS versions,
            (SELECT COUNT(*) FROM pending) AS pending`,
  ),
};

// ---------- Helpers ----------

const json = (data: unknown, status = 200) => Response.json(data, { status });

function normalizeUrl(raw: unknown): string | null {
  try {
    const u = new URL(String(raw ?? "").trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function removeFolder(folder: string) {
  const dir = resolve(ARCHIVES_DIR, folder);
  if (dir.startsWith(ARCHIVES_DIR + sep)) rmSync(dir, { recursive: true, force: true });
}

function removeVersions(rows: ArchiveRow[]) {
  for (const r of rows) {
    removeFolder(r.folder);
    sql.deleteArchive.run(r.id);
  }
  return rows.length;
}

/** Index archive folders already on disk (e.g. from the old Node server) that aren't in the DB yet. */
function importExistingFolders() {
  const known = new Set(
    db
      .query<{ folder: string }, []>("SELECT folder FROM archives")
      .all()
      .map((r) => r.folder),
  );
  let imported = 0;
  for (const folder of readdirSync(ARCHIVES_DIR)) {
    if (known.has(folder)) continue;
    const dir = join(ARCHIVES_DIR, folder);
    try {
      const meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf-8"));
      const url = normalizeUrl(meta.url);
      if (!url) continue;
      const size = (name: string) => {
        try {
          return statSync(join(dir, name)).size;
        } catch {
          return 0;
        }
      };
      sql.insertArchive.run({
        $id: crypto.randomUUID(),
        $url: url,
        $title: meta.title || url,
        $folder: folder,
        $archivedAt: meta.capturedAt || statSync(dir).mtime.toISOString(),
        $htmlSize: size("page.html"),
        $hasScreenshot: size("screenshot.png") > 0 ? 1 : 0,
        $metadata: JSON.stringify(meta),
      });
      imported++;
    } catch {
      /* not an archive folder */
    }
  }
  if (imported) console.log(`[Import] Indexed ${imported} existing archive folder(s)`);
}

// ---------- Handlers ----------

async function handleArchive(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Invalid body. Expected multipart/form-data." }, 400);
  }

  // Accept both field names (html) and file names (page.html).
  const pick = (names: string[]): string | File | null => {
    for (const n of names) {
      const v = form.get(n);
      if (v != null) return v;
    }
    for (const [, v] of form) if (typeof v !== "string" && names.includes(v.name)) return v;
    return null;
  };
  const asText = async (v: string | File | null) =>
    v == null ? "" : typeof v === "string" ? v : v.text();
  const asBytes = async (v: string | File | null) =>
    v == null
      ? null
      : typeof v === "string"
        ? new TextEncoder().encode(v)
        : new Uint8Array(await v.arrayBuffer());

  const html = await asBytes(pick(["html", "page.html"]));
  const screenshot = await asBytes(pick(["screenshot", "screenshot.png"])); //todo: screenshot.jpg
  const metaText = await asText(pick(["metadata", "json", "metadata.json"]));
  let meta: Record<string, any> | null = null;
  try {
    meta = metaText ? JSON.parse(metaText) : null;
  } catch {
    /* ignore malformed metadata */
  }

  const url = normalizeUrl((await asText(form.get("url"))) || meta?.url);
  if (!url) return json({ error: "Missing or invalid target URL in archive request" }, 400);
  const title = (await asText(form.get("title"))) || meta?.title || url;

  const now = new Date();
  const host = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  const folder = `${now.toISOString().replace(/[:.]/g, "-")}_${host}`;
  const dir = join(ARCHIVES_DIR, folder);
  mkdirSync(dir, { recursive: true });

  if (html) await Bun.write(join(dir, "page.html"), html);
  if (screenshot) await Bun.write(join(dir, "screenshot.png"), screenshot);
  if (meta) await Bun.write(join(dir, "metadata.json"), JSON.stringify(meta, null, 2));

  const id = crypto.randomUUID();
  db.transaction(() => {
    sql.insertArchive.run({
      $id: id,
      $url: url,
      $title: title,
      $folder: folder,
      $archivedAt: now.toISOString(),
      $htmlSize: html?.length ?? 0,
      $hasScreenshot: screenshot ? 1 : 0,
      $metadata: meta ? JSON.stringify(meta) : null,
    });
    sql.deletePendingByUrl.run(url);
  })();

  const versionCount = sql.byUrl.all(url).length;
  console.log(`[Archived] ✓ "${title}" -> ${folder} (${versionCount} versions)`);
  return json({
    success: true,
    message: "Page archived successfully",
    id,
    url,
    archivedAt: now.toISOString(),
    versionCount,
    folder,
  });
}

function handleCheck(searchParams: URLSearchParams): Response {
  const raw = searchParams.get("url");
  if (!raw) return json({ error: 'Missing "url" query parameter' }, 400);
  const versions = sql.byUrl.all(normalizeUrl(raw) ?? raw);
  return json({
    archived: versions.length > 0,
    count: versions.length,
    lastArchivedAt: versions[0]?.archived_at ?? null,
    versions: versions.map(toVersion),
  });
}

function handleListArchives(): Response {
  const groups = new Map<string, ArchiveRow[]>();
  for (const r of sql.allArchives.all()) {
    const group = groups.get(r.url);
    if (group !== undefined) {
      group.push(r);
    } else {
      groups.set(r.url, [r]);
    }
  }
  const items = [...groups].map(([url, rows]) => ({
    url,
    title: rows[0].title,
    count: rows.length,
    lastArchived: rows[0].archived_at,
    versions: rows.map(toVersion),
  }));
  return json({ items, total: items.length });
}

async function handleAddPending(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const url = normalizeUrl(body?.url);
  if (!url) return json({ error: "A valid http(s) URL is required" }, 400);
  sql.insertPending.run(
    crypto.randomUUID(),
    url,
    String(body?.title ?? "").trim(),
    new Date().toISOString(),
  );
  return json({ success: true, item: toPending(sql.pendingByUrl.get(url)!) }, 201);
}

async function handleCompletePending(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON payload" }, 400);
  if (body.id) sql.deletePendingById.run(String(body.id));
  if (body.url) sql.deletePendingByUrl.run(normalizeUrl(body.url) ?? String(body.url));
  return json({ success: true, remaining: sql.allPending.all().length });
}

async function serveArchiveFile(folder: string, file: string): Promise<Response> {
  const f = Bun.file(join(ARCHIVES_DIR, folder, file));
  if (!(await f.exists())) return json({ error: "File not found" }, 404);
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  // Archived pages are untrusted: no scripts, no same-origin access to this server's API.
  if (file === "page.html") headers["Content-Security-Policy"] = "sandbox";
  return new Response(f, { headers });
}

// ---------- Router ----------

async function route(req: Request): Promise<Response> {
  const { pathname, searchParams } = new URL(req.url);
  const path = pathname.replace(/\/+$/, "") || "/";
  const m = req.method;
  let x: RegExpMatchArray | null;

  if (m === "GET" && path === "/") {
    return new Response(Bun.file(join(import.meta.dir, "index.html")));
  }
  if (m === "GET" && path === "/api/health") {
    return json({ status: "online", ...sql.count.get() });
  }

  if (m === "GET" && (path === "/api/check" || path === "/api/status")) {
    return handleCheck(searchParams);
  }

  if (m === "POST" && path === "/api/archive") {
    return handleArchive(req);
  }

  if (m === "GET" && path === "/api/archives") {
    return handleListArchives();
  }

  if (m === "DELETE" && path === "/api/archives") {
    const raw = searchParams.get("url");
    if (!raw) return json({ error: 'Missing "url" query parameter' }, 400);
    const removed = removeVersions(sql.byUrl.all(normalizeUrl(raw) ?? raw));
    return removed ? json({ success: true, removed }) : json({ error: "URL not archived" }, 404);
  }

  if (m === "DELETE" && (x = path.match(/^\/api\/archives\/([^/]+)$/))) {
    const row = sql.byId.get(x[1]);
    if (!row) return json({ error: "Version not found" }, 404);
    removeVersions([row]);
    return json({ success: true, remaining: sql.byUrl.all(row.url).length });
  }

  if (m === "GET" && path === "/api/pending") {
    const items = sql.allPending.all().map(toPending);
    return json({ items, total: items.length });
  }

  if (m === "POST" && path === "/api/pending") {
    return handleAddPending(req);
  }

  if (m === "POST" && path === "/api/pending/complete") {
    return handleCompletePending(req);
  }

  if (m === "DELETE" && (x = path.match(/^\/api\/pending\/([^/]+)$/))) {
    if (!sql.pendingById.get(x[1])) return json({ error: "Pending item not found" }, 404);
    sql.deletePendingById.run(x[1]);
    return json({ success: true });
  }

  if (
    m === "GET" &&
    (x = path.match(/^\/archives\/([\w.-]+)\/(page\.html|screenshot\.png|metadata\.json)$/))
  ) {
    return serveArchiveFile(x[1], x[2]);
  }

  return json({ error: `Endpoint not found: ${path}` }, 404);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
};

importExistingFolders();

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  maxRequestBodySize: MAX_BODY,
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const res = await route(req);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    console.log(
      `[${new Date().toLocaleTimeString()}] ${req.method} ${new URL(req.url).pathname} ${res.status}`,
    );
    return res;
  },
  error(err) {
    console.error(err);
    return json({ error: err.message }, 500);
  },
});

console.log(`🚀 Web archive server: ${server.url}`);
console.log(`   Archives: ${ARCHIVES_DIR}`);
console.log(`   Database: ${join(DATA_DIR, "db.sqlite")}`);

const shutdown = () => {
  server.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
