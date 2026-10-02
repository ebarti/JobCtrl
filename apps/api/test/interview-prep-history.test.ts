import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import type { InterviewCatalog } from "../src/contracts.js";
import { createActionDispatcher } from "../src/local-actions.js";
import { interviewPrepStaleReasons } from "../src/interview-prep-history.js";
import { buildApp } from "../src/server.js";
import { syntheticInterviewCatalogAsset, syntheticInterviewGenerationContext } from "./interview-fixture.js";
import { initializeExactV7Database } from "./v7-schema.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB_ID = "22222222-2222-4222-8222-222222222222";

describe("canonical interview prep history and dispatch", () => {
  let directory: string;
  let dbPath: string;
  let db: Database.Database;
  const options = () => ({ appDir: directory, dbPath, configPath: path.join(directory, "config.json"), interviewCatalogAssetLoader: syntheticInterviewCatalogAsset });
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-prep-history-"));
    dbPath = path.join(directory, "jobctrl.db"); initializeExactV7Database(dbPath);
    db = new Database(dbPath); db.pragma("foreign_keys = ON");
    for (const [tenantId, jobId] of [["local", JOB_ID], ["local", OTHER_JOB_ID], ["other", JOB_ID]]) {
      db.prepare("INSERT INTO jobs (tenant_id, job_id, url, title, company, description) VALUES (?, ?, ?, 'Synthetic job', 'Example', 'Synthetic responsibilities')")
        .run(tenantId, jobId, `https://example.test/${tenantId}/${jobId}`);
    }
    db.prepare("INSERT INTO resume_templates (tenant_id,template_id,display_name,status,built_in,created_at,updated_at) VALUES ('local','built_in:modern-html','Modern HTML','active',1,'2026-10-01','2026-10-01')").run();
    db.prepare(`INSERT INTO resume_template_versions (tenant_id,version_id,template_id,version_number,display_name,status,theme_json,layout_json,content_hash,created_at)
      VALUES ('local','built_in:modern-html:v1','built_in:modern-html',1,'Modern HTML','active',?,'{}','synthetic-template','2026-10-01')`).run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME));
    db.prepare("INSERT INTO candidate_profiles (tenant_id, profile_id, version, updated_at) VALUES ('local', 'default', 1, '2026-10-01T00:00:00Z')").run();
  });
  afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  function seed(generation: number, status: string, context: unknown, tenantId = "local", jobId = JOB_ID) {
    db.prepare(`INSERT INTO job_interview_prep (tenant_id, job_id, generation, status, model, generated_at, gate_status,
      failure_reason, generation_context_json) VALUES (?, ?, ?, ?, 'synthetic', '2026-10-01T12:00:00Z', ?, ?, ?)`)
      .run(tenantId, jobId, generation, status, status === "failed" ? "failed" : "passed", status === "failed" ? "synthetic provider failure" : "", context === null ? null : JSON.stringify(context));
  }

  it("reads bounded accepted/failed history with pinned context, and marks old generations explicitly legacy", async () => {
    const context = syntheticInterviewGenerationContext(JOB_ID);
    seed(1, "accepted", null); seed(2, "accepted", context); seed(3, "failed", context);
    seed(10, "accepted", null, "other"); seed(12, "accepted", null, "local", OTHER_JOB_ID);
    const app = buildApp(options());
    const response = await app.inject({ method: "GET", url: `/v1/jobs/${JOB_ID}/interview-prep/history?pageSize=2` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ total: 3, page: 1, pageSize: 2, generations: [
      { generation: 3, status: "failed", generationContext: context, staleReasons: [] },
      { generation: 2, status: "accepted", generationContext: context, staleReasons: [] },
    ] });
    const legacy = await app.inject({ method: "GET", url: `/v1/jobs/${JOB_ID}/interview-prep/history?generation=1` });
    expect(legacy.json().generations).toEqual([expect.objectContaining({ generation: 1, generationContext: null, staleReasons: ["legacy_unbound"] })]);
    expect((await app.inject({ method: "GET", url: `/v1/jobs/${JOB_ID}/interview-prep/history?pageSize=101` })).statusCode).toBe(400);
    const prep = await app.inject({ method: "GET", url: `/v1/jobs/${JOB_ID}` });
    expect(prep.statusCode, prep.body).toBe(200);
    expect(prep.json().interviewPrep.generation).toBe(2);
    await app.close();
  });

  it("compares canonical profile, full current enrichment and catalog while preserving pinned snapshots", async () => {
    const context = syntheticInterviewGenerationContext(JOB_ID);
    seed(1, "accepted", context);
    const app = buildApp(options());
    db.prepare("UPDATE candidate_profiles SET version = 2 WHERE tenant_id='local' AND profile_id='default'").run();
    db.prepare("INSERT INTO job_enrichments (tenant_id, job_id, current_status, full_description, updated_at) VALUES ('local', ?, 'ready', ?, '2026-10-02T12:00:00Z')")
      .run(JOB_ID, "Synthetic responsibilities" + "x".repeat(13_000));
    const response = await app.inject({ method: "GET", url: `/v1/jobs/${JOB_ID}/interview-prep/history` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().generations[0]).toMatchObject({ generationContext: context, staleReasons: ["profile_changed", "job_changed"] });
    const detail = await app.inject({ method: "GET", url: `/v1/jobs/${JOB_ID}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().interviewPrep).toMatchObject({ generationContext: context, staleReasons: ["profile_changed", "job_changed"] });
    expect(JSON.parse((db.prepare("SELECT generation_context_json FROM job_interview_prep WHERE tenant_id='local' AND job_id=?").get(JOB_ID) as { generation_context_json: string }).generation_context_json)).toEqual(context);
    const changed = structuredClone(syntheticInterviewCatalogAsset().data) as InterviewCatalog;
    changed.catalogRevision = "test.2";
    expect(interviewPrepStaleReasons(db, "local", JOB_ID, context, changed, directory)).toContain("catalog_changed");
    await app.close();
  });

  it("binds current approved material bytes instead of newer unapproved provenance", () => {
    const context = syntheticInterviewGenerationContext(JOB_ID);
    const approvedPath = path.join(directory, "approved.txt"); fs.writeFileSync(approvedPath, "synthetic approved material");
    db.prepare("INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at) VALUES ('local',?,1,'approved','2026-10-01','2026-10-01')").run(JOB_ID);
    db.prepare("INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) VALUES ('local',?,1,'tailored_resume','approved-artifact','approved',?,'txt','2026-10-01')").run(JOB_ID, approvedPath);
    context.approvedMaterials = [{ materialId: "approved-artifact", generation: 1, sha256: createHash("sha256").update("synthetic approved material").digest("hex") }];
    db.prepare("INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at) VALUES ('local',?,2,'rejected','2026-10-02','2026-10-02')").run(JOB_ID);
    db.prepare("INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) VALUES ('local',?,2,'tailored_resume','rejected-artifact','rejected',?,'txt','2026-10-02')").run(JOB_ID, path.join(directory, "not-approved.txt"));
    const catalog = syntheticInterviewCatalogAsset().data as InterviewCatalog;
    expect(interviewPrepStaleReasons(db, "local", JOB_ID, context, catalog, directory)).toEqual([]);
    fs.writeFileSync(approvedPath, "changed bytes");
    expect(interviewPrepStaleReasons(db, "local", JOB_ID, context, catalog, directory)).toContain("approved_materials_changed");
    fs.rmSync(approvedPath);
    expect(interviewPrepStaleReasons(db, "local", JOB_ID, context, catalog, directory)).toContain("approved_materials_changed");
  });

  it("forwards exact bounded selection/context fields over actual TS action-to-RPC mapping", async () => {
    const context = syntheticInterviewGenerationContext(JOB_ID);
    const call = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: { runId: "synthetic-run", workflowId: "synthetic-workflow", status: "queued" } }));
    const dispatcher = createActionDispatcher({ call, close: async () => {} });
    const app = buildApp({ ...options(), actionDispatcher: dispatcher, requireHealthyWorkerForActions: false });
    const payload = { selectedQuestionIds: ["TS10", "TS09"], catalogBinding: context.catalogBinding, evidenceSelections: [{ questionId: "TS09", evidenceIds: [] }], evidenceProfileVersion: 1, interviewStage: "technical", interviewFormat: "video",
      roleLens: "staff_principal", roleResponsibilities: ["technical_strategy"], knownCriteria: ["private-bounded-criteria"], selectionRationale: "private-selection-rationale", llmModel: "synthetic" };
    const response = await app.inject({ method: "POST", url: `/v1/jobs/${JOB_ID}/actions/generate-interview-prep`, payload });
    expect(response.statusCode, response.body).toBe(202);
    expect(call).toHaveBeenCalledWith("generate_interview_prep", { ...payload, tenantId: "local", jobId: JOB_ID, expectedAppDir: directory, expectedDbPath: dbPath });
    const events = db.prepare("SELECT payload_json FROM job_events WHERE event_type='InterviewPrepRequested'").all();
    expect(JSON.stringify(events)).not.toContain("private-bounded-criteria");
    expect(JSON.stringify(events)).not.toContain("private-selection-rationale");
    await app.close();
  });
});
