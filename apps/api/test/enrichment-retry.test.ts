import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { SubprocessJsonRpcAdapter } from "../src/json-rpc-adapter.js";
import { createSourcePythonRuntime } from "../src/python-runtime.js";
import { initializeExactDatabase } from "./exact-schema.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";

const JOB = "00000000-0000-4000-8000-000000001008";
const PEER = "00000000-0000-4000-8000-000000001009";
const fixtureSql = fs.readFileSync(fileURLToPath(new URL(
  "../../../workers/automation/tests/fixtures/enrichment_retry.sql", import.meta.url,
)), "utf8");
const fixtures: { directory: string; db: Database.Database; rpc: SubprocessJsonRpcAdapter; app: ReturnType<typeof buildApp> }[] = [];
const preservedTables = ["job_materials", "job_materials_artifacts", "job_scores", "application_review_decisions"];

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-enrichment-retry-"));
  const dbPath = path.join(directory, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(fixtureSql);
  db.exec(`INSERT INTO resume_templates (tenant_id, template_id, display_name, status, built_in, created_at, updated_at)
    VALUES ('local', 'built_in:modern-html', 'Modern HTML', 'active', 1, '2026-01-01', '2026-01-01')`);
  db.prepare(`INSERT INTO resume_template_versions (tenant_id, version_id, template_id, version_number,
    display_name, status, theme_json, layout_json, content_hash, created_at)
    VALUES ('local', 'built_in:modern-html:v1', 'built_in:modern-html', 1, 'Modern HTML', 'active', ?, '{}', 'synthetic', '2026-01-01')`)
    .run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME));
  fs.writeFileSync(path.join(directory, "config.json"), "{}");
  fs.writeFileSync(path.join(directory, "synthetic-accepted.txt"), "Accepted synthetic material");
  const pythonRuntime = createSourcePythonRuntime({ environment: { ...process.env, LANGFUSE_DISABLE: "1" } });
  const rpc = new SubprocessJsonRpcAdapter({ appDir: directory, pythonRuntime });
  const actionDispatcher = vi.fn(async () => ({ status: "queued", workflowId: "synthetic-workflow", runId: "synthetic-run" }));
  const app = buildApp({ dbPath, appDir: directory, configPath: path.join(directory, "config.json"),
    providerDispatcher: rpc, pythonRuntime, actionDispatcher, requireHealthyWorkerForActions: false });
  const result = { directory, dbPath, db, pythonRuntime, rpc, app, actionDispatcher };
  fixtures.push(result);
  return result;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.app.close();
    await f.rpc.close();
    f.db.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

function normalized(db: Database.Database) {
  const stage = db.prepare("SELECT * FROM job_stage_states WHERE job_id = ? AND stage = 'enrich'").get(JOB) as Record<string, unknown>;
  const aggregate = db.prepare("SELECT * FROM job_enrichments WHERE job_id = ?").get(JOB) as Record<string, unknown>;
  const event = db.prepare("SELECT event_type, payload_json FROM job_events WHERE event_type = 'StageReset'").get();
  delete stage.updated_at;
  delete aggregate.updated_at;
  return { stage, aggregate, event };
}

