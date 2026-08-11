import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const getJobDetail = vi.hoisted(() => vi.fn((_db: unknown, jobId: string) => ({
  ok: true,
  job: { jobKey: jobId },
})));

vi.mock("../src/read-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/read-model.js")>()),
  getJobDetail,
}));

import { hasExactV8SchemaManifest } from "../src/schema-manifest.js";
import { buildApp } from "../src/server.js";
import { initializeExactV7Database } from "./v7-schema.js";

const CORRECTED_JOB_ID = "00000000-0000-4000-8000-000000000081";
const CORRECTED_JOB_URL = "https://jobs.example.test/score-correction";
const COMPARABLE_JOB_ID = "00000000-0000-4000-8000-000000000082";
const COMPARABLE_JOB_URL = "https://jobs.example.test/comparable-score";
const directories: string[] = [];

afterEach(() => {
  getJobDetail.mockClear();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("score correction exact-v7 identity", () => {
  it("resolves URL locators at the API boundary and persists corrections, policy staleness, and events by JobId", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-score-correction-v7-"));
    directories.push(directory);
    const dbPath = path.join(directory, "jobctrl.db");
    initializeExactV7Database(dbPath);
    seedScores(dbPath);

    const app = buildApp({
      appDir: directory,
      dbPath,
      configPath: path.join(directory, "config.json"),
      logger: false,
    });
    try {
      const correctionResponse = await app.inject({
        method: "POST",
        url: `/v1/jobs/${encodeURIComponent(CORRECTED_JOB_URL)}/score-correction`,
        payload: { correctedScore: 9, reason: "Reviewed against explicit evidence" },
      });

      expect(correctionResponse.statusCode).toBe(200);
      expect(getJobDetail).toHaveBeenCalledWith(expect.anything(), CORRECTED_JOB_ID);

      const db = new Database(dbPath);
      try {
        expect(scoreRows(db, CORRECTED_JOB_ID)).toEqual([
          { tenant_id: "local", job_id: CORRECTED_JOB_ID, version: 1, fit_score: 6 },
          { tenant_id: "local", job_id: CORRECTED_JOB_ID, version: 2, fit_score: 9 },
        ]);
        expect(db.prepare("SELECT fit_score FROM jobs WHERE tenant_id = 'local' AND job_id = ?")
          .get(CORRECTED_JOB_ID)).toEqual({ fit_score: 3 });

        const policies = db.prepare(
          "SELECT tenant_id, version, anchors_json FROM scoring_policies ORDER BY version",
        ).all() as Array<{ tenant_id: string; version: number; anchors_json: string }>;
        expect(policies.map(({ tenant_id, version }) => ({ tenant_id, version }))).toEqual([
          { tenant_id: "local", version: 1 },
          { tenant_id: "local", version: 2 },
        ]);
        expect(policies[1]?.anchors_json).not.toContain(CORRECTED_JOB_URL);

        expect(db.prepare(
          `SELECT tenant_id, job_id, stale_reason, resolved
             FROM job_score_staleness`,
        ).all()).toEqual([{
          tenant_id: "local",
          job_id: COMPARABLE_JOB_ID,
          stale_reason: "scoring_policy_changed",
          resolved: 0,
        }]);
        expect(db.prepare(
          "SELECT tenant_id, job_id, state FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'",
        ).get(COMPARABLE_JOB_ID)).toEqual({
          tenant_id: "local",
          job_id: COMPARABLE_JOB_ID,
          state: "stale",
        });
        expect(scoreEvents(db)).toEqual([
          expect.objectContaining({
            tenant_id: "local",
            job_id: COMPARABLE_JOB_ID,
            identity_version: 1,
            event_type: "ScoreMarkedStale",
          }),
          expect.objectContaining({
            tenant_id: "local",
            job_id: CORRECTED_JOB_ID,
            identity_version: 1,
            event_type: "ScoreCorrected",
          }),
        ]);
        expect(hasExactV8SchemaManifest(db)).toBe(true);
      } finally {
        db.close();
      }

      const resetResponse = await app.inject({
        method: "POST",
        url: "/v1/scoring/stale-scores/actions/reset-for-rescore",
        payload: { limit: 1, jobKeys: [COMPARABLE_JOB_URL] },
      });

      expect(resetResponse.statusCode).toBe(200);
      expect(resetResponse.json()).toMatchObject({
        ok: true,
        count: 1,
        jobKeys: [COMPARABLE_JOB_ID],
      });

      const resetDb = new Database(dbPath);
      try {
        expect(resetDb.prepare(
          "SELECT resolved FROM job_score_staleness WHERE tenant_id = 'local' AND job_id = ?",
        ).get(COMPARABLE_JOB_ID)).toEqual({ resolved: 1 });
        expect(resetDb.prepare(
          "SELECT state, attempt_count FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'",
        ).get(COMPARABLE_JOB_ID)).toEqual({ state: "pending", attempt_count: 0 });
        expect(scoreEvents(resetDb).at(-1)).toEqual(expect.objectContaining({
          tenant_id: "local",
          job_id: COMPARABLE_JOB_ID,
          identity_version: 1,
          event_type: "ScoreRescoreRequested",
        }));
        expect(hasExactV8SchemaManifest(resetDb)).toBe(true);
      } finally {
        resetDb.close();
      }
    } finally {
      await app.close();
    }
  });
});

function seedScores(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    const insertJob = db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, fit_score, discovered_at)
       VALUES ('local', ?, ?, ?, 3, '2026-07-31T12:00:00Z')`,
    );
    insertJob.run(CORRECTED_JOB_ID, CORRECTED_JOB_URL, "Corrected role");
    insertJob.run(COMPARABLE_JOB_ID, COMPARABLE_JOB_URL, "Comparable role");

    const insertScore = db.prepare(
      `INSERT INTO job_scores (
         tenant_id, job_id, version, fit_score, breakdown_json, keywords_json,
         scored_at, correction_json, criteria_json, trace_json
       ) VALUES ('local', ?, 1, ?, '{}', '[]', '2026-07-31T12:01:00Z', NULL, '{}', ?)`,
    );
    const trace = JSON.stringify({
      scoring_policy_id: "local:scoring-policy-v1",
      scoring_policy_version: 1,
    });
    insertScore.run(CORRECTED_JOB_ID, 6, trace);
    insertScore.run(COMPARABLE_JOB_ID, 7, trace);

    const insertStage = db.prepare(
      `INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at)
       VALUES ('local', ?, 'score', 'succeeded', '2026-07-31T12:01:00Z')`,
    );
    insertStage.run(CORRECTED_JOB_ID);
    insertStage.run(COMPARABLE_JOB_ID);
  } finally {
    db.close();
  }
}

function scoreRows(db: Database.Database, jobId: string): unknown[] {
  return db.prepare(
    `SELECT tenant_id, job_id, version, fit_score
       FROM job_scores
      WHERE tenant_id = 'local' AND job_id = ?
      ORDER BY version`,
  ).all(jobId);
}

function scoreEvents(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare(
    `SELECT tenant_id, job_id, identity_version, event_type, payload_json
       FROM job_events
      WHERE event_type IN ('ScoreMarkedStale', 'ScoreCorrected', 'ScoreRescoreRequested')
      ORDER BY event_id`,
  ).all() as Array<Record<string, unknown>>;
}
