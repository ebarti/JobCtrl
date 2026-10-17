import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { initializeExactDatabase } from "./exact-schema.js";
import { buildApp } from "../src/server.js";
import { EMPLOYER_ANALYSIS_PROMPT_VERSION } from "../src/contracts.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import {
  ensureJobDetailProjection, jobDetailWatermarkName, REFRESH_EVENT_BATCH_LIMIT,
  refreshJobDetailProjections, refreshProjections, repairJobDetailProjections,
} from "../src/projections.js";

const JOB = "00000000-0000-4000-8000-000000000101";
const PEER = "00000000-0000-4000-8000-000000000102";
const owned: Array<() => void> = [];
afterEach(() => { for (const cleanup of owned.splice(0).reverse()) cleanup(); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-detail-authority-"));
  owned.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "jobctrl.db");
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, "{}");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.prepare(`INSERT INTO resume_templates
    (tenant_id,template_id,display_name,status,built_in,created_at,updated_at)
    VALUES ('local','built_in:modern-html','Modern HTML','active',1,'2026-10-17','2026-10-17')`).run();
  db.prepare(`INSERT INTO resume_template_versions
    (tenant_id,version_id,template_id,version_number,display_name,status,theme_json,layout_json,content_hash,created_at)
    VALUES ('local','built_in:modern-html:v1','built_in:modern-html',1,'Modern HTML','active',?,'{}','fixture','2026-10-17')`)
    .run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME));
  owned.push(() => db.close());
  return { db, dir, dbPath, configPath };
}
function job(db: Database.Database, jobId = JOB, tenant = "local") {
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,description) VALUES (?,?,?,'Synthetic job','Original')")
    .run(tenant, jobId, `https://example.invalid/${jobId}`);
}
function event(db: Database.Database, jobId: string | null = JOB, tenant = "local") {
  db.prepare(`INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,occurred_at,payload_json)
    VALUES (?,?,1,'enrich','JobEnriched','2026-10-17T10:00:00Z','{}')`).run(tenant, jobId);
}
function detail(db: Database.Database, jobId = JOB, tenant = "local") {
  return db.prepare("SELECT * FROM job_detail_projections WHERE tenant_id=? AND job_id=?").get(tenant, jobId);
}
function cursor(db: Database.Database, tenant = "local") {
  return db.prepare("SELECT last_event_id FROM event_watermarks WHERE projection_name=?")
    .get(jobDetailWatermarkName(tenant)) as { last_event_id: number } | undefined;
}

