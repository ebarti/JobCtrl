import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: fileURLToPath(new URL(".", import.meta.url)),
  envPrefix: "VITE_",
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/v1": "http://127.0.0.1:8766",
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
