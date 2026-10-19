# Web Archiver (Chrome + Firefox, Manifest V3)

Build: `./build.py` → `dist/chrome`, `dist/firefox` and `dist/web-archiver-*.zip`.
Only the manifest differs (Chrome: service worker; Firefox: event-page scripts).
All code is shared in `src/`.

## Install

- **Chrome/Edge/Brave**:
  `chrome://extensions` → Developer mode → _Load unpacked_ → `dist/chrome`.
- **Firefox**:
  `about:debugging#/runtime/this-firefox` → _Load Temporary Add-on_ → `dist/firefox/manifest.json`.

For permanent install, sign it as an unlisted add-on (`web-ext sign`) or use
Developer/Nightly with signing disabled.
Firefox MV3 doesn't auto-grant host permissions: use the "Grant access" button
in the popup/preferences.

## Server Contract

Endpoints derive from the server URL (`https://archive.example.com/`):

| purpose | method | derived URL                                                  |
| ------- | ------ | ------------------------------------------------------------ |
| archive | POST   | `/api/archive`                                               |
| pending | GET    | `/api/pending`                                               |
| check   | GET    | `/api/check?url=<page url>` (or override containing `{url}`) |

Each can be overridden in Preferences. If an API token is set:
`Authorization: Bearer <token>`.

### Post Archive — `multipart/form-data`

| part                    | filename                  | content-type               |
| ----------------------- | ------------------------- | -------------------------- |
| `metadata`              | `metadata.json`           | `application/json`         |
| `html`                  | `page.html`               | `text/html;charset=utf-8`  |
| `screenshot` (optional) | `screenshot.png` / `.jpg` | `image/png` / `image/jpeg` |

`metadata` JSON: `url, title, capturedAt, page{referrer,lang,charset,contentType,canonical,favicon,meta{},viewport,scroll,userAgent,...}, request{method,url,headers{}}, response{statusCode,headers{}}, sensitiveHeadersRedacted, extension{}, files{html{size,sha256},screenshot{...}}, warnings[]`.
Return 2xx (JSON optional). On error return non-2xx with `{"error": "..."}` — the message is shown in the toolbar popup.

### GET check → any of these shapes work

`{"archived":true,"count":3,"versions":[{"id":3,"archived_at":"2026-10-01T10:00:00Z","url":"https://…"}, …]}`
(keys `versions|snapshots|archives|items`; time keys `archived_at|archivedAt|created_at|timestamp|time|date`; unix seconds or ms also OK).

### GET pending → `["https://a", …]` or `{"urls":[…]}` / `{"items":[{"url","title","added_at"}]}`

## 🚀 Quick Start with Mock Server

To test the extensions immediately on your machine without configuring an external server:

1. **Start the mock server**:

   ```bash
   node mock-server.js
   ```

   The mock server will listen on `http://localhost:3000`.

2. The extensions are pre-configured with default host `http://localhost:3000`.
3. Captured pages will be saved to `./archives/<timestamp>_<domain>/`:
   - `page.html`
   - `screenshot.png`
   - `metadata.json`

---

## 🌐 Installation Instructions

### Chrome / Brave / Edge (Chromium)

1. Open your Chromium-based browser and navigate to:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
2. Enable **Developer mode** (toggle switch in the top-right corner).
3. Click **Load unpacked**.
4. Select the `chrome/` folder inside this repository:
   ```
   /home/knack/github/web-browser-extention/chrome
   ```
5. Pin the extension to your toolbar.

---

### Mozilla Firefox

1. Open Firefox and navigate to:
   ```
   about:debugging#/runtime/this-firefox
   ```
2. Click **Load Temporary Add-on...**.
3. Select the `manifest.json` file inside the `firefox/` folder:
   ```
   /home/knack/github/web-browser-extention/firefox/manifest.json
   ```
4. The extension is now loaded and available in your toolbar.

---

## 📡 Server API Specification

If you are developing your own archive server, implement the following endpoints:

### 1. `POST /api/archive`

Receives multipart form data:

