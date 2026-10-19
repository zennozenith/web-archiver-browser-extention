#!/usr/bin/env node

/**
 * Self-Hosted Archive Mock Server.
 * A zero-dependency Node.js HTTP server implementing all endpoints expected by the Myopic Archiver extension:
 *  - POST /api/archive          (Receives multipart/form-data: page.html, screenshot.png, metadata.json)
 *  - GET  /api/check?url=...    (Returns archival status & version history for a given URL)
 *  - GET  /api/pending          (Returns list of pending URLs to archive)
 *  - POST /api/pending/complete (Marks a pending URL as completed/removed)
 *
 * Saves captured archives to: ./archives/<timestamp>_<hostname>/
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;
const ARCHIVES_DIR = path.join(__dirname, "archives");

// Ensure archives storage directory exists
if (!fs.existsSync(ARCHIVES_DIR)) {
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
}

// In-memory pending queue with sample URLs
let pendingUrls = {
  items: [
    {
      id: "p-1",
      url: "https://en.wikipedia.org/wiki/Web_archiving",
      title: "Web Archiving - Wikipedia",
      addedAt: new Date(Date.now() - 3600000 * 2).toISOString(),
    },
    {
      id: "p-2",
      url: "https://news.ycombinator.com",
      title: "Hacker News",
      addedAt: new Date(Date.now() - 3600000 * 5).toISOString(),
    },
    {
      id: "p-3",
      url: "https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions",
      title: "MDN WebExtensions Documentation",
      addedAt: new Date(Date.now() - 3600000 * 24).toISOString(),
    },
  ],
  total: 3,
};

// In-memory archive registry: url -> Array of version objects
const archiveIndex = new Map();

/**
 * Basic multipart form parser for Node.js standard library.
 */
function parseMultipartFormData(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let start = 0;

  while (start < buffer.length) {
    const boundaryIndex = buffer.indexOf(boundaryBuffer, start);
    if (boundaryIndex === -1) break;

    const nextBoundaryIndex = buffer.indexOf(boundaryBuffer, boundaryIndex + boundaryBuffer.length);
    if (nextBoundaryIndex === -1) break;

    const partBuffer = buffer.subarray(boundaryIndex + boundaryBuffer.length, nextBoundaryIndex);
    const headerEndIndex = partBuffer.indexOf("\r\n\r\n");
    if (headerEndIndex !== -1) {
      const headerStr = partBuffer.subarray(0, headerEndIndex).toString("utf-8");
      let dataBuffer = partBuffer.subarray(headerEndIndex + 4);
      if (
        dataBuffer.length >= 2 &&
        dataBuffer[dataBuffer.length - 2] === 13 &&
        dataBuffer[dataBuffer.length - 1] === 10
      ) {
        dataBuffer = dataBuffer.subarray(0, dataBuffer.length - 2);
      }

      const nameMatch = headerStr.match(/name="([^"]+)"/);
      const filenameMatch = headerStr.match(/filename="([^"]+)"/);
      const contentTypeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

      if (nameMatch) {
        parts.push({
          name: nameMatch[1],
          filename: filenameMatch ? filenameMatch[1] : null,
          contentType: contentTypeMatch ? contentTypeMatch[1] : "application/octet-stream",
          data: dataBuffer,
        });
      }
    }
    start = nextBoundaryIndex;
  }
  return parts;
}