describe("canonical enrichment retry through HTTP, Python RPC and CLI", () => {
  it("acknowledges the committed API reset and matches the actual CLI result", async () => {
    const f = fixture();
    const cli = fixture();
    const preserved = preservedTables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
    const started = performance.now();
    const response = await f.app.inject({ method: "POST", url: `/v1/jobs/${JOB}/actions/retry-stage`,
      payload: { stage: "enrich" } });
    const coldMs = performance.now() - started;
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, status: "reset", stage: {
      stage: "enrich", state: "pending", attemptCount: 2, startedAt: null, finishedAt: null,
      errorCode: null, errorMessage: null, retryable: true, blockedBy: [],
    } });
    const command = cli.pythonRuntime.resolve({ kind: "cli", args: ["retry", "enrich", "https://example.test/apply"] }, { appDir: cli.directory });
    const result = spawnSync(command.executable, command.argv, { cwd: command.cwd, env: command.env, encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Reset enrich for retry");
    expect(normalized(f.db)).toEqual(normalized(cli.db));
    expect(preservedTables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(preserved);
    expect(fs.readFileSync(path.join(f.directory, "synthetic-accepted.txt"), "utf8")).toBe("Accepted synthetic material");
    expect(f.actionDispatcher).not.toHaveBeenCalled();

    // Both durable event readback and projection refresh run after the RPC commit.
    const detail = await f.app.inject({ method: "GET", url: `/v1/jobs/${JOB}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.body).toContain("Accepted synthetic description");
    const warmSamples = [];
    for (let index = 0; index < 5; index += 1) {
      const start = performance.now();
      const repeat = await f.app.inject({ method: "POST", url: `/v1/jobs/${JOB}/actions/retry-stage`, payload: { stage: "enrich" } });
      expect(repeat.statusCode, repeat.body).toBe(200);
      warmSamples.push(performance.now() - start);
    }
    console.info(JSON.stringify({ enrichmentRetryLatency: { coldMs, warmMs: warmSamples } }));
  }, 30_000);

  it("resets a mixed failed cohort atomically before dispatching its existing continuation", async () => {
    const f = fixture();
    const response = await f.app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed",
      payload: { allMatching: false, jobKeys: [JOB, "https://example.test/retry", PEER], runAfter: true } });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({ count: 2, stageCounts: { enrich: 1, score: 1 }, status: "queued" });
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE event_type = 'StageReset'").get()).toEqual({ count: 2 });
    expect(f.actionDispatcher).toHaveBeenCalledWith(expect.objectContaining({ stages: ["enrich", "score", "tailor", "cover"] }), expect.anything());
    const stage = f.db.prepare("SELECT state, metadata_json FROM job_stage_states WHERE job_id = ? AND stage = 'enrich'").get(JOB) as { state: string; metadata_json: string };
    expect(stage.state).toBe("queued");
    expect(JSON.parse(stage.metadata_json)).toMatchObject({ workflowId: "synthetic-workflow", temporalRunId: "synthetic-run" });
  }, 30_000);

  it("leaves failure evidence intact when worker readiness or the RPC transport fails", async () => {
    const f = fixture();
    const before = normalized(f.db);
    const readyApp = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
      providerDispatcher: f.rpc, actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: true });
    try {
      const response = await readyApp.inject({ method: "POST", url: `/v1/jobs/${JOB}/actions/retry-stage`, payload: { stage: "enrich", runAfter: true } });
      expect(response.statusCode).toBe(503);
      expect(normalized(f.db)).toEqual(before);
    } finally { await readyApp.close(); }
    await f.rpc.close();
    const failed = await f.app.inject({ method: "POST", url: `/v1/jobs/${JOB}/actions/retry-stage`, payload: { stage: "enrich" } });
    expect(failed.statusCode).toBe(500);
    expect(normalized(f.db)).toEqual(before);
    expect(f.actionDispatcher).not.toHaveBeenCalled();
  });

  it.each([
    { resets: [] },
    { resets: [{ jobId: JOB, jobUrl: "https://example.test/peer", stage: "enrich" }] },
    { resets: [{ jobId: PEER, jobUrl: "https://example.test/peer", stage: "enrich" }] },
    { resets: [{ jobId: JOB, jobUrl: "https://example.test/retry", stage: "enrich", extra: true }] },
  ])("rejects an invalid RPC acknowledgement before run-after dispatch: %j", async (result) => {
    const f = fixture();
    const before = normalized(f.db);
    const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
      providerDispatcher: { call: async () => ({ jsonrpc: "2.0", id: 1, result }), close: async () => {} },
      actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false });
    try {
      const response = await app.inject({ method: "POST", url: `/v1/jobs/${JOB}/actions/retry-stage`,
        payload: { stage: "enrich", runAfter: true } });
      expect(response.statusCode).toBe(500);
      expect(f.actionDispatcher).not.toHaveBeenCalled();
      expect(normalized(f.db)).toEqual(before);
    } finally { await app.close(); }
  });
});
