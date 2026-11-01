import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { resetStaleScoresForRescore } from "../src/write-model.js";
import { initializeExactDatabase } from "./exact-schema.js";

const ids = ["a", "b", "running", "queued", "pending"].map((_, index) =>
  `93000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
const [first, second, running, queued, pending] = ids as [string, string, string, string, string];

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-score-reset-"));
  const dbPath = path.join(root, "state.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  db.prepare("INSERT INTO resume_templates (tenant_id,template_id,display_name,status,built_in,created_at,updated_at) VALUES ('local','built_in:modern-html','Modern HTML','active',1,?,?)")
    .run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  db.prepare("INSERT INTO resume_template_versions (tenant_id,version_id,template_id,version_number,display_name,status,theme_json,layout_json,content_hash,created_at) VALUES ('local','built_in:modern-html:v1','built_in:modern-html',1,'Modern HTML','active',?,'{}','synthetic',?)")
    .run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME), "2026-01-01T00:00:00Z");
  const job = db.prepare("INSERT INTO jobs (tenant_id,job_id,url,discovered_at) VALUES ('local',?,?,?)");
  const score = db.prepare("INSERT INTO job_scores (tenant_id,job_id,version,fit_score,breakdown_json,keywords_json,scored_at,criteria_json,trace_json) VALUES ('local',?,1,6,'{}','[]',?,'{}','{}')");
  const stage = db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,attempt_count,updated_at,metadata_json) VALUES ('local',?,'score',?,3,?,?)");
  for (const [id, state, metadata] of [
    [first, "stale", JSON.stringify({ activityOwner: "old-owner", audit: "preserve" })], [second, "failed", null],
    [running, "running", JSON.stringify({ activityOwner: "synthetic-running" })],
    [queued, "queued", JSON.stringify({ automaticPreparation: { workflowId: "synthetic-queued" } })],
    [pending, "pending", JSON.stringify({ activityOwner: "synthetic-pending" })],
  ] as const) {
    job.run(id, `https://example.test/${id}`, "2026-01-01T00:00:00Z");
    score.run(id, "2026-01-01T00:00:00Z");
    stage.run(id, state, "2026-01-01T00:00:00Z", metadata);
  }
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,discovered_at) VALUES ('other',?,'https://other.example.test/first',?)").run(first, "2026-01-01T00:00:00Z");
  db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,updated_at,metadata_json) VALUES ('other',?,'score','running',?,?)")
    .run(first, "2026-01-01T00:00:00Z", JSON.stringify({ activityOwner: "foreign-owner" }));
  db.prepare("INSERT INTO job_score_staleness (tenant_id,job_id,stale_reason,old_policy_version,new_policy_version,marked_at,resolved) VALUES ('other',?,'foreign',1,2,?,0)")
    .run(first, "2026-01-01T00:00:00Z");
  const marker = db.prepare("INSERT INTO job_score_staleness (tenant_id,job_id,stale_reason,old_policy_version,new_policy_version,marked_at,resolved) VALUES ('local',?,?,1,2,?,0)");
  for (const [id, reason, time] of [
    [running, "running", "2026-01-01T00:00:00Z"],
    [queued, "queued", "2026-01-01T00:00:01Z"],
    [pending, "pending", "2026-01-01T00:00:02Z"],
    [first, "first", "2026-01-01T00:00:03Z"],
    [first, "second", "2026-01-01T00:00:04Z"],
    [second, "next", "2026-01-01T00:00:05Z"],
  ] as const) marker.run(id, reason, time);
  const app = buildApp({ appDir: root, dbPath, configPath: path.join(root, "config.json"), logger: false });
  return { root, db, app, cleanup: async () => { await app.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

describe("stale-score reset ownership", () => {
  it("keeps a stale marker visible in job and dashboard reads after a manual correction", async () => {
    const s = workspace();
    try {
      const markersBefore = s.db.prepare("SELECT * FROM job_score_staleness WHERE tenant_id='local' AND job_id=? ORDER BY rowid").all(first);
      const response = await s.app.inject({
        method: "POST", url: `/v1/jobs/${first}/score-correction`,
        payload: { correctedScore: 8, reason: "Synthetic manual review" },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().job).toMatchObject({ fitScore: 8, scoreVersion: 2, scoreStaleness: { isStale: true } });
      expect(s.db.prepare("SELECT * FROM job_score_staleness WHERE tenant_id='local' AND job_id=? ORDER BY rowid").all(first)).toEqual(markersBefore);
      const digest = await s.app.inject({ method: "GET", url: "/v1/digest" });
      const summary = await s.app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(digest.json().staleScores.count).toBe(5);
      expect(summary.json().preparation.outdatedScoreCount).toBe(5);
    } finally {
      await s.cleanup();
    }
  });

  it("limits distinct eligible jobs and preserves active owners on repeated requests", async () => {
    const s = workspace();
    try {
      const activeBefore = s.db.prepare("SELECT * FROM job_stage_states WHERE job_id IN (?,?,?) ORDER BY job_id").all(running, queued, pending);
      const markersBefore = s.db.prepare("SELECT * FROM job_score_staleness ORDER BY rowid").all();
      const scoresBefore = s.db.prepare("SELECT * FROM job_scores ORDER BY job_id,version").all();
      const foreignBefore = s.db.prepare("SELECT * FROM job_stage_states WHERE tenant_id='other' AND job_id=? AND stage='score'").get(first);
      const request = () => s.app.inject({ method: "POST", url: "/v1/scoring/stale-scores/actions/reset-for-rescore", payload: { limit: 1 } });
      const one = await request();
      const two = await request();
      const three = await request();
      expect(one.statusCode, one.body).toBe(200);
      expect(two.statusCode, two.body).toBe(200);
      expect(three.statusCode, three.body).toBe(200);
      expect(one.json()).toMatchObject({ count: 1, jobKeys: [first] });
      expect(two.json()).toMatchObject({ count: 1, jobKeys: [second] });
      expect(three.json()).toMatchObject({ count: 0, jobKeys: [] });
      expect(one.json().skippedActiveJobKeys).toEqual([running, queued, pending]);
      expect(two.json().alreadyPendingJobKeys).toEqual([first]);
      expect(three.json().alreadyPendingJobKeys).toEqual([first, second]);
      expect(s.db.prepare("SELECT metadata_json FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='score'").get(first))
        .toEqual({ metadata_json: JSON.stringify({ audit: "preserve" }) });
      const held = await s.app.inject({ method: "POST", url: "/v1/scoring/stale-scores/actions/reset-for-rescore", payload: { jobKeys: [running] } });
      expect(held.json()).toMatchObject({ count: 0, jobKeys: [], skippedActiveJobKeys: [running] });
      expect(s.db.prepare("SELECT * FROM job_stage_states WHERE job_id IN (?,?,?) ORDER BY job_id").all(running, queued, pending)).toEqual(activeBefore);
      expect(s.db.prepare("SELECT * FROM job_score_staleness ORDER BY rowid").all()).toEqual(markersBefore);
      expect(s.db.prepare("SELECT * FROM job_scores ORDER BY job_id,version").all()).toEqual(scoresBefore);
      expect(s.db.prepare("SELECT * FROM job_stage_states WHERE tenant_id='other' AND job_id=? AND stage='score'").get(first)).toEqual(foreignBefore);
      expect(s.db.prepare("SELECT job_id FROM job_events WHERE event_type='ScoreRescoreRequested' ORDER BY event_id").all()).toEqual([
        { job_id: first }, { job_id: second },
      ]);
    } finally {
      await s.cleanup();
    }
  });

  it("resets only active jobs before applying the limit or reporting ownership", async () => {
    const s = workspace();
    try {
      const at = "2026-01-01T00:00:00Z";
      s.db.prepare("INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at) VALUES ('local',?,?)").run(first, at);
      s.db.prepare("INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at) VALUES ('local',?,?)").run(pending, at);
      s.db.prepare("INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at,restored_at) VALUES ('local',?,?,?)").run(second, at, at);
      s.db.prepare("UPDATE job_stage_states SET state='stale' WHERE tenant_id='local' AND job_id IN (?,?) AND stage='score'").run(running, queued);
      s.db.prepare("UPDATE job_score_staleness SET marked_at='2025-01-01T00:00:00Z' WHERE tenant_id='local' AND job_id IN (?,?)").run(first, second);
      s.db.prepare("INSERT INTO jobs (tenant_id,job_id,url,discovered_at) VALUES ('other',?,'https://other.example.test/active',?)").run(running, at);
      s.db.prepare("INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at) VALUES ('other',?,?)").run(running, at);
      const inactivePostingIds = ["closed", "expired", "removed", "location_incompatible"].map((state, index) => {
        const id = `93000000-0000-4000-8000-${String(index + 6).padStart(12, "0")}`;
        s.db.prepare("INSERT INTO jobs (tenant_id,job_id,url,discovered_at) VALUES ('local',?,?,?)").run(id, `https://example.test/${id}`, at);
        s.db.prepare("INSERT INTO job_scores (tenant_id,job_id,version,fit_score,breakdown_json,keywords_json,scored_at,criteria_json,trace_json) VALUES ('local',?,1,6,'{}','[]',?,'{}','{}')").run(id, at);
        s.db.prepare("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,updated_at,metadata_json) VALUES ('local',?,'score',?,?,?)").run(id, index === 0 ? "queued" : "stale", at, JSON.stringify({ activityOwner: "keep" }));
        s.db.prepare("INSERT INTO posting_snapshot_sets (tenant_id,job_id,snapshot_set_json,latest_active_state,updated_at) VALUES ('local',?,'{}',?,?)").run(id, state, at);
        s.db.prepare("INSERT INTO job_score_staleness (tenant_id,job_id,stale_reason,old_policy_version,new_policy_version,marked_at,resolved) VALUES ('local',?,'posting',1,2,'2025-01-01T00:00:00Z',0)").run(id);
        return id;
      });
      const inactiveIds = [first, second, pending, ...inactivePostingIds];
      const placeholders = inactiveIds.map(() => "?").join(",");
      const readInactive = () => ({
        stages: s.db.prepare(`SELECT * FROM job_stage_states WHERE tenant_id='local' AND job_id IN (${placeholders}) ORDER BY job_id`).all(...inactiveIds),
        markers: s.db.prepare(`SELECT * FROM job_score_staleness WHERE tenant_id='local' AND job_id IN (${placeholders}) ORDER BY job_id,stale_reason`).all(...inactiveIds),
        scores: s.db.prepare(`SELECT * FROM job_scores WHERE tenant_id='local' AND job_id IN (${placeholders}) ORDER BY job_id,version`).all(...inactiveIds),
      });
      const before = readInactive();
      const reset = (jobKeys: string[]) => s.app.inject({ method: "POST", url: "/v1/scoring/stale-scores/actions/reset-for-rescore", payload: { jobKeys, limit: 1 } });
      const one = await reset([]);
      const two = await reset([]);
      const explicit = await reset(inactiveIds);
      expect(one.statusCode, one.body).toBe(200);
      expect(one.json()).toMatchObject({ count: 1, jobKeys: [running], skippedActiveJobKeys: [], alreadyPendingJobKeys: [] });
      expect(two.json()).toMatchObject({ count: 1, jobKeys: [queued], skippedActiveJobKeys: [], alreadyPendingJobKeys: [running] });
      expect(explicit.json()).toMatchObject({ count: 0, jobKeys: [], skippedActiveJobKeys: [], alreadyPendingJobKeys: [] });
      expect(readInactive()).toEqual(before);
      expect(s.db.prepare("SELECT job_id FROM job_events WHERE event_type='ScoreRescoreRequested' ORDER BY event_id").all()).toEqual([
        { job_id: running }, { job_id: queued },
      ]);

      s.db.prepare("UPDATE jobctrl_hidden_jobs SET unhidden_at=? WHERE tenant_id='local' AND job_id=?").run("2026-01-02T00:00:00Z", first);
      s.db.prepare("UPDATE jobctrl_deleted_jobs SET restored_at=? WHERE tenant_id='local' AND job_id=?").run("2026-01-02T00:00:00Z", second);
      expect((await reset([first, second])).json()).toMatchObject({ count: 1, jobKeys: [first] });
      expect((await reset([first, second])).json()).toMatchObject({ count: 1, jobKeys: [second] });
    } finally {
      await s.cleanup();
    }
  });

  it("takes the writer before selection and leaves a winning score owner intact", async () => {
    const s = workspace();
    const writer = new Database(path.join(s.root, "state.db"));
    try {
      s.db.pragma("busy_timeout = 0");
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("UPDATE job_stage_states SET state='running', metadata_json=? WHERE tenant_id='local' AND job_id=? AND stage='score'")
        .run(JSON.stringify({ activityOwner: "winning-owner" }), first);
      expect(() => resetStaleScoresForRescore(s.db, { jobIds: [first] })).toThrow(/locked/i);
      writer.exec("COMMIT");
      expect(resetStaleScoresForRescore(s.db, { jobIds: [first] })).toMatchObject({
        count: 0, jobKeys: [], skippedActiveJobKeys: [first],
      });
      expect(s.db.prepare("SELECT state,metadata_json FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='score'").get(first))
        .toEqual({ state: "running", metadata_json: JSON.stringify({ activityOwner: "winning-owner" }) });
      expect(s.db.prepare("SELECT COUNT(*) AS n FROM job_score_staleness WHERE tenant_id='local' AND job_id=? AND resolved=0").get(first)).toEqual({ n: 2 });
    } finally {
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
      await s.cleanup();
    }
  });

  it("rolls back the complete selected cohort when an event write fails", async () => {
    const s = workspace();
    try {
      const before = s.db.prepare("SELECT * FROM job_stage_states ORDER BY job_id").all();
      s.db.exec(`CREATE TRIGGER fail_second_reset BEFORE INSERT ON job_events WHEN NEW.event_type='ScoreRescoreRequested' AND NEW.job_id='${second}' BEGIN SELECT RAISE(ABORT, 'synthetic reset failure'); END`);
      expect(() => resetStaleScoresForRescore(s.db, { jobIds: [first, second] })).toThrow("synthetic reset failure");
      expect(s.db.prepare("SELECT * FROM job_stage_states ORDER BY job_id").all()).toEqual(before);
      expect(s.db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE event_type='ScoreRescoreRequested'").get()).toEqual({ count: 0 });
    } finally {
      await s.cleanup();
    }
  });

  it("leaves a successful reset inside a caller-owned transaction", async () => {
    const s = workspace();
    try {
      s.db.exec("BEGIN IMMEDIATE");
      s.db.prepare("UPDATE jobs SET title='synthetic caller work' WHERE tenant_id='local' AND job_id=?").run(first);
      expect(resetStaleScoresForRescore(s.db, { jobIds: [first] })).toMatchObject({ count: 1, jobKeys: [first] });
      expect(s.db.inTransaction).toBe(true);
      const observer = new Database(path.join(s.root, "state.db"), { readonly: true });
      try {
        expect(observer.prepare("SELECT state FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='score'").get(first))
          .toEqual({ state: "stale" });
      } finally {
        observer.close();
      }
      s.db.exec("ROLLBACK");
      expect(s.db.prepare("SELECT state FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='score'").get(first))
        .toEqual({ state: "stale" });
      expect(s.db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE event_type='ScoreRescoreRequested'").get()).toEqual({ count: 0 });
    } finally {
      if (s.db.inTransaction) s.db.exec("ROLLBACK");
      await s.cleanup();
    }
  });
});