describe("TypeScript job-detail family authority", () => {
  it("initializes from canonical state independently of existing runtime and foreign-tenant cursors", () => {
    const { db } = fixture();
    job(db); job(db, PEER, "python:local");
    event(db); event(db, PEER, "python:local");
    db.prepare("INSERT INTO event_watermarks VALUES ('python:operations_projections:local',9000,'old')").run();
    expect(refreshJobDetailProjections(db)).toBe(false);
    expect(detail(db)).toMatchObject({ description_preview: "Original" });
    expect(detail(db, PEER, "python:local")).toBeUndefined();
    expect(cursor(db)?.last_event_id).toBe(1);
    refreshJobDetailProjections(db, "python:local");
    expect(cursor(db, "python:local")?.last_event_id).toBe(2);
    expect(db.prepare("SELECT last_event_id FROM event_watermarks WHERE projection_name='python:operations_projections:local'").get())
      .toEqual({ last_event_id: 9000 });
  });

  it("bounds incremental work and gives the requested job read-after-write without skipping unrelated events", () => {
    const { db } = fixture();
    job(db); job(db, PEER); repairJobDetailProjections(db);
    db.transaction(() => { for (let i = 0; i < REFRESH_EVENT_BATCH_LIMIT; i++) event(db, PEER); })();
    db.prepare("UPDATE jobs SET description='Updated' WHERE job_id=?").run(JOB);
    event(db);
    expect(refreshJobDetailProjections(db)).toBe(true);
    expect(cursor(db)?.last_event_id).toBe(REFRESH_EVENT_BATCH_LIMIT);
    expect(detail(db)).toMatchObject({ description_preview: "Original" });
    ensureJobDetailProjection(db, "local", JOB);
    expect(detail(db)).toMatchObject({ description_preview: "Updated" });
    expect(cursor(db)?.last_event_id).toBe(REFRESH_EVENT_BATCH_LIMIT);
    expect(refreshJobDetailProjections(db)).toBe(false);
    expect(cursor(db)?.last_event_id).toBe(REFRESH_EVENT_BATCH_LIMIT + 1);
  });

  it.each([false, true])("does no detail writes on a settled pass with a writer holding SQLite (different JSON formatting: %s)", (differentFormatting) => {
    const { db, dbPath } = fixture(); job(db); refreshProjections(db);
    if (differentFormatting) {
      const list = db.prepare("SELECT compensation_summary_json FROM job_list_projections WHERE job_id=?")
        .get(JOB) as { compensation_summary_json: string };
      const reordered = Object.fromEntries(Object.entries(JSON.parse(list.compensation_summary_json)).reverse());
      db.prepare("UPDATE job_list_projections SET compensation_summary_json=? WHERE job_id=?")
        .run(JSON.stringify(reordered, null, 2), JOB);
    }
    const before = detail(db);
    const observer = new Database(dbPath);
    try {
      observer.exec("BEGIN IMMEDIATE");
      db.pragma("busy_timeout = 1");
      expect(refreshJobDetailProjections(db)).toBe(false);
      ensureJobDetailProjection(db, "local", JOB);
      expect(detail(db)).toEqual(before);
    } finally { observer.exec("ROLLBACK"); observer.close(); }
  });

  it("rolls back the complete publication and cursor on failure, then recovers a missed notification", () => {
    const { db } = fixture(); job(db); refreshProjections(db);
    const before = detail(db); const oldCursor = cursor(db);
    const beforeList = db.prepare("SELECT * FROM job_list_projections WHERE job_id=?").get(JOB);
    db.prepare("UPDATE jobs SET description='Committed without a bus notification' WHERE job_id=?").run(JOB);
    event(db);
    db.exec(`CREATE TEMP TRIGGER fail_detail BEFORE UPDATE ON job_detail_projections
      BEGIN SELECT RAISE(ABORT, 'injected detail failure'); END`);
    expect(() => ensureJobDetailProjection(db, "local", JOB)).toThrow("injected detail failure");
    expect(db.prepare("SELECT * FROM job_list_projections WHERE job_id=?").get(JOB)).toEqual(beforeList);
    expect(detail(db)).toEqual(before);
    expect(() => refreshJobDetailProjections(db)).toThrow("injected detail failure");
    expect(detail(db)).toEqual(before); expect(cursor(db)).toEqual(oldCursor);
    db.exec("DROP TRIGGER fail_detail");
    refreshJobDetailProjections(db);
    expect(detail(db)).toMatchObject({ description_preview: "Committed without a bus notification" });
  });

  it("keeps a nested refresh inside its caller's rollback boundary", () => {
    const { db } = fixture(); job(db); repairJobDetailProjections(db);
    const before = detail(db); const oldCursor = cursor(db);
    db.exec("BEGIN");
    db.prepare("UPDATE jobs SET description='Uncommitted' WHERE job_id=?").run(JOB); event(db);
    refreshJobDetailProjections(db);
    expect(detail(db)).toMatchObject({ description_preview: "Uncommitted" });
    db.exec("ROLLBACK");
    expect(detail(db)).toEqual(before); expect(cursor(db)).toEqual(oldCursor);
  });

  it("repairs missing rows and orphan deletion explicitly, preserving foreign tenants", () => {
    const { db } = fixture(); job(db); job(db, PEER, "peer");
    repairJobDetailProjections(db); repairJobDetailProjections(db, "peer");
    const foreign = detail(db, PEER, "peer");
    db.prepare("DELETE FROM job_detail_projections WHERE tenant_id='local'").run();
    // A normal event pass does not hide a full missing-row scan.
    refreshJobDetailProjections(db); expect(detail(db)).toBeUndefined();
    ensureJobDetailProjection(db, "local", JOB); expect(detail(db)).toBeDefined();
    db.prepare("DELETE FROM jobs WHERE tenant_id='local'").run();
    repairJobDetailProjections(db);
    expect(detail(db)).toBeUndefined(); expect(detail(db, PEER, "peer")).toEqual(foreign);
  });

  it("preserves accepted artifact bytes, registrations and approval bindings through repair and failure", () => {
    const { db, dir } = fixture(); job(db);
    const artifactPath = path.join(dir, "accepted.txt");
    fs.writeFileSync(artifactPath, "Owned synthetic accepted material");
    db.prepare(`INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at)
      VALUES ('local',?,1,'approved','2026-10-17','2026-10-17')`).run(JOB);
    db.prepare(`INSERT INTO job_materials_artifacts
      (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at)
      VALUES ('local',?,1,'tailored_resume','accepted','approved',?,'txt','2026-10-17')`).run(JOB, artifactPath);
    db.prepare(`INSERT INTO application_review_decisions
      (tenant_id,decision_id,job_id,decision,decided_at,materials_generation,profile_version,application_url)
      VALUES ('local','approval',?,'approved','2026-10-17',1,7,'https://example.invalid/apply')`).run(JOB);
    const canonical = () => ["job_materials", "job_materials_artifacts", "application_review_decisions"]
      .map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const before = canonical();
    repairJobDetailProjections(db);
    db.exec(`CREATE TEMP TRIGGER fail_repair BEFORE UPDATE ON job_detail_projections
      BEGIN SELECT RAISE(ABORT, 'failed repair'); END`);
    expect(() => repairJobDetailProjections(db)).toThrow("failed repair");
    expect(canonical()).toEqual(before);
    expect(fs.readFileSync(artifactPath, "utf8")).toBe("Owned synthetic accepted material");
  });

  it.each([
    { surface: "Apply Review", state: "backlogged" },
    { surface: "Apply Review", state: "missing" },
    { surface: "Apply Review", state: "missed notification" },
    { surface: "Job Detail", state: "backlogged" },
    { surface: "Job Detail", state: "missing" },
    { surface: "Job Detail", state: "missed notification" },
  ])("serves coherent score and evidence through $surface with $state", async ({ surface, state }) => {
    const { db, dbPath, dir, configPath } = fixture();
    job(db); job(db, PEER);
    db.prepare(`INSERT INTO job_stage_states (tenant_id,job_id,stage,state,updated_at)
      VALUES ('local',?,'apply','pending','2026-10-17T10:00:00Z')`).run(JOB);
    db.prepare(`INSERT INTO job_employer_analysis
      (tenant_id,job_id,generation,snapshot_hash,prompt_version,sdk_set_version,cache_key,inferred_seniority,
       requirements_json,legs_attempted,legs_succeeded,created_at)
      VALUES ('local',?,1,'fixture',?,'fixture','fixture','senior',?,1,1,'2026-10-17')`)
      .run(JOB, EMPLOYER_ANALYSIS_PROMPT_VERSION, JSON.stringify([
        { id: "r1", text: "Own platform reliability", tier: "must_have", weight: 0.9,
          evidence_span: "Own platform reliability" },
      ]));
    const score = (version: number) => {
      db.prepare(`INSERT INTO job_scores
        (tenant_id,job_id,version,fit_score,breakdown_json,keywords_json,scored_at)
        VALUES ('local',?,?,?,'{}','[]','2026-10-17')`).run(JOB, version, version === 1 ? 9 : 3);
      db.prepare(`INSERT INTO job_requirement_fit_reports
        (tenant_id,job_id,score_version,employer_analysis_generation,profile_snapshot_version,
         scoring_policy_version,formula_version,resolved_fit_score,fit_band,confidence,summary_json,created_at)
        VALUES ('local',?,?,1,1,1,'requirement-fit-v1',?,'strong','high',?,'2026-10-17')`)
        .run(JOB, version, version === 1 ? 9 : 3, JSON.stringify({
          weighted_fit: 0.5, must_have_coverage: 0.5, blocker_count: 0, missing_high_weight_count: 0,
        }));
      db.prepare(`INSERT INTO job_requirement_fit_items
        (tenant_id,job_id,score_version,requirement_id,requirement_text,tier,weight,
         job_evidence_span,fit_json,contribution_json,tailoring_json,position)
        VALUES ('local',?,?,'r1','Own platform reliability','must_have',0.9,
          'Own platform reliability',?,?,?,0)`)
        .run(JOB, version, JSON.stringify(version === 1
          ? { kind: "matched", evidence_ids: ["ev-1"], strength: "direct" }
          : { kind: "missing", evidence_ids: [], reason: "no_evidence" }),
        JSON.stringify({ max_points: 1, awarded_points: version === 1 ? 1 : 0,
          weighted_impact: version === 1 ? 1 : 0, rationale: "Synthetic score" }),
        JSON.stringify({ action: "double_down", priority: 0.9, allowed_evidence_ids: ["ev-1"],
          target_keywords: [], prohibited_claims: [], instruction: "Synthetic" }));
    };
    score(1);
    const app = buildApp({ dbPath, configPath, appDir: dir });
    try {
      const baseline = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });
      expect(baseline.statusCode, baseline.body).toBe(200);
      expect(baseline.json().items[0].position.idealRequirements[0].fit.kind).toBe("matched");
      score(2);
      // Python can publish the shared list before the independent detail owner.
      if (state !== "missed notification") {
        db.prepare("UPDATE job_list_projections SET score_version=2,fit_score=3 WHERE job_id=?").run(JOB);
      }
      if (state === "missing") {
        db.prepare("DELETE FROM job_detail_projections WHERE job_id=?").run(JOB);
      } else {
        db.transaction(() => {
          for (let i = 0; i < 5 * REFRESH_EVENT_BATCH_LIMIT; i++) event(db, PEER);
          event(db);
        })();
        expect(detail(db)).toMatchObject({ score_version: 1 });
      }
      const response = await app.inject({ method: "GET",
        url: surface === "Apply Review" ? "/v1/apply/review-queue" : `/v1/jobs/${JOB}` });
      expect(response.statusCode, response.body).toBe(200);
      if (surface === "Apply Review") {
        const item = response.json().items.find((row: { jobKey: string }) => row.jobKey === JOB);
        expect(item).toMatchObject({ scoreVersion: 2, fitScore: 3 });
        expect(item.position.idealRequirements[0].fit.kind).toBe("missing");
      } else {
        const body = response.json();
        expect(body.job).toMatchObject({ scoreVersion: 2, fitScore: 3 });
        expect(body.requirementFitReport).toMatchObject({ scoreVersion: 2 });
        expect(body.requirementFitReport.assessments[0].fit.kind).toBe("missing");
      }
    } finally { await app.close(); }
  });

  it("repairs an eventless canonical update on API restart and serves real Job Detail", async () => {
    const { db, dbPath, dir, configPath } = fixture(); job(db);
    repairJobDetailProjections(db);
    db.prepare("UPDATE jobs SET description='Recovered after restart' WHERE job_id=?").run(JOB);
    const app = buildApp({ dbPath, configPath, appDir: dir });
    try {
      const response = await app.inject({ method: "GET", url: `/v1/jobs/${JOB}` });
      expect(response.statusCode, response.body).toBe(200);
      expect(JSON.stringify(response.json())).toContain("Recovered after restart");
      expect(detail(db)).toMatchObject({ description_preview: "Recovered after restart" });
    } finally { await app.close(); }
  });
});
