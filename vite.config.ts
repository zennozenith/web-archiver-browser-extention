import { defineConfig, lazyPlugins } from "vite-plus";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config.ts";
import { resolve } from "path";

const target = process.env.TARGET || "chrome";
const outDir = process.env.OUT_DIR || `dist/${target}`;

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    ignorePatterns: [],
  },
  plugins: lazyPlugins(() => [crx({ manifest })]),
  build: {
    outDir,
    emptyOutDir: true,
    minify: process.env.NODE_ENV === "production",
  },
  resolve: {
    alias: {
      "@common": resolve(import.meta.dirname, "src/common"),
      "@src": resolve(import.meta.dirname, "src"),
    },
  },
});
