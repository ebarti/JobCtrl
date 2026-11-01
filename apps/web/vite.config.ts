import { fileURLToPath } from "node:url";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const demoApiProxyTarget = process.env["VITE_DEMO_API_PROXY_TARGET"];
const ciLane = process.env["CI_LANE"];
const ownedCiLane = process.env["CI"] === "true" &&
  process.env["RUNNER_ENVIRONMENT"] === "github-hosted" &&
  ["browsers", "core", "support"].includes(ciLane ?? "");

export default defineConfig({
  ...(ownedCiLane ? { cacheDir: path.join(process.env["RUNNER_TEMP"]!, `vite-${ciLane}`) } : {}),
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      // The CI job generates and builds the real tree before parallel consumers.
      enableRouteGeneration: !(ownedCiLane && process.env["JOBCTRL_CI_ROUTES_READY"] === "1"),
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
