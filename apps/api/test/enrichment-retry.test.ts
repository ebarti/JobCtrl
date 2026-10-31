import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { SubprocessJsonRpcAdapter } from "../src/json-rpc-adapter.js";
import { createRetryFixturePythonRuntime } from "./retry-rpc-runtime.js";
import { initializeExactDatabase } from "./exact-schema.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { ResetEnrichmentParamsSchema, ResetStagesParamsSchema } from "../src/contracts.js";

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
  const pythonRuntime = createRetryFixturePythonRuntime();
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

function seedMaterialRetry(f: ReturnType<typeof fixture>, stage: "tailor" | "cover", state: "failed" | "exhausted") {
  f.db.prepare("UPDATE job_stage_states SET state='succeeded' WHERE tenant_id='local' AND job_id=? AND stage='enrich'").run(JOB);
  f.db.prepare(`INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,
    started_at,finished_at,duration_ms,error_code,error_message,retryable,blocked_by_json,next_action,metadata_json,version)
    VALUES ('local',?,?,?,?,5,'2026-01-01','start','finish',1,'FAILED','synthetic',1,'["score"]','retry','{"activityOwner":"old"}',7)`)
    .run(JOB, stage, state, state === "exhausted" ? 5 : 2);
  if (stage === "tailor") f.db.prepare(`INSERT INTO job_materials
    (tenant_id,job_id,generation,status,created_at,updated_at) VALUES ('local',?,2,'resume_in_progress','2026-01-01','2026-01-01')`).run(JOB);
  f.db.prepare(`INSERT INTO job_materials_artifacts
    (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at)
    VALUES ('local',?,?,?,?, 'rejected','synthetic-rejected.txt','text','2026-01-01')`)
    .run(JOB, stage === "tailor" ? 2 : 1, stage === "tailor" ? "tailored_resume" : "cover_letter", `rejected-${stage}`);
  f.db.prepare(`INSERT INTO artifact_line_anchors VALUES ('local','resume','synthetic-accepted',1,'line-1','[]','[]','retain','synthetic provenance',NULL)`).run();
}

function setPostingState(f: ReturnType<typeof fixture>, jobId: string, state: string, version = 1, updatedAt = "2026-01-01") {
  f.db.prepare(`INSERT INTO posting_snapshot_sets
    (tenant_id,job_id,snapshot_set_json,latest_snapshot_version,latest_active_state,updated_at)
    VALUES ('local',?,'{}',?,?,?) ON CONFLICT(tenant_id,job_id) DO UPDATE SET
    latest_snapshot_version=excluded.latest_snapshot_version,latest_active_state=excluded.latest_active_state,updated_at=excluded.updated_at`)
    .run(jobId, version, state, updatedAt);
}

function runSyntheticPostingProducer(f: ReturnType<typeof fixture>, jobId: string, phase: "seed" | "reverse") {
  const script = `
import sqlite3, sys
from jobctrl.domain.enrichment import snapshot_use_case
from jobctrl.domain.enrichment.snapshot_services import ContentAcquisitionResult
from jobctrl.domain.enrichment.snapshot_set import PostingSnapshotSet
from jobctrl.domain.enrichment.snapshot_value_objects import ActiveState, QuarantineReason, SnapshotConfidence
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.enrichment.sqlite_repository import SqlitePostingSnapshotSetRepository
conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row
job_id = canonical_job_id(sys.argv[2])
now = '2026-01-01T00:00:00+00:00'
snapshot_use_case._utc_now = lambda: now
repo = SqlitePostingSnapshotSetRepository(conn)
if sys.argv[3] == 'seed':
    initial = PostingSnapshotSet.empty(tenant_id=LOCAL_TENANT, job_id=job_id, updated_at=now)
    initial, _ = initial.mark_active_state(active_state=ActiveState.ACTIVE, verified_at=now)
    repo.save(initial)
else:
    class Acquisition:
        states = iter((ActiveState.CLOSED, ActiveState.ACTIVE))
        def acquire(self, **kwargs):
            return ContentAcquisitionResult(ok=False, extraction_tier='synthetic', confidence=SnapshotConfidence.LOW,
                quarantine_reason=QuarantineReason.POSTING_INACTIVE, active_state=next(self.states),
                verification_method='synthetic', error_class='SYNTHETIC', error_message='synthetic failure')
    use_case = snapshot_use_case.CapturePostingSnapshotUseCase(snapshot_repository=repo, acquisition_service=Acquisition())
    for expected in (ActiveState.CLOSED, ActiveState.ACTIVE):
        outcome = use_case.execute(tenant_id=LOCAL_TENANT, job_id=job_id, url='https://example.test/retry',
            source_id='synthetic', promote_to_job_enrichment=False)
        assert not outcome.ok and outcome.active_state_changed and outcome.snapshot_set.latest_active_state is expected
conn.close()
`;
  const command = f.pythonRuntime.resolve({ kind: "script", script, args: [f.dbPath, jobId, phase] }, { appDir: f.directory });
  const result = spawnSync(command.executable, command.argv, { cwd: command.cwd, env: command.env, encoding: "utf8", timeout: 30_000 });
  expect(result.status, result.stderr).toBe(0);
}

