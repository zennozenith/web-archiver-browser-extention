import { defineManifest } from '@crxjs/vite-plugin';
import packageJson from './package.json' with { type: 'json' };

const { version, name, description } = packageJson;

const [major, minor, patch, label = '0'] = version
  .replace(/[^\d.-]+/g, '')
  .split(/[.-]/);

const target = process.env.TARGET || 'chrome';

export default defineManifest(async (env) => {
  const isFirefox = target === 'firefox';

  const manifest: any = {
    manifest_version: 3,
    name: env.mode === 'development' ? `[DEV] ${name}` : name,
    description: description || 'Chrome & Firefox Extension built with Bun, TypeScript, and Vite',
    version: `${major}.${minor}.${patch}.${label}`,
    version_name: version,
    icons: {
      '16': 'icons/icon-16.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
    action: {
      default_popup: 'src/popup/index.html',
      default_icon: {
        '16': 'icons/icon-16.png',
        '48': 'icons/icon-48.png',
        '128': 'icons/icon-128.png',
      },
    },
    options_ui: {
      page: 'src/options/index.html',
      open_in_tab: true,
    },
    permissions: ['storage'],
  };

  if (isFirefox) {
    manifest.background = {
      scripts: ['src/background/index.ts'],
      type: 'module',
    };
    manifest.browser_specific_settings = {
      gecko: {
        id: 'browser-extension-starter@example.com',
        strict_min_version: '142.0',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    };
  } else {
    manifest.background = {
      service_worker: 'src/background/index.ts',
      type: 'module',
    };
  }

  return manifest;
});
