import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: new URL(".", import.meta.url).pathname,
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

