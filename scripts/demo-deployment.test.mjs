import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const parse = async (path) => JSON.parse(await read(path));

test("demo build and Pages files select the fail-closed demo composition", async () => {
  const packageJson = await parse("package.json");
  assert.equal(
    packageJson.scripts["demo:build"],
    "VITE_JOBCTRL_APP_MODE=demo corepack pnpm --filter @jobctrl/web build",
  );
  assert.equal(packageJson.scripts["demo:smoke"], "node scripts/demo-smoke.mjs");
  await assert.rejects(read("apps/web/public/404.html"), { code: "ENOENT" });

  const indexHtml = await read("apps/web/index.html");
  assert.match(indexHtml, /<script src="\/theme-init\.js"><\/script>/);
  assert.doesNotMatch(indexHtml, /<script>[^]*jh:ui-preferences/);
  assert.match(await read("apps/web/public/theme-init.js"), /jh:ui-preferences/);

  const headers = await read("apps/web/public/_headers");
  assert.match(headers, /\/\*\n  Cache-Control: no-transform/);
  for (const required of [
    "Content-Security-Policy: default-src 'self'",
    "connect-src 'self' https://*.google-analytics.com",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob: https://*.google-analytics.com",
    "Referrer-Policy: no-referrer",
    "script-src 'self' https://www.googletagmanager.com",
    "X-Content-Type-Options: nosniff",
  ]) {
    assert.match(headers, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(headers, /Cache-Control: public, max-age=0, must-revalidate/);
  assert.match(headers, /\/assets\/\*\n  Cache-Control: public, max-age=31536000, immutable/);
});

test("production Workers share the provisioned EU D1 database", async () => {
  const api = await parse("apps/demo-edge/wrangler.api.jsonc");
  const retention = await parse("apps/demo-edge/wrangler.retention.jsonc");
  const apiDatabase = api.d1_databases.find(({ binding }) => binding === "DEMO_TELEMETRY_DB");
  const retentionDatabase = retention.d1_databases.find(
    ({ binding }) => binding === "DEMO_TELEMETRY_DB",
  );
  assert.match(apiDatabase.database_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.notEqual(apiDatabase.database_id, "00000000-0000-0000-0000-000000000000");
  assert.equal(retentionDatabase.database_id, apiDatabase.database_id);
  assert.equal(apiDatabase.database_name, "jobctrl-demo-telemetry");
});
