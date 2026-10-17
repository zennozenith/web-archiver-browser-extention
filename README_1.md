# Cross-Browser Extension Starter (Chrome & Firefox MV3)

A modern Manifest V3 browser extension starter template supporting both **Google Chrome** and **Mozilla Firefox**, built with **Bun**, **TypeScript**, and **Vite**.

## 🌐 Cross-Browser Compatibility

Chrome and Firefox have distinct Manifest V3 specifications for background execution:

| Feature | Chrome (MV3) | Firefox (MV3) |
| :--- | :--- | :--- |
| **Background Target** | Service Worker (`background.service_worker`) | Event Page (`background.scripts`) |
| **API Model** | Unified via `webextension-polyfill` (`browser.*`) | Native W3C WebExtensions (`browser.*`) |
| **Manifest Settings** | Standard Chromium MV3 | `browser_specific_settings.gecko` with Addon ID & Data Consent |
| **Output Directory** | `dist/chrome/` | `dist/firefox/` |

By using [`webextension-polyfill`](https://github.com/mozilla/webextension-polyfill), the exact same TypeScript codebase runs identically across both browsers with native `async/await` syntax.

---

## 📁 Project Structure

```text
.
├── public/
│   └── icons/                 # Extension icons (16x16, 48x48, 128x128)
├── src/
│   ├── background/            # Background script / service worker
│   │   └── index.ts           # Handles lifecycle, badge updates, and message passing
│   ├── common/                # Shared utilities, storage helpers, and type definitions
│   │   ├── constants.ts       # Shared defaults and storage keys
│   │   ├── index.ts           # Barrel export
│   │   ├── messaging.ts       # Type-safe background messaging helper (browser.*)
│   │   ├── storage.ts         # Chrome & Firefox storage wrapper (sync & local)
│   │   └── types.ts           # Message contracts, payloads, and settings interfaces
│   ├── options/               # Extension Options / Preferences page
│   │   ├── index.html         # Settings UI template
│   │   ├── index.ts           # Form state management and browser.storage.sync persistence
│   │   └── options.css        # Options page styling (responsive with dark mode)
│   └── popup/                 # Toolbar Popup action
│       ├── index.html         # Action popup layout
│       ├── index.ts           # Popup logic, reactive counter, and background communication
│       └── popup.css          # Modern popup styling
├── manifest.config.ts         # Dual-target Chrome/Firefox Manifest V3 definition
├── vite.config.ts             # Vite configuration with target-aware outDir
├── tsconfig.json              # TypeScript configuration
└── package.json               # Project scripts and dependencies
```

---

## 🚀 Available Commands

### 1. Build Production Bundles

```bash
# Build for BOTH Chrome and Firefox
bun run build

# Build specifically for Chrome (outputs to dist/chrome)
bun run build:chrome

# Build specifically for Firefox (outputs to dist/firefox)
bun run build:firefox
```

### 2. Development Mode (with Live Reload / HMR)

```bash
# Dev server for Chrome
bun run dev:chrome

# Dev server for Firefox
bun run dev:firefox
```

### 3. Linting & Testing for Firefox

```bash
# Validate dist/firefox using Mozilla's official web-ext linter
bun run lint:firefox

# Launch a temporary Firefox instance with the extension pre-loaded
bun run start:firefox
```

### 4. Type Checking

```bash
bun run typecheck
```

---

## 🔌 How to Load and Test the Extension

### In Google Chrome (or Chromium browsers: Brave, Edge, Opera)

1. Build the Chrome extension:
   ```bash
   bun run build:chrome
   ```
2. Navigate to `chrome://extensions` in Chrome.
3. Enable **Developer mode** (toggle in top-right corner).
4. Click **Load unpacked**.
5. Select the `dist/chrome` folder in this repository.

### In Mozilla Firefox

#### Method A: Automatic (Recommended)
Run:
```bash
bun run start:firefox
```
This automatically boots a clean Firefox profile and installs the extension from `dist/firefox`.

#### Method B: Manual (about:debugging)
1. Build the Firefox extension:
   ```bash
   bun run build:firefox
   ```
2. Navigate to `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on...**
4. Select the `dist/firefox/manifest.json` file.