function normalizedStageReset(f: ReturnType<typeof fixture>, stage: "tailor" | "cover") {
  const stageRow = f.db.prepare("SELECT * FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage=?").get(JOB, stage) as Record<string, unknown>;
  delete stageRow.updated_at;
  const event = f.db.prepare("SELECT event_type,message,payload_json FROM job_events WHERE tenant_id='local' AND job_id=? AND stage=? AND event_type='StageReset'").get(JOB, stage);
  const approved = f.db.prepare("SELECT * FROM job_materials_artifacts WHERE tenant_id='local' AND job_id=? AND artifact_id='synthetic-accepted'").get(JOB);
  const anchors = f.db.prepare("SELECT * FROM artifact_line_anchors ORDER BY rowid").all();
  return { stageRow, event, approved, anchors };
}

describe("canonical enrichment retry through HTTP, Python RPC and CLI", () => {
  it("requires current RPC selection identity while preserving legacy single Enrich parameters", () => {
    const single = { tenantId: "local", expectedAppDir: "/synthetic", expectedDbPath: "/synthetic/jobctrl.db",
      targets: [{ jobId: JOB, stage: "enrich" }] };
    expect(ResetStagesParamsSchema.safeParse(single).success).toBe(false);
    expect(ResetEnrichmentParamsSchema.safeParse(single).success).toBe(true);
    expect(ResetEnrichmentParamsSchema.safeParse({ ...single, onlyFailed: true }).success).toBe(false);
    expect(ResetStagesParamsSchema.safeParse({ ...single,
      targets: [{ jobId: JOB, stage: "enrich", expectedFingerprint: "a".repeat(64) }] }).success).toBe(true);
  });

  it.each([
    ["tailor", "failed", false, 2], ["tailor", "failed", true, 0], ["tailor", "exhausted", false, 0],
    ["cover", "failed", false, 2], ["cover", "failed", true, 0], ["cover", "exhausted", false, 0],
  ] as const)("keeps %s %s reset semantics across HTTP, CLI and bulk (resetAttempts=%s)", async (stage, state, resetAttempts, expected) => {
    const single = fixture();
    const cli = fixture();
    const bulk = fixture();
    for (const f of [single, cli, bulk]) seedMaterialRetry(f, stage, state);
    const response = await single.app.inject({ method: "POST", url: `/v1/jobs/${JOB}/actions/retry-stage`,
      payload: { stage, ...(resetAttempts ? { resetAttempts: true } : {}) } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "reset", stage: { state: "pending", attemptCount: expected } });
    const bulkResponse = await bulk.app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed",
      payload: { jobKeys: [JOB, "https://example.test/retry"], ...(resetAttempts ? { resetAttempts: true } : {}) } });
    expect(bulkResponse.statusCode, bulkResponse.body).toBe(200);
    expect(bulkResponse.json()).toMatchObject({ count: 1, stageCounts: { [stage]: 1 } });
    const command = cli.pythonRuntime.resolve({ kind: "cli", args: ["retry", stage, "https://example.test/apply",
      ...(resetAttempts ? ["--reset-attempts"] : [])] }, { appDir: cli.directory });
    const result = spawnSync(command.executable, command.argv, { cwd: command.cwd, env: command.env, encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(normalizedStageReset(single, stage)).toEqual(normalizedStageReset(cli, stage));
    expect(normalizedStageReset(single, stage)).toEqual(normalizedStageReset(bulk, stage));
    expect(single.db.prepare("SELECT 1 FROM job_materials_artifacts WHERE artifact_id=?").get(`rejected-${stage}`)).toBeUndefined();
    for (const f of [single, cli, bulk]) expect(fs.readFileSync(path.join(f.directory, "synthetic-accepted.txt"), "utf8")).toBe("Accepted synthetic material");
    if (stage === "tailor") {
      expect(response.json().message).toContain("explicit re-tailor");
      expect(bulkResponse.json()).toMatchObject({ retailorRequiredJobKeys: [JOB] });
      expect(result.stdout).toContain("explicit re-tailor");
    }
  }, 60_000);

  it("preserves a non-exhausted budget when false is sent explicitly", async () => {
    const single = fixture();
    const bulk = fixture();
    seedMaterialRetry(single, "cover", "failed");
    seedMaterialRetry(bulk, "cover", "failed");
    const direct = await single.app.inject({ method: "POST", url: `/v1/jobs/${JOB}/actions/retry-stage`,
      payload: { stage: "cover", resetAttempts: false } });
    const cohort = await bulk.app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed",
      payload: { jobKeys: [JOB], resetAttempts: false } });
    expect(direct.statusCode, direct.body).toBe(200);
    expect(cohort.statusCode, cohort.body).toBe(200);
    expect(normalizedStageReset(single, "cover")).toEqual(normalizedStageReset(bulk, "cover"));
    expect(direct.json().stage.attemptCount).toBe(2);
  }, 30_000);

  it("does not dispatch approved material replacements in a mixed bulk run", async () => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    const response = await f.app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed",
      payload: { jobKeys: [JOB, PEER], runAfter: true } });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({ count: 2, retailorRequiredJobKeys: [JOB] });
    expect(response.json().message).toContain("explicit re-tailor");
    expect(f.actionDispatcher).toHaveBeenCalledTimes(1);
    expect(f.actionDispatcher).toHaveBeenCalledWith(expect.objectContaining({ stage: "score" }), expect.anything());
    expect(f.db.prepare("SELECT state FROM job_stage_states WHERE job_id=? AND stage='tailor'").get(JOB)).toEqual({ state: "pending" });
  }, 30_000);

  it.each(["single", "bulk"] as const)("reports re-tailor instead of dispatching an approved %s retry", async (entry) => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    const response = await f.app.inject(entry === "single"
      ? { method: "POST", url: `/v1/jobs/${JOB}/actions/retry-stage`, payload: { stage: "tailor", runAfter: true } }
      : { method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [JOB], runAfter: true } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "reset", message: expect.stringContaining("explicit re-tailor") });
    expect(f.actionDispatcher).not.toHaveBeenCalled();
  }, 30_000);

  it("rolls back a failed non-enrichment HTTP cohort including material cleanup", async () => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    f.db.exec(`CREATE TRIGGER synthetic_fail_peer BEFORE INSERT ON job_events WHEN NEW.job_id='${PEER}'
      BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    const before = ["job_stage_states", "job_materials", "job_materials_artifacts", "job_events", "artifact_line_anchors"]
      .map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const response = await f.app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [JOB, PEER] } });
    expect(response.statusCode).toBe(500);
    expect(["job_stage_states", "job_materials", "job_materials_artifacts", "job_events", "artifact_line_anchors"]
      .map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
    expect(f.actionDispatcher).not.toHaveBeenCalled();
  }, 30_000);

  it.each(["row", "event"] as const)("rejects a cohort when retryability changes after selection (%s)", async (change) => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    const tables = ["job_stage_states", "job_materials", "job_materials_artifacts", "job_events"];
    let afterConcurrentWrite: unknown[] = [];
    const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
      actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
      providerDispatcher: { close: async () => {}, call: async (method, params) => {
        if (change === "row") {
          f.db.prepare("UPDATE job_stage_states SET retryable=0 WHERE tenant_id='local' AND job_id=? AND stage='tailor'").run(JOB);
        } else {
          f.db.prepare(`INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,level,message,occurred_at,payload_json)
            VALUES ('local',?,1,'tailor','StageFailed','info','synthetic','2026-01-02','{"retryable":false}')`).run(JOB);
        }
        afterConcurrentWrite = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        return f.rpc.call(method, params);
      } },
    });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [PEER, JOB], runAfter: true } });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toEqual({ ok: false, error: "retry_selection_changed", message: "A selected job or its retry stage changed or is no longer eligible. Refresh the jobs list and review the selection, then retry." });
      expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(afterConcurrentWrite);
      expect(fs.readFileSync(path.join(f.directory, "synthetic-accepted.txt"), "utf8")).toBe("Accepted synthetic material");
      expect(f.actionDispatcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }, 30_000);

  it.each(["owner", "event"] as const)("does not reset a newer failed %s selected by an earlier bulk request", async (change) => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    const tables = ["job_stage_states", "job_materials", "job_materials_artifacts", "job_events", "artifact_line_anchors"];
    let afterSuccessor: unknown[] = [];
    const app = buildApp({
      dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
      actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
      providerDispatcher: { close: async () => {}, call: async (method, params) => {
        // The newer attempt can finish with the same failed/retryable state and
        // version, so comparing only those fields would accept a stale cohort.
        if (change === "owner") {
          f.db.prepare(`UPDATE job_stage_states SET metadata_json='{"activityOwner":"successor"}'
            WHERE tenant_id='local' AND job_id=? AND stage='tailor'`).run(JOB);
        } else {
          f.db.prepare(`INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,level,message,occurred_at,payload_json)
            VALUES ('local',?,1,'tailor','StageFailed','error','new synthetic attempt','2026-01-02','{"retryable":true}')`).run(JOB);
        }
        afterSuccessor = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        return f.rpc.call(method, params);
      } },
    });
    try {
      const response = await app.inject({
        method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [PEER, JOB], runAfter: true },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toEqual({ ok: false, error: "retry_selection_changed", message: "A selected job or its retry stage changed or is no longer eligible. Refresh the jobs list and review the selection, then retry." });
      expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(afterSuccessor);
      expect(fs.readFileSync(path.join(f.directory, "synthetic-accepted.txt"), "utf8")).toBe("Accepted synthetic material");
      expect(f.actionDispatcher).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }, 30_000);

  it.each(["hidden", "deleted", "hidden_then_unhidden", "deleted_then_restored"] as const)("does not reset a job that becomes %s after bulk selection", async (change) => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    const tables = ["job_stage_states", "job_materials", "job_materials_artifacts", "job_events", "artifact_line_anchors",
      "jobctrl_hidden_jobs", "jobctrl_deleted_jobs", "posting_snapshot_sets"];
    let afterLifecycleChange: unknown[] = [];
    const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
      actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
      providerDispatcher: { close: async () => {}, call: async (method, params) => {
        expect(params).toMatchObject({ targets: [{ jobId: PEER, stage: "score" }, { jobId: JOB, stage: "tailor" }] });
        const lifecycle = await f.app.inject(change.startsWith("hidden")
          ? { method: "POST", url: `/v1/jobs/${JOB}/hide`, payload: {} }
          : { method: "DELETE", url: `/v1/jobs/${JOB}`, payload: {} });
        expect(lifecycle.statusCode, lifecycle.body).toBe(200);
        if (change.endsWith("then_unhidden") || change.endsWith("then_restored")) {
          // A restore must be later than the deletion timestamp to be active.
          if (change.startsWith("deleted")) await new Promise((resolve) => setTimeout(resolve, 10));
          const restored = await f.app.inject({ method: "POST", url: `/v1/jobs/${JOB}/${change.startsWith("hidden") ? "unhide" : "restore"}`, payload: {} });
          expect(restored.statusCode, restored.body).toBe(200);
        }
        afterLifecycleChange = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        return f.rpc.call(method, params);
      } },
    });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [PEER, JOB], runAfter: true } });
      const observed = {
        response: response.json(), dispatchCount: f.actionDispatcher.mock.calls.length,
        stages: f.db.prepare("SELECT job_id,stage,state FROM job_stage_states WHERE job_id IN (?,?) ORDER BY job_id,stage").all(JOB, PEER),
      };
      expect(response.statusCode, JSON.stringify(observed)).toBe(409);
      expect(response.json()).toMatchObject({ ok: false, error: "retry_selection_changed" });
      expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(afterLifecycleChange);
      expect(fs.readFileSync(path.join(f.directory, "synthetic-accepted.txt"), "utf8")).toBe("Accepted synthetic material");
      expect(f.actionDispatcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }, 30_000);

  it.each(["single", "bulk"] as const)("rejects %s Retry when a tombstone returns to identical values", async (entry) => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    f.db.prepare(`INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at,reason,restored_at)
      VALUES ('local',?,'2026-01-01','synthetic','2026-01-02')`).run(JOB);
    const tombstone = f.db.prepare("SELECT * FROM jobctrl_deleted_jobs WHERE job_id=?").get(JOB);
    const tables = ["job_stage_states", "job_materials", "job_materials_artifacts", "job_events", "jobctrl_deleted_jobs", "job_lifecycle_revisions"];
    let afterChange: unknown[] = [];
    const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
      actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
      providerDispatcher: { close: async () => {}, call: async (method, params) => {
        f.db.prepare("UPDATE jobctrl_deleted_jobs SET restored_at=NULL WHERE tenant_id='local' AND job_id=?").run(JOB);
        f.db.prepare("UPDATE jobctrl_deleted_jobs SET restored_at='2026-01-02' WHERE tenant_id='local' AND job_id=?").run(JOB);
        expect(f.db.prepare("SELECT * FROM jobctrl_deleted_jobs WHERE job_id=?").get(JOB)).toEqual(tombstone);
        expect(f.db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id=? AND event_type IN ('JobDeleted','JobRestored')").get(JOB))
          .toEqual({ count: 0 });
        afterChange = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        return f.rpc.call(method, params);
      } },
    });
    try {
      const response = await app.inject(entry === "single"
        ? { method: "POST", url: `/v1/jobs/${JOB}/actions/retry-stage`, payload: { stage: "tailor", runAfter: true } }
        : { method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [PEER, JOB], runAfter: true } });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ ok: false, error: "retry_selection_changed" });
      expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(afterChange);
      expect(f.actionDispatcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }, 30_000);

  it("refuses a selected job without a v15 lifecycle revision", async () => {
    const f = fixture();
    f.db.prepare("DELETE FROM job_lifecycle_revisions WHERE tenant_id='local' AND job_id=?").run(PEER);
    const before = f.db.prepare("SELECT * FROM job_stage_states WHERE job_id=? AND stage='score'").get(PEER);
    const rpcCall = vi.spyOn(f.rpc, "call");
    const response = await f.app.inject({ method: "POST", url: `/v1/jobs/${PEER}/actions/retry-stage`,
      payload: { stage: "score", runAfter: true } });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ ok: false, error: "retry_selection_changed" });
    expect(f.db.prepare("SELECT * FROM job_stage_states WHERE job_id=? AND stage='score'").get(PEER)).toEqual(before);
    expect(rpcCall).not.toHaveBeenCalled();
    expect(f.actionDispatcher).not.toHaveBeenCalled();
  }, 30_000);

  it.each(["hidden", "deleted"] as const)("refuses an already %s job selected explicitly for bulk retry", async (change) => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    const lifecycle = await f.app.inject(change === "hidden"
      ? { method: "POST", url: `/v1/jobs/${JOB}/hide`, payload: {} }
      : { method: "DELETE", url: `/v1/jobs/${JOB}`, payload: {} });
    expect(lifecycle.statusCode, lifecycle.body).toBe(200);
    const tables = ["job_stage_states", "job_materials", "job_materials_artifacts", "job_events"];
    const before = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const response = await f.app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [JOB], runAfter: true } });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ ok: false, error: "retry_selection_changed" });
    expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
    expect(f.actionDispatcher).not.toHaveBeenCalled();
  }, 30_000);

  it("allows a selected retry when another job is hidden after selection", async () => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
      actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
      providerDispatcher: { close: async () => {}, call: async (method, params) => {
        const lifecycle = await f.app.inject({ method: "POST", url: `/v1/jobs/${PEER}/hide`, payload: {} });
        expect(lifecycle.statusCode, lifecycle.body).toBe(200);
        return f.rpc.call(method, params);
      } },
    });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [JOB] } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, count: 1, stageCounts: { tailor: 1 } });
      expect(f.db.prepare("SELECT state FROM job_stage_states WHERE job_id=? AND stage='tailor'").get(JOB)).toEqual({ state: "pending" });
      expect(f.actionDispatcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }, 30_000);

  it.each(["closed", "expired", "removed", "location_incompatible", "closed_then_active"] as const)(
    "rejects the cohort when the selected posting becomes %s after selection", async (change) => {
      const f = fixture();
      seedMaterialRetry(f, "tailor", "failed");
      if (change === "closed_then_active") setPostingState(f, JOB, "active");
      const tables = ["job_stage_states", "job_materials", "job_materials_artifacts", "job_events", "posting_snapshot_sets"];
      let afterChange: unknown[] = [];
      const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
        actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
        providerDispatcher: { close: async () => {}, call: async (method, params) => {
          if (change === "closed_then_active") {
            setPostingState(f, JOB, "closed", 2, "2026-01-02");
            setPostingState(f, JOB, "active", 3, "2026-01-03");
          } else setPostingState(f, JOB, change);
          afterChange = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
          return f.rpc.call(method, params);
        } },
      });
      try {
        const response = await app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [PEER, JOB], runAfter: true } });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toMatchObject({ ok: false, error: "retry_selection_changed" });
        expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(afterChange);
        expect(f.actionDispatcher).not.toHaveBeenCalled();
      } finally { await app.close(); }
    }, 30_000,
  );

  it.each(["single", "bulk"] as const)("rejects %s Retry after a real producer closes and reopens the selected posting", async (entry) => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    runSyntheticPostingProducer(f, JOB, "seed");
    const lifecycleSql = "SELECT latest_active_state,latest_snapshot_version,updated_at FROM posting_snapshot_sets WHERE tenant_id='local' AND job_id=?";
    const selectedLifecycle = f.db.prepare(lifecycleSql).get(JOB);
    const tables = ["job_enrichments", "job_stage_states", "job_materials", "job_materials_artifacts", "job_events", "posting_snapshot_sets"];
    let afterChange: unknown[] = [];
    const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
      actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
      providerDispatcher: { close: async () => {}, call: async (method, params) => {
        runSyntheticPostingProducer(f, JOB, "reverse");
        expect(f.db.prepare(lifecycleSql).get(JOB)).toEqual(selectedLifecycle);
        expect(f.db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id=? AND event_type='JobActiveStateChanged'").get(JOB))
          .toEqual({ count: 0 });
        afterChange = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        return f.rpc.call(method, params);
      } },
    });
    try {
      const response = await app.inject(entry === "single"
        ? { method: "POST", url: `/v1/jobs/${JOB}/actions/retry-stage`, payload: { stage: "tailor", runAfter: true } }
        : { method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [PEER, JOB], runAfter: true } });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ ok: false, error: "retry_selection_changed" });
      expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(afterChange);
      expect(fs.readFileSync(path.join(f.directory, "synthetic-accepted.txt"), "utf8")).toBe("Accepted synthetic material");
      expect(f.actionDispatcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }, 30_000);

  it("allows Retry when a real posting producer changes only an unrelated job", async () => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    runSyntheticPostingProducer(f, PEER, "seed");
    const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
      actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
      providerDispatcher: { close: async () => {}, call: async (method, params) => {
        runSyntheticPostingProducer(f, PEER, "reverse");
        return f.rpc.call(method, params);
      } },
    });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [JOB] } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, count: 1, stageCounts: { tailor: 1 } });
    } finally { await app.close(); }
  }, 30_000);

  it.each(["closed", "expired", "removed", "location_incompatible"] as const)(
    "refuses an already %s posting selected explicitly for bulk retry", async (state) => {
      const f = fixture();
      seedMaterialRetry(f, "tailor", "failed");
      setPostingState(f, JOB, state);
      const tables = ["job_stage_states", "job_materials", "job_materials_artifacts", "job_events", "posting_snapshot_sets"];
      const before = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const response = await f.app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [JOB], runAfter: true } });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ ok: false, error: "retry_selection_changed" });
      expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
      expect(f.actionDispatcher).not.toHaveBeenCalled();
    }, 30_000,
  );

  it.each(["active", "unknown"] as const)("allows a selected %s posting to retry", async (state) => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    setPostingState(f, JOB, state);
    const response = await f.app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [JOB] } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, count: 1, stageCounts: { tailor: 1 } });
    expect(f.db.prepare("SELECT state FROM job_stage_states WHERE job_id=? AND stage='tailor'").get(JOB)).toEqual({ state: "pending" });
    expect(f.actionDispatcher).not.toHaveBeenCalled();
  }, 30_000);

  it.each(["successor", "hidden", "deleted", "closed", "removed_stage", "created_stage"] as const)(
    "refuses a single-stage retry when its selected identity changes (%s)", async (change) => {
      const f = fixture();
      const stage = change === "created_stage" ? "cover" : "score";
      const tables = ["job_stage_states", "job_materials", "job_materials_artifacts", "job_events", "posting_snapshot_sets",
        "jobctrl_hidden_jobs", "jobctrl_deleted_jobs"];
      let afterChange: unknown[] = [];
      const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
        actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
        providerDispatcher: { close: async () => {}, call: async (method, params) => {
          expect(params).toMatchObject({ targets: [{ jobId: PEER, stage, expectedFingerprint: expect.any(String) }] });
          if (change === "successor") f.db.prepare(`UPDATE job_stage_states SET state='running',version=version+1,
            metadata_json='{\"activityOwner\":\"synthetic-successor\"}' WHERE tenant_id='local' AND job_id=? AND stage='score'`).run(PEER);
          else if (change === "hidden" || change === "deleted") {
            const lifecycle = await f.app.inject(change === "hidden"
              ? { method: "POST", url: `/v1/jobs/${PEER}/hide`, payload: {} }
              : { method: "DELETE", url: `/v1/jobs/${PEER}`, payload: {} });
            expect(lifecycle.statusCode, lifecycle.body).toBe(200);
          } else if (change === "closed") setPostingState(f, PEER, "closed");
          else if (change === "removed_stage") f.db.prepare("DELETE FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='score'").run(PEER);
          else f.db.prepare(`INSERT INTO job_stage_states
            (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable,blocked_by_json,metadata_json,version)
            VALUES ('local',?,'cover','running',1,5,'2026-01-02',1,'[]','{\"activityOwner\":\"synthetic-successor\"}',1)`).run(PEER);
          afterChange = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
          return f.rpc.call(method, params);
        } },
      });
      try {
        const response = await app.inject({ method: "POST", url: `/v1/jobs/${PEER}/actions/retry-stage`, payload: { stage, runAfter: true } });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toMatchObject({ ok: false, error: "retry_selection_changed" });
        expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(afterChange);
        expect(fs.readFileSync(path.join(f.directory, "synthetic-accepted.txt"), "utf8")).toBe("Accepted synthetic material");
        expect(f.actionDispatcher).not.toHaveBeenCalled();
      } finally { await app.close(); }
    }, 30_000,
  );

  it("permits an unchanged deliberate single-stage reset when the stage does not yet exist", async () => {
    const f = fixture();
    const response = await f.app.inject({ method: "POST", url: `/v1/jobs/${PEER}/actions/retry-stage`,
      payload: { stage: "cover", runAfter: false } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, status: "reset", stage: { stage: "cover", state: "pending" } });
    expect(f.db.prepare("SELECT state FROM job_stage_states WHERE job_id=? AND stage='score'").get(PEER)).toEqual({ state: "failed" });
    expect(f.actionDispatcher).not.toHaveBeenCalled();
  }, 30_000);

  it.each(["new_score", "retryable_event", "exhausted_score", "failed_enrich"] as const)(
    "rejects a newly eligible earlier failure before resetting the selected stage (%s)",
    async (change) => {
      const f = fixture();
      seedMaterialRetry(f, "tailor", "failed");
      const insertScore = (state: string, retryable: number) => f.db.prepare(`INSERT INTO job_stage_states
        (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable,blocked_by_json,version)
        VALUES ('local',?,'score',?,1,3,'2026-01-01',?,'[]',1)`).run(JOB, state, retryable);
      const insertOverride = (retryable: boolean) => f.db.prepare(`INSERT INTO job_events
        (tenant_id,job_id,identity_version,stage,event_type,level,message,occurred_at,payload_json)
        VALUES ('local',?,1,'score','StageFailed','info','synthetic','2026-01-02',?)`)
        .run(JOB, JSON.stringify({ retryable }));
      if (change === "retryable_event") {
        insertScore("failed", 1);
        insertOverride(false);
      }
      const tables = ["job_stage_states", "job_materials", "job_materials_artifacts", "job_events", "artifact_line_anchors"];
      let afterConcurrentWrite: unknown[] = [];
      const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
        actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
        providerDispatcher: { close: async () => {}, call: async (method, params) => {
          expect(params).toMatchObject({ targets: [
            { jobId: PEER, stage: "score" }, { jobId: JOB, stage: "tailor" },
          ] });
          if (change === "new_score") insertScore("failed", 1);
          else if (change === "retryable_event") insertOverride(true);
          else if (change === "exhausted_score") insertScore("exhausted", 0);
          else f.db.prepare("UPDATE job_stage_states SET state='failed',retryable=0 WHERE tenant_id='local' AND job_id=? AND stage='enrich'").run(JOB);
          afterConcurrentWrite = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
          return f.rpc.call(method, params);
        } },
      });
      try {
        const response = await app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [PEER, JOB], runAfter: true } });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toMatchObject({ ok: false, error: "retry_selection_changed", message: expect.stringContaining("Refresh") });
        expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(afterConcurrentWrite);
        expect(fs.readFileSync(path.join(f.directory, "synthetic-accepted.txt"), "utf8")).toBe("Accepted synthetic material");
        expect(f.actionDispatcher).not.toHaveBeenCalled();
      } finally { await app.close(); }
    }, 30_000,
  );

  it.each(["non_retryable_score", "later_cover"] as const)(
    "does not reject an unchanged first retryable failure when another stage changes (%s)", async (change) => {
      const f = fixture();
      seedMaterialRetry(f, "tailor", "failed");
      const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
        actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
        providerDispatcher: { close: async () => {}, call: async (method, params) => {
          const stage = change === "non_retryable_score" ? "score" : "cover";
          f.db.prepare(`INSERT INTO job_stage_states
            (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable,blocked_by_json,version)
            VALUES ('local',?,?,'failed',1,3,'2026-01-01',?,'[]',1)`)
            .run(JOB, stage, change === "non_retryable_score" ? 0 : 1);
          return f.rpc.call(method, params);
        } },
      });
      try {
        const response = await app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [JOB] } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ ok: true, count: 1, stageCounts: { tailor: 1 } });
        expect(f.db.prepare("SELECT state FROM job_stage_states WHERE job_id=? AND stage='tailor'").get(JOB)).toEqual({ state: "pending" });
        expect(f.actionDispatcher).not.toHaveBeenCalled();
      } finally { await app.close(); }
    }, 30_000,
  );

  it.each([
    [-32602, { reason: "retry_selection_changed" }, "different worker wording", 409, "retry_selection_changed"],
    [-32602, undefined, "retry target changed; refresh and retry", 500, "db_write_failed"],
    [-32603, { reason: "retry_selection_changed" }, "different worker error", 500, "db_write_failed"],
    [-32602, { reason: "apply_reset_refused" }, "Apply reset refused by the writer", 409, "apply_reset_refused"],
    [-32603, { reason: "apply_reset_refused" }, "different worker error", 500, "db_write_failed"],
    [-32602, undefined, "Apply reset refused by the writer", 500, "db_write_failed"],
  ] as const)("classifies only structured retry refusals (%i, %s)", async (code, data, message, status, error) => {
    const f = fixture();
    const tables = ["job_stage_states", "job_materials", "job_materials_artifacts", "job_events"];
    const before = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const app = buildApp({
      dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
      actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
      providerDispatcher: { close: async () => {}, call: async () => ({
        jsonrpc: "2.0", id: 1, error: { code, message, ...(data ? { data } : {}) },
      }) },
    });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [PEER], runAfter: true } });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toMatchObject({ ok: false, error });
      expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
      expect(f.actionDispatcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }, 30_000);

  it("matches the Python writer identity for Unicode and escaped metadata", async () => {
    const f = fixture();
    seedMaterialRetry(f, "tailor", "failed");
    setPostingState(f, JOB, "active");
    f.db.prepare("UPDATE posting_snapshot_sets SET snapshot_set_json=? WHERE tenant_id='local' AND job_id=?")
      .run(JSON.stringify({ synthetic: "café-🚀\nline two" }), JOB);
    f.db.prepare(`INSERT INTO job_events
      (tenant_id,job_id,identity_version,stage,event_type,level,occurred_at,payload_json,entity_kind,entity_ref)
      VALUES ('local',?,1,NULL,'PostingSnapshotStatePersisted','info','2026-01-01','{}','posting_retry_lifecycle',?)`)
      .run(JOB, JOB);
    // This per-job generation must remain lossless above JS's safe integer range.
    f.db.prepare("UPDATE job_lifecycle_revisions SET revision=9007199254740993 WHERE tenant_id='local' AND job_id=?").run(JOB);
    f.db.prepare("UPDATE job_stage_states SET metadata_json=? WHERE tenant_id='local' AND job_id=? AND stage='tailor'")
      .run(JSON.stringify({ activityOwner: "synthetic-á-🚀", reason: "line one\nline two" }), JOB);
    const response = await f.app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [JOB] } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ count: 1, stageCounts: { tailor: 1 } });
  }, 30_000);

  it("keeps the internal posting-state receipt out of Activity", async () => {
    const f = fixture();
    f.db.prepare("INSERT INTO job_list_projections (tenant_id,job_id,title) VALUES ('local',?,'Synthetic retry job')").run(JOB);
    const event = f.db.prepare(`INSERT INTO job_events
      (tenant_id,job_id,identity_version,stage,event_type,level,occurred_at,payload_json,entity_kind,entity_ref)
      VALUES ('local',?,1,NULL,'PostingSnapshotStatePersisted','info','2026-01-01','{}','posting_retry_lifecycle',?)`)
      .run(JOB, JOB);
    f.db.prepare(`INSERT INTO job_events
      (tenant_id,job_id,identity_version,stage,event_type,level,message,occurred_at,payload_json)
      VALUES ('local',?,1,'score','StageFailed','info','Synthetic visible event','2026-01-01','{}')`).run(JOB);
    const list = await f.app.inject({ method: "GET", url: "/v1/debug/activity" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Synthetic visible event" })]));
    expect(list.json().items).not.toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "PostingSnapshotStatePersisted" })]));
    const detail = await f.app.inject({ method: "GET", url: `/v1/debug/activity/${event.lastInsertRowid}` });
    expect(detail.statusCode, detail.body).toBe(404);
  }, 30_000);

  it.each(["single", "bulk"] as const)("keeps the selected job identity when its URL changes after a %s reset commits", async (entry) => {
    const f = fixture();
    const app = buildApp({ dbPath: f.dbPath, appDir: f.directory, configPath: path.join(f.directory, "config.json"),
      actionDispatcher: f.actionDispatcher, requireHealthyWorkerForActions: false,
      providerDispatcher: { close: async () => {}, call: async (method, params) => {
        const result = await f.rpc.call(method, params);
        expect(result.error).toBeUndefined();
        f.db.prepare("UPDATE jobs SET url=? WHERE tenant_id='local' AND job_id=?").run("https://example.test/new-peer", PEER);
        // Reuse the observed URL for another synthetic job to prove the
        // continuation follows the captured ID rather than the old URL.
        f.db.prepare("UPDATE jobs SET url=? WHERE tenant_id='local' AND job_id=?").run("https://example.test/peer", JOB);
        return result;
      } },
    });
    try {
      const response = await app.inject(entry === "single"
        ? { method: "POST", url: `/v1/jobs/${PEER}/actions/retry-stage`, payload: { stage: "score", runAfter: true } }
        : { method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { jobKeys: [PEER], runAfter: true } });
      expect(response.statusCode, response.body).toBe(202);
      expect(f.actionDispatcher).toHaveBeenCalledTimes(1);
      expect(f.actionDispatcher).toHaveBeenCalledWith(expect.objectContaining(entry === "single"
        ? { jobId: PEER, stage: "score" }
        : { jobIds: [PEER], stage: "score" }), expect.anything());
      expect(f.db.prepare("SELECT state FROM job_stage_states WHERE job_id=? AND stage='score'").get(PEER))
        .toEqual({ state: entry === "bulk" ? "queued" : "pending" });
      expect(f.db.prepare("SELECT 1 FROM job_events WHERE job_id=? AND event_type='StageReset'").get(JOB)).toBeUndefined();
      expect(fs.readFileSync(path.join(f.directory, "synthetic-accepted.txt"), "utf8")).toBe("Accepted synthetic material");
      if (entry === "bulk") expect(response.json()).toMatchObject({ ok: true, jobKeys: [PEER] });
    } finally { await app.close(); }
  }, 30_000);

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

it.each(["intent", "prior admitted run"])("rejects %s in a real HTTP to RPC mixed cohort without resetting Enrich", async (blocker) => {
  const f = fixture();
  f.db.prepare("UPDATE job_stage_states SET stage='apply',state='failed' WHERE job_id=? AND stage='score'").run(PEER);
  f.db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply','ApplySubmitIntended',?,'2026-10-24')").run(PEER, JSON.stringify({ run_id: "original-1173" }));
  if (blocker !== "intent") {
    f.db.prepare("UPDATE job_events SET event_type='ApplyRunStarted' WHERE job_id=? AND stage='apply'").run(PEER);
    f.db.prepare("INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at) VALUES ('local',?,1,'apply','StageCanceled',?,'2026-10-24')").run(PEER, JSON.stringify({ run_id: "original-1173" }));
  }
  const tables = ["job_stage_states", "job_events", "job_enrichments", ...preservedTables];
  const before = tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
  const response = await f.app.inject({ method: "POST", url: "/v1/jobs/bulk-retry-failed", payload: { allMatching: false, jobKeys: [JOB, PEER] } });
  expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
  expect(response.body).toContain(blocker);
  expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  expect(f.actionDispatcher).not.toHaveBeenCalled();
});

it("retains Apply submission authority through the canonical reset RPC", async () => {
  const f = fixture();
  f.db.prepare(`INSERT INTO job_stage_states
    (tenant_id,job_id,stage,state,attempt_count,max_attempts,updated_at,retryable)
    VALUES('local',?,'apply','failed',2,3,'2026-01-01',1)`).run(JOB);
  f.db.prepare(`INSERT INTO job_events
    (tenant_id,job_id,identity_version,stage,event_type,payload_json,occurred_at)
    VALUES('local',?,1,'apply','ApplySubmitIntended','{"run_id":"synthetic-original"}','2026-01-01')`).run(JOB);
  const tables = ["job_stage_states", "job_materials", "job_materials_artifacts", "application_review_decisions", "job_events"];
  const before = tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const response = await f.app.inject({ method: "POST", url: `/v1/jobs/${JOB}/actions/retry-stage`,
    payload: { stage: "apply", resetAttempts: true, runAfter: false } });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toMatchObject({ ok: false, error: "apply_reset_refused" });
  expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
  expect(fs.readFileSync(path.join(f.directory, "synthetic-accepted.txt"), "utf8")).toBe("Accepted synthetic material");
  expect(f.actionDispatcher).not.toHaveBeenCalled();
}, 30_000);
