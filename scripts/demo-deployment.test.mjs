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
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "Referrer-Policy: no-referrer",
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

test("deployment workflow pins Wrangler, gates production, and deploys in safe order", async () => {
  const workflow = await read(".github/workflows/demo-site.yml");
  const edgePackage = await parse("apps/demo-edge/package.json");
  assert.equal(edgePackage.devDependencies.wrangler, "4.107.0");
  assert.match(workflow, /wrangler@4\.107\.0 pages deploy/);
  const setupNode = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0";
  assert.equal(workflow.split(setupNode).length - 1, 3);
  assert.equal((workflow.match(/node-version: 22\.21\.1/g) ?? []).length, 3);
  assert.doesNotMatch(workflow, /node-version: "20\.19"/);
  assert.match(workflow, /vars\.DEMO_DEPLOY_ENABLED == 'true'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /pull_request_target/);

  const previewJob = workflow.slice(workflow.indexOf("  preview:"), workflow.indexOf("  production:"));
  assert.match(previewJob, /uses: actions\/checkout@v4/);
  assert.ok(previewJob.indexOf("actions/checkout@v4") < previewJob.indexOf("pnpm/action-setup@v4"));
  assert.match(previewJob, /^\s+HEAD_REF: \$\{\{ github\.head_ref \}\}$/m);
  assert.match(previewJob, /run: .*--branch="\$HEAD_REF"/);
  assert.doesNotMatch(previewJob, /run: .*\$\{\{\s*github\.head_ref\s*\}\}/);

  const migrate = workflow.indexOf("Apply telemetry migrations");
  const api = workflow.indexOf("Deploy consent and telemetry API");
  const retention = workflow.indexOf("Deploy retention worker");
  const pages = workflow.indexOf("Publish production site");
  const smoke = workflow.indexOf("Smoke production consent boundary");
  assert.ok(migrate < api && api < retention && retention < pages && pages < smoke);
});
