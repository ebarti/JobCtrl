/**
 * PR 4 of the Temporal stack: the TS API reads ``apply_run_projections``
 * directly. The bespoke ``apply_runs`` / ``apply_run_events`` tables
 * are no longer required for the read-model to function, and the
 * Python projection builder now owns ``apply_run_projections``
 * materialisation from ``job_events``.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";

import { buildApp } from "../src/server.js";

function withTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-projections-"));
  const dbPath = path.join(dir, "jobs.db");
  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function seedSchema(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      title TEXT,
      site TEXT,
      strategy TEXT,
      location TEXT,
      salary TEXT,
      discovered_at TEXT,
      application_url TEXT,
      description TEXT,
      full_description TEXT,
      detail_scraped_at TEXT,
      detail_error TEXT,
      fit_score INTEGER,
      score_reasoning TEXT,
      scored_at TEXT,
      tailored_resume_path TEXT,
      tailored_at TEXT,
      tailor_attempts INTEGER DEFAULT 0,
      cover_letter_path TEXT,
      cover_letter_at TEXT,
      cover_attempts INTEGER DEFAULT 0,
      applied_at TEXT,
      apply_status TEXT,
      apply_error TEXT,
      apply_attempts INTEGER DEFAULT 0,
      agent_id TEXT,
      last_attempted_at TEXT,
      apply_duration_ms INTEGER,
      apply_task_id TEXT,
      verification_confidence TEXT
    );
    CREATE TABLE job_stage_states (
      job_url TEXT NOT NULL,
      stage TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER DEFAULT 0,
      max_attempts INTEGER,
      started_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT,
      duration_ms INTEGER,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER DEFAULT 1,
      blocked_by_json TEXT,
      next_action TEXT,
      metadata_json TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (job_url, stage)
    );
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      stage TEXT,
      event_type TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT
    );
    CREATE TABLE apply_run_projections (
      run_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      job_title TEXT NOT NULL DEFAULT '',
      job_employer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      result TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      worker_id INTEGER,
      model TEXT,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      events_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE job_scores (
      job_url TEXT NOT NULL,
      version INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      fit_score INTEGER NOT NULL,
      breakdown_json TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      scored_at TEXT NOT NULL,
      correction_json TEXT,
      PRIMARY KEY (job_url, version)
    );
  `);
  db.prepare(
    "INSERT INTO jobs (url, title, site, fit_score, score_reasoning, application_url) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "https://example.com/jobs/event-driven",
    "Event-Driven Engineer",
    "ExampleCo",
    9,
    "Legacy reasoning kept for old callers.",
    "https://example.com/apply/event",
  );
  db.prepare(
    "INSERT INTO job_scores (job_url, version, tenant_id, fit_score, breakdown_json, keywords_json, scored_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "https://example.com/jobs/event-driven",
    1,
    "local",
    7,
    JSON.stringify({
      technical_fit: 7,
      experience_fit: 6,
      role_fit: 7,
      reasoning: "Older score evidence.",
    }),
    JSON.stringify(["python"]),
    "2026-05-04T11:00:00+00:00",
  );
  db.prepare(
    "INSERT INTO job_scores (job_url, version, tenant_id, fit_score, breakdown_json, keywords_json, scored_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "https://example.com/jobs/event-driven",
    2,
    "local",
    8,
    JSON.stringify({
      technical_fit: 9,
      experience_fit: 7,
      role_fit: 8,
      reasoning: "Latest structured score evidence.",
    }),
    JSON.stringify(["python", "fastapi"]),
    "2026-05-05T09:30:00+00:00",
  );
  db.prepare(
    "INSERT INTO apply_run_projections (run_id, job_id, job_title, job_employer, status, result, dry_run, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "run-event-driven",
    "https://example.com/jobs/event-driven",
    "Event-Driven Engineer",
    "ExampleCo",
    "succeeded",
    "applied",
    0,
    "2026-05-04T13:00:00+00:00",
    "2026-05-04T13:05:00+00:00",
  );
  db.close();
}

describe("apply_run_projections without legacy apply_runs table", () => {
  it("dashboard summary surfaces the projection row when apply_runs is absent", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);

      const app = buildApp({
        dbPath,
        profilePath: path.join(path.dirname(dbPath), "profile.json"),
        resumeStylePath: path.join(path.dirname(dbPath), "resume_style.json"),
        resumeTemplatePath: path.join(path.dirname(dbPath), "resume_template.tex"),
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json();
        const run = body.applyRuns.find(
          (r: { runId: string }) => r.runId === "run-event-driven",
        );
        expect(run).toBeDefined();
        expect(run.status).toBe("succeeded");
        expect(run.title).toBe("Event-Driven Engineer");
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("jobs list derives applyStatus + appliedAt from apply_run_projections", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const app = buildApp({
        dbPath,
        profilePath: path.join(path.dirname(dbPath), "profile.json"),
        resumeStylePath: path.join(path.dirname(dbPath), "resume_style.json"),
        resumeTemplatePath: path.join(path.dirname(dbPath), "resume_template.tex"),
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/jobs" });
        expect(res.statusCode, res.body).toBe(200);
        const item = res
          .json()
          .items.find((j: { jobKey: string }) => j.jobKey === "https://example.com/jobs/event-driven");
        expect(item).toBeDefined();
        expect(item.applyStatus).toBe("applied");
        expect(item.appliedAt).toBe("2026-05-04T13:05:00+00:00");
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("jobs endpoints expose latest score evidence from job_scores", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const app = buildApp({
        dbPath,
        profilePath: path.join(path.dirname(dbPath), "profile.json"),
        resumeStylePath: path.join(path.dirname(dbPath), "resume_style.json"),
        resumeTemplatePath: path.join(path.dirname(dbPath), "resume_template.tex"),
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        const listRes = await app.inject({ method: "GET", url: "/v1/jobs" });
        expect(listRes.statusCode, listRes.body).toBe(200);
        const item = listRes
          .json()
          .items.find((j: { jobKey: string }) => j.jobKey === "https://example.com/jobs/event-driven");
        expect(item).toMatchObject({
          fitScore: 8,
          scoreBreakdown: {
            technicalFit: 9,
            experienceFit: 7,
            roleFit: 8,
            reasoning: "Latest structured score evidence.",
          },
          scoreKeywords: ["python", "fastapi"],
          scoreReasoning: "Latest structured score evidence.",
          scoreVersion: 2,
          scoredAt: "2026-05-05T09:30:00+00:00",
        });

        const detailRes = await app.inject({
          method: "GET",
          url: "/v1/jobs/https%3A%2F%2Fexample.com%2Fjobs%2Fevent-driven",
        });
        expect(detailRes.statusCode, detailRes.body).toBe(200);
        expect(detailRes.json().job).toMatchObject({
          fitScore: 8,
          scoreBreakdown: {
            technicalFit: 9,
            experienceFit: 7,
            roleFit: 8,
            reasoning: "Latest structured score evidence.",
          },
          scoreKeywords: ["python", "fastapi"],
          scoreReasoning: "Latest structured score evidence.",
          scoreVersion: 2,
          scoredAt: "2026-05-05T09:30:00+00:00",
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });
});
