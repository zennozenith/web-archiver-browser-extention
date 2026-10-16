# URL Archiver (Chrome + Firefox, Manifest V3)

Build: `./build.py` → `dist/chrome`, `dist/firefox` and `dist/url-archiver-*.zip`.
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

Each can be overridden in Preferences. If an API token is set: `Authorization: Bearer <token>`.

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
