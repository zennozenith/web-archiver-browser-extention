import { defineManifest } from "@crxjs/vite-plugin";
import packageJson from "./package.json" with { type: "json" };

const { version, description, displayName } = packageJson;

const [major, minor, patch, label = "0"] = version
  .replace(/[^\d.-]+/g, "")
  .split(/[.-]/)
  .filter((v) => v.trim().length > 0);

// const label_name = version.match(/-(.*?)\./)?.[1];
// const version_name = label_name
//   ? `${major}.${minor}.${patch} .${label}`
//   : `${major}.${minor}.${patch}.${label}`;

const target = process.env.TARGET || "chrome";

export default defineManifest(async (env) => {
  const isFirefox = target === "firefox";

  const manifest: any = {
    manifest_version: 3,
    name: env.mode === "development" ? `[DEV] ${displayName}` : displayName,
    description: description,
    version: `${major}.${minor}.${patch}.${label}`,
    // version_name,
    host_permissions: ["<all_urls>"],
    permissions: ["activeTab", "scripting", "storage", "tabs", "alarms", "webRequest"],
    commands: {
      "archive-page": {
        suggested_key: { default: "Alt+Shift+A" },
        description: "Archive the current page",
      },
    },

    icons: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
    action: {
      default_popup: "src/popup/index.html",
      default_icon: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png",
        "48": "icons/icon-48.png",
        "128": "icons/icon-128.png",
      },
    },
    options_ui: {
      page: "src/options/index.html",
      open_in_tab: true,
    },
    // content_scripts: [
    //   {
    //     matches: ["<all_urls>"],
    //     js: ["src/background/page.ts"],
    //   },
    // ],
  };

  if (isFirefox) {
    manifest.background = {
      scripts: ["src/background/index.ts"],
      type: "module",
    };
    manifest.browser_specific_settings = {
      gecko: {
        id: "web-archiver@zennozenith.com",
        strict_min_version: "150.0",
        data_collection_permissions: {
          required: ["none"],
        },
      },
    };
  } else {
    manifest.minimum_chrome_version = "150";
    manifest.background = {
      service_worker: "src/background/index.ts",
      type: "module",
    };
  }

  return manifest;
});
