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
      company TEXT,
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
      criteria_json TEXT NOT NULL DEFAULT '{}',
      trace_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (job_url, version)
    );
    CREATE TABLE operational_attempt_metrics (
      metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      occurred_at TEXT NOT NULL,
      stage TEXT NOT NULL,
      source_id TEXT,
      source_kind TEXT,
      source_priority TEXT,
      source_role TEXT,
      adapter TEXT,
      attempt_kind TEXT NOT NULL,
      outcome TEXT NOT NULL,
      failure_category TEXT,
      is_operational_failure INTEGER NOT NULL DEFAULT 0,
      is_scrape_failure INTEGER NOT NULL DEFAULT 0,
      is_retryable INTEGER NOT NULL DEFAULT 1,
      run_id TEXT,
      job_url TEXT,
      duration_ms INTEGER,
      total_count INTEGER,
      new_count INTEGER,
      existing_count INTEGER,
      observed_count INTEGER,
      duplicate_count INTEGER,
      error_class TEXT,
      error_message TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
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
    `INSERT INTO job_scores (
      job_url, version, tenant_id, fit_score, breakdown_json, keywords_json,
      scored_at, criteria_json, trace_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      fit_band: "strong",
      confidence: "high",
      eligibility: { status: "eligible", hard_blockers: [], warnings: [] },
      matched_signals: ["event-driven architecture"],
      missing_signals: ["people management"],
      transferable_signals: ["platform ownership"],
    }),
    JSON.stringify(["python", "fastapi"]),
    "2026-05-05T09:30:00+00:00",
    JSON.stringify({
      min_fit_score: 8,
      criteria_text: "Platform reliability and distributed systems.",
      target_criteria: "Remote platform roles.",
      profile_preferences: { target_work_models: "remote" },
      criteria_version: "criteria-v2",
    }),
    JSON.stringify({
      prompt_version: "score-fit-assessment-v1",
      schema_version: "score-fit-assessment-v1",
      model: "fake-eval",
      criteria_version: "criteria-v2",
      profile_snapshot_version: 4,
      parser_warnings: [],
      correction_history: [],
    }),
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

function insertEvent(
  dbPath: string,
  eventType: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): void {
  const db = new Database(dbPath);
  db.prepare(
    "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(null, "discover", eventType, "info", eventType, occurredAt, JSON.stringify(payload));
  db.close();
}

function insertOperationalMetric(
  dbPath: string,
  values: {
    stage: string;
    attemptKind: string;
    outcome: string;
    occurredAt: string;
    sourceId?: string | null;
    sourceKind?: string | null;
    sourcePriority?: string | null;
    sourceRole?: string | null;
    adapter?: string | null;
    failureCategory?: string | null;
    operationalFailure?: boolean;
    scrapeFailure?: boolean;
    retryable?: boolean;
    runId?: string | null;
    durationMs?: number | null;
    totalCount?: number | null;
    newCount?: number | null;
    existingCount?: number | null;
    observedCount?: number | null;
    duplicateCount?: number | null;
    errorClass?: string | null;
    errorMessage?: string | null;
  },
): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO operational_attempt_metrics (
      tenant_id, occurred_at, stage, source_id, source_kind, source_priority,
      source_role, adapter, attempt_kind, outcome, failure_category,
      is_operational_failure, is_scrape_failure, is_retryable, run_id,
      duration_ms, total_count, new_count, existing_count, observed_count,
      duplicate_count, error_class, error_message, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    values.occurredAt,
    values.stage,
    values.sourceId ?? null,
    values.sourceKind ?? null,
    values.sourcePriority ?? null,
    values.sourceRole ?? null,
    values.adapter ?? null,
    values.attemptKind,
    values.outcome,
    values.failureCategory ?? null,
    values.operationalFailure ? 1 : 0,
    values.scrapeFailure ? 1 : 0,
    values.retryable === false ? 0 : 1,
    values.runId ?? null,
    values.durationMs ?? null,
    values.totalCount ?? null,
    values.newCount ?? null,
    values.existingCount ?? null,
    values.observedCount ?? null,
    values.duplicateCount ?? null,
    values.errorClass ?? null,
    values.errorMessage ?? null,
    "{}",
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

  it("projects internal preparation progress as the single discover list stage", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      const insertStage = db.prepare(
        "INSERT INTO job_stage_states (job_url, stage, state, updated_at, finished_at) VALUES (?, ?, ?, ?, ?)",
      );
      insertStage.run(
        "https://example.com/jobs/event-driven",
        "discover",
        "succeeded",
        "2026-05-04T13:00:00+00:00",
        "2026-05-04T13:00:00+00:00",
      );
      insertStage.run(
        "https://example.com/jobs/event-driven",
        "enrich",
        "succeeded",
        "2026-05-04T13:05:00+00:00",
        "2026-05-04T13:05:00+00:00",
      );
      insertStage.run(
        "https://example.com/jobs/event-driven",
        "score",
        "pending",
        "2026-05-04T13:10:00+00:00",
        null,
      );
      db.close();

      const app = buildApp({
        dbPath,
        profilePath: path.join(path.dirname(dbPath), "profile.json"),
        resumeStylePath: path.join(path.dirname(dbPath), "resume_style.json"),
        resumeTemplatePath: path.join(path.dirname(dbPath), "resume_template.tex"),
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        const listRes = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(listRes.statusCode, listRes.body).toBe(200);
        const item = listRes
          .json()
          .items.find((job: { jobKey: string }) => job.jobKey === "https://example.com/jobs/event-driven");
        expect(item).toMatchObject({
          currentStage: "discover",
          currentState: "pending",
        });

        const detailRes = await app.inject({
          method: "GET",
          url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/event-driven")}`,
        });
        expect(detailRes.statusCode, detailRes.body).toBe(200);
        expect(detailRes.json().stages).toEqual(
          expect.arrayContaining([expect.objectContaining({ stage: "score", state: "pending" })]),
        );
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("backfills legacy jobs inserted after the first projection refresh", async () => {
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
        const firstRes = await app.inject({ method: "GET", url: "/v1/jobs" });
        expect(firstRes.statusCode, firstRes.body).toBe(200);

        const db = new Database(dbPath);
        db.prepare(
          "INSERT INTO jobs (url, title, site, strategy, location, discovered_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          "https://example.com/jobs/late-legacy",
          "Late Legacy Engineer",
          "Workday",
          "workday_api",
          "Barcelona, Spain",
          "2026-05-06T09:00:00+00:00",
        );
        db.close();

        const secondRes = await app.inject({ method: "GET", url: "/v1/jobs" });
        expect(secondRes.statusCode, secondRes.body).toBe(200);
        const late = secondRes
          .json()
          .items.find((j: { jobKey: string }) => j.jobKey === "https://example.com/jobs/late-legacy");
        expect(late).toMatchObject({
          title: "Late Legacy Engineer",
          source: "Workday",
          location: "Barcelona, Spain",
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("uses explicit company from discovered jobs before source inference", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      db.prepare(
        "INSERT INTO jobs (url, title, company, site, strategy, location, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "https://www.linkedin.com/jobs/view/1",
        "Head of Engineering",
        "Keyrock",
        "linkedin",
        "jobspy",
        "Barcelona, Spain",
        "2026-05-06T09:00:00+00:00",
      );
      db.close();

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
          .items.find((j: { jobKey: string }) => j.jobKey === "https://www.linkedin.com/jobs/view/1");
        expect(item).toMatchObject({
          title: "Head of Engineering",
          company: "Keyrock",
          source: "linkedin",
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("jobs endpoints expose discovered source and posting owner separately", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE job_source_observations (
          tenant_id TEXT NOT NULL DEFAULT 'local',
          source_observation_id TEXT NOT NULL,
          job_url TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_native_id TEXT NOT NULL,
          observed_url TEXT NOT NULL,
          normalized_observed_url TEXT NOT NULL,
          run_id TEXT NOT NULL DEFAULT '',
          observed_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, source_observation_id)
        );
        CREATE TABLE job_canonical_identities (
          tenant_id TEXT NOT NULL DEFAULT 'local',
          job_url TEXT NOT NULL,
          canonical_url TEXT NOT NULL,
          ats_kind TEXT NOT NULL,
          source_native_id TEXT NOT NULL,
          confidence REAL NOT NULL,
          resolved_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, job_url)
        );
      `);
      db.prepare(
        `INSERT INTO job_source_observations (
          tenant_id, source_observation_id, job_url, source_id,
          source_native_id, observed_url, normalized_observed_url,
          run_id, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "obs-linkedin",
        "https://example.com/jobs/event-driven",
        "jobspy:linkedin",
        "https://www.linkedin.com/jobs/view/1",
        "https://www.linkedin.com/jobs/view/1",
        "https://www.linkedin.com/jobs/view/1",
        "discovery:jobspy:test",
        "2026-05-06T09:01:00+00:00",
      );
      db.prepare(
        `INSERT INTO job_canonical_identities (
          tenant_id, job_url, canonical_url, ats_kind, source_native_id,
          confidence, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "https://example.com/jobs/event-driven",
        "https://boards.greenhouse.io/acme/jobs/123456",
        "greenhouse",
        "123456",
        0.82,
        "2026-05-06T09:02:00+00:00",
      );
      db.close();

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
          discoverySource: "jobspy:linkedin",
          postingSource: "greenhouse:acme",
          postingSourceUrl: "https://boards.greenhouse.io/acme/jobs/123456",
        });

        const sourceFilteredRes = await app.inject({
          method: "GET",
          url: "/v1/jobs?source=greenhouse%3Aacme&q=event",
        });
        expect(sourceFilteredRes.statusCode, sourceFilteredRes.body).toBe(200);
        expect(sourceFilteredRes.json().items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              jobKey: "https://example.com/jobs/event-driven",
              postingSource: "greenhouse:acme",
            }),
          ]),
        );

        const detailRes = await app.inject({
          method: "GET",
          url: "/v1/jobs/https%3A%2F%2Fexample.com%2Fjobs%2Fevent-driven",
        });
        expect(detailRes.statusCode, detailRes.body).toBe(200);
        expect(detailRes.json().job).toMatchObject({
          discoverySource: "jobspy:linkedin",
          postingSource: "greenhouse:acme",
          postingSourceUrl: "https://boards.greenhouse.io/acme/jobs/123456",
        });
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
            fitBand: "strong",
            confidence: "high",
            matchedSignals: ["event-driven architecture"],
            missingSignals: ["people management"],
            transferableSignals: ["platform ownership"],
          },
          scoreKeywords: ["python", "fastapi"],
          scoreReasoning: "Latest structured score evidence.",
          scoreVersion: 2,
          scoredAt: "2026-05-05T09:30:00+00:00",
          scoreCriteria: {
            minFitScore: 8,
            criteriaText: "Platform reliability and distributed systems.",
            targetCriteria: "Remote platform roles.",
            criteriaVersion: "criteria-v2",
          },
          scoreTrace: {
            promptVersion: "score-fit-assessment-v1",
            schemaVersion: "score-fit-assessment-v1",
            model: "fake-eval",
            criteriaVersion: "criteria-v2",
            profileSnapshotVersion: 4,
            parserWarnings: [],
            correctionHistory: [],
          },
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
            fitBand: "strong",
            confidence: "high",
            matchedSignals: ["event-driven architecture"],
            missingSignals: ["people management"],
            transferableSignals: ["platform ownership"],
          },
          scoreKeywords: ["python", "fastapi"],
          scoreReasoning: "Latest structured score evidence.",
          scoreVersion: 2,
          scoredAt: "2026-05-05T09:30:00+00:00",
          scoreCriteria: {
            minFitScore: 8,
            criteriaText: "Platform reliability and distributed systems.",
            targetCriteria: "Remote platform roles.",
            criteriaVersion: "criteria-v2",
          },
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("rebuilds source health from discovery, enrichment, and content events", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      insertEvent(dbPath, "DiscoveryRunStarted", "2026-05-13T00:00:00Z", {
        runId: "run-source-quality",
        sourceIds: ["greenhouse:acme"],
        startedAt: "2026-05-13T00:00:00Z",
      });
      insertEvent(dbPath, "JobSourceObserved", "2026-05-13T00:00:05Z", {
        jobId: "job-1",
        sourceObservationId: "obs-1",
        sourceId: "greenhouse:acme",
      });
      insertEvent(dbPath, "PostingContentSnapshotCaptured", "2026-05-13T00:00:10Z", {
        jobId: "job-1",
        sourceId: "greenhouse:acme",
      });
      insertEvent(dbPath, "JobEnriched", "2026-05-13T00:00:12Z", {
        jobId: "job-1",
        fullDescription: "Complete posting",
        applicationUrl: "https://acme.example/apply/1",
      });
      insertEvent(dbPath, "JobActiveStateChanged", "2026-05-13T00:00:15Z", {
        jobId: "job-1",
        activeState: "active",
      });
      insertEvent(dbPath, "JobSourceObserved", "2026-05-13T00:00:20Z", {
        jobId: "job-2",
        sourceObservationId: "obs-2",
        sourceId: "greenhouse:acme",
      });
      insertEvent(dbPath, "EnrichmentFailed", "2026-05-13T00:00:25Z", {
        jobId: "job-2",
        error: "TimeoutError",
        attemptNumber: 1,
      });
      insertEvent(dbPath, "ContentDuplicateCandidateDetected", "2026-05-13T00:00:30Z", {
        jobId: "job-1",
        candidateJobId: "job-2",
        confidence: 0.91,
      });
      insertEvent(dbPath, "DiscoveryRunCompleted", "2026-05-13T00:01:00Z", {
        runId: "run-source-quality",
        counts: {
          total: 2,
          newJobs: 2,
          observedJobs: 2,
        },
        completedAt: "2026-05-13T00:01:00Z",
      });

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
        const [source] = res.json().sourceHealth;
        expect(source).toMatchObject({
          sourceId: "greenhouse:acme",
          runCount: 1,
          observedJobs: 2,
          newJobs: 2,
          duplicateRate: 0.5,
          activeVerificationRate: 1,
          fullDescriptionSuccessRate: 0.5,
          applyUrlSuccessRate: 0.5,
          lastRunId: "run-source-quality",
          lastErrorClass: "TimeoutError",
          recommendedState: "normal",
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("does not reset failed sources on partial discovery completion", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      for (let i = 0; i < 3; i += 1) {
        insertEvent(dbPath, "DiscoveryRunFailed", `2026-05-13T00:0${i}:00Z`, {
          runId: `prior-${i}`,
          sourceId: "lever:acme",
          errorClass: "TimeoutError",
          retryable: true,
        });
      }
      insertEvent(dbPath, "DiscoveryRunStarted", "2026-05-13T00:10:00Z", {
        runId: "mixed-run",
        sourceIds: ["greenhouse:acme", "lever:acme"],
        startedAt: "2026-05-13T00:10:00Z",
      });
      insertEvent(dbPath, "DiscoveryRunFailed", "2026-05-13T00:10:20Z", {
        runId: "mixed-run",
        sourceId: "lever:acme",
        errorClass: "TimeoutError",
        retryable: true,
      });
      insertEvent(dbPath, "DiscoveryRunCompleted", "2026-05-13T00:11:00Z", {
        runId: "mixed-run",
        counts: { total: 1, newJobs: 1, observedJobs: 1 },
        failedSourceIds: ["lever:acme"],
        completedAt: "2026-05-13T00:11:00Z",
      });

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
        const sources = new Map(
          res.json().sourceHealth.map((source: { sourceId: string }) => [source.sourceId, source]),
        );
        expect(sources.get("greenhouse:acme")).toMatchObject({
          sourceId: "greenhouse:acme",
          runCount: 1,
          consecutiveFailures: 0,
          recommendedState: "normal",
          lastRunId: "mixed-run",
        });
        expect(sources.get("lever:acme")).toMatchObject({
          sourceId: "lever:acme",
          runCount: 0,
          failedRunCount: 4,
          consecutiveFailures: 4,
          recommendedState: "quarantined",
          lastRunId: "mixed-run",
          lastErrorClass: "TimeoutError",
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("exposes structured operational metrics without parsing free-text events", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      insertOperationalMetric(dbPath, {
        stage: "discover",
        attemptKind: "discovery_source",
        outcome: "failed",
        occurredAt: "2026-05-14T00:00:00Z",
        sourceId: "jobspy:linkedin",
        sourceKind: "broad_board",
        sourcePriority: "lead_generator",
        sourceRole: "lead_generator",
        adapter: "jobspy",
        failureCategory: "timeout",
        operationalFailure: true,
        scrapeFailure: true,
        retryable: true,
        runId: "run-jobspy-timeout",
        durationMs: 1200,
        observedCount: 3,
        errorClass: "TimeoutError",
        errorMessage: "Fetch timed out",
      });
      insertOperationalMetric(dbPath, {
        stage: "discover",
        attemptKind: "discovery_source",
        outcome: "succeeded",
        occurredAt: "2026-05-14T00:01:00Z",
        sourceId: "workday:acme",
        sourceKind: "ats_api",
        sourcePriority: "canonical",
        sourceRole: "canonical_source",
        adapter: "workday",
        runId: "run-workday-success",
        durationMs: 400,
        newCount: 1,
        observedCount: 1,
      });
      insertOperationalMetric(dbPath, {
        stage: "score",
        attemptKind: "pipeline_stage",
        outcome: "succeeded",
        occurredAt: "2026-05-14T00:02:00Z",
        durationMs: 80,
        totalCount: 1,
      });

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
        expect(body.operationalMetrics).toMatchObject({
          attempts: 3,
          failures: 1,
          operationalFailures: 1,
          scrapeFailures: 1,
          retryableFailures: 1,
        });
        expect(body.operationalMetrics.byStage).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              stage: "discover",
              attempts: 2,
              failures: 1,
              scrapeFailures: 1,
              lastFailureCategory: "timeout",
              lastErrorClass: "TimeoutError",
            }),
            expect.objectContaining({
              stage: "score",
              attempts: 1,
              failures: 0,
              lastOutcome: "succeeded",
            }),
          ]),
        );
        expect(body.operationalMetrics.bySource).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceId: "jobspy:linkedin",
              adapter: "jobspy",
              sourceRole: "lead_generator",
              failures: 1,
              scrapeFailures: 1,
              lastRunId: "run-jobspy-timeout",
            }),
            expect.objectContaining({
              sourceId: "workday:acme",
              adapter: "workday",
              sourceRole: "canonical_source",
              failures: 0,
              lastRunId: "run-workday-success",
            }),
          ]),
        );
        expect(body.sourceHealth).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceId: "jobspy:linkedin",
              operationalFailureCount: 1,
              scrapeFailureCount: 1,
              retryableFailureCount: 1,
              lastFailureCategory: "timeout",
              lastErrorClass: "TimeoutError",
            }),
          ]),
        );
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });
});