| Field Name   | Type                                       | Description                                       |
| ------------ | ------------------------------------------ | ------------------------------------------------- |
| `html`       | File (`page.html`, `text/html`)            | The complete serialized HTML DOM.                 |
| `screenshot` | File (`screenshot.png`, `image/png`)       | PNG image of the visible viewport.                |
| `metadata`   | File (`metadata.json`, `application/json`) | JSON metadata payload (see below).                |
| `json`       | String (JSON)                              | Stringified version of metadata for text parsers. |
| `url`        | String                                     | Target page URL.                                  |
| `title`      | String                                     | Target page title.                                |
| `timestamp`  | String (ISO 8601)                          | Time when archive was captured.                   |

**Example `metadata.json`:**

```json
{
  "url": "https://news.ycombinator.com",
  "title": "Hacker News",
  "timestamp": "2026-10-15T18:04:17.732Z",
  "requestHeaders": {
    "User-Agent": "Mozilla/5.0 ...",
    "Accept": "text/html,...",
    "Referer": "https://google.com"
  },
  "referrer": "",
  "characterSet": "UTF-8",
  "language": "en",
  "viewport": { "width": 1440, "height": 900 },
  "screen": { "width": 1920, "height": 1080, "pixelRatio": 1 },
  "meta": {
    "description": "...",
    "ogTitle": "...",
    "canonical": "..."
  }
}
```

**Success Response (200 OK):**

```json
{
  "success": true,
  "message": "Archived",
  "id": "v-12345",
  "versionCount": 1,
  "archivedAt": "2026-10-15T18:04:17.732Z"
}
```

---

### 2. `GET /api/check?url=<encoded_url>`

Used by the extension to check if a page is already archived and retrieve versions.

**Response (if archived):**

```json
{
  "archived": true,
  "count": 2,
  "lastArchived": "2026-10-15T18:04:17.732Z",
  "versions": [
    {
      "id": "v-2",
      "archivedAt": "2026-10-15T18:04:17.732Z"
    },
    {
      "id": "v-1",
      "archivedAt": "2026-10-14T10:15:00.000Z"
    }
  ]
}
```

**Response (if not archived):**

```json
{
  "archived": false,
  "count": 0,
  "versions": []
}
```

_(HTTP 404 is also accepted as "not archived")_

---

### 3. `GET /api/pending`

Returns the list of pending URLs to archive.

**Response:**

```json
[
  {
    "id": "p-1",
    "url": "https://en.wikipedia.org/wiki/Web_archiving",
    "title": "Web Archiving - Wikipedia",
    "addedAt": "2026-10-15T16:00:00.000Z"
  },
  {
    "id": "p-2",
    "url": "https://news.ycombinator.com",
    "title": "Hacker News",
    "addedAt": "2026-10-15T13:00:00.000Z"
  }
]
```

---

### 4. `POST /api/pending/complete` (Optional)

Notified when a pending item is archived or completed.

**Request Body (`application/json`):**

```json
{
  "id": "p-1",
  "url": "https://en.wikipedia.org/wiki/Web_archiving"
}
```

---

## ⚙️ Configuration & Options

Click the **Gear icon** in the extension popup or right-click the extension and select **Options**:

- **Host Archive URL**: Set your base server URL (`https://archive.example.com`).
- **Endpoint Overrides**: Override derived endpoints if your API has non-standard paths.
- **Authentication**: Bearer token, `X-API-Key`, or custom header.
- **Pending Queue Auto-Refresh**: Set automatic polling interval (1 min, 5 min, 15 min, 30 min, 1 hour, or Manual).
- **Visual Screenshot**: Toggle PNG screenshot capture on or off.
- **Prompt on Pending URLs**: Show in-page floating banner when opening pending URLs.
- **Toolbar Badge**: Display archived version count (`✓` / `2v`), pending queue count, or disable.
- **Test Connection**: Instant interactive test to verify server reachability.

---

## ⌨️ Keyboard Shortcuts

| Action                   | Shortcut                                                          |
| ------------------------ | ----------------------------------------------------------------- |
| **Archive Current Page** | `Alt + Shift + A` (Mac: `Alt + Shift + A` / `Option + Shift + A`) |

To customize shortcuts in your browser:

- Chrome: `chrome://extensions/shortcuts`
- Firefox: `about:addons` > Gear icon > **Manage Extension Shortcuts**
