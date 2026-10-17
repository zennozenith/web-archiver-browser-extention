import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.ts';
import { resolve } from 'path';

const target = process.env.TARGET || 'chrome';
const outDir = process.env.OUT_DIR || `dist/${target}`;

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir,
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@common': resolve(import.meta.dirname, 'src/common'),
      '@src': resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
