import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, defineConfig } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const outDir = resolve(rootDir, "../../dist/extension");

export default defineConfig({
  plugins: [{
    name: "manifest-content-script",
    async closeBundle() {
      // Manifest content scripts execute as classic scripts, so bundle their
      // dependencies into one IIFE instead of sharing ESM chunks with the worker.
      await build({
        configFile: false,
        publicDir: false,
        build: {
          outDir,
          emptyOutDir: false,
          lib: {
            entry: resolve(rootDir, "src/content-script.ts"),
            name: "JobCtrlContentScript",
            formats: ["iife"],
            fileName: () => "content-script.js",
          },
        },
      });
    },
  }],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(rootDir, "src/background.ts"),
        popup: resolve(rootDir, "popup.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  publicDir: "public",
});
