import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    outDir: "../../dist/extension",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(rootDir, "src/background.ts"),
        popup: resolve(rootDir, "popup.html")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  publicDir: "public"
});
