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

function insertCompensationRows(dbPath: string): void {
  const db = new Database(dbPath);
  const jobUrl = "https://example.com/jobs/event-driven";
  db.prepare("UPDATE jobs SET salary = ? WHERE url = ?").run("EUR 70000-90000/year", jobUrl);
  db.exec(`
    CREATE TABLE job_posted_compensation_facts (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      source_field TEXT NOT NULL DEFAULT 'jobs.salary',
      source_text TEXT,
      legacy_raw_salary TEXT,
      parse_state TEXT NOT NULL,
      currency TEXT,
      period TEXT NOT NULL DEFAULT 'unknown',
      component TEXT NOT NULL DEFAULT 'unknown',
      minimum_amount INTEGER,
      maximum_amount INTEGER,
      annualized_minimum_amount INTEGER,
      annualized_maximum_amount INTEGER,
      annualization_assumption TEXT,
      confidence TEXT NOT NULL DEFAULT 'none',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      parser_version TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      parsed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_url)
    );
    CREATE TABLE job_market_compensation_estimates (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      estimate_state TEXT NOT NULL,
      currency TEXT,
      period TEXT NOT NULL DEFAULT 'year',
      component TEXT NOT NULL DEFAULT 'base_salary',
      minimum_amount INTEGER,
      maximum_amount INTEGER,
      confidence_band TEXT NOT NULL DEFAULT 'none',
      confidence_score REAL NOT NULL DEFAULT 0,
      source_count INTEGER NOT NULL DEFAULT 0,
      sample_count INTEGER,
      aggregate_bucket TEXT,
      geography_scope TEXT,
      occupation_code TEXT,
      occupation_label TEXT,
      seniority_label TEXT,
      source_snapshot_json TEXT NOT NULL DEFAULT '[]',
      factor_reasons_json TEXT NOT NULL DEFAULT '[]',
      insufficient_reasons_json TEXT NOT NULL DEFAULT '[]',
      unsupported_reasons_json TEXT NOT NULL DEFAULT '[]',
      source_unavailable_reasons_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      estimator_version TEXT NOT NULL,
      estimated_at TEXT NOT NULL,
      company_name TEXT,
      normalized_company TEXT,
      role_title TEXT,
      normalized_role TEXT,
      company_tier TEXT NOT NULL DEFAULT 'unknown',
      match_scope TEXT NOT NULL DEFAULT 'none',
      PRIMARY KEY (tenant_id, job_url)
    );
  `);
  db.prepare(
    `INSERT INTO job_posted_compensation_facts (
      tenant_id, job_url, source_field, source_text, legacy_raw_salary,
      parse_state, currency, period, component, minimum_amount, maximum_amount,
      annualized_minimum_amount, annualized_maximum_amount,
      annualization_assumption, confidence, warnings_json, parser_version,
      source_hash, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobUrl,
    "jobs.salary",
    "EUR 70000-90000/year",
    "EUR 70000-90000/year",
    "parsed_range",
    "EUR",
    "year",
    "base_salary",
    70000,
    90000,
    70000,
    90000,
    "Source text states annual compensation.",
    "high",
    JSON.stringify(["broad_range"]),
    "posted-compensation-v1",
    "hash-posted",
    "2026-06-19T10:00:00Z",
  );
  db.prepare(
    `INSERT INTO job_market_compensation_estimates (
      tenant_id, job_url, estimate_state, currency, period, component,
      minimum_amount, maximum_amount, confidence_band, confidence_score,
      source_count, sample_count, aggregate_bucket, geography_scope,
      occupation_code, occupation_label, seniority_label, source_snapshot_json,
      factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
      source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
      company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobUrl,
    "estimated_range",
    "EUR",
    "year",
    "total_compensation",
    112000,
    142000,
    "medium",
    0.82,
    2,
    7,
    "reported company-role compensation",
    "Europe",
    "acme ai",
    "platform engineer",
    "senior",
    JSON.stringify([
      {
        source_id: "levels_fyi",
        source_type: "reported_compensation",
        release_year: 2026,
        sample_count: 4,
      },
      {
        source_id: "glassdoor",
        source_type: "reported_compensation",
        release_year: 2026,
        sample_count: 3,
      },
    ]),
    JSON.stringify([
      { name: "company", score: 1, band: "high" },
      { name: "role", score: 1, band: "high" },
    ]),
    "[]",
    "[]",
    "[]",
    JSON.stringify(["reported_compensation_sample", "location_mismatch"]),
    "company-role-reported-compensation-v1",
    "2026-06-19T10:01:00Z",
    "Acme AI",
    "acme ai",
    "Senior Platform Engineer",
    "platform engineer",
    "tier_2_ambitious",
    "exact_company_role",
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

  it("projects canonical compensation summary and detail audit JSON", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      insertCompensationRows(dbPath);
      const app = buildApp({
        dbPath,
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(res.statusCode, res.body).toBe(200);
      } finally {
        await app.close();
      }

      const db = new Database(dbPath, { readonly: true });
      try {
        const listProjection = db
          .prepare(
            `SELECT salary, compensation_summary_json
               FROM job_list_projections
              WHERE tenant_id = 'local' AND job_id = ?`,
          )
          .get("https://example.com/jobs/event-driven") as
          | { salary: string; compensation_summary_json: string }
          | undefined;
        expect(listProjection?.salary).toBe("EUR 70000-90000/year");
        const summary = JSON.parse(listProjection?.compensation_summary_json ?? "{}");
        expect(summary).toMatchObject({
          projectionVersion: 1,
          warningCount: 3,
          posted: {
            recordStatus: "recorded",
            parseState: "parsed_range",
            displayRange: "EUR 70000-90000/year",
            warningCount: 1,
          },
          market: {
            sourceKind: "reported_company_role_market",
            recordStatus: "recorded",
            estimateState: "estimated_range",
            displayRange: "EUR 112000-142000/year",
            confidenceScore: 0.82,
            sourceCount: 2,
            sampleCount: 7,
            warningCount: 2,
          },
        });

        const detailProjection = db
          .prepare(
            `SELECT compensation_audit_json
               FROM job_detail_projections
              WHERE tenant_id = 'local' AND job_id = ?`,
          )
          .get("https://example.com/jobs/event-driven") as
          | { compensation_audit_json: string }
          | undefined;
        const audit = JSON.parse(detailProjection?.compensation_audit_json ?? "{}");
        expect(audit.posted.fact.sourceText).toBe("EUR 70000-90000/year");
        expect(audit.market.estimate.sources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceId: "levels_fyi",
              displayName: "Levels.fyi",
            }),
            expect.objectContaining({
              sourceId: "glassdoor",
              displayName: "Glassdoor",
            }),
          ]),
        );
        expect(audit.market.estimate.companyName).toBe("Acme AI");
        expect(audit.market.estimate.matchScope).toBe("exact_company_role");
        expect(JSON.stringify(audit)).not.toContain("/Users/");
      } finally {
        db.close();
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

  it("projects cover preparation as apply-stage once a tailored resume exists", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      db.prepare("UPDATE jobs SET tailored_resume_path = ?, tailored_at = ? WHERE url = ?").run(
        "/tmp/tailored-resume.txt",
        "2026-05-04T13:12:00+00:00",
        "https://example.com/jobs/event-driven",
      );
      const insertStage = db.prepare(
        "INSERT INTO job_stage_states (job_url, stage, state, updated_at, finished_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const stage of ["discover", "enrich", "score", "tailor"]) {
        insertStage.run(
          "https://example.com/jobs/event-driven",
          stage,
          "succeeded",
          "2026-05-04T13:00:00+00:00",
          "2026-05-04T13:00:00+00:00",
        );
      }
      insertStage.run(
        "https://example.com/jobs/event-driven",
        "cover",
        "pending",
        "2026-05-04T13:15:00+00:00",
        null,
      );
      db.close();

      const app = buildApp({
        dbPath,
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        const listRes = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(listRes.statusCode, listRes.body).toBe(200);
        const item = listRes
          .json()
          .items.find((job: { jobKey: string }) => job.jobKey === "https://example.com/jobs/event-driven");
        expect(item).toMatchObject({
          currentStage: "apply",
          currentSubstage: "cover",
          currentState: "pending",
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("projects latest approved materials when a newer re-tailor generation is rejected", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE job_materials (
          job_url TEXT NOT NULL,
          generation INTEGER NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local',
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_validation_json TEXT,
          last_verdict_json TEXT,
          metadata_json TEXT,
          PRIMARY KEY (job_url, generation)
        );
        CREATE TABLE job_materials_artifacts (
          job_url TEXT NOT NULL,
          generation INTEGER NOT NULL,
          artifact_type TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          status TEXT NOT NULL,
          path TEXT NOT NULL,
          render_format TEXT NOT NULL,
          size_bytes INTEGER,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          superseded_at TEXT,
          PRIMARY KEY (job_url, generation, artifact_type)
        );
      `);
      const jobUrl = "https://example.com/jobs/event-driven";
      const insertMaterials = db.prepare(
        `INSERT INTO job_materials (
          job_url, generation, tenant_id, status, created_at, updated_at
        ) VALUES (?, ?, 'local', ?, ?, ?)`,
      );
      insertMaterials.run(
        jobUrl,
        1,
        "complete",
        "2026-05-04T12:00:00+00:00",
        "2026-05-04T12:10:00+00:00",
      );
      insertMaterials.run(
        jobUrl,
        3,
        "complete",
        "2026-05-04T13:00:00+00:00",
        "2026-05-04T13:10:00+00:00",
      );
      insertMaterials.run(
        jobUrl,
        4,
        "resume_in_progress",
        "2026-05-04T14:00:00+00:00",
        "2026-05-04T14:05:00+00:00",
      );
      const insertArtifact = db.prepare(
        `INSERT INTO job_materials_artifacts (
          job_url, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertArtifact.run(
        jobUrl,
        1,
        "tailored_resume",
        "gen1-superseded-resume",
        "superseded",
        "/tmp/gen1-resume.txt",
        "text",
        9,
        JSON.stringify({ quality_plan: { target_seniority: "junior" } }),
        "2026-05-04T12:05:00+00:00",
      );
      insertArtifact.run(
        jobUrl,
        3,
        "tailored_resume",
        "gen3-resume",
        "approved",
        "/tmp/gen3-resume.txt",
        "text",
        10,
        JSON.stringify({ quality_plan: { target_seniority: "executive" } }),
        "2026-05-04T13:05:00+00:00",
      );
      insertArtifact.run(
        jobUrl,
        3,
        "resume_pdf",
        "gen3-pdf",
        "approved",
        "/tmp/gen3-resume.pdf",
        "pdf",
        20,
        "{}",
        "2026-05-04T13:06:00+00:00",
      );
      insertArtifact.run(
        jobUrl,
        4,
        "tailored_resume",
        "gen4-rejected-resume",
        "rejected",
        "/tmp/gen4-rejected-resume.txt",
        "text",
        11,
        "{}",
        "2026-05-04T14:05:00+00:00",
      );
      db.close();

      const app = buildApp({
        dbPath,
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        const listRes = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(listRes.statusCode, listRes.body).toBe(200);
      } finally {
        await app.close();
      }

      const readDb = new Database(dbPath, { readonly: true });
      try {
        const projection = readDb
          .prepare(
            `SELECT has_resume, has_pdf
               FROM job_list_projections
              WHERE tenant_id = 'local' AND job_id = ?`,
          )
          .get(jobUrl) as { has_resume: number; has_pdf: number } | undefined;
        expect(projection).toMatchObject({ has_resume: 1, has_pdf: 1 });

        const rejected = readDb
          .prepare(
            `SELECT status
               FROM artifact_list_projections
              WHERE tenant_id = 'local'
                AND job_id = ?
                AND artifact_id = 'gen4-rejected-resume'`,
          )
          .get(jobUrl) as { status: string } | undefined;
        expect(rejected).toMatchObject({ status: "rejected" });

        const syntheticPdf = readDb
          .prepare(
            `SELECT metadata_json
               FROM artifact_list_projections
              WHERE tenant_id = 'local'
                AND job_id = ?
                AND artifact_type = 'tailored_resume_pdf'`,
          )
          .get(jobUrl) as { metadata_json: string | null } | undefined;
        expect(JSON.parse(syntheticPdf?.metadata_json ?? "{}")).toMatchObject({
          quality_plan: { target_seniority: "executive" },
        });
      } finally {
        readDb.close();
      }
    } finally {
      cleanup();
    }
  });

  it("repairs stale artifact projection metadata from canonical material artifacts", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE job_materials (
          job_url TEXT NOT NULL,
          generation INTEGER NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local',
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_validation_json TEXT,
          last_verdict_json TEXT,
          metadata_json TEXT,
          PRIMARY KEY (job_url, generation)
        );
        CREATE TABLE job_materials_artifacts (
          job_url TEXT NOT NULL,
          generation INTEGER NOT NULL,
          artifact_type TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          status TEXT NOT NULL,
          path TEXT NOT NULL,
          render_format TEXT NOT NULL,
          size_bytes INTEGER,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          superseded_at TEXT,
          PRIMARY KEY (job_url, generation, artifact_type)
        );
      `);
      const jobUrl = "https://example.com/jobs/event-driven";
      db.prepare(
        `INSERT INTO job_materials (
          job_url, generation, tenant_id, status, created_at, updated_at
        ) VALUES (?, 1, 'local', 'complete', ?, ?)`,
      ).run(jobUrl, "2026-05-04T13:00:00+00:00", "2026-05-04T13:10:00+00:00");
      db.prepare(
        `INSERT INTO job_materials_artifacts (
          job_url, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, 1, 'tailored_resume', 'stale-resume', 'approved', ?, 'text', 10, ?, ?)`,
      ).run(
        jobUrl,
        "/tmp/stale-resume.txt",
        JSON.stringify({
          quality_plan: { target_seniority: "executive" },
          selected_model: "generator-a",
          adversarial_review: {
            llm_audit: {
              prompt_messages: [{ role: "user", content: "Run persona review." }],
            },
          },
          change_annotations: [
            {
              section: "executive_profile",
              label: "Executive profile",
            },
          ],
        }),
        "2026-05-04T13:05:00+00:00",
      );
      db.close();

      const app = buildApp({
        dbPath,
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        const firstRes = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(firstRes.statusCode, firstRes.body).toBe(200);

        const corruptDb = new Database(dbPath);
        corruptDb
          .prepare(
            `UPDATE artifact_list_projections
                SET metadata_json = json_object(
                  'quality_plan', json_object('target_seniority', 'executive'),
                  'selected_model', 'generator-a'
                )
              WHERE tenant_id = 'local'
                AND job_id = ?
                AND artifact_type = 'tailored_resume'`,
          )
          .run(jobUrl);
        corruptDb.close();

        const secondRes = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(secondRes.statusCode, secondRes.body).toBe(200);
      } finally {
        await app.close();
      }

      const readDb = new Database(dbPath, { readonly: true });
      try {
        const projection = readDb
          .prepare(
            `SELECT metadata_json
               FROM artifact_list_projections
              WHERE tenant_id = 'local'
                AND job_id = ?
                AND artifact_type = 'tailored_resume'`,
          )
          .get(jobUrl) as { metadata_json: string | null } | undefined;
        expect(JSON.parse(projection?.metadata_json ?? "{}")).toMatchObject({
          quality_plan: { target_seniority: "executive" },
          selected_model: "generator-a",
          adversarial_review: {
            llm_audit: {
              prompt_messages: [{ role: "user", content: "Run persona review." }],
            },
          },
          change_annotations: [
            {
              section: "executive_profile",
              label: "Executive profile",
            },
          ],
        });
      } finally {
        readDb.close();
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

  it("serves the canonical employer analysis from projection rows (TS↔Python parity)", async () => {
    // AUDIT-02-style cross-runtime parity: seed the canonical
    // ``job_employer_analysis`` rows exactly as the Python repository writes
    // them, then assert the TS projection builder + read model reconstruct the
    // same read shape the Python ``EmployerAnalysis.to_read_model()`` produces.
    const { dbPath, cleanup } = withTempDb();
    const jobUrl = "https://example.com/jobs/event-driven";
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE job_employer_analysis (
          job_url TEXT NOT NULL,
          generation INTEGER NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local',
          snapshot_hash TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          sdk_set_version TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          role_framing TEXT NOT NULL DEFAULT '',
          inferred_seniority TEXT NOT NULL DEFAULT '',
          ideal_candidate_narrative TEXT NOT NULL DEFAULT '',
          requirements_json TEXT NOT NULL DEFAULT '[]',
          keywords_json TEXT NOT NULL DEFAULT '[]',
          agreement_json TEXT NOT NULL DEFAULT '{}',
          legs_attempted INTEGER NOT NULL,
          legs_succeeded INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (job_url, generation)
        );
        CREATE TABLE job_employer_analysis_sub_analyses (
          job_url TEXT NOT NULL,
          generation INTEGER NOT NULL,
          model_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local',
          analysis_json TEXT NOT NULL,
          PRIMARY KEY (job_url, generation, model_id)
        );
        CREATE TABLE job_employer_analysis_failures (
          job_url TEXT NOT NULL,
          generation INTEGER NOT NULL,
          model_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local',
          error TEXT NOT NULL,
          raw_output TEXT,
          PRIMARY KEY (job_url, generation, model_id)
        );
      `);
      const requirements = [
        {
          id: "r1",
          text: "5+ years Python",
          tier: "must_have",
          weight: 0.9,
          evidence_span: "5+ years Python",
        },
      ];
      const keywords = [
        {
          keyword: "Python",
          evidence_span: "5+ years Python",
          requirement_ref: "r1",
          rationale: "core",
          is_orphan: false,
        },
      ];
      // Two generations prove "load latest" + supersede-not-destroy (D-13).
      const insertAnalysis = db.prepare(
        `INSERT INTO job_employer_analysis (
          job_url, generation, tenant_id, snapshot_hash, prompt_version, sdk_set_version,
          cache_key, role_framing, inferred_seniority, ideal_candidate_narrative,
          requirements_json, keywords_json, agreement_json, legs_attempted, legs_succeeded, created_at
        ) VALUES (?, ?, 'local', ?, 'employer-analysis-v1', 'claude+codex-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertAnalysis.run(
        jobUrl, 1, "hash-old", "hash-old:employer-analysis-v1:claude+codex-v1",
        "Old framing.", "mid", "Old narrative.",
        "[]", "[]", JSON.stringify({ score: 0.5, flagged_requirements: [], flagged_keywords: [] }),
        2, 2, "2026-05-04T12:00:00+00:00",
      );
      insertAnalysis.run(
        jobUrl, 2, "hash-new", "hash-new:employer-analysis-v1:claude+codex-v1",
        "Own the event platform.", "senior", "A hands-on platform owner.",
        JSON.stringify(requirements), JSON.stringify(keywords),
        JSON.stringify({ score: 0.8, flagged_requirements: [], flagged_keywords: ["kafka"] }),
        2, 1, "2026-05-04T13:00:00+00:00",
      );
      db.prepare(
        `INSERT INTO job_employer_analysis_sub_analyses (job_url, generation, model_id, tenant_id, analysis_json)
         VALUES (?, 2, 'claude-opus-4-8', 'local', ?)`,
      ).run(
        jobUrl,
        JSON.stringify({
          role_framing: "Own the event platform.",
          inferred_seniority: "senior",
          ideal_candidate_narrative: "A hands-on platform owner.",
          requirements,
          keywords,
        }),
      );
      db.prepare(
        `INSERT INTO job_employer_analysis_failures (job_url, generation, model_id, tenant_id, error, raw_output)
         VALUES (?, 2, 'gpt-5.4', 'local', 'codex app-server timeout', NULL)`,
      ).run(jobUrl);
      db.close();

      const app = buildApp({
        dbPath,
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        const detailRes = await app.inject({
          method: "GET",
          url: `/v1/jobs/${encodeURIComponent(jobUrl)}`,
        });
        expect(detailRes.statusCode, detailRes.body).toBe(200);
        const analysis = detailRes.json().employerAnalysis;
        expect(analysis).not.toBeNull();
        // Latest generation only (gen 2); gen 1 superseded but retained as history.
        expect(analysis).toMatchObject({
          generation: 2,
          cache_key: "hash-new:employer-analysis-v1:claude+codex-v1",
          ensemble_completeness: "1/2",
          legs_attempted: 2,
          legs_succeeded: 1,
          is_degraded: true,
          role_framing: "Own the event platform.",
          inferred_seniority: "senior",
        });
        expect(analysis.requirements[0]).toMatchObject({ tier: "must_have", weight: 0.9 });
        expect(analysis.keywords[0]).toMatchObject({ keyword: "Python", requirement_ref: "r1" });
        expect(analysis.agreement.flagged_keywords).toEqual(["kafka"]);
        expect(analysis.sub_analyses[0].model_id).toBe("claude-opus-4-8");
        expect(analysis.failures[0]).toMatchObject({
          model_id: "gpt-5.4",
          error: "codex app-server timeout",
          raw_output: null,
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("serves the canonical requirement fit report from projection rows", async () => {
    const { dbPath, cleanup } = withTempDb();
    const jobUrl = "https://example.com/jobs/event-driven";
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE job_requirement_fit_reports (
          job_url TEXT NOT NULL,
          score_version INTEGER NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local',
          employer_analysis_generation INTEGER NOT NULL,
          profile_snapshot_version INTEGER NOT NULL,
          scoring_policy_version INTEGER NOT NULL,
          formula_version TEXT NOT NULL,
          resolved_fit_score INTEGER,
          fit_band TEXT NOT NULL,
          confidence TEXT NOT NULL,
          summary_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          PRIMARY KEY (job_url, score_version, tenant_id)
        );
        CREATE TABLE job_requirement_fit_items (
          job_url TEXT NOT NULL,
          score_version INTEGER NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local',
          requirement_id TEXT NOT NULL,
          requirement_text TEXT NOT NULL,
          tier TEXT NOT NULL,
          weight REAL NOT NULL,
          job_evidence_span TEXT NOT NULL DEFAULT '',
          fit_json TEXT NOT NULL DEFAULT '{}',
          contribution_json TEXT NOT NULL DEFAULT '{}',
          tailoring_json TEXT NOT NULL DEFAULT '{}',
          artifact_coverage_json TEXT,
          position INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (job_url, score_version, tenant_id, requirement_id)
        );
      `);
      const insertReport = db.prepare(
        `INSERT INTO job_requirement_fit_reports (
          job_url, score_version, tenant_id, employer_analysis_generation,
          profile_snapshot_version, scoring_policy_version, formula_version,
          resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES (?, ?, 'local', ?, ?, ?, 'requirement-fit-v1', ?, ?, ?, ?, ?)`,
      );
      insertReport.run(
        jobUrl,
        1,
        1,
        2,
        3,
        6,
        "plausible",
        "medium",
        JSON.stringify({
          weighted_fit: 0.55,
          must_have_coverage: 0.55,
          blocker_count: 0,
          missing_high_weight_count: 1,
        }),
        "2026-05-04T11:00:00+00:00",
      );
      insertReport.run(
        jobUrl,
        2,
        2,
        3,
        4,
        8,
        "strong",
        "high",
        JSON.stringify({
          weighted_fit: 0.82,
          must_have_coverage: 1.0,
          blocker_count: 0,
          missing_high_weight_count: 0,
        }),
        "2026-05-04T12:00:00+00:00",
      );
      db.prepare(
        `INSERT INTO job_requirement_fit_items (
          job_url, score_version, tenant_id, requirement_id, requirement_text,
          tier, weight, job_evidence_span, fit_json, contribution_json,
          tailoring_json, artifact_coverage_json, position
        ) VALUES (?, 2, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        jobUrl,
        "r1",
        "5+ years Python",
        "must_have",
        0.9,
        "5+ years Python",
        JSON.stringify({
          kind: "matched",
          evidence_ids: ["ev-python"],
          strength: "direct",
        }),
        JSON.stringify({
          max_points: 1.125,
          awarded_points: 1.125,
          weighted_impact: 1.125,
          rationale: "Direct Python evidence covers r1.",
        }),
        JSON.stringify({
          action: "double_down",
          priority: 0.9,
          allowed_evidence_ids: ["ev-python"],
          target_keywords: ["Python"],
          prohibited_claims: [],
          instruction: "Keep Python evidence prominent.",
        }),
        JSON.stringify({
          state: "covered",
          source: "tailored_resume_bullet_provenance",
          bullet_count: 1,
          examples: ["Built Python event services."],
        }),
        0,
      );
      db.close();

      const app = buildApp({
        dbPath,
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        const detailRes = await app.inject({
          method: "GET",
          url: `/v1/jobs/${encodeURIComponent(jobUrl)}`,
        });
        expect(detailRes.statusCode, detailRes.body).toBe(200);
        const report = detailRes.json().requirementFitReport;
        expect(report).toMatchObject({
          jobKey: jobUrl,
          scoreVersion: 2,
          employerAnalysisGeneration: 2,
          profileSnapshotVersion: 3,
          scoringPolicyVersion: 4,
          formulaVersion: "requirement-fit-v1",
          resolvedFitScore: 8,
          fitBand: "strong",
          confidence: "high",
          summary: {
            weightedFit: 0.82,
            mustHaveCoverage: 1.0,
            blockerCount: 0,
            missingHighWeightCount: 0,
          },
        });
        expect(report.assessments[0]).toMatchObject({
          requirementId: "r1",
          requirementText: "5+ years Python",
          tier: "must_have",
          weight: 0.9,
          jobEvidenceSpan: "5+ years Python",
          fit: {
            kind: "matched",
            evidenceIds: ["ev-python"],
            strength: "direct",
          },
          contribution: {
            maxPoints: 1.125,
            awardedPoints: 1.125,
            weightedImpact: 1.125,
          },
          tailoring: {
            action: "double_down",
            allowedEvidenceIds: ["ev-python"],
            targetKeywords: ["Python"],
          },
          artifactCoverage: {
            state: "covered",
            bulletCount: 1,
            examples: ["Built Python event services."],
          },
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("serves canonical per-bullet provenance from projection rows (TS↔Python parity)", async () => {
    // AUDIT-02-style cross-runtime parity for Phase 2: seed the canonical
    // ``job_bullet_provenance`` rows exactly as the Python repository writes
    // them, then assert the TS projection builder + read model reconstruct the
    // same ``bulletProvenance`` shape the Python ``BulletProvenanceSet
    // .to_read_model()`` produces — served on the artifact's tailoring
    // explanation, exclusively from canonical rows.
    const { dbPath, cleanup } = withTempDb();
    // Reuse the job ``seedSchema`` already inserts, so the artifact projection
    // builds (the builder drops projections for jobs with no ``jobs`` row).
    const jobUrl = "https://example.com/jobs/event-driven";
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE job_materials (
          job_url TEXT NOT NULL,
          generation INTEGER NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local',
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_validation_json TEXT,
          last_verdict_json TEXT,
          metadata_json TEXT,
          PRIMARY KEY (job_url, generation)
        );
        CREATE TABLE job_materials_artifacts (
          job_url TEXT NOT NULL,
          generation INTEGER NOT NULL,
          artifact_type TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          status TEXT NOT NULL,
          path TEXT NOT NULL,
          render_format TEXT NOT NULL,
          size_bytes INTEGER,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          superseded_at TEXT,
          PRIMARY KEY (job_url, generation, artifact_type)
        );
        CREATE TABLE job_bullet_provenance (
          job_url TEXT NOT NULL,
          generation INTEGER NOT NULL,
          bullet_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local',
          artifact_id TEXT NOT NULL,
          section TEXT NOT NULL,
          source_id TEXT,
          evidence_ids_json TEXT NOT NULL DEFAULT '[]',
          requirement_ids_json TEXT NOT NULL DEFAULT '[]',
          matched_keywords_json TEXT NOT NULL DEFAULT '[]',
          transform_type TEXT NOT NULL,
          control TEXT NOT NULL,
          rationale TEXT NOT NULL DEFAULT '',
          generated_text TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          PRIMARY KEY (job_url, generation, bullet_id)
        );
      `);
      // A complete metadata blob so the tailoring explanation has its audit fields
      // (the explanation must exist for bulletProvenance to attach to it).
      const completeMetadata = JSON.stringify({
        validation_mode: "normal",
        attempts: 1,
        quality_plan: {
          target_seniority: "senior",
          claim_mode: "evidence_reframing",
          auto_approvable_claim_modes: ["evidence_reframing"],
          allow_adjacent_achievement_drafts: false,
          required_evidence_ids: ["ev_latency"],
          seniority_evidence_ids: ["ev_latency"],
          verified_metric_count: 1,
          job_keywords: ["latency"],
        },
        quality_checks: { passed: true, keyword_coverage: { covered: ["latency"], missing: [] } },
        judge: { passed: true, verdict: "PASS", score: 0.9 },
        judge_min_score: 0.7,
        selected_model: "generator-a",
        selected_candidate: "candidate-1",
        judge_model: "judge-a",
        candidate_models: ["generator-a"],
        adversarial_review: { ran: false, skipped_reason: "below_threshold" },
        change_annotations: [
          {
            section: "experience",
            label: "Senior SWE at Acme Corp",
            change_type: "achievement_reframed",
            source_id: "acme_swe",
            source_text: ["Built distributed systems."],
            tailored_text: ["Owned the API and cut latency 40%."],
            rationale: "Reframed for the target.",
            job_signals: ["latency"],
            controls: ["claim mode: evidence_reframing"],
            evidence_ids: ["ev_latency"],
            evidence_notes: [],
          },
        ],
      });
      db.prepare(
        `INSERT INTO job_materials (job_url, generation, tenant_id, status, created_at, updated_at)
         VALUES (?, 1, 'local', 'complete', '2026-06-08T12:00:00+00:00', '2026-06-08T12:10:00+00:00')`,
      ).run(jobUrl);
      const insertArtifact = db.prepare(
        `INSERT INTO job_materials_artifacts (
          job_url, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, 1, ?, ?, 'approved', ?, ?, ?, ?, '2026-06-08T12:05:00+00:00')`,
      );
      insertArtifact.run(jobUrl, "tailored_resume", "resume-1", "/tmp/resume.txt", "text", 10, completeMetadata);
      insertArtifact.run(jobUrl, "resume_pdf", "resume-pdf-1", "/tmp/resume.pdf", "pdf", 20, "{}");

      // Provenance rows (as the Python repo writes them): bound to the text
      // resume artifact, ordered by position.
      const insertProvenance = db.prepare(
        `INSERT INTO job_bullet_provenance (
          job_url, generation, bullet_id, tenant_id, artifact_id, section, source_id,
          evidence_ids_json, requirement_ids_json, matched_keywords_json,
          transform_type, control, rationale, generated_text, position, created_at
        ) VALUES (?, 1, ?, 'local', 'resume-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-06-08T12:10:00+00:00')`,
      );
      insertProvenance.run(
        jobUrl, "executive_profile#0", "executive_profile", "executive_profile",
        "[]", "[]", "[]", "reframe", "rephrase_allowed", "Reframed summary.",
        "Senior backend engineer focused on Python.", 0,
      );
      insertProvenance.run(
        jobUrl, "experience:acme_swe#0", "experience", "acme_swe",
        JSON.stringify(["ev_latency"]), JSON.stringify(["req_latency"]), JSON.stringify(["latency"]),
        "quantify_from_evidence", "never_fabricate_metrics", "Surfaced a recorded metric.",
        "Owned the API and cut latency 40%.", 1,
      );
      db.close();

      const app = buildApp({
        dbPath,
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        // The text resume serves provenance directly from its own row.
        const resumeRes = await app.inject({ method: "GET", url: "/v1/artifacts/resume-1" });
        expect(resumeRes.statusCode, resumeRes.body).toBe(200);
        const explanation = resumeRes.json().tailoringExplanation;
        expect(explanation).not.toBeNull();
        expect(explanation.bulletProvenance).toHaveLength(2);
        // Ordered by position; FK bindings + transform/control round-trip exactly.
        expect(explanation.bulletProvenance[0]).toMatchObject({
          bulletId: "executive_profile#0",
          section: "executive_profile",
          transformType: "reframe",
          control: "rephrase_allowed",
        });
        expect(explanation.bulletProvenance[1]).toMatchObject({
          bulletId: "experience:acme_swe#0",
          section: "experience",
          sourceId: "acme_swe",
          evidenceIds: ["ev_latency"],
          requirementIds: ["req_latency"],
          matchedKeywords: ["latency"],
          transformType: "quantify_from_evidence",
          control: "never_fabricate_metrics",
          generatedText: "Owned the API and cut latency 40%.",
        });

        // The PDF artifact resolves provenance from the sibling text resume row.
        const pdfRes = await app.inject({ method: "GET", url: "/v1/artifacts/resume-pdf-1" });
        expect(pdfRes.statusCode, pdfRes.body).toBe(200);
        const pdfExplanation = pdfRes.json().tailoringExplanation;
        expect(pdfExplanation).not.toBeNull();
        expect(pdfExplanation.bulletProvenance).toHaveLength(2);
        expect(pdfExplanation.bulletProvenance[1].requirementIds).toEqual(["req_latency"]);
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("serves canonical coverage + voice audit from projection rows (Phase 3 TS↔Python parity)", async () => {
    // AUDIT-02-style cross-runtime parity for Phase 3: seed the canonical
    // ``job_bullet_provenance`` rows WITH the set-level ``coverage_json`` +
    // ``voice_json`` the Python repo denormalises onto every row, then assert the
    // TS read model serves the SAME ``coverageAudit`` (GROUND-06) + ``voicePass``
    // (VOICE-02) shapes — for the text resume AND, via the sibling row, the PDF.
    const { dbPath, cleanup } = withTempDb();
    const jobUrl = "https://example.com/jobs/event-driven";
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE job_materials (
          job_url TEXT NOT NULL, generation INTEGER NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          last_validation_json TEXT, last_verdict_json TEXT, metadata_json TEXT,
          PRIMARY KEY (job_url, generation)
        );
        CREATE TABLE job_materials_artifacts (
          job_url TEXT NOT NULL, generation INTEGER NOT NULL, artifact_type TEXT NOT NULL,
          artifact_id TEXT NOT NULL, status TEXT NOT NULL, path TEXT NOT NULL,
          render_format TEXT NOT NULL, size_bytes INTEGER, metadata_json TEXT,
          created_at TEXT NOT NULL, superseded_at TEXT,
          PRIMARY KEY (job_url, generation, artifact_type)
        );
        CREATE TABLE job_bullet_provenance (
          job_url TEXT NOT NULL, generation INTEGER NOT NULL, bullet_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local', artifact_id TEXT NOT NULL,
          section TEXT NOT NULL, source_id TEXT,
          evidence_ids_json TEXT NOT NULL DEFAULT '[]', requirement_ids_json TEXT NOT NULL DEFAULT '[]',
          matched_keywords_json TEXT NOT NULL DEFAULT '[]', transform_type TEXT NOT NULL,
          control TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '', generated_text TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
          coverage_json TEXT, voice_json TEXT,
          PRIMARY KEY (job_url, generation, bullet_id)
        );
      `);
      const completeMetadata = JSON.stringify({
        validation_mode: "normal",
        attempts: 1,
        quality_plan: {
          target_seniority: "senior",
          claim_mode: "evidence_reframing",
          auto_approvable_claim_modes: ["evidence_reframing"],
          allow_adjacent_achievement_drafts: false,
          required_evidence_ids: ["ev_latency"],
          seniority_evidence_ids: ["ev_latency"],
          verified_metric_count: 1,
          job_keywords: ["latency"],
        },
        quality_checks: { passed: true },
        judge: { passed: true, verdict: "PASS", score: 0.9 },
        judge_min_score: 0.7,
        selected_model: "generator-a",
        selected_candidate: "candidate-1",
        judge_model: "judge-a",
        candidate_models: ["generator-a"],
        adversarial_review: { ran: false, skipped_reason: "below_threshold" },
        change_annotations: [],
      });
      db.prepare(
        `INSERT INTO job_materials (job_url, generation, tenant_id, status, created_at, updated_at)
         VALUES (?, 1, 'local', 'complete', '2026-06-08T12:00:00+00:00', '2026-06-08T12:10:00+00:00')`,
      ).run(jobUrl);
      const insertArtifact = db.prepare(
        `INSERT INTO job_materials_artifacts (
          job_url, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, 1, ?, ?, 'approved', ?, ?, ?, ?, '2026-06-08T12:05:00+00:00')`,
      );
      insertArtifact.run(jobUrl, "tailored_resume", "resume-1", "/tmp/resume.txt", "text", 10, completeMetadata);
      insertArtifact.run(jobUrl, "resume_pdf", "resume-pdf-1", "/tmp/resume.pdf", "pdf", 20, "{}");

      // The set-level coverage + voice, denormalised onto every row (the Python
      // repo writes the SAME value on each row of the generation).
      const coverageJson = JSON.stringify({
        computed_against: "rendered_text",
        planned: ["latency", "python"],
        covered: ["latency"],
        missing: ["python"],
        covered_by: { latency: "experience:acme_swe#0" },
        counts: { planned: 2, covered: 1, missing: 1 },
      });
      const voiceJson = JSON.stringify({
        ran: true,
        accepted: true,
        model: "claude-opus-4-8",
        prompt_version: "voice-pass-v1",
        proxy_delta: { improved: true, buzzword_density_reduced: true },
        reason: "",
      });
      const insertProvenance = db.prepare(
        `INSERT INTO job_bullet_provenance (
          job_url, generation, bullet_id, tenant_id, artifact_id, section, source_id,
          evidence_ids_json, requirement_ids_json, matched_keywords_json,
          transform_type, control, rationale, generated_text, position, created_at,
          coverage_json, voice_json
        ) VALUES (?, 1, ?, 'local', 'resume-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-06-08T12:10:00+00:00', ?, ?)`,
      );
      insertProvenance.run(
        jobUrl, "experience:acme_swe#0", "experience", "acme_swe",
        JSON.stringify(["ev_latency"]), JSON.stringify(["req_latency"]), JSON.stringify(["latency"]),
        "voice", "rephrase_allowed", "Voiced bullet.",
        "Owned the API and cut latency 40%.", 0, coverageJson, voiceJson,
      );
      db.close();

      const app = buildApp({
        dbPath,
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
      });
      try {
        const resumeRes = await app.inject({ method: "GET", url: "/v1/artifacts/resume-1" });
        expect(resumeRes.statusCode, resumeRes.body).toBe(200);
        const explanation = resumeRes.json().tailoringExplanation;
        expect(explanation.coverageAudit).toMatchObject({
          computedAgainst: "rendered_text",
          covered: ["latency"],
          missing: ["python"],
          coveredBy: { latency: "experience:acme_swe#0" },
          counts: { planned: 2, covered: 1, missing: 1 },
        });
        expect(explanation.voicePass).toMatchObject({
          ran: true,
          accepted: true,
          model: "claude-opus-4-8",
          promptVersion: "voice-pass-v1",
        });
        // The voiced bullet is served with transformType "voice".
        expect(explanation.bulletProvenance[0].transformType).toBe("voice");

        // The PDF artifact resolves coverage + voice from the sibling text row.
        const pdfRes = await app.inject({ method: "GET", url: "/v1/artifacts/resume-pdf-1" });
        expect(pdfRes.statusCode, pdfRes.body).toBe(200);
        const pdfExplanation = pdfRes.json().tailoringExplanation;
        expect(pdfExplanation.coverageAudit?.covered).toEqual(["latency"]);
        expect(pdfExplanation.voicePass?.accepted).toBe(true);
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
