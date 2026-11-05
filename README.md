# Web Archiver

A browser extension (Manifest V3) that archives web pages to **your own archive server**. For any URL it can capture the HTML, a screenshot, request/response headers, and page metadata — everything is sent to a server you control, so nothing depends on a third-party archive service.

Works in **Firefox** and **Chrome** from a single TypeScript codebase.

## Install

| Browser     | Where to get it                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------ |
| **Firefox** | [Install from Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/web-archiver/)     |
| **Chrome**  | [Download from GitHub Releases](https://github.com/zennozenith/web-archiver-browser-extention/releases/tag/v0.2.2) — Chrome is not published to the Chrome Web Store |

### Installing the Chrome build

Chrome builds are distributed only through GitHub Releases:

1. Download `web-archiver-chrome.zip` from the [v0.2.2 release](https://github.com/zennozenith/web-archiver-browser-extention/releases/tag/v0.2.2).
2. Unzip it to a permanent folder.
3. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.
4. Select the unzipped folder.

### You also need a server

The extension is a client. It talks to a companion server that stores links, snapshots, tags, collections, and the pending queue:

> **[zennozenith/web-archiver-server](https://github.com/zennozenith/web-archiver-server)**

Set the server URL (and an optional API token) in the extension's preferences after installing.

## Features

- **Archive a page** — captures the full HTML, a screenshot, request/response headers, and metadata (title, description, canonical URL, favicon, meta tags, viewport, language, …).
- **Multiple snapshots per URL** — every archive is stored as a new version; the popup lists previous versions and links to their archived HTML.
- **Save links without archiving** — save a page with a title, notes, collection, pin state, and tags, optionally archiving a snapshot in the same step.
- **Tags & collections** — add tags from the popup (with colors and autocomplete), file links into collections, and set default tags for manual archives.
- **Pending queue** — the server can hold URLs to archive later. The popup shows the queue, lets you edit tags, and can open a queued URL and archive it in one go.
- **Archive status check** — automatically checks whether the current page is already archived and shows the result on the toolbar badge and in the popup.
- **Screenshot options** — PNG or JPEG, configurable quality, optional full-page capture (Firefox; Chrome captures the visible area).
- **Header capture** — records request and response headers, with sensitive headers (`Cookie`, `Authorization`, `Set-Cookie`, …) redacted by default.
- **Asset saving** — optionally have the server download related assets (JS, CSS, images, …) for a snapshot.
- **Keyboard shortcut** — archive the current page with `Alt+Shift+A` (configurable in the browser).
- **Light / dark / system theme**, centralized logging, and a connection test in preferences.

## Quick start

1. Install the extension for [Firefox](https://addons.mozilla.org/en-US/firefox/addon/web-archiver/) or [Chrome](https://github.com/zennozenith/web-archiver-browser-extention/releases/tag/v0.2.2).
2. Run the [web-archiver-server](https://github.com/zennozenith/web-archiver-server) somewhere reachable.
3. Open the extension's **Preferences** and set:
   - **Server URL** — e.g. `https://archive.example.com/`
   - **API auth token** — optional, sent as `Authorization: Bearer …`
4. Click **Test connection**, grant site access when prompted, and save.
5. Open any `http`/`https` page and archive it from the toolbar popup or with `Alt+Shift+A`.

## How it works

The extension only needs the server's base URL; API paths are derived from it:

| Path                         | Purpose                                      |
| ---------------------------- | -------------------------------------------- |
| `POST /api/page`             | Create a link (or return an existing one)    |
| `PATCH /api/page/:id`        | Update title, notes, collection, pin, …      |
| `GET /api/page/lookup`       | Check whether a URL is already saved         |
| `POST /api/page/:id/capture` | Upload a new snapshot (HTML, screenshot, …)  |
| `GET /api/page/:id/capture`  | Snapshot history                             |
| `PUT /api/page/:id/tag`      | Replace the tag set for a page               |
| `GET /api/tag`               | List tags for autocomplete                   |
| `GET /api/collection`        | List collections for the popup select        |
| `GET \| POST /api/pending`   | List / add queued URLs                       |
| `PATCH /api/pending/:id`     | Update tags on a queued URL                  |
| `GET /api/health`            | Liveness check                               |
| `GET /api/stats`             | Archive and deduplication statistics         |

### Architecture

```
src/
├── background/           # service worker (Chrome) / background script (Firefox)
│   ├── index.ts          # events, alarms, message handlers
│   ├── archive.ts        # capture + upload flow, status checks, header memory
│   ├── page.ts           # page/lookup/capture API calls
│   ├── save-link.ts      # save a link, optionally archive immediately
│   ├── pending.ts        # pending queue refresh + tag updates
│   ├── tags.ts           # tag listing and page tag management
│   ├── collections.ts    # collection listing
│   ├── screenshot.ts     # screenshot capture (per-browser differences)
│   ├── reqwest.ts        # fetch wrapper (auth, timeouts, error handling)
│   ├── badge.ts          # toolbar badge state
│   ├── browser-scripting.ts
│   └── content-scripts/  # injected page collector + in-page banner
├── popup/                # toolbar popup: current page, snapshots, queue, tags
├── options/              # preferences page
├── common/               # settings, storage, messaging, logging, Result errors
└── manifest.config.ts    # MV3 manifest (Chrome / Firefox variants)
```

Key design points:

- **Per-target builds** — `TARGET=chrome|firefox` swaps the manifest background definition and target-specific details.
- **Typed messaging** — every popup/options message has a compile-checked handler in the background.
- **Header capture** — `webRequest` listeners record main-frame request/response headers per tab.
- **Centralized logging** — child loggers per subsystem; popup/options logs are forwarded to the background console.
- **No third-party backend** — the extension talks only to the server you configure.

Path aliases: `@src` → `src/`, `@common` → `src/common/`.

## Development

### Requirements

- [Bun](https://bun.sh) — runtime, package manager, and script runner
- [Vite+](https://viteplus.dev) (`vp`) — build, lint, and formatting toolchain
- For `./build.sh`: `jq`, `zip`, and `rsvg-convert` (from `librsvg`)
- Optional: [devenv](https://devenv.sh) — `devenv.nix` provides the toolchain and helper scripts

### Setup

```bash
vp install          # or: bun install
bun run dev:chrome  # dev server + HMR, Chrome target
bun run dev:firefox # dev server + HMR, Firefox target
```

### Build

```bash
bun run build       # type-check + build both targets
./build.sh          # render icons, build dist/chrome and dist/firefox, create zips
```

Outputs:

- `dist/chrome/`, `dist/firefox/` — unpacked builds
- `dist/web-archiver-chrome.zip`, `dist/web-archiver-firefox.zip` — release archives

### Scripts

| Command                                  | Description                                        |
| ---------------------------------------- | -------------------------------------------------- |
| `bun run dev` / `dev:chrome`             | Dev server (HMR), Chrome target                    |
| `bun run dev:firefox`                    | Dev server (HMR), Firefox target                   |
| `bun run build`                          | Type-check and build both targets                  |
| `bun run build:chrome` / `build:firefox` | Build a single target                              |
| `bun run typecheck`                      | `tsc --noEmit`                                     |
| `bun run lint:firefox`                   | AMO lint of the Firefox build (`web-ext lint`)     |
| `bun run start:firefox`                  | Launch Firefox with the built extension            |
| `vp check`                               | Format, lint, and type-check in one shot           |

## Permissions

- `activeTab`, `scripting`, `tabs` — read the current page (HTML, screenshot, metadata)
- `webRequest` + `<all_urls>` — record request/response headers for archived pages
- `storage`, `alarms` — settings, cached state, and periodic queue refresh

The extension only talks to the server URL you configure.

## Links

- **Release:** [v0.2.2](https://github.com/zennozenith/web-archiver-browser-extention/releases/tag/v0.2.2)
- **Firefox Add-on:** [Web Archiver on AMO](https://addons.mozilla.org/en-US/firefox/addon/web-archiver/)
- **Companion server:** [zennozenith/web-archiver-server](https://github.com/zennozenith/web-archiver-server)

## License

Dual-licensed, at your option:

- [MIT license](./LICENSE-MIT)
- [Apache License, Version 2.0](./LICENSE-APACHE)

```text
SPDX-License-Identifier: MIT OR Apache-2.0
```

Unless you explicitly state otherwise, any contribution you submit is intended to be dual-licensed under these terms.
