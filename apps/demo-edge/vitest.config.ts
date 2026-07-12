import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { cloudflarePool, cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));
const workerOptions = {
  wrangler: { configPath: "./wrangler.test.jsonc" },
};

export default defineConfig({
  plugins: [
    {
      name: "demo-edge-migrations",
      resolveId(id) {
        return id === "virtual:demo-edge-migrations" ? id : undefined;
      },
      load(id) {
        return id === "virtual:demo-edge-migrations"
          ? `export const migrations = ${JSON.stringify(migrations)};`
          : undefined;
      },
    },
    cloudflareTest(workerOptions),
  ],
  test: {
    pool: cloudflarePool(workerOptions),
    include: ["test/**/*.test.ts"],
  },
});
