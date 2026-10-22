# Web Archiver

A browser extension (Manifest V3) that archives web pages to **your own archive server**. For any given URL it can capture the HTML, a full-page screenshot, request/response headers, and page metadata — everything is sent to a server you control, so nothing depends on a third-party archive service.

Built with TypeScript, Vite+ (`vp`), and [`@crxjs/vite-plugin`](https://crxjs.dev). Chrome and Firefox are supported from a single codebase via a `TARGET` build flag.

## Features

- **Archive pages** — captures HTML, a screenshot, HTTP headers, and metadata, then sends it to your own server.
  - Toolbar button, keyboard shortcut (`Alt+Shift+A`), or right from the page.
- **Archive status-check** — checks whether the current page is already archived and shows existing versions in the popup badge/pill. Optionally runs automatically on page load (`autoCheck`).
- **Tags** — add site-wide tags from the popup; tags are shared across all versions of a URL and merged server-side.
- **Pending queue** — a periodic (configurable alarm-based) background refresh keeps a list of pending archives, and items can be re-tagged from the popup.
- **Open and archive** — archive a URL without visiting it first.
- **Badge feedback** — a small toast/notification with success/error feedback on archiving.
- **Native-feeling integration** — respects the browser API differences between Chrome (Blink / service worker) and Firefox (Gecko / background scripts, `captureTab`).

## Requirements

- [Bun](https://bun.sh) (runtime, package manager, and script runner)
- [Vite+ CLI](https://viteplus.dev) (`vp`) — the unified build/lint/format/test toolchain
- (Optional) [devenv](https://devenv.sh) for a hermetic dev shell — `devenv.nix` provides Bun, `librsvg`, `zip`, `oxfmt`, and defines helper scripts

Manual dependencies for `./build.sh`: `jq`, `zip`, `rsvg-convert` (from `librsvg`).

## Getting started

```bash
# install dependencies
vp install        # or: bun install

# dev mode (Chrome)
bun run dev:chrome

# dev mode (Firefox)
bun run dev:firefox

# local Firefox testing (web-ext run)
bun run start:firefox
```

### Production build

```bash
bun run build
```

This type-checks, builds `dist/chrome` and `dist/firefox`, and packages `dist/web-archiver-chrome.zip` / `dist/web-archiver-firefox.zip`. The full pipeline (icon rendering from `assets/icon.svg`, both targets, zips) is available via the build script:

```bash
./build.sh            # dev build
NODE_ENV=production ./build.sh
```

## Using the extension

1. After install, the options page opens automatically — configure your archive server's endpoints and API token there.
2. Grant site access when prompted (needed to read pages and capture headers).
3. Open a page and archive it via the toolbar popup or `Alt+Shift+A`.

### Endpoints

The extension is configured with a server URL and separate endpoints for:

| Endpoint    | Purpose                                        |
| ----------- | ---------------------------------------------- |
| `archive`   | Submit a new page archive                      |
| `check`     | Query archive status for a URL                 |
| `pending`   | List/manage pending archives                   |
| `tags`      | List known tags                                |
| `sitesTags` | Set tags for a site                            |

Endpoint configuration and a connection test ("Test endpoints") live in the options page.

## Architecture

```
src/
├── background/           # service worker (Chrome) / background script (Firefox)
│   ├── index.ts          # event listeners, alarm scheduling, message handlers
│   ├── archive.ts        # archiving flow + feedback, status checks, header patching
│   ├── screenshot.ts     # full-page capture (tabs.captureTab / activeTab)
│   ├── browser-scripting.ts
│   ├── badge.ts          # badge/toast feedback
│   ├── pending.ts        # pending queue refresh + tag updates
│   ├── tags.ts           # tag listing / site tag management
│   └── content-scripts/
├── popup/                # toolbar popup UI (current page, tags, pending list)
├── options/              # options page (server + endpoint + behavior settings)
├── common/               # shared utilities: settings, storage, messaging, logging,
│                         #   error handling (Result type), event bus, time helpers
└── (manifest.config.ts)  # MV3 manifest, per-target (chrome/firefox) variations
```

Key design points:

- **Per-target builds** — `TARGET=chrome|firefox` swaps the manifest background definition and runtime details; Firefox targets get `browser_specific_settings.gecko` and minimum version gates.
- **Typed messaging** — every popup/options message type has a handler registered in the background (`registerHandlers`), compile-checked so no message type can be forgotten.
- **Header capture** — taps `webRequest` `onSendHeaders`/`onHeadersReceived` for main-frame requests (including `extraHeaders` on Blink) and records them per tab.
- **Centralized logging** — `@common/log` child loggers per subsystem; popup/options entries are forwarded into the background console.

Path aliases in `vite.config.ts`: `@src` → `src/`, `@common` → `src/common/`.

## Scripts

| Command                 | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `bun run dev` / `dev:chrome` | Dev server (HMR), Chrome target               |
| `bun run dev:firefox`   | Dev server (HMR), Firefox target                   |
| `bun run build`         | Type-check + build + zip Chrome and Firefox        |
| `bun run build:chrome` / `build:firefox` | Build a single target             |
| `bun run typecheck`     | `tsc --noEmit`                                     |
| `bun run lint:firefox`  | AMO linting of the Firefox build (`web-ext lint`)  |
| `bun run start:firefox` | Launch Firefox with the built extension (`web-ext run`) |

Lint/format/typecheck in one shot: `vp check`.

## Permissions

- `activeTab`, `scripting`, `tabs` — capture the current page (HTML, screenshot, metadata)
- `webRequest` (+ `<all_urls>` host permission) — record request/response headers for archived pages, restricted to `main_frame` http/https requests
- `storage`, `alarms` — settings, cached state, and the pending-refresh schedule

## Related

- Requires a compatible archive server providing the endpoints listed above (a mock server is referenced via `devenv.nix` under `mock-server/`).
- Example server: [zennozenith/web-archiver-example-server](https://github.com/zennozenith/web-archiver-example-server) — a ready-to-run reference implementation of the endpoints above.

## License

Dual-licensed, at your option:

- [MIT license](./LICENSE-MIT)
- [Apache License, Version 2.0](./LICENSE-APACHE)

```text
SPDX-License-Identifier: MIT OR Apache-2.0
```

Unless you explicitly state otherwise, any contribution you submit is intended to be dual-licensed under these terms.
