import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { initializeExactDatabase } from "./exact-schema.js";
import { scoreProfileFreshness } from "../src/score-profile-freshness.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { buildApp } from "../src/server.js";

const JOB = "00000000-0000-4000-8000-000000000096";
const SCORE_ID = "1".repeat(64);
const REVIEW_ID = "2".repeat(64);
const disposals: Array<() => void> = [];
afterEach(() => { while (disposals.length) disposals.pop()?.(); });
function fixture() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-profile-score-"));
  const dbPath = path.join(appDir, "jobs.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  disposals.push(() => { db.close(); fs.rmSync(appDir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO candidate_profiles (tenant_id, profile_id, version, updated_at) VALUES ('local','default',2,'2026-10-23T00:00:00Z')").run();
  db.prepare("INSERT INTO jobs (tenant_id, job_id, url, title) VALUES ('local',?,'https://example.test/profile-score','Synthetic role')").run(JOB);
  db.prepare("INSERT INTO resume_templates (tenant_id,template_id,display_name,status,built_in,created_at,updated_at) VALUES ('local','built_in:modern-html','Modern HTML','active',1,'2026-10-23','2026-10-23')").run();
  db.prepare("INSERT INTO resume_template_versions (tenant_id,version_id,template_id,version_number,display_name,status,theme_json,layout_json,content_hash,created_at) VALUES ('local','built_in:modern-html:v1','built_in:modern-html',1,'Modern HTML','active',?,'{}','synthetic-hash','2026-10-23')").run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME));
  const trace = { profile_snapshot_version: 1, determination_id: SCORE_ID };
  db.prepare("INSERT INTO job_scores (tenant_id,job_id,version,fit_score,breakdown_json,keywords_json,scored_at,criteria_json,trace_json) VALUES ('local',?,1,8,'{}','[]','2026-10-22T00:00:00Z','{}',?)").run(JOB, JSON.stringify(trace));
  return { db, appDir, dbPath, trace };
}
function bind(db: Database.Database, verdict = "insignificant", overrides: Record<string, unknown> = {}, key = "1:default:2") {
  const result = { job_id: JOB, score_version: 1, scoring_determination_id: SCORE_ID,
    profile_id: "default", scored_profile_version: 1, reviewed_profile_version: 2,
    verdict, rationale: "Explicit synthetic profile review.", citations: [{ source_id: "after:0", quote: "Synthetic source", exact_values: [] }], ...overrides };
  const envelope = { determination_id: REVIEW_ID, input_fingerprint: REVIEW_ID, tenant_id: "local", entity_id: JOB,
    kind: "score_profile_impact", schema_version: "1", prompt_version: "score-profile-impact-v1",
    provider: "synthetic", model: "synthetic-model", reasoning_effort: "max", lane: "scoring",
    created_at: "2026-10-23T01:00:00Z", result };
  db.prepare("INSERT INTO semantic_determinations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("local", REVIEW_ID, JOB, "score_profile_impact", "1", "score-profile-impact-v1", "synthetic", "synthetic-model", "scoring", REVIEW_ID, envelope.created_at, JSON.stringify(envelope));
  db.prepare("INSERT INTO semantic_entity_bindings VALUES (?,?,?,?,?,?)")
    .run("local", "score_profile_review", JOB, key, "score_profile_impact", REVIEW_ID);
}

describe("canonical score/profile freshness", () => {
  it.each([null, {}, { profile_snapshot_version: 0 }, { profile_snapshot_version: "1" }, { profile_snapshot_version: 99 }, { profile_snapshot_version: 1, profile_inputs: { profile_id: "other", profile_version: 1 } }, { profile_snapshot_version: 1, profile_inputs: { profile_id: "default", profile_version: 2 } }])("keeps absent or incomparable provenance unknown: %j", trace => {
    const { db } = fixture();
    expect(scoreProfileFreshness(db, JOB, 1, JSON.stringify(trace)).status).toBe("unknown");
  });
  it("shows an edited profile without changing score rows, stages or files", () => {
    const { db, trace } = fixture();
    const before = db.prepare("SELECT * FROM job_scores").all();
    expect(scoreProfileFreshness(db, JOB, 1, JSON.stringify(trace))).toEqual({ status: "profile_updated", scoredProfileVersion: 1, currentProfileVersion: 2, review: null });
    expect(scoreProfileFreshness(db, JOB, 1, JSON.stringify({ ...trace, profile_snapshot_version: 2 })).status).toBe("current");
    expect(scoreProfileFreshness(db, JOB, null, null).status).toBe("not_scored");
    expect(db.prepare("SELECT * FROM job_scores").all()).toEqual(before);
  });
  it.each(["significant", "insignificant"])("reads the exact recorded %s review while retaining original score provenance", verdict => {
    const { db, trace } = fixture(); bind(db, verdict);
    expect(scoreProfileFreshness(db, JOB, 1, JSON.stringify(trace))).toMatchObject({
      status: verdict === "insignificant" ? "reviewed_unchanged" : "profile_updated",
      scoredProfileVersion: 1, currentProfileVersion: 2,
      review: { determinationId: REVIEW_ID, verdict, model: "synthetic-model", reasoningEffort: "max" },
    });
    db.prepare("UPDATE candidate_profiles SET version=3").run();
    expect(scoreProfileFreshness(db, JOB, 1, JSON.stringify(trace))).toMatchObject({ status: "profile_updated", review: null });
  });
  it.each([
    { job_id: "00000000-0000-4000-8000-000000000097" }, { score_version: 2 },
    { profile_id: "another" }, { scored_profile_version: 2 }, { reviewed_profile_version: 3 },
    { scoring_determination_id: "3".repeat(64) },
  ])("never treats foreign review bindings as current: %j", overrides => {
    const { db, trace } = fixture(); bind(db, "insignificant", overrides);
    expect(scoreProfileFreshness(db, JOB, 1, JSON.stringify(trace))).toMatchObject({ status: "profile_updated", review: null });
  });
  it("serves the badge through actual Jobs and Job Detail reads, without model calls", async () => {
    const { db, appDir, dbPath } = fixture(); bind(db);
    const app = buildApp({ appDir, dbPath, configPath: path.join(appDir, "config.json"), logger: false });
    try {
      const before = db.prepare("SELECT * FROM job_scores").all();
      for (const url of ["/v1/jobs", `/v1/jobs/${JOB}`]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, response.body).toBe(200);
        const job = url === "/v1/jobs" ? response.json().items[0] : response.json().job;
        expect(job.scoreProfileFreshness).toMatchObject({ status: "reviewed_unchanged", scoredProfileVersion: 1, currentProfileVersion: 2 });
        expect(JSON.stringify(job.scoreTrace)).not.toContain("profile_inputs");
      }
      expect(db.prepare("SELECT * FROM job_scores").all()).toEqual(before);
    } finally { await app.close(); }
  });
});
