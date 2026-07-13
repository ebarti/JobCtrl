import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const demoApiProxyTarget = process.env["VITE_DEMO_API_PROXY_TARGET"];

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  envPrefix: "VITE_",
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/v1": process.env["VITE_DEV_API_PROXY_TARGET"] ?? "http://127.0.0.1:8766",
      ...(demoApiProxyTarget === undefined
        ? {}
        : {
            // Preserve the browser-facing Host/Origin pair. The demo Worker
            // intentionally rejects requests that are not same-origin.
            "/api": {
              target: demoApiProxyTarget,
              changeOrigin: false,
            },
          }),
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
