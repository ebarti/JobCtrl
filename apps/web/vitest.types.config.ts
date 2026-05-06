import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/types/**/*.test-d.ts"],
    typecheck: {
      enabled: true,
      only: true,
      tsconfig: "./tsconfig.json",
      include: ["test/types/**/*.test-d.ts"],
    },
  },
});