const server = http.createServer((req, res) => {
  // CORS Headers for browser extensions
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";

  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${pathname}`);

  // 1. GET /api/check or /api/status - Check if a URL has been archived
  if (req.method === "GET" && (pathname === "/api/check" || pathname === "/api/status")) {
    const targetUrl = parsedUrl.searchParams.get("url");
    if (!targetUrl) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
      return;
    }

    const versions = archiveIndex.get(targetUrl) || [];
    const archived = versions.length > 0;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        archived,
        count: versions.length,
        lastArchived: versions[0]?.archivedAt || null,
        versions: versions.map((v, i) => ({
          id: v.id,
          archivedAt: v.archivedAt,
          folder: v.folder,
        })),
      }),
    );
    return;
  }

  // 2. GET /api/pending - Return pending queue
  if (req.method === "GET" && pathname === "/api/pending") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(pendingUrls));
    return;
  }

  // 3. POST /api/pending/complete - Complete/dismiss a pending item
  if (req.method === "POST" && pathname === "/api/pending/complete") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const idToRemove = payload.id;
        const urlToRemove = payload.url;

        pendingUrls = pendingUrls.filter((item) => {
          if (idToRemove && item.id === idToRemove) return false;
          if (urlToRemove && item.url === urlToRemove) return false;
          return true;
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, remaining: pendingUrls.length }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON payload" }));
      }
    });
    return;
  }

  // 4. POST /api/archive - Main archive endpoint accepting multipart/form-data
  if (req.method === "POST" && pathname === "/api/archive") {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i);

    if (!boundaryMatch) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid Content-Type. Expected multipart/form-data with boundary.",
        }),
      );
      return;
    }

    let boundary = boundaryMatch[1].trim();
    if (boundary.startsWith('"') && boundary.endsWith('"')) {
      boundary = boundary.slice(1, -1);
    }
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        const parts = parseMultipartFormData(buffer, boundary);

        let targetUrl = "";
        let targetTitle = "";
        let htmlBuffer = null;
        let screenshotBuffer = null;
        let metadataJson = null;

        for (const part of parts) {
          if (part.name === "url") targetUrl = part.data.toString("utf-8");
          else if (part.name === "title") targetTitle = part.data.toString("utf-8");
          else if (part.name === "html") htmlBuffer = part.data;
          else if (part.name === "screenshot") screenshotBuffer = part.data;
          else if (part.name === "metadata" || part.name === "json") {
            try {
              metadataJson = JSON.parse(part.data.toString("utf-8"));
              if (!targetUrl && metadataJson.url) targetUrl = metadataJson.url;
              if (!targetTitle && metadataJson.title) targetTitle = metadataJson.title;
            } catch {
              // fallback
            }
          }
        }

        if (!targetUrl) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing target URL in archive request" }));
          return;
        }

        // Save archive to disk
        const now = new Date();
        const safeDomain = new URL(targetUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
        const folderName = `${now.toISOString().replace(/[:.]/g, "-")}_${safeDomain}`;
        const archivePath = path.join(ARCHIVES_DIR, folderName);

        fs.mkdirSync(archivePath, { recursive: true });

        if (htmlBuffer) {
          fs.writeFileSync(path.join(archivePath, "page.html"), htmlBuffer);
        }
        if (screenshotBuffer) {
          fs.writeFileSync(path.join(archivePath, "screenshot.png"), screenshotBuffer);
        }
        if (metadataJson) {
          fs.writeFileSync(
            path.join(archivePath, "metadata.json"),
            JSON.stringify(metadataJson, null, 2),
          );
        }

        // Register version in index
        const versionId = `v-${Date.now()}`;
        const versionEntry = {
          id: versionId,
          archivedAt: now.toISOString(),
          folder: folderName,
          title: targetTitle || targetUrl,
          hasScreenshot: Boolean(screenshotBuffer),
          htmlSize: htmlBuffer ? htmlBuffer.length : 0,
        };

        const existingVersions = archiveIndex.get(targetUrl) || [];
        existingVersions.unshift(versionEntry);
        archiveIndex.set(targetUrl, existingVersions);

        // Remove from pending list if matching
        pendingUrls = pendingUrls.filter((p) => p.url !== targetUrl);

        console.log(
          `[Archived] ✓ Saved "${targetTitle || targetUrl}" -> ${folderName} (${existingVersions.length} versions total)`,
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            message: "Page archived successfully",
            id: versionId,
            url: targetUrl,
            archivedAt: versionEntry.archivedAt,
            versionCount: existingVersions.length,
            folder: folderName,
          }),
        );
      } catch (err) {
        console.error("Error handling archive request:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 5. Root page / Health check
  if (pathname === "/" || pathname === "/api") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: "online",
          message: "Myopic Archive Server is running",
          endpoints: {
            archive: "/api/archive (POST multipart/form-data)",
            pending: "/api/pending (GET)",
            statusCheck: "/api/check?url=<url> (GET)",
            completePending: "/api/pending/complete (POST)",
          },
          stats: {
            totalArchivedUrls: archiveIndex.size,
            totalPendingUrls: pendingUrls.length,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  // 404 Fallback
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `Endpoint not found: ${pathname}` }));
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Myopic Mock Archive Server running at: http://localhost:${PORT}`);
  console.log(`   - Archive endpoint:  http://localhost:${PORT}/api/archive`);
  console.log(`   - Pending endpoint:  http://localhost:${PORT}/api/pending`);
  console.log(`   - Check endpoint:    http://localhost:${PORT}/api/check?url=...`);
  console.log(`   - Archives stored in: ${ARCHIVES_DIR}`);
  console.log(`=======================================================`);
});
