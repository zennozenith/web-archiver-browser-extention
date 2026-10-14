import tailwindcss from "@tailwindcss/vite";
import { globSync } from "tinyglobby";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lazyPlugins } from "vite-plus";

const root = path.dirname(fileURLToPath(import.meta.url));

const files = globSync("src/**/*.{js,ts,css}", {
  cwd: root,
  absolute: true,
  // skip type declarations and partials like _foo.css
  ignore: ["**/*.d.ts", "**/_*"],
});

if (files.length === 0) {
  throw new Error(`No entry files found under ${path.join(root, "src")}`);
}

/** @type {import('vite').UserConfig} */
export default {
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  root,
  // base: "/static/vite/",
  plugins: lazyPlugins(() => [tailwindcss()]),
  mode: "production",
  build: {
    outDir: "build",
    emptyOutDir: true,
    // sourcemap: true,
    rolldownOptions: {
      input: Object.fromEntries(
        files.map((file) => [
          path
            .relative(path.join(root, "src"), file)
            .slice(0, -path.extname(file).length)
            .split(path.sep)
            .join("/"),
          file,
        ]),
      ),
      output: {
        minify: false,
        // predictable filenames instead of hashed ones, so Askama
        // templates can reference /static/counter.js directly
        entryFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
        cleanDir: true,

        // entryFileNames: "[name].js",              // stable name, no hash
        // chunkFileNames: "chunks/[name]-[hash].js",
        // assetFileNames: "assets/[name][extname]",
      },
    },
  },
};
