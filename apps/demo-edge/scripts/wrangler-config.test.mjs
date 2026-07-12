import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configNames = ["wrangler.api.jsonc", "wrangler.retention.jsonc", "wrangler.test.jsonc"];

test("edge configs persist only allowlisted custom logs", async () => {
  for (const name of configNames) {
    const config = JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"));
    assert.equal(config.compatibility_date, "2026-07-08", name);
    assert.equal(Boolean(config.compatibility_flags?.includes("nodejs_compat")), false, name);
    assert.equal(config.observability.enabled, true, name);
    assert.equal(config.observability.logs.invocation_logs, false, name);
    assert.equal(config.observability.traces.enabled, false, name);
  }
});

test("API Worker owns the same-origin route and two distinct limiter scopes", async () => {
  const apiConfig = JSON.parse(await readFile(new URL("../wrangler.api.jsonc", import.meta.url), "utf8"));
  assert.equal(apiConfig.main, "./workers/api.ts");
  assert.equal(apiConfig.workers_dev, false);
  assert.equal("pages_build_output_dir" in apiConfig, false);
  assert.deepEqual(apiConfig.routes, [{ pattern: "demo.jobctrl.dev/api/*", zone_name: "jobctrl.dev" }]);

  for (const name of ["wrangler.api.jsonc", "wrangler.test.jsonc"]) {
    const config = JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"));
    assert.deepEqual(config.ratelimits, [
      {
        name: "PUBLIC_INGRESS_LIMITER",
        namespace_id: "2026071101",
        simple: { limit: 240, period: 60 },
      },
      {
        name: "TELEMETRY_EDGE_LIMITER",
        namespace_id: "2026071102",
        simple: { limit: 2000, period: 60 },
      },
    ], name);
  }
});

test("retention is hourly and both Workers are dry-run targets", async () => {
  const retention = JSON.parse(await readFile(new URL("../wrangler.retention.jsonc", import.meta.url), "utf8"));
  assert.equal(retention.workers_dev, false);
  assert.deepEqual(retention.triggers.crons, ["17 * * * *"]);
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts["dry-run"], /deploy --config wrangler\.api\.jsonc --dry-run/);
  assert.match(packageJson.scripts["dry-run"], /deploy --config wrangler\.retention\.jsonc --dry-run/);
});

test("reports isolate operational and consented populations from dedupe and rate state", async () => {
  const operational = await readFile(new URL("../reports/operational-metrics.sql", import.meta.url), "utf8");
  const consented = (await Promise.all([
    "consented-audience-reach.sql",
    "consented-engagement.sql",
    "consented-funnel.sql",
    "consented-timing-cta.sql",
  ].map((name) => readFile(new URL(`../reports/${name}`, import.meta.url), "utf8")))).join("\n");
  assert.match(operational, /FROM daily_operational_counters/);
  assert.equal(operational.includes("consented_product_events"), false);
  assert.match(consented, /FROM consented_product_events/);
  assert.equal(consented.includes("daily_operational_counters"), false);
  for (const report of [operational, consented]) {
    assert.match(report, /expires_at/);
    for (const table of [
      "operational_retry_digests",
      "telemetry_rate_windows",
      "telemetry_global_rate_windows",
      "operational_rate_windows",
      "active_demo_identities",
    ]) {
      assert.equal(report.includes(table), false, table);
    }
  }
});
