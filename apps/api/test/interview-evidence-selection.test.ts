import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ActionDispatcher } from "../src/local-actions.js";
import { buildApp } from "../src/server.js";
import { syntheticInterviewCatalogAsset } from "./interview-fixture.js";
import { initializeExactDatabase } from "./exact-schema.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

describe("canonical explicit interview evidence admission", () => {
  let directory: string;
  let db: Database.Database;
  let dbPath: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-interview-choice-"));
    dbPath = path.join(directory, "jobctrl.db"); initializeExactDatabase(dbPath); db = new Database(dbPath);
    db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title) VALUES ('local',?,'https://example.test/job','Synthetic')").run(JOB_ID);
    db.prepare("INSERT INTO candidate_profiles (tenant_id,profile_id,version,updated_at) VALUES ('local','default',3,'2026-10-01')").run();
    evidence("Role_Bullet_1", 1, "supported"); evidence("verified-fact", 1, "verified"); evidence(" raw canonical ID ", 1, "supported"); evidence("x".repeat(200), 1, "supported");
    evidence("unconfirmed", 0, "supported"); evidence("inferred", 1, "inferred"); evidence("draft", 1, "draft");
    evidence("empty", 1, "supported", ""); evidence("other-tenant", 1, "supported", "Synthetic accepted fact", "other");
    evidence("other-profile", 1, "supported", "Synthetic accepted fact", "local", "alternate");
  });
  afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  function evidence(id: string, confirmed: number, strength: string, text = "Synthetic accepted fact", tenant = "local", profile = "default", index = 0) {
    db.prepare(`INSERT INTO candidate_profile_achievement_evidence
      (tenant_id,profile_id,entry_id,evidence_index,evidence_id,user_confirmed,evidence_strength,source_text)
      VALUES (?,?,?, ?,?,?,?,?)`).run(tenant, profile, id, index, id, confirmed, strength, text);
  }
  function appWith(dispatch: Mock<ActionDispatcher>) {
    return buildApp({ appDir: directory, dbPath, configPath: path.join(directory, "config.json"),
      interviewCatalogAssetLoader: syntheticInterviewCatalogAsset, actionDispatcher: dispatch, requireHealthyWorkerForActions: false });
  }
  const payload = (ids: string[]) => ({ selectedQuestionIds: ["TS09"], evidenceProfileVersion: 3,
    evidenceSelections: [{ questionId: "TS09", evidenceIds: ids }] });

  it("keeps exact user order and an explicit empty choice through dispatch", async () => {
    const dispatch = vi.fn<ActionDispatcher>(async () => ({ status: "queued" as const, runId: "synthetic" }));
    const app = appWith(dispatch);
    for (const ids of [["verified-fact", "Role_Bullet_1"], [" raw canonical ID "], ["x".repeat(200)], []]) {
      const body = payload(ids);
      const response = await app.inject({ method: "POST", url: `/v1/jobs/${JOB_ID}/actions/generate-interview-prep`, payload: body });
      expect(response.statusCode, response.body).toBe(202);
      expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject(body);
    }
    expect(JSON.stringify(db.prepare("SELECT payload_json FROM job_events").all())).not.toContain("Role_Bullet_1");
    await app.close();
  });

  it("rejects stale versions and noncanonical, unaccepted, ambiguous or foreign evidence before dispatch", async () => {
    const dispatch = vi.fn<ActionDispatcher>(); const app = appWith(dispatch);
    for (const id of ["role_bullet_1", "unknown", "unconfirmed", "inferred", "draft", "empty", "other-tenant", "other-profile"]) {
      const response = await app.inject({ method: "POST", url: `/v1/jobs/${JOB_ID}/actions/generate-interview-prep`, payload: payload([id]) });
      expect(response.statusCode, response.body).toBe(400); expect(response.json().error).toBe("invalid_evidence_selection");
    }
    const stale = await app.inject({ method: "POST", url: `/v1/jobs/${JOB_ID}/actions/generate-interview-prep`, payload: { ...payload([]), evidenceProfileVersion: 2 } });
    expect(stale.statusCode).toBe(409); expect(stale.json().error).toBe("evidence_profile_changed");
    // Even an unconfirmed duplicate makes the exact current-profile identity ambiguous.
    db.prepare(`INSERT INTO candidate_profile_achievement_evidence
      (tenant_id,profile_id,entry_id,evidence_index,evidence_id,user_confirmed,source_text)
      VALUES ('local','default','second-entry',0,'Role_Bullet_1',0,'Synthetic duplicate')`).run();
    const ambiguous = await app.inject({ method: "POST", url: `/v1/jobs/${JOB_ID}/actions/generate-interview-prep`, payload: payload(["Role_Bullet_1"]) });
    expect(ambiguous.statusCode).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE event_type='InterviewPrepRequested'").get()).toEqual({ count: 0 });
    await app.close();
  });

  it("rejects malformed choice budgets and missing fences before dispatch", async () => {
    const dispatch = vi.fn<ActionDispatcher>(); const app = appWith(dispatch);
    const valid = payload(["Role_Bullet_1"]);
    const { evidenceProfileVersion: _version, ...unfenced } = valid;
    for (const body of [unfenced, { ...valid, evidenceProfileVersion: 0 }, payload(["Role_Bullet_1", "Role_Bullet_1"]),
      payload(["x".repeat(201)]), payload(Array.from({ length: 9 }, (_, index) => `id-${index}`)),
      { ...valid, evidenceSelections: [valid.evidenceSelections[0], valid.evidenceSelections[0]] },
      { ...valid, evidenceSelections: [{ questionId: "TS10", evidenceIds: [] }] }]) {
      expect((await app.inject({ method: "POST", url: `/v1/jobs/${JOB_ID}/actions/generate-interview-prep`, payload: body })).statusCode).toBe(400);
    }
    expect(dispatch).not.toHaveBeenCalled(); await app.close();
  });
});
