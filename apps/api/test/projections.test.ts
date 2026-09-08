/**
 * PR 4 of the Temporal stack: the TS API reads ``apply_run_projections``
 * directly. The bespoke ``apply_runs`` / ``apply_run_events`` tables
 * are no longer required for the read-model to function, and the
 * Python projection builder now owns ``apply_run_projections``
 * materialisation from ``job_events``.
 */
import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { buildApp } from "../src/server.js";
import { initializeExactV7Database } from "./v7-schema.js";
import {
  REFRESH_EVENT_BATCH_LIMIT, refreshProjections, setWatermark,
  refreshContactProjections, refreshContactResearchProjections, refreshOutreachProjections,
} from "../src/projections.js";
import { recoveryKeyDigest } from "../src/discovery-execution-recovery.js";
import { PROJECTION_WATERMARK_NAME } from "../src/contracts.js";

const EVENT_JOB_URL = "https://example.com/jobs/event-driven";
const EVENT_JOB_ID = "00000000-0000-4000-8000-000000000001";

function projectionFixtureJobId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function withTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-projections-"));
  const dbPath = path.join(dir, "jobs.db");
  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function seedSchema(dbPath: string): void {
  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  seedBuiltInResumeTemplate(db);
  db.prepare(
    `INSERT INTO jobs (
       tenant_id, job_id, url, title, site, fit_score, score_reasoning, application_url
     ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EVENT_JOB_ID,
    EVENT_JOB_URL,
    "Event-Driven Engineer",
    "ExampleCo",
    9,
    "Legacy reasoning kept for old callers.",
    "https://example.com/apply/event",
  );
  db.prepare(
    "INSERT INTO job_scores (tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at) VALUES ('local', ?, ?, ?, ?, ?, ?)",
  ).run(
    EVENT_JOB_ID,
    1,
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
      tenant_id, job_id, version, fit_score, breakdown_json, keywords_json,
      scored_at, criteria_json, trace_json
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EVENT_JOB_ID,
    2,
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
    "INSERT INTO apply_run_projections (run_id, tenant_id, job_id, job_title, job_employer, status, result, dry_run, started_at, finished_at) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "run-event-driven",
    EVENT_JOB_ID,
    "Event-Driven Engineer",
    "ExampleCo",
    "succeeded",
    "applied",
    0,
    "2026-05-04T13:00:00+00:00",
    "2026-05-04T13:05:00+00:00",
  );
  db.prepare(
    `INSERT INTO job_stage_states (
       tenant_id, job_id, stage, state, updated_at, finished_at
     ) VALUES ('local', ?, 'discover', 'succeeded', ?, ?)`,
  ).run(EVENT_JOB_ID, "2026-05-04T12:00:00+00:00", "2026-05-04T12:00:00+00:00");
  db.close();
}

function seedBuiltInResumeTemplate(db: Database.Database): void {
  db.prepare(
    `INSERT INTO resume_templates (
       tenant_id, template_id, display_name, status, built_in, created_at, updated_at
     ) VALUES ('local', 'built_in:modern-html', 'Modern HTML', 'active', 1, ?, ?)`,
  ).run("2026-05-04T12:00:00+00:00", "2026-05-04T12:00:00+00:00");
  db.prepare(
    `INSERT INTO resume_template_versions (
       tenant_id, version_id, template_id, version_number, display_name, status,
       theme_json, layout_json, content_hash, created_at
     ) VALUES ('local', 'built_in:modern-html:v1', 'built_in:modern-html', 1,
               'Modern HTML', 'active', ?, '{}', 'projection-fixture-template', ?)`,
  ).run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME), "2026-05-04T12:00:00+00:00");
}

function insertEvent(
  dbPath: string,
  eventType: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): void {
  const db = new Database(dbPath);
  db.prepare(
    "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) VALUES ('local', NULL, 1, ?, ?, 'info', ?, ?, ?)",
  ).run("discover", eventType, eventType, occurredAt, JSON.stringify(payload));
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
  db.prepare("UPDATE jobs SET salary = ? WHERE tenant_id = 'local' AND job_id = ?").run(
    "USD 70000-90000/year",
    EVENT_JOB_ID,
  );
  db.prepare(
    `INSERT INTO job_posted_compensation_facts (
      tenant_id, job_id, source_field, source_text, legacy_raw_salary,
      parse_state, currency, period, component, minimum_amount, maximum_amount,
      annualized_minimum_amount, annualized_maximum_amount,
      annualization_assumption, confidence, warnings_json, parser_version,
      source_hash, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    EVENT_JOB_ID,
    "jobs.salary",
    "USD 70000-90000/year",
    "USD 70000-90000/year",
    "parsed_range",
    "USD",
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
      tenant_id, job_id, estimate_state, currency, period, component,
      minimum_amount, maximum_amount, confidence_interval_minimum_amount,
      confidence_interval_maximum_amount, confidence_band, confidence_score,
      source_count, sample_count, aggregate_bucket, geography_scope,
      occupation_code, occupation_label, seniority_label, source_snapshot_json,
      factor_reasons_json, selected_evidence_json, insufficient_reasons_json, unsupported_reasons_json,
      source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
      company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    EVENT_JOB_ID,
    "estimated_range",
    "EUR",
    "year",
    "total_compensation",
    112000,
    142000,
    98000,
    176000,
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
        source_provenance: "licensed",
        source_type: "reported_compensation",
        release_year: 2026,
        snapshot_version: "levels-fyi-licensed-2026-q2",
        attribution: "Levels.fyi licensed Q2 export",
        sample_count: 4,
      },
      {
        source_id: "glassdoor",
        source_type: "reported_compensation",
        release_year: 2026,
        sample_count: 3,
      },
      {
        source_id: "levels_fyi",
        source_provenance: "public",
        source_type: "reported_compensation",
        release_year: 2026,
        snapshot_version: "levels-fyi-public-2026",
        attribution: "Data source: Levels.fyi (https://www.levels.fyi)",
        sample_count: null,
      },
    ]),
    JSON.stringify([
      { name: "company", score: 1, band: "high" },
      { name: "role", score: 1, band: "high" },
    ]),
    JSON.stringify([
      {
        source_id: "levels_fyi",
        source_url: "https://www.levels.fyi/companies/acme-ai/salaries/software-engineer",
        company_name: "Acme AI",
        role_title: "Senior Platform Engineer",
        location: "Europe",
        level_label: "senior",
        company_tier: "tier_2_ambitious",
        component: "total_compensation",
        currency: "EUR",
        period: "year",
        minimum_amount: 112000,
        maximum_amount: 142000,
        sample_count: 4,
        release_year: 2026,
        company_score: 1,
        role_score: 1,
        level_score: 0.95,
        location_score: 0.78,
        freshness_score: 0.95,
      },
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
        configPath: path.join(path.dirname(dbPath), "config.json"),
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
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/jobs" });
        expect(res.statusCode, res.body).toBe(200);
        const item = res
          .json()
          .items.find((j: { jobKey: string }) => j.jobKey === EVENT_JOB_ID);
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
        configPath: path.join(path.dirname(dbPath), "config.json"),
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
          .get(EVENT_JOB_ID) as
          | { salary: string; compensation_summary_json: string }
          | undefined;
        expect(listProjection?.salary).toBe("USD 70000-90000/year");
        const summary = JSON.parse(listProjection?.compensation_summary_json ?? "{}");
        expect(summary).toMatchObject({
          projectionVersion: 3,
          warningCount: 3,
          posted: {
            recordStatus: "recorded",
            parseState: "parsed_range",
            displayRange: "USD 70000-90000/year",
            warningCount: 1,
            range: {
              annualizedMinimumAmount: 70000,
              annualizedMaximumAmount: 90000,
              annualizedMinimumEur: 64400,
              annualizedMaximumEur: 82800,
            },
          },
          market: {
            sourceKind: "reported_company_role_market",
            benchmarkKind: null,
            recordStatus: "recorded",
            estimateState: "estimated_range",
            displayRange: "EUR 112000-142000/year",
            displayConfidenceInterval: "EUR 98000-176000/year",
            confidenceScore: 0.82,
            sourceCount: 2,
            sampleCount: 7,
            warningCount: 2,
            range: {
              annualizedMinimumAmount: 112000,
              annualizedMaximumAmount: 142000,
              annualizedMinimumEur: 112000,
              annualizedMaximumEur: 142000,
            },
            confidenceInterval: {
              minimumAmount: 98000,
              maximumAmount: 176000,
              annualizedMinimumAmount: 98000,
              annualizedMaximumAmount: 176000,
              annualizedMinimumEur: 98000,
              annualizedMaximumEur: 176000,
              displayRange: "EUR 98000-176000/year",
            },
          },
        });

        const detailProjection = db
          .prepare(
            `SELECT compensation_audit_json
               FROM job_detail_projections
              WHERE tenant_id = 'local' AND job_id = ?`,
          )
          .get(EVENT_JOB_ID) as
          | { compensation_audit_json: string }
          | undefined;
        const audit = JSON.parse(detailProjection?.compensation_audit_json ?? "{}");
        expect(audit.posted.fact.sourceText).toBe("USD 70000-90000/year");
        expect(audit.market.estimate.sources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceId: "levels_fyi",
              provenance: "licensed",
              displayName: "Levels.fyi",
              snapshotVersion: "levels-fyi-licensed-2026-q2",
              attribution: "Levels.fyi licensed Q2 export",
            }),
            expect.objectContaining({
              sourceId: "glassdoor",
              displayName: "Glassdoor",
            }),
            expect.objectContaining({
              sourceId: "levels_fyi",
              provenance: "public",
              snapshotVersion: "levels-fyi-public-2026",
              attribution: "Data source: Levels.fyi (https://www.levels.fyi)",
              sampleCount: null,
            }),
          ]),
        );
        expect(audit.market.estimate.companyName).toBe("Acme AI");
        expect(audit.market.estimate.matchScope).toBe("exact_company_role");
        expect(audit.market.estimate.confidenceInterval).toEqual({
          minimumAmount: 98000,
          maximumAmount: 176000,
        });
        expect(JSON.stringify(audit)).not.toContain("/Users/");
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  it("rebuilds settled v1 compensation projections across the posted-market authority upgrade", () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      insertCompensationRows(dbPath);
      const db = new Database(dbPath);
      try {
        refreshProjections(db);
        const initial = db
          .prepare(
            `SELECT compensation_summary_json
               FROM job_list_projections
              WHERE tenant_id = 'local' AND job_id = ?`,
          )
          .get(EVENT_JOB_ID) as { compensation_summary_json: string };
        expect(JSON.parse(initial.compensation_summary_json)).toMatchObject({
          projectionVersion: 3,
          market: { recordStatus: "recorded" },
        });

        for (const { table, column } of [
          { table: "job_list_projections", column: "compensation_summary_json" },
          { table: "job_detail_projections", column: "compensation_summary_json" },
          { table: "job_detail_projections", column: "compensation_audit_json" },
        ]) {
          const row = db
            .prepare(`SELECT ${column} AS payload FROM ${table} WHERE tenant_id = 'local' AND job_id = ?`)
            .get(EVENT_JOB_ID) as { payload: string };
          const payload = JSON.parse(row.payload);
          payload.projectionVersion = 1;
          db.prepare(`UPDATE ${table} SET ${column} = ? WHERE tenant_id = 'local' AND job_id = ?`).run(
            JSON.stringify(payload),
            EVENT_JOB_ID,
          );
        }
        db.prepare(
          `UPDATE job_market_compensation_estimates
              SET source_snapshot_json = ?, warnings_json = ?
            WHERE tenant_id = 'local' AND job_id = ?`,
        ).run(
          JSON.stringify([
            {
              source_id: "posted_salary_text",
              source_provenance: "employer_posted",
              source_type: "posted_salary",
            },
          ]),
          JSON.stringify(["posted_salary_sample"]),
          EVENT_JOB_ID,
        );

        // The original event is already folded; projectionVersion is the
        // deterministic dirty signal for this authority migration.
        refreshProjections(db);

        const rebuilt = db
          .prepare(
            `SELECT list.compensation_summary_json,
                    detail.compensation_summary_json AS detail_summary_json,
                    detail.compensation_audit_json
               FROM job_list_projections AS list
               JOIN job_detail_projections AS detail
                 ON detail.tenant_id = list.tenant_id
                AND detail.job_id = list.job_id
              WHERE list.tenant_id = 'local' AND list.job_id = ?`,
          )
          .get(EVENT_JOB_ID) as {
          compensation_summary_json: string;
          detail_summary_json: string;
          compensation_audit_json: string;
        };
        const summary = JSON.parse(rebuilt.compensation_summary_json);
        const detailSummary = JSON.parse(rebuilt.detail_summary_json);
        const audit = JSON.parse(rebuilt.compensation_audit_json);
        expect(summary).toMatchObject({
          projectionVersion: 3,
          market: { recordStatus: "not_requested", displayRange: null },
        });
        expect(detailSummary.projectionVersion).toBe(3);
        expect(audit).toMatchObject({
          projectionVersion: 3,
          market: { recordStatus: "not_requested" },
        });
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  it("keeps extrapolation safety warnings and country lineage during a TypeScript rebuild", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      insertCompensationRows(dbPath);
      const db = new Database(dbPath);
      try {
        db.prepare(
          `UPDATE job_market_compensation_estimates
              SET minimum_amount = ?,
                  maximum_amount = ?,
                  confidence_interval_minimum_amount = ?,
                  confidence_interval_maximum_amount = ?,
                  confidence_band = ?,
                  confidence_score = ?,
                  source_count = ?,
                  sample_count = ?,
                  geography_scope = ?,
                  source_snapshot_json = ?,
                  warnings_json = ?,
                  estimator_version = ?
            WHERE tenant_id = 'local' AND job_id = ?`,
        ).run(
          1_200_000,
          1_800_000,
          900_000,
          2_100_000,
          "low",
          0.31,
          1,
          4,
          "country",
          JSON.stringify([
            {
              source_id: "levels_fyi",
              source_provenance: "public",
              source_type: "reported_compensation",
              release_year: 2026,
              snapshot_version: "levels-fyi-public-de-2026-08-12",
              geography_scope: "country",
              aggregate_bucket: "reported company-role compensation",
              attribution: "Data source: Levels.fyi (https://www.levels.fyi)",
              sample_count: 4,
            },
          ]),
          JSON.stringify([
            "benchmark_extrapolated",
            "cost_of_living_only",
            "factor_out_of_bounds",
          ]),
          "company-role-reported-compensation-canonical-benchmark-v1:extrapolated:fact-1",
          EVENT_JOB_ID,
        );
      } finally {
        db.close();
      }

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const response = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(response.statusCode, response.body).toBe(200);
      } finally {
        await app.close();
      }

      const readonlyDb = new Database(dbPath, { readonly: true });
      try {
        const rows = readonlyDb
          .prepare(
            `SELECT list.compensation_summary_json, detail.compensation_audit_json
               FROM job_list_projections AS list
               JOIN job_detail_projections AS detail
                 ON detail.tenant_id = list.tenant_id
                AND detail.job_id = list.job_id
              WHERE list.tenant_id = 'local' AND list.job_id = ?`,
          )
          .get(EVENT_JOB_ID) as
          | { compensation_summary_json: string; compensation_audit_json: string }
          | undefined;
        const summary = JSON.parse(rows?.compensation_summary_json ?? "{}");
        expect(summary.market).toMatchObject({
          displayRange: "EUR 1200000-1800000/year",
          warningCount: 3,
        });
        const audit = JSON.parse(rows?.compensation_audit_json ?? "{}");
        expect(audit.market.estimate).toMatchObject({
          geographyScope: "country",
          sources: [expect.objectContaining({ geographyScope: "country" })],
        });
        expect(audit.market.estimate.warnings.map((warning: { code: string }) => warning.code)).toEqual([
          "benchmark_extrapolated",
          "cost_of_living_only",
          "factor_out_of_bounds",
        ]);
      } finally {
        readonlyDb.close();
      }
    } finally {
      cleanup();
    }
  });

  it("projects trimodal fallback and source-conflict evidence from canonical compensation rows", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      insertCompensationRows(dbPath);
      const db = new Database(dbPath);
      try {
        db.prepare(
          `UPDATE job_market_compensation_estimates
              SET minimum_amount = ?,
                  maximum_amount = ?,
                  confidence_band = ?,
                  confidence_score = ?,
                  aggregate_bucket = ?,
                  geography_scope = ?,
                  source_snapshot_json = ?,
                  factor_reasons_json = ?,
                  selected_evidence_json = ?,
                  warnings_json = ?,
                  company_name = ?,
                  normalized_company = ?,
                  role_title = ?,
                  normalized_role = ?,
                  company_tier = ?,
                  match_scope = ?
            WHERE tenant_id = 'local' AND job_id = ?`,
        ).run(
          168000,
          190000,
          "medium",
          0.62,
          "trimodal tier role fallback",
          "Europe",
          JSON.stringify([
            {
              source_id: "levels_fyi",
              display_name: "Levels.fyi rawProviderPayload",
              source_type: "reported_compensation",
              release_year: 2026,
              snapshot_version: "rawProviderPayload",
              geography_scope: "file:///Users/local/private",
              aggregate_bucket: "credential secret token",
              attribution: "api_key password",
              sample_count: 4,
            },
            {
              source_id: "glassdoor",
              display_name: "Glassdoor",
              source_type: "reported_compensation",
              release_year: 2026,
              sample_count: 3,
            },
          ]),
          JSON.stringify([
            { name: "company", score: 0.62, band: "medium", reason: "/Users/local credential" },
            { name: "role", score: 1, band: "high", reason: "Reported rows matched role Senior Platform Engineer." },
            { name: "trimodal_tier", score: 0.62, band: "medium", reason: "tier inferred" },
          ]),
          JSON.stringify([
            {
              source_id: "levels_fyi",
              source_url: "https://levels.example/private?token=secret",
              company_name: "private /Users/local credential",
              role_title: "Senior Platform Engineer",
              location: "file:///Users/local/private",
              level_label: "senior",
              company_tier: "tier_3_top_of_market",
              component: "total_compensation",
              currency: "EUR",
              period: "year",
              minimum_amount: 168000,
              maximum_amount: 190000,
              sample_count: 4,
              release_year: 2026,
              company_score: 0.62,
              role_score: 1,
              level_score: 0.95,
              location_score: 0.78,
              freshness_score: 0.95,
            },
            {
              source_id: "glassdoor",
              source_url: "https://www.glassdoor.com/Salary/Trimodal-Labs-Senior-Platform-Engineer-Salaries.htm",
              company_name: "Trimodal Labs",
              role_title: "Senior Platform Engineer",
              location: "Europe",
              level_label: "senior",
              company_tier: "tier_3_top_of_market",
              component: "total_compensation",
              currency: "EUR",
              period: "year",
              minimum_amount: 170000,
              maximum_amount: 188000,
              sample_count: 3,
              release_year: 2026,
              company_score: 1,
              role_score: 1,
              level_score: 0.95,
              location_score: 0.78,
              freshness_score: 0.95,
            },
          ]),
          JSON.stringify([
            "reported_compensation_sample",
            "company_role_fallback",
            "trimodal_tier_inferred",
            "source_conflict_with_posted_salary",
          ]),
          "Trimodal Labs",
          "trimodal labs",
          "Senior Platform Engineer",
          "platform engineer",
          "tier_3_top_of_market",
          "tier_role_fallback",
          EVENT_JOB_ID,
        );
      } finally {
        db.close();
      }

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(res.statusCode, res.body).toBe(200);
      } finally {
        await app.close();
      }

      const readonlyDb = new Database(dbPath, { readonly: true });
      try {
        const projections = readonlyDb
          .prepare(
            `SELECT l.compensation_summary_json, d.compensation_audit_json
               FROM job_list_projections AS l
               JOIN job_detail_projections AS d
                 ON d.tenant_id = l.tenant_id AND d.job_id = l.job_id
              WHERE l.tenant_id = 'local' AND l.job_id = ?`,
          )
          .get(EVENT_JOB_ID) as
          | { compensation_summary_json: string; compensation_audit_json: string }
          | undefined;
        const summary = JSON.parse(projections?.compensation_summary_json ?? "{}");
        expect(summary).toMatchObject({
          posted: {
            recordStatus: "recorded",
            parseState: "parsed_range",
          },
          market: {
            sourceKind: "reported_company_role_market",
            recordStatus: "recorded",
            estimateState: "estimated_range",
            confidenceBand: "medium",
            sourceCount: 2,
            warningCount: 4,
            displayRange: "EUR 168000-190000/year",
          },
        });

        const audit = JSON.parse(projections?.compensation_audit_json ?? "{}");
        expect(audit.posted.recordStatus).toBe("recorded");
        expect(audit.market.estimate).toMatchObject({
          matchScope: "tier_role_fallback",
          aggregateBucket: "trimodal tier role fallback",
          confidenceBand: "medium",
          companyTier: "tier_3_top_of_market",
        });
        expect(audit.market.estimate.factors.map((factor: { name: string }) => factor.name)).toEqual(
          expect.arrayContaining(["company", "role", "trimodal_tier"]),
        );
        expect(audit.market.estimate.factors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "role",
              reason: "Reported rows matched role Senior Platform Engineer.",
            }),
            expect.objectContaining({
              name: "company",
              reason: "Reported compensation estimate factor recorded by the deterministic company-role estimator.",
            }),
          ]),
        );
        expect(audit.market.estimate.evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceId: "levels_fyi",
              sourceUrl: null,
              companyName: "unknown company",
              roleTitle: "Senior Platform Engineer",
              location: null,
              minimumAmount: 168000,
              maximumAmount: 190000,
            }),
            expect.objectContaining({
              sourceId: "glassdoor",
              sourceUrl: "https://www.glassdoor.com/Salary/Trimodal-Labs-Senior-Platform-Engineer-Salaries.htm",
              companyName: "Trimodal Labs",
              roleTitle: "Senior Platform Engineer",
              minimumAmount: 170000,
              maximumAmount: 188000,
            }),
          ]),
        );
        expect(audit.market.estimate.warnings.map((warning: { code: string }) => warning.code)).toEqual(
          expect.arrayContaining([
            "reported_compensation_sample",
            "company_role_fallback",
            "trimodal_tier_inferred",
            "source_conflict_with_posted_salary",
          ]),
        );
        expect(audit.market.estimate.sources.map((source: { sourceId: string }) => source.sourceId)).toEqual([
          "levels_fyi",
          "glassdoor",
        ]);
        const serialized = JSON.stringify({ summary, audit }).toLowerCase();
        for (const unsafe of [
          "/users/",
          "file://",
          "rawproviderpayload",
          "credential",
          "secret",
          "api_key",
          "token",
          "password",
        ]) {
          expect(serialized).not.toContain(unsafe);
        }
      } finally {
        readonlyDb.close();
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
        `INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at, finished_at)
         VALUES ('local', ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, job_id, stage) DO UPDATE SET
           state = excluded.state,
           updated_at = excluded.updated_at,
           finished_at = excluded.finished_at`,
      );
      insertStage.run(
        EVENT_JOB_ID,
        "discover",
        "succeeded",
        "2026-05-04T13:00:00+00:00",
        "2026-05-04T13:00:00+00:00",
      );
      insertStage.run(
        EVENT_JOB_ID,
        "enrich",
        "succeeded",
        "2026-05-04T13:05:00+00:00",
        "2026-05-04T13:05:00+00:00",
      );
      insertStage.run(
        EVENT_JOB_ID,
        "score",
        "pending",
        "2026-05-04T13:10:00+00:00",
        null,
      );
      db.close();

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const listRes = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(listRes.statusCode, listRes.body).toBe(200);
        const item = listRes
          .json()
          .items.find((job: { jobKey: string }) => job.jobKey === EVENT_JOB_ID);
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

  it.each([
    [
      "APPLY_URL_EXTERNAL_RECOVERED",
      "An external application URL was recovered.",
      false,
      "click",
    ],
    [
      "APPLY_URL_LINKEDIN_ONSITE",
      "LinkedIn uses an on-site application flow for this posting; no external application URL exists.",
      false,
      "linkedin_onsite_apply",
    ],
    [
      "APPLY_URL_CONTROL_MISSING",
      "No application control was visible on the authenticated LinkedIn page.",
      true,
      "apply_button_missing",
    ],
    [
      "APPLY_URL_EXTERNAL_TARGET_MISSING",
      "An application control was visible, but no external application URL could be verified.",
      true,
      "external_url_missing",
    ],
    [
      "APPLY_URL_NAVIGATION_FAILED",
      "The authenticated LinkedIn page could not be inspected.",
      true,
      "navigation_error",
    ],
    [
      "APPLY_URL_UNSAFE_TARGET",
      "JobCtrl rejected the discovered application target because it is not a safe public HTTP(S) destination.",
      false,
      "unsafe_url",
    ],
  ])(
    "projects allow-listed outcome %s independently of Enrich success",
    async (code, message, retryable, method) => {
      const { dbPath, cleanup } = withTempDb();
      try {
        seedSchema(dbPath);
        const db = new Database(dbPath);
        db.prepare(
          `INSERT INTO job_stage_states (
             tenant_id, job_id, stage, state, updated_at, finished_at, metadata_json
           ) VALUES ('local', ?, 'enrich', 'succeeded', ?, ?, ?)
           ON CONFLICT(tenant_id, job_id, stage) DO UPDATE SET
             state = excluded.state,
             updated_at = excluded.updated_at,
             finished_at = excluded.finished_at,
             metadata_json = excluded.metadata_json`,
        ).run(
          EVENT_JOB_ID,
          "2026-05-04T13:05:00+00:00",
          "2026-05-04T13:05:00+00:00",
          JSON.stringify({
            authenticatedApplyUrlMethod: method,
            authenticatedApplyUrlError: "/private/path/must-not-project",
            applyUrlOutcomeCode: code,
            applyUrlOutcomeMessage: `${message} /private/path/must-not-project`,
            applyUrlOutcomeRetryable: !retryable,
          }),
        );
        db.close();

        const app = buildApp({
          dbPath,
          configPath: path.join(path.dirname(dbPath), "config.json"),
        });
        try {
          const response = await app.inject({
            method: "GET",
            url: `/v1/jobs/${encodeURIComponent(EVENT_JOB_URL)}`,
          });
          expect(response.statusCode, response.body).toBe(200);
          const enrich = response
            .json()
            .stages.find((stage: { stage: string }) => stage.stage === "enrich");
          expect(enrich).toMatchObject({
            state: "succeeded",
            applyUrlOutcome: {
              code,
              message,
              retryable,
              method,
            },
          });
          expect(JSON.stringify(enrich)).not.toContain("/private/path");
          expect(JSON.stringify(enrich)).not.toContain(
            "authenticatedApplyUrlError",
          );
        } finally {
          await app.close();
        }
      } finally {
        cleanup();
      }
    },
  );

  it("refreshes stale stage projections after workflow-scoped stage events", async () => {
    const { dbPath, cleanup } = withTempDb();
    const jobUrl = "https://example.com/jobs/event-driven";
    try {
      seedSchema(dbPath);
      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const baseline = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(baseline.statusCode, baseline.body).toBe(200);
        const item = baseline.json().items.find((job: { jobKey: string }) => job.jobKey === EVENT_JOB_ID);
        expect(item).toMatchObject({
          currentStage: "discover",
          currentSubstage: "enrich",
          currentState: "pending",
        });
      } finally {
        await app.close();
      }

      const db = new Database(dbPath);
      const insertStage = db.prepare(
        `INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at, finished_at)
         VALUES ('local', ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, job_id, stage) DO UPDATE SET
           state = excluded.state,
           updated_at = excluded.updated_at,
           finished_at = excluded.finished_at`,
      );
      insertStage.run(EVENT_JOB_ID, "discover", "succeeded", "2026-05-04T13:00:00+00:00", "2026-05-04T13:00:00+00:00");
      insertStage.run(EVENT_JOB_ID, "enrich", "succeeded", "2026-05-04T13:05:00+00:00", "2026-05-04T13:05:00+00:00");
      insertStage.run(EVENT_JOB_ID, "score", "pending", "2026-05-04T13:10:00+00:00", null);
      db.prepare("UPDATE job_list_projections SET last_updated_at = ? WHERE tenant_id = ? AND job_id = ?").run(
        "2026-05-04T12:00:00+00:00",
        "local",
        EVENT_JOB_ID,
      );
      db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) VALUES ('local', NULL, 1, ?, ?, ?, ?, ?, ?)",
      ).run(
        "discover",
        "StageCompleted",
        "info",
        "Discovery preparation complete",
        "2026-05-04T13:06:00+00:00",
        "{}",
      );
      db.close();

      const refreshedApp = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const listRes = await refreshedApp.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(listRes.statusCode, listRes.body).toBe(200);
        const item = listRes.json().items.find((job: { jobKey: string }) => job.jobKey === EVENT_JOB_ID);
        expect(item).toMatchObject({
          currentStage: "discover",
          currentSubstage: "score",
          currentState: "pending",
        });

        const detailRes = await refreshedApp.inject({
          method: "GET",
          url: `/v1/jobs/${encodeURIComponent(jobUrl)}`,
        });
        expect(detailRes.statusCode, detailRes.body).toBe(200);
        expect(detailRes.json().stages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ stage: "discover", state: "succeeded" }),
            expect.objectContaining({ stage: "enrich", state: "succeeded" }),
            expect.objectContaining({ stage: "score", state: "pending" }),
          ]),
        );
      } finally {
        await refreshedApp.close();
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
      db.prepare(
        `INSERT INTO job_materials (
           tenant_id, job_id, generation, status, created_at, updated_at
         ) VALUES ('local', ?, 1, 'complete', ?, ?)`,
      ).run(
        EVENT_JOB_ID,
        "2026-05-04T13:12:00+00:00",
        "2026-05-04T13:12:00+00:00",
      );
      db.prepare(
        `INSERT INTO job_materials_artifacts (
           tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
           render_format, created_at
         ) VALUES ('local', ?, 1, 'tailored_resume', 'resume-cover-ready', 'approved', ?, 'text', ?)`,
      ).run(
        EVENT_JOB_ID,
        "/tmp/tailored-resume.txt",
        "2026-05-04T13:12:00+00:00",
      );
      const insertStage = db.prepare(
        `INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at, finished_at)
         VALUES ('local', ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, job_id, stage) DO UPDATE SET
           state = excluded.state,
           updated_at = excluded.updated_at,
           finished_at = excluded.finished_at`,
      );
      for (const stage of ["discover", "enrich", "score", "tailor"]) {
        insertStage.run(
          EVENT_JOB_ID,
          stage,
          "succeeded",
          "2026-05-04T13:00:00+00:00",
          "2026-05-04T13:00:00+00:00",
        );
      }
      insertStage.run(
        EVENT_JOB_ID,
        "cover",
        "pending",
        "2026-05-04T13:15:00+00:00",
        null,
      );
      db.close();

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const listRes = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(listRes.statusCode, listRes.body).toBe(200);
        const item = listRes
          .json()
          .items.find((job: { jobKey: string }) => job.jobKey === EVENT_JOB_ID);
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
      const jobId = EVENT_JOB_ID;
      const insertMaterials = db.prepare(
        `INSERT INTO job_materials (
          tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES ('local', ?, ?, ?, ?, ?)`,
      );
      insertMaterials.run(
        jobId,
        1,
        "complete",
        "2026-05-04T12:00:00+00:00",
        "2026-05-04T12:10:00+00:00",
      );
      insertMaterials.run(
        jobId,
        3,
        "complete",
        "2026-05-04T13:00:00+00:00",
        "2026-05-04T13:10:00+00:00",
      );
      insertMaterials.run(
        jobId,
        4,
        "resume_in_progress",
        "2026-05-04T14:00:00+00:00",
        "2026-05-04T14:05:00+00:00",
      );
      const insertArtifact = db.prepare(
        `INSERT INTO job_materials_artifacts (
          tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertArtifact.run(
        jobId,
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
        jobId,
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
        jobId,
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
        jobId,
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
        configPath: path.join(path.dirname(dbPath), "config.json"),
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
          .get(jobId) as { has_resume: number; has_pdf: number } | undefined;
        expect(projection).toMatchObject({ has_resume: 1, has_pdf: 1 });

        const rejected = readDb
          .prepare(
            `SELECT status
               FROM artifact_list_projections
              WHERE tenant_id = 'local'
                AND job_id = ?
                AND artifact_id = 'gen4-rejected-resume'`,
          )
          .get(jobId) as { status: string } | undefined;
        expect(rejected).toMatchObject({ status: "rejected" });

        const explicitPdf = readDb
          .prepare(
            `SELECT metadata_json
               FROM artifact_list_projections
              WHERE tenant_id = 'local'
                AND job_id = ?
                AND artifact_type = 'tailored_resume_pdf'`,
          )
          .get(jobId) as { metadata_json: string | null } | undefined;
        expect(JSON.parse(explicitPdf?.metadata_json ?? "{}")).toEqual({});

        const approvedResume = readDb
          .prepare(
            `SELECT metadata_json
               FROM artifact_list_projections
              WHERE tenant_id = 'local'
                AND job_id = ?
                AND artifact_id = 'gen3-resume'`,
          )
          .get(jobId) as { metadata_json: string | null } | undefined;
        expect(JSON.parse(approvedResume?.metadata_json ?? "{}")).toMatchObject({
          quality_plan: { target_seniority: "executive" },
        });
      } finally {
        readDb.close();
      }
    } finally {
      cleanup();
    }
  });

  it("projects resume layout boxes for HTML-rendered PDF artifacts", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      const jobId = EVENT_JOB_ID;
      db.prepare(
        `INSERT INTO job_materials (
          tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES ('local', ?, 1, 'complete', ?, ?)`,
      ).run(jobId, "2026-05-04T13:00:00+00:00", "2026-05-04T13:10:00+00:00");
      db.prepare(
        `INSERT INTO job_materials_artifacts (
          tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES ('local', ?, 1, 'resume_pdf', 'html-resume-pdf', 'approved', ?, 'html_pdf', 20, '{}', ?)`,
      ).run(jobId, "/tmp/html-resume.pdf", "2026-05-04T13:06:00+00:00");
      db.prepare(
        `INSERT INTO job_material_layout_boxes (
          tenant_id, job_id, generation, artifact_id, box_index,
          semantic_id, page_number, line_number, text_excerpt,
          left_pct, top_pct, width_pct, height_pct, audit_target_json, created_at
        ) VALUES ('local', ?, 1, 'html-resume-pdf', 0, ?, 1, 6, ?, 12.5, 24.0, 62.0, 2.4, '{}', ?)`,
      ).run(jobId, "experience:acme:bullet:1", "Cut latency.", "2026-05-04T13:06:00+00:00");
      db.close();

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
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
            `SELECT layout_boxes_json
               FROM artifact_list_projections
              WHERE tenant_id = 'local'
                AND job_id = ?
                AND artifact_id = 'html-resume-pdf'`,
          )
          .get(jobId) as { layout_boxes_json: string | null } | undefined;
        expect(JSON.parse(projection?.layout_boxes_json ?? "[]")).toEqual([
          {
            semanticId: "experience:acme:bullet:1",
            pageNumber: 1,
            lineNumber: 6,
            textExcerpt: "Cut latency.",
            leftPct: 12.5,
            topPct: 24,
            widthPct: 62,
            heightPct: 2.4,
          },
        ]);
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
      const jobId = EVENT_JOB_ID;
      db.prepare(
        `INSERT INTO job_materials (
          tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES ('local', ?, 1, 'complete', ?, ?)`,
      ).run(jobId, "2026-05-04T13:00:00+00:00", "2026-05-04T13:10:00+00:00");
      db.prepare(
        `INSERT INTO job_materials_artifacts (
          tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES ('local', ?, 1, 'tailored_resume', 'stale-resume', 'approved', ?, 'text', 10, ?, ?)`,
      ).run(
        jobId,
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
        configPath: path.join(path.dirname(dbPath), "config.json"),
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
          .run(jobId);
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
          .get(jobId) as { metadata_json: string | null } | undefined;
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

  it("does not rebuild artifact projections from unrelated sibling metadata", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      const jobId = EVENT_JOB_ID;
      const insertMaterials = db.prepare(
        `INSERT INTO job_materials (
          tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES ('local', ?, ?, ?, ?, ?)`,
      );
      insertMaterials.run(
        jobId,
        1,
        "complete",
        "2026-05-04T13:00:00+00:00",
        "2026-05-04T13:10:00+00:00",
      );
      insertMaterials.run(
        jobId,
        2,
        "complete",
        "2026-05-04T14:00:00+00:00",
        "2026-05-04T14:10:00+00:00",
      );
      const insertArtifact = db.prepare(
        `INSERT INTO job_materials_artifacts (
          tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES ('local', ?, ?, 'tailored_resume', ?, ?, ?, 'text', ?, ?, ?)`,
      );
      insertArtifact.run(
        jobId,
        1,
        "approved-resume",
        "approved",
        "/tmp/approved-resume.txt",
        10,
        JSON.stringify({
          quality_plan: { target_seniority: "executive" },
          selected_model: "generator-a",
          adversarial_review: {
            llm_audit: {
              prompt_messages: [{ role: "user", content: "Run persona review." }],
            },
          },
        }),
        "2026-05-04T13:05:00+00:00",
      );
      insertArtifact.run(
        jobId,
        2,
        "rejected-resume",
        "rejected",
        "/tmp/rejected-resume.txt",
        11,
        "{}",
        "2026-05-04T14:05:00+00:00",
      );
      db.close();

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const firstRes = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(firstRes.statusCode, firstRes.body).toBe(200);

        const markerDb = new Database(dbPath);
        markerDb
          .prepare(
            `UPDATE artifact_list_projections
                SET status = 'sentinel'
              WHERE tenant_id = 'local'
                AND job_id = ?
                AND artifact_id = 'rejected-resume'`,
          )
          .run(jobId);
        markerDb.close();

        const secondRes = await app.inject({ method: "GET", url: "/v1/jobs?q=event" });
        expect(secondRes.statusCode, secondRes.body).toBe(200);
      } finally {
        await app.close();
      }

      const readDb = new Database(dbPath, { readonly: true });
      try {
        const projection = readDb
          .prepare(
            `SELECT status
               FROM artifact_list_projections
              WHERE tenant_id = 'local'
                AND job_id = ?
                AND artifact_id = 'rejected-resume'`,
          )
          .get(jobId) as { status: string } | undefined;
        expect(projection?.status).toBe("sentinel");
      } finally {
        readDb.close();
      }
    } finally {
      cleanup();
    }
  });

  it("projects canonical jobs inserted after the first projection refresh", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const firstRes = await app.inject({ method: "GET", url: "/v1/jobs" });
        expect(firstRes.statusCode, firstRes.body).toBe(200);

        const db = new Database(dbPath);
        db.prepare(
          "INSERT INTO jobs (tenant_id, job_id, url, title, site, strategy, location, discovered_at) VALUES ('local', ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          projectionFixtureJobId(2),
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
          .items.find((j: { jobKey: string }) => j.jobKey === projectionFixtureJobId(2));
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

  it("orders dashboard by_source by count desc then source name ascending", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      const insert = db.prepare(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, strategy, location, discovered_at) VALUES ('local', ?, ?, ?, ?, ?, ?, ?)",
      );
      // seedSchema pre-seeds one ExampleCo job (count 1). Netflix leads on
      // count; Acme and Wayfair tie at 2, seeded reverse-alphabetically so a
      // count-only sort would leak insertion order. The tiebreak re-orders the
      // tie A->Z, byte-identical to the Python builder.
      const seeded: Array<[string, string, string]> = [
        [projectionFixtureJobId(3), "https://example.com/jobs/w1", "Wayfair"],
        [projectionFixtureJobId(4), "https://example.com/jobs/w2", "Wayfair"],
        [projectionFixtureJobId(5), "https://example.com/jobs/n1", "Netflix"],
        [projectionFixtureJobId(6), "https://example.com/jobs/n2", "Netflix"],
        [projectionFixtureJobId(7), "https://example.com/jobs/n3", "Netflix"],
        [projectionFixtureJobId(8), "https://example.com/jobs/a1", "Acme"],
        [projectionFixtureJobId(9), "https://example.com/jobs/a2", "Acme"],
      ];
      for (const [jobId, url, site] of seeded) {
        insert.run(jobId, url, "Engineer", site, "jobspy", "Remote", "2026-05-06T09:00:00+00:00");
      }
      db.close();

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
        expect(res.statusCode, res.body).toBe(200);
      } finally {
        await app.close();
      }

      const readonlyDb = new Database(dbPath, { readonly: true });
      try {
        const row = readonlyDb
          .prepare("SELECT by_source_json FROM dashboard_projections WHERE tenant_id = 'local'")
          .get() as { by_source_json: string } | undefined;
        expect(JSON.parse(row?.by_source_json ?? "[]")).toEqual([
          ["Netflix", 3],
          ["Acme", 2],
          ["Wayfair", 2],
          ["ExampleCo", 1],
        ]);
      } finally {
        readonlyDb.close();
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
        "INSERT INTO jobs (tenant_id, job_id, url, title, company, site, strategy, location, discovered_at) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        projectionFixtureJobId(10),
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
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/jobs" });
        expect(res.statusCode, res.body).toBe(200);
        const item = res
          .json()
          .items.find((j: { jobKey: string }) => j.jobKey === projectionFixtureJobId(10));
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
      db.prepare(
        "UPDATE jobs SET company = 'Acme', site = 'greenhouse' WHERE tenant_id = 'local' AND job_id = ?",
      ).run(EVENT_JOB_ID);
      db.prepare(
        `INSERT INTO job_source_observations (
          tenant_id, source_observation_id, job_id, source_id,
          source_native_id, observed_url, normalized_observed_url,
          run_id, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "obs-linkedin",
        EVENT_JOB_ID,
        "jobspy:linkedin",
        "https://www.linkedin.com/jobs/view/1",
        "https://www.linkedin.com/jobs/view/1",
        "https://www.linkedin.com/jobs/view/1",
        "discovery:jobspy:test",
        "2026-05-06T09:01:00+00:00",
      );
      db.prepare(
        `INSERT INTO job_canonical_identities (
          tenant_id, job_id, canonical_url, ats_kind, source_native_id,
          confidence, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        EVENT_JOB_ID,
        "https://boards.greenhouse.io/acme/jobs/123456",
        "greenhouse",
        "123456",
        0.82,
        "2026-05-06T09:02:00+00:00",
      );
      db.close();

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const listRes = await app.inject({ method: "GET", url: "/v1/jobs" });
        expect(listRes.statusCode, listRes.body).toBe(200);
        const item = listRes
          .json()
          .items.find((j: { jobKey: string }) => j.jobKey === EVENT_JOB_ID);
        expect(item).toMatchObject({
          company: "Acme",
          source: "greenhouse",
          discoverySource: "jobspy:linkedin",
          postingSource: "greenhouse:acme",
          postingSourceUrl: "https://boards.greenhouse.io/acme/jobs/123456",
        });

        const companyFilteredRes = await app.inject({
          method: "GET",
          url: "/v1/jobs?company=Acme",
        });
        expect(companyFilteredRes.statusCode, companyFilteredRes.body).toBe(200);
        expect(companyFilteredRes.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([
          EVENT_JOB_ID,
        ]);

        const sourceFilteredRes = await app.inject({
          method: "GET",
          url: "/v1/jobs?source=greenhouse",
        });
        expect(sourceFilteredRes.statusCode, sourceFilteredRes.body).toBe(200);
        expect(sourceFilteredRes.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([
          EVENT_JOB_ID,
        ]);

        const postingSourceFilteredRes = await app.inject({
          method: "GET",
          url: "/v1/jobs?source=greenhouse%3Aacme&q=event",
        });
        expect(postingSourceFilteredRes.statusCode, postingSourceFilteredRes.body).toBe(200);
        expect(postingSourceFilteredRes.json().items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              jobKey: EVENT_JOB_ID,
              postingSource: "greenhouse:acme",
            }),
          ]),
        );

        const combinedFilteredRes = await app.inject({
          method: "GET",
          url: "/v1/jobs?company=Acme&source=greenhouse",
        });
        expect(combinedFilteredRes.statusCode, combinedFilteredRes.body).toBe(200);
        expect(combinedFilteredRes.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([
          EVENT_JOB_ID,
        ]);

        const crossedFilterRes = await app.inject({
          method: "GET",
          url: "/v1/jobs?company=greenhouse&source=Acme",
        });
        expect(crossedFilterRes.statusCode, crossedFilterRes.body).toBe(200);
        expect(crossedFilterRes.json().items).toEqual([]);

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
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const listRes = await app.inject({ method: "GET", url: "/v1/jobs" });
        expect(listRes.statusCode, listRes.body).toBe(200);
        const item = listRes
          .json()
          .items.find((j: { jobKey: string }) => j.jobKey === EVENT_JOB_ID);
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
    const jobId = EVENT_JOB_ID;
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      const requirements = [
        {
          id: "r1",
          text: "5+ years Python",
          tier: "must_have",
          weight: 0.9,
          evidence_span: "5+ years Python",
          coverage_scope: "resume",
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
          tenant_id, job_id, generation, snapshot_hash, prompt_version, sdk_set_version,
          cache_key, role_framing, inferred_seniority, ideal_candidate_narrative,
          requirements_json, keywords_json, agreement_json, legs_attempted, legs_succeeded, created_at
        ) VALUES ('local', ?, ?, ?, 'employer-analysis-v1', 'claude+codex-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertAnalysis.run(
        jobId, 1, "hash-old", "hash-old:employer-analysis-v1:claude+codex-v1",
        "Old framing.", "mid", "Old narrative.",
        "[]", "[]", JSON.stringify({ score: 0.5, flagged_requirements: [], flagged_keywords: [] }),
        2, 2, "2026-05-04T12:00:00+00:00",
      );
      insertAnalysis.run(
        jobId, 2, "hash-new", "hash-new:employer-analysis-v1:claude+codex-v1",
        "Own the event platform.", "senior", "A hands-on platform owner.",
        JSON.stringify(requirements), JSON.stringify(keywords),
        JSON.stringify({ score: 0.8, flagged_requirements: [], flagged_keywords: ["kafka"] }),
        2, 1, "2026-05-04T13:00:00+00:00",
      );
      db.prepare(
        `INSERT INTO job_employer_analysis_sub_analyses (tenant_id, job_id, generation, model_id, analysis_json)
         VALUES ('local', ?, 2, 'claude-opus-4-8', ?)`,
      ).run(
        jobId,
        JSON.stringify({
          role_framing: "Own the event platform.",
          inferred_seniority: "senior",
          ideal_candidate_narrative: "A hands-on platform owner.",
          requirements,
          keywords,
        }),
      );
      db.prepare(
        `INSERT INTO job_employer_analysis_failures (tenant_id, job_id, generation, model_id, error, raw_output)
         VALUES ('local', ?, 2, 'gpt-5.4', 'codex app-server timeout', NULL)`,
      ).run(jobId);
      db.close();

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const detailRes = await app.inject({
          method: "GET",
          url: `/v1/jobs/${encodeURIComponent(EVENT_JOB_URL)}`,
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
        expect(analysis.requirements[0]).toMatchObject({
          tier: "must_have",
          weight: 0.9,
          coverage_scope: "resume",
        });
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
    const jobId = EVENT_JOB_ID;
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      const insertReport = db.prepare(
        `INSERT INTO job_requirement_fit_reports (
          tenant_id, job_id, score_version, employer_analysis_generation,
          profile_snapshot_version, scoring_policy_version, formula_version,
          resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES ('local', ?, ?, ?, ?, ?, 'requirement-fit-v1', ?, ?, ?, ?, ?)`,
      );
      insertReport.run(
        jobId,
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
        jobId,
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
          tenant_id, job_id, score_version, requirement_id, requirement_text,
          tier, weight, job_evidence_span, fit_json, contribution_json,
          tailoring_json, artifact_coverage_json, position
        ) VALUES ('local', ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        jobId,
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
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const detailRes = await app.inject({
          method: "GET",
          url: `/v1/jobs/${encodeURIComponent(EVENT_JOB_URL)}`,
        });
        expect(detailRes.statusCode, detailRes.body).toBe(200);
        const report = detailRes.json().requirementFitReport;
        expect(report).toMatchObject({
          jobId,
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
        expect(report).not.toHaveProperty("jobKey");
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

  it("projects the career evidence map from profile evidence, provenance, and requirement fit", async () => {
    const { dbPath, cleanup } = withTempDb();
    const jobId = EVENT_JOB_ID;
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO candidate_profile_experience_entries
         (tenant_id, profile_id, entry_id, position_index, date_range, title, company, location)
         VALUES ('local', 'default', 'exp-platform', 0, '2024-2025', 'Senior Engineer', 'Acme', 'Remote')`,
      ).run();
      db.prepare(
        `INSERT INTO candidate_profile_achievement_evidence (
          tenant_id, profile_id, entry_id, evidence_index, evidence_id, source_text,
          scope, action, tools_json, metrics_json, outcome, seniority_signal,
          evidence_strength, claim_confidence, user_confirmed, tags_json
        ) VALUES ('local', 'default', 'exp-platform', 0, 'ev_platform', ?, ?, ?, ?, ?, ?, '', 'verified', 0.95, 1, ?)`,
      ).run(
        "Led a platform migration that reduced latency by 40%.",
        "Platform migration",
        "Led migration",
        JSON.stringify(["Python", "Postgres"]),
        JSON.stringify(["40% latency reduction"]),
        "Reduced latency",
        JSON.stringify(["migration"]),
      );
      db.prepare(
        `INSERT INTO candidate_profile_skill_categories
         (tenant_id, profile_id, category_id, position_index, label)
         VALUES ('local', 'default', 'backend', 0, 'Backend')`,
      ).run();
      db.prepare(
        `INSERT INTO candidate_profile_skill_items
         (tenant_id, profile_id, category_id, item_index, item_text)
         VALUES ('local', 'default', 'backend', 0, 'Python')`,
      ).run();
      db.prepare(
        `INSERT INTO job_materials
         (tenant_id, job_id, generation, status, created_at, updated_at)
         VALUES ('local', ?, 1, 'complete', '2026-07-05T12:00:00Z', '2026-07-05T12:10:00Z')`,
      ).run(jobId);
      db.prepare(
        `INSERT INTO job_materials_artifacts (
          tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES ('local', ?, 1, 'tailored_resume', 'artifact-resume-1', 'approved', '/tmp/resume.txt', 'text', 12, ?, '2026-07-05T12:05:00Z')`,
      ).run(jobId, JSON.stringify({ validation_mode: "normal", attempts: 1, quality_checks: { passed: true } }));
      db.prepare(
        `INSERT INTO job_bullet_provenance (
          tenant_id, job_id, generation, bullet_id, artifact_id, section, source_id,
          evidence_ids_json, requirement_ids_json, matched_keywords_json, transform_type,
          control, rationale, generated_text, position, created_at, coverage_json
        ) VALUES ('local', ?, 1, 'experience:exp-platform#0', 'artifact-resume-1', 'experience', 'exp-platform', ?, ?, ?, 'reframe', 'rephrase_allowed', 'Used profile evidence.', 'Led migration and reduced latency 40%.', 0, '2026-07-05T12:10:00Z', ?)`,
      ).run(
        jobId,
        JSON.stringify(["ev_platform"]),
        JSON.stringify(["req-platform"]),
        JSON.stringify(["latency"]),
        JSON.stringify({ covered: ["Python"], declared: [], missing: ["Kubernetes"] }),
      );
      db.prepare(
        `INSERT INTO job_requirement_fit_reports (
          tenant_id, job_id, score_version, employer_analysis_generation,
          profile_snapshot_version, scoring_policy_version, formula_version,
          resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES ('local', ?, 2, 1, 1, 1, 'v1', 8, 'strong', 'high', ?, '2026-07-05T12:20:00Z')`,
      ).run(jobId, JSON.stringify({ weighted_fit: 0.8, must_have_coverage: 0.5, blocker_count: 0, missing_high_weight_count: 1 }));
      const insertFitItem = db.prepare(
        `INSERT INTO job_requirement_fit_items (
          tenant_id, job_id, score_version, requirement_id, requirement_text,
          tier, weight, job_evidence_span, fit_json, contribution_json,
          tailoring_json, artifact_coverage_json, position
        ) VALUES ('local', ?, 2, ?, ?, 'must_have', ?, ?, ?, '{}', '{}', ?, ?)`,
      );
      insertFitItem.run(
        jobId,
        "req-platform",
        "Own platform migrations",
        0.8,
        "platform migrations",
        JSON.stringify({ kind: "matched", evidence_ids: ["ev_platform"], strength: "direct" }),
        JSON.stringify({ state: "covered", source: "tailored_resume_bullet_provenance", bullet_count: 1, examples: ["Led migration"] }),
        0,
      );
      insertFitItem.run(
        jobId,
        "req-kubernetes",
        "Run Kubernetes clusters",
        0.7,
        "Kubernetes clusters",
        JSON.stringify({ kind: "missing", reason: "No Kubernetes profile evidence." }),
        JSON.stringify({ state: "missing_from_profile", source: "tailored_resume_bullet_provenance", bullet_count: 0, examples: [] }),
        1,
      );
      db.close();

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const response = await app.inject({ method: "GET", url: "/v1/evidence-map" });
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json();
        const evidenceEntry = body.entries.find((entry: { evidenceId: string }) => entry.evidenceId === "ev_platform");
        expect(evidenceEntry).toBeTruthy();
        expect(evidenceEntry.resumeUsages).toMatchObject([
          { jobKey: jobId, artifactId: "artifact-resume-1", bulletId: "experience:exp-platform#0" },
        ]);
        expect(evidenceEntry.requirementUsages).toMatchObject([
          { jobKey: jobId, scoreVersion: 2, requirementId: "req-platform", requirementFitKind: "matched" },
        ]);
        expect(evidenceEntry.freshness).toMatchObject({
          evidenceDateRange: "2024-2025",
          evidenceStrength: "verified",
          userConfirmed: true,
          lastUsedAt: "2026-07-05T12:10:00Z",
        });
        expect(body.gaps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "missing_requirement",
              requirementId: "req-kubernetes",
              jobRefs: [expect.objectContaining({ jobKey: jobId, scoreVersion: 2 })],
            }),
            expect.objectContaining({
              kind: "missing_skill",
              demandedSkill: "Kubernetes",
              jobRefs: [expect.objectContaining({ jobKey: jobId, artifactId: "artifact-resume-1" })],
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

  it("excludes soft-deleted and hidden jobs from the career evidence map", async () => {
    // Regression for the R5 evidence-usage index: soft delete only writes a
    // jobctrl_deleted_jobs tombstone (and hide only writes jobctrl_hidden_jobs),
    // leaving the job_bullet_provenance / job_requirement_fit_items /
    // artifact_list_projections rows in place. Those rows must not re-surface a
    // removed job's title, employer, generated-text preview, usages, or gaps.
    const { dbPath, cleanup } = withTempDb();
    const activeUrl = "https://example.com/jobs/active-role";
    const deletedUrl = "https://example.com/jobs/deleted-role";
    const hiddenUrl = "https://example.com/jobs/hidden-role";
    const activeId = projectionFixtureJobId(11);
    const deletedId = projectionFixtureJobId(12);
    const hiddenId = projectionFixtureJobId(13);
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      // Shared profile evidence + skill that every job's tailoring references.
      db.prepare(
        `INSERT INTO candidate_profile_experience_entries
         (tenant_id, profile_id, entry_id, position_index, date_range, title, company, location)
         VALUES ('local', 'default', 'exp-platform', 0, '2024-2025', 'Senior Engineer', 'Acme', 'Remote')`,
      ).run();
      db.prepare(
        `INSERT INTO candidate_profile_achievement_evidence (
          tenant_id, profile_id, entry_id, evidence_index, evidence_id, source_text,
          scope, action, tools_json, metrics_json, outcome, seniority_signal,
          evidence_strength, claim_confidence, user_confirmed, tags_json
        ) VALUES ('local', 'default', 'exp-platform', 0, 'ev_platform', ?, ?, ?, ?, ?, ?, '', 'verified', 0.95, 1, ?)`,
      ).run(
        "Led a platform migration that reduced latency by 40%.",
        "Platform migration",
        "Led migration",
        JSON.stringify(["Python", "Postgres"]),
        JSON.stringify(["40% latency reduction"]),
        "Reduced latency",
        JSON.stringify(["migration"]),
      );
      db.prepare(
        `INSERT INTO candidate_profile_skill_categories
         (tenant_id, profile_id, category_id, position_index, label)
         VALUES ('local', 'default', 'backend', 0, 'Backend')`,
      ).run();
      db.prepare(
        `INSERT INTO candidate_profile_skill_items
         (tenant_id, profile_id, category_id, item_index, item_text)
         VALUES ('local', 'default', 'backend', 0, 'Python')`,
      ).run();

      const insertJob = db.prepare(
        "INSERT INTO jobs (tenant_id, job_id, url, title, company, site) VALUES ('local', ?, ?, ?, ?, ?)",
      );
      const insertScore = db.prepare(
        `INSERT INTO job_scores (
           tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at
         ) VALUES ('local', ?, 2, 8, '{}', '[]', '2026-07-05T11:00:00Z')`,
      );
      const insertMaterials = db.prepare(
        `INSERT INTO job_materials (tenant_id, job_id, generation, status, created_at, updated_at)
         VALUES ('local', ?, 1, 'complete', '2026-07-05T12:00:00Z', '2026-07-05T12:10:00Z')`,
      );
      const insertArtifact = db.prepare(
        `INSERT INTO job_materials_artifacts (
          tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES ('local', ?, 1, 'tailored_resume', ?, 'approved', ?, 'text', 12, ?, '2026-07-05T12:05:00Z')`,
      );
      const insertProvenance = db.prepare(
        `INSERT INTO job_bullet_provenance (
          tenant_id, job_id, generation, bullet_id, artifact_id, section, source_id,
          evidence_ids_json, requirement_ids_json, matched_keywords_json, transform_type,
          control, rationale, generated_text, position, created_at, coverage_json
        ) VALUES ('local', ?, 1, 'experience:exp-platform#0', ?, 'experience', 'exp-platform', ?, ?, ?, 'reframe', 'rephrase_allowed', 'Used profile evidence.', ?, 0, ?, ?)`,
      );
      const insertReport = db.prepare(
        `INSERT INTO job_requirement_fit_reports (
          tenant_id, job_id, score_version, employer_analysis_generation,
          profile_snapshot_version, scoring_policy_version, formula_version,
          resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES ('local', ?, 2, 1, 1, 1, 'v1', 8, 'strong', 'high', ?, '2026-07-05T12:20:00Z')`,
      );
      const insertFitItem = db.prepare(
        `INSERT INTO job_requirement_fit_items (
          tenant_id, job_id, score_version, requirement_id, requirement_text,
          tier, weight, job_evidence_span, fit_json, contribution_json,
          tailoring_json, artifact_coverage_json, position
        ) VALUES ('local', ?, 2, ?, ?, 'must_have', ?, ?, ?, '{}', '{}', ?, ?)`,
      );

      const seedJobEvidence = (
        jobId: string,
        jobUrl: string,
        opts: { title: string; company: string; artifactId: string; generatedText: string; createdAt: string },
      ): void => {
        insertJob.run(jobId, jobUrl, opts.title, opts.company, "example.com");
        insertScore.run(jobId);
        insertMaterials.run(jobId);
        insertArtifact.run(
          jobId,
          opts.artifactId,
          `/tmp/${opts.artifactId}.txt`,
          JSON.stringify({ validation_mode: "normal", attempts: 1, quality_checks: { passed: true } }),
        );
        insertProvenance.run(
          jobId,
          opts.artifactId,
          JSON.stringify(["ev_platform"]),
          JSON.stringify(["req-platform"]),
          JSON.stringify(["latency"]),
          opts.generatedText,
          opts.createdAt,
          JSON.stringify({ covered: ["Python"], declared: [], missing: ["Kubernetes"] }),
        );
        insertReport.run(
          jobId,
          JSON.stringify({ weighted_fit: 0.8, must_have_coverage: 0.5, blocker_count: 0, missing_high_weight_count: 1 }),
        );
        insertFitItem.run(
          jobId,
          "req-platform",
          "Own platform migrations",
          0.8,
          "platform migrations",
          JSON.stringify({ kind: "matched", evidence_ids: ["ev_platform"], strength: "direct" }),
          JSON.stringify({ state: "covered", source: "tailored_resume_bullet_provenance", bullet_count: 1, examples: ["Led migration"] }),
          0,
        );
        insertFitItem.run(
          jobId,
          "req-kubernetes",
          "Run Kubernetes clusters",
          0.7,
          "Kubernetes clusters",
          JSON.stringify({ kind: "missing", reason: "No Kubernetes profile evidence." }),
          JSON.stringify({ state: "missing_from_profile", source: "tailored_resume_bullet_provenance", bullet_count: 0, examples: [] }),
          1,
        );
      };

      seedJobEvidence(activeId, activeUrl, {
        title: "Active Platform Role",
        company: "ActiveCorp",
        artifactId: "artifact-active",
        generatedText: "ACTIVE-bullet reduced latency 40%.",
        createdAt: "2026-07-05T12:10:00Z",
      });
      seedJobEvidence(deletedId, deletedUrl, {
        title: "Deleted Platform Role",
        company: "DeletedCorp",
        artifactId: "artifact-deleted",
        generatedText: "DELETED-bullet should never surface.",
        createdAt: "2026-07-04T12:10:00Z",
      });
      seedJobEvidence(hiddenId, hiddenUrl, {
        title: "Hidden Platform Role",
        company: "HiddenCorp",
        artifactId: "artifact-hidden",
        generatedText: "HIDDEN-bullet should never surface.",
        createdAt: "2026-07-03T12:10:00Z",
      });

      db.prepare(
        `INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at, reason, restored_at)
         VALUES ('local', ?, '2026-07-05T13:00:00Z', 'user delete', NULL)`,
      ).run(deletedId);
      db.prepare(
        `INSERT INTO jobctrl_hidden_jobs (tenant_id, job_id, hidden_at, reason, unhidden_at)
         VALUES ('local', ?, '2026-07-05T13:00:00Z', 'user hide', NULL)`,
      ).run(hiddenId);
      db.close();

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const response = await app.inject({ method: "GET", url: "/v1/evidence-map" });
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json();

        const referencedJobKeys = new Set<string>();
        for (const entry of body.entries as Array<{
          resumeUsages: Array<{ jobKey: string }>;
          requirementUsages: Array<{ jobKey: string }>;
          coverageUsages: Array<{ jobKey: string }>;
        }>) {
          for (const usage of [...entry.resumeUsages, ...entry.requirementUsages, ...entry.coverageUsages]) {
            referencedJobKeys.add(usage.jobKey);
          }
        }
        for (const gap of body.gaps as Array<{ jobRefs: Array<{ jobKey: string }> }>) {
          for (const ref of gap.jobRefs) referencedJobKeys.add(ref.jobKey);
        }

        // The live job still populates the map (positive control) ...
        expect(referencedJobKeys.has(activeId)).toBe(true);
        // ... while the soft-deleted and hidden jobs are fully excluded.
        expect(referencedJobKeys.has(deletedId)).toBe(false);
        expect(referencedJobKeys.has(hiddenId)).toBe(false);

        // No removed job's title, employer, or generated-text preview may leak
        // through any evidence field.
        const serialized = JSON.stringify(body);
        for (const leaked of [
          "Deleted Platform Role",
          "DeletedCorp",
          "DELETED-bullet",
          "Hidden Platform Role",
          "HiddenCorp",
          "HIDDEN-bullet",
        ]) {
          expect(serialized).not.toContain(leaked);
        }
        expect(serialized).toContain("ACTIVE-bullet");
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
    const jobId = EVENT_JOB_ID;
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
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
        `INSERT INTO job_materials (tenant_id, job_id, generation, status, created_at, updated_at)
         VALUES ('local', ?, 1, 'complete', '2026-06-08T12:00:00+00:00', '2026-06-08T12:10:00+00:00')`,
      ).run(jobId);
      const insertArtifact = db.prepare(
        `INSERT INTO job_materials_artifacts (
          tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES ('local', ?, 1, ?, ?, 'approved', ?, ?, ?, ?, '2026-06-08T12:05:00+00:00')`,
      );
      insertArtifact.run(jobId, "tailored_resume", "resume-1", "/tmp/resume.txt", "text", 10, completeMetadata);
      insertArtifact.run(jobId, "resume_pdf", "resume-pdf-1", "/tmp/resume.pdf", "pdf", 20, "{}");

      // Provenance rows (as the Python repo writes them): bound to the text
      // resume artifact, ordered by position.
      const insertProvenance = db.prepare(
        `INSERT INTO job_bullet_provenance (
          tenant_id, job_id, generation, bullet_id, artifact_id, section, source_id,
          evidence_ids_json, requirement_ids_json, matched_keywords_json,
          transform_type, control, rationale, generated_text, position, created_at
        ) VALUES ('local', ?, 1, ?, 'resume-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-06-08T12:10:00+00:00')`,
      );
      insertProvenance.run(
        jobId, "executive_profile#0", "executive_profile", "executive_profile",
        "[]", "[]", "[]", "reframe", "rephrase_allowed", "Reframed summary.",
        "Senior backend engineer focused on Python.", 0,
      );
      insertProvenance.run(
        jobId, "experience:acme_swe#0", "experience", "acme_swe",
        JSON.stringify(["ev_latency"]), JSON.stringify(["req_latency"]), JSON.stringify(["latency"]),
        "quantify_from_evidence", "never_fabricate_metrics", "Surfaced a recorded metric.",
        "Owned the API and cut latency 40%.", 1,
      );
      db.close();

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
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
    const jobId = EVENT_JOB_ID;
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
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
        `INSERT INTO job_materials (tenant_id, job_id, generation, status, created_at, updated_at)
         VALUES ('local', ?, 1, 'complete', '2026-06-08T12:00:00+00:00', '2026-06-08T12:10:00+00:00')`,
      ).run(jobId);
      db.prepare(
        `INSERT INTO job_materials (tenant_id, job_id, generation, status, created_at, updated_at)
         VALUES ('local', ?, 2, 'complete', '2026-06-09T12:00:00+00:00', '2026-06-09T12:10:00+00:00')`,
      ).run(jobId);
      const insertArtifact = db.prepare(
        `INSERT INTO job_materials_artifacts (
          tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
          render_format, size_bytes, metadata_json, created_at
        ) VALUES ('local', ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)`,
      );
      insertArtifact.run(
        jobId,
        1,
        "tailored_resume",
        "resume-1",
        "/tmp/resume.txt",
        "text",
        10,
        completeMetadata,
        "2026-06-08T12:05:00+00:00",
      );
      insertArtifact.run(
        jobId,
        1,
        "resume_pdf",
        "resume-pdf-1",
        "/tmp/resume.pdf",
        "pdf",
        20,
        "{}",
        "2026-06-08T12:05:00+00:00",
      );
      insertArtifact.run(
        jobId,
        2,
        "tailored_resume",
        "resume-2",
        "/tmp/resume-v2.txt",
        "text",
        12,
        completeMetadata,
        "2026-06-09T12:05:00+00:00",
      );

      // The set-level coverage + voice, denormalised onto every row (the Python
      // repo writes the SAME value on each row of the generation).
      const coverageJsonGen1 = JSON.stringify({
        computed_against: "rendered_text",
        planned: ["latency", "terraform", "python"],
        covered: ["latency"],
        declared: ["terraform"],
        missing: ["python"],
        covered_by: { latency: "experience:acme_swe#0" },
        declared_by: { terraform: "skills:cloud#0" },
        counts: { planned: 3, covered: 1, declared: 1, missing: 1 },
      });
      const coverageJsonGen2 = JSON.stringify({
        computed_against: "rendered_text",
        planned: ["latency", "incident response", "python"],
        covered: ["latency", "incident response"],
        declared: [],
        missing: ["python"],
        covered_by: {
          latency: "experience:acme_swe#0",
          "incident response": "experience:incident#0",
        },
        declared_by: {},
        counts: { planned: 3, covered: 2, declared: 0, missing: 1 },
      });
      const voiceJson = JSON.stringify({
        ran: true,
        accepted: true,
        model: "claude-opus-4-8",
        prompt_version: "voice-pass-v1",
        proxy_delta: { improved: true, buzzword_density_reduced: true },
        reason: "",
        final_judge: {
          passed: true,
          verdict: "PASS",
          score: 0.91,
          judge_model: "judge-a",
          adversarial_review: {
            ran: true,
            passed: true,
            score: 0.9,
            blockers: [],
            warnings: [],
            repair_instructions: [],
            personas: [],
            llm_audit: {
              model: "judge-a",
              prompt_messages: [
                { role: "user", content: "FULL PROFILE SECRET and complete resume text" },
              ],
            },
          },
          unbounded_internal_record: "FULL PROFILE SECRET",
        },
      });
      const insertProvenance = db.prepare(
        `INSERT INTO job_bullet_provenance (
          tenant_id, job_id, generation, bullet_id, artifact_id, section, source_id,
          evidence_ids_json, requirement_ids_json, matched_keywords_json,
          transform_type, control, rationale, generated_text, position, created_at,
          coverage_json, voice_json
        ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertProvenance.run(
        jobId, 1, "experience:acme_swe#0", "resume-1", "experience", "acme_swe",
        JSON.stringify(["ev_latency"]), JSON.stringify(["req_latency"]), JSON.stringify(["latency"]),
        "voice", "rephrase_allowed", "Voiced bullet.",
        "Owned the API and cut latency 40%.", 0, "2026-06-08T12:10:00+00:00", coverageJsonGen1, voiceJson,
      );
      insertProvenance.run(
        jobId, 2, "experience:incident#0", "resume-2", "experience", "incident_response",
        JSON.stringify(["ev_incident"]), JSON.stringify(["req_incident"]), JSON.stringify(["incident response"]),
        "voice", "rephrase_allowed", "Voiced bullet.",
        "Owned incident response drills.", 0, "2026-06-09T12:10:00+00:00", coverageJsonGen2, voiceJson,
      );
      db.close();

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const resumeRes = await app.inject({ method: "GET", url: "/v1/artifacts/resume-1" });
        expect(resumeRes.statusCode, resumeRes.body).toBe(200);
        const explanation = resumeRes.json().tailoringExplanation;
        expect(explanation.coverageAudit).toMatchObject({
          computedAgainst: "rendered_text",
          covered: ["latency"],
          declared: ["terraform"],
          missing: ["python"],
          coveredBy: { latency: "experience:acme_swe#0" },
          declaredBy: { terraform: "skills:cloud#0" },
          counts: { planned: 3, covered: 1, declared: 1, missing: 1 },
        });
        expect(explanation.voicePass).toMatchObject({
          ran: true,
          accepted: true,
          model: "claude-opus-4-8",
          promptVersion: "voice-pass-v1",
          finalJudge: {
            passed: true,
            verdict: "PASS",
            score: 0.91,
            judge_model: "judge-a",
            adversarial_review: expect.objectContaining({ ran: true, audit: null }),
          },
        });
        expect(JSON.stringify(explanation.voicePass)).not.toContain("FULL PROFILE SECRET");
        expect(explanation.voicePass.finalJudge).not.toHaveProperty("unbounded_internal_record");
        // The voiced bullet is served with transformType "voice".
        expect(explanation.bulletProvenance[0].transformType).toBe("voice");

        // Historical and current text artifacts each keep their own generation's
        // canonical coverage row.
        const resume2Res = await app.inject({ method: "GET", url: "/v1/artifacts/resume-2" });
        expect(resume2Res.statusCode, resume2Res.body).toBe(200);
        const resume2Explanation = resume2Res.json().tailoringExplanation;
        expect(resume2Explanation.coverageAudit?.covered).toEqual(["latency", "incident response"]);
        expect(resume2Explanation.coverageAudit?.declared).toEqual([]);
        expect(resume2Explanation.coverageAudit?.missing).toEqual(["python"]);

        // The PDF artifact resolves coverage + voice from its same-generation
        // sibling text row, not the newer generation.
        const pdfRes = await app.inject({ method: "GET", url: "/v1/artifacts/resume-pdf-1" });
        expect(pdfRes.statusCode, pdfRes.body).toBe(200);
        const pdfExplanation = pdfRes.json().tailoringExplanation;
        expect(pdfExplanation.coverageAudit?.covered).toEqual(["latency"]);
        expect(pdfExplanation.coverageAudit?.declared).toEqual(["terraform"]);
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
        configPath: path.join(path.dirname(dbPath), "config.json"),
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
        configPath: path.join(path.dirname(dbPath), "config.json"),
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
        configPath: path.join(path.dirname(dbPath), "config.json"),
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

  it("surfaces politeness outcomes per source without counting them as failures", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      // Source A: only politeness "blocked" outcomes — a robots deny then two
      // rate-limits. These are NON-error outcomes (is_scrape_failure = 0).
      insertOperationalMetric(dbPath, {
        stage: "discover",
        attemptKind: "politeness_gate",
        outcome: "blocked",
        occurredAt: "2026-05-15T00:00:00Z",
        sourceId: "greenhouse:acme",
        failureCategory: "robots_disallowed",
      });
      insertOperationalMetric(dbPath, {
        stage: "discover",
        attemptKind: "politeness_gate",
        outcome: "blocked",
        occurredAt: "2026-05-15T00:01:00Z",
        sourceId: "greenhouse:acme",
        failureCategory: "rate_limited",
      });
      insertOperationalMetric(dbPath, {
        stage: "enrich",
        attemptKind: "politeness_gate",
        outcome: "blocked",
        occurredAt: "2026-05-15T00:02:00Z",
        sourceId: "greenhouse:acme",
        failureCategory: "rate_limited",
      });
      // Source B: a real scrape failure AND a budget-exhaustion outcome. The two
      // must be reported on independent axes.
      insertOperationalMetric(dbPath, {
        stage: "discover",
        attemptKind: "discovery_source",
        outcome: "failed",
        occurredAt: "2026-05-15T00:03:00Z",
        sourceId: "jobspy:linkedin",
        adapter: "jobspy",
        failureCategory: "timeout",
        operationalFailure: true,
        scrapeFailure: true,
        retryable: true,
        errorClass: "TimeoutError",
      });
      insertOperationalMetric(dbPath, {
        stage: "discover",
        attemptKind: "politeness_gate",
        outcome: "blocked",
        occurredAt: "2026-05-15T00:04:00Z",
        sourceId: "jobspy:linkedin",
        failureCategory: "budget_exhausted",
      });
      // Source C: only a real scrape failure, no politeness outcomes at all.
      insertOperationalMetric(dbPath, {
        stage: "discover",
        attemptKind: "discovery_source",
        outcome: "failed",
        occurredAt: "2026-05-15T00:05:00Z",
        sourceId: "workday:beta",
        adapter: "workday",
        failureCategory: "http_500",
        operationalFailure: true,
        scrapeFailure: true,
        retryable: true,
        errorClass: "HttpError",
      });

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
        expect(res.statusCode, res.body).toBe(200);
        const sources = new Map<string, Record<string, unknown>>(
          res
            .json()
            .sourceHealth.map((source: { sourceId: string }) => [source.sourceId, source]),
        );

        // Blocked-only source: counts recorded, most-recent reason wins, and it
        // is NOT counted as any kind of failure.
        expect(sources.get("greenhouse:acme")).toMatchObject({
          scrapeFailureCount: 0,
          operationalFailureCount: 0,
          failedRunCount: 0,
          consecutiveFailures: 0,
          politeness: {
            robotsDisallowedCount: 1,
            rateLimitedCount: 2,
            budgetExhaustedCount: 0,
            lastBlockedReason: "rate_limited",
            lastBlockedAt: "2026-05-15T00:02:00Z",
          },
        });

        // Mixed source: real failure and politeness outcome on independent axes.
        expect(sources.get("jobspy:linkedin")).toMatchObject({
          scrapeFailureCount: 1,
          lastFailureCategory: "timeout",
          politeness: {
            robotsDisallowedCount: 0,
            rateLimitedCount: 0,
            budgetExhaustedCount: 1,
            lastBlockedReason: "budget_exhausted",
            lastBlockedAt: "2026-05-15T00:04:00Z",
          },
        });

        // Failure-only source: honest empty politeness state (nothing implied).
        expect(sources.get("workday:beta")).toMatchObject({
          scrapeFailureCount: 1,
          politeness: {
            robotsDisallowedCount: 0,
            rateLimitedCount: 0,
            budgetExhaustedCount: 0,
            lastBlockedReason: null,
            lastBlockedAt: null,
          },
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });
});

describe("dashboard outcome-conversion projection", () => {
  function seedConversionDb(dbPath: string): void {
    initializeExactV7Database(dbPath);
    const db = new Database(dbPath);
    seedBuiltInResumeTemplate(db);
    db.close();
  }

  interface SeedJob {
    url: string;
    site: string;
    fitScore: number | null;
    fitBand?: "excellent" | "strong" | "plausible" | "stretch" | "poor";
    applied: boolean;
    applyRun?: { status: string; dryRun?: boolean };
    manualMarked?: boolean;
    outcomes?: string[];
    template?: { id: string; name: string };
    policyVersion?: number;
  }

  function seedJobs(dbPath: string, jobs: SeedJob[]): void {
    const db = new Database(dbPath);
    const insertJob = db.prepare(
      `INSERT INTO jobs (
         tenant_id, job_id, url, title, site, fit_score, apply_status, applied_at, discovered_at
       ) VALUES (
         'local', @job_id, @url, @title, @site, @fit_score, @apply_status, @applied_at, @discovered_at
       )`,
    );
    const insertScore = db.prepare(
      `INSERT INTO job_scores (
         tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at
       ) VALUES ('local', @job_id, 1, @fit_score, '{}', '[]', @scored_at)`,
    );
    const insertOutcome = db.prepare(
      `INSERT INTO application_outcomes (tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at)
       VALUES ('local', @outcome_id, @job_id, @kind, 'manual', @at, @at)`,
    );
    const insertFitReport = db.prepare(
      `INSERT INTO job_requirement_fit_reports (
         tenant_id, job_id, score_version, employer_analysis_generation, profile_snapshot_version,
         scoring_policy_version, formula_version, resolved_fit_score, fit_band, confidence, summary_json, created_at
       ) VALUES ('local', @job_id, 1, 1, 1, 1, 'test', @resolved_fit_score, @fit_band, 'medium', '{}', @at)`,
    );
    const insertApplyRun = db.prepare(
      `INSERT INTO apply_run_projections (
         run_id, tenant_id, job_id, job_title, job_employer, status, result, dry_run, started_at, finished_at, events_json
       ) VALUES (@run_id, 'local', @job_id, 'Engineer', 'Example', @status, @result, @dry_run, @started_at, @finished_at, '[]')`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
       ) VALUES ('local', @job_id, 1, 'apply', @event_type, 'info', @message, @at, '{}')`,
    );
    const insertMaterial = db.prepare(
      `INSERT INTO job_materials (
         tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
       ) VALUES ('local', @job_id, @generation, 'resume_approved', @created_at, @created_at, @metadata_json)`,
    );
    const insertMaterialArtifact = db.prepare(
      `INSERT INTO job_materials_artifacts (
         tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
         render_format, size_bytes, metadata_json, created_at
       ) VALUES (
         'local', @job_id, 1, 'tailored_resume', @artifact_id, 'approved', @path,
         'text', 12, @metadata_json, @created_at
       )`,
    );
    jobs.forEach((job, index) => {
      const jobId = projectionFixtureJobId(1000 + index);
      insertJob.run({
        job_id: jobId,
        url: job.url,
        title: "Engineer",
        site: job.site,
        fit_score: job.fitScore,
        apply_status: job.applied ? "applied" : null,
        applied_at: job.applied ? "2026-06-01T12:00:00+00:00" : null,
        discovered_at: "2026-05-20T12:00:00+00:00",
      });
      if (job.fitScore !== null) {
        insertScore.run({
          job_id: jobId,
          fit_score: job.fitScore,
          scored_at: "2026-05-25T12:00:00+00:00",
        });
      }
      if (job.fitBand) {
        insertFitReport.run({
          job_id: jobId,
          resolved_fit_score: job.fitScore,
          fit_band: job.fitBand,
          at: "2026-05-25T12:00:00+00:00",
        });
      }
      if (job.applyRun) {
        insertApplyRun.run({
          run_id: `${jobId}-run`,
          job_id: jobId,
          status: job.applyRun.status,
          result: job.applyRun.status === "succeeded" ? "applied" : job.applyRun.status,
          dry_run: job.applyRun.dryRun ? 1 : 0,
          started_at: "2026-06-01T11:55:00+00:00",
          finished_at: job.applyRun.status === "starting" ? null : "2026-06-01T12:00:00+00:00",
        });
      }
      const seedsManualApplication =
        job.manualMarked ||
        (job.applied && !job.applyRun && !job.outcomes?.includes("applied_confirmation"));
      if (seedsManualApplication) {
        insertEvent.run({
          job_id: jobId,
          event_type: "ApplicationManuallyMarked",
          message: "Job marked applied from test.",
          at: "2026-06-01T12:00:00+00:00",
        });
      }
      if (job.template || job.policyVersion !== undefined) {
        const metadata = JSON.stringify({
          tailoring_policy_version: job.policyVersion ?? null,
          resume_template: job.template
            ? {
                templateId: job.template.id,
                templateVersionId: `${job.template.id}:v1`,
                templateVersionNumber: 1,
                templateName: job.template.name,
                templateHash: `hash:${job.template.id}`,
                assignmentSource: "job_override",
              }
            : undefined,
        });
        insertMaterial.run({
          job_id: jobId,
          generation: 1,
          metadata_json: metadata,
          created_at: "2026-06-01T12:00:00+00:00",
        });
        insertMaterialArtifact.run({
          job_id: jobId,
          artifact_id: `${jobId}-resume`,
          path: `/tmp/${jobId}.txt`,
          metadata_json: metadata,
          created_at: "2026-06-01T12:00:00+00:00",
        });
      }
      for (const kind of job.outcomes ?? []) {
        insertOutcome.run({
          outcome_id: `${jobId}-${kind}`,
          job_id: jobId,
          kind,
          at: "2026-06-05T12:00:00+00:00",
        });
      }
    });
    db.close();
  }

  function seedAcceptedReplacementResume(dbPath: string, jobUrl: string): void {
    const db = new Database(dbPath);
    const row = db
      .prepare("SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?")
      .get(jobUrl) as { job_id: string } | undefined;
    if (!row) throw new Error(`Missing exact-v7 job fixture for ${jobUrl}`);
    db.prepare(
      `INSERT INTO job_materials (
         tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
       ) VALUES ('local', ?, 2, 'resume_approved', ?, ?, ?)`,
    ).run(
      row.job_id,
      "2026-06-02T12:00:00+00:00",
      "2026-06-02T12:00:00+00:00",
      JSON.stringify({
        source: "resume_review_draft",
        base_generation: 1,
      }),
    );
    db.prepare(
      `INSERT INTO job_materials_artifacts (
         tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
         render_format, size_bytes, metadata_json, created_at
       ) VALUES ('local', ?, 2, 'tailored_resume', ?, 'approved', ?, 'text', 14, ?, ?)`,
    ).run(
      row.job_id,
      `${row.job_id}-replacement-resume`,
      `/tmp/${row.job_id}-replacement.txt`,
      JSON.stringify({
        source: "resume_review_draft",
        base_generation: 1,
        base_resume_text_artifact_id: `${row.job_id}-resume`,
      }),
      "2026-06-02T12:00:00+00:00",
    );
    db.close();
  }

  function seedSuggestions(dbPath: string, statuses: string[]): void {
    const db = new Database(dbPath);
    const jobs = db
      .prepare("SELECT job_id FROM jobs WHERE tenant_id = 'local' ORDER BY job_id")
      .all() as Array<{ job_id: string }>;
    if (jobs.length === 0) throw new Error("Outcome suggestion fixtures require an exact-v7 job");
    const insertSuggestion = db.prepare(
      `INSERT INTO application_outcome_suggestions (
         tenant_id, suggestion_id, job_id, suggested_kind, confidence, rationale,
         status, created_at, decided_at, decision
       ) VALUES ('local', @suggestion_id, @job_id, 'recruiter_reply', 0.9, '',
         @status, @created_at, @decided_at, @decision)`,
    );
    statuses.forEach((status, index) => {
      insertSuggestion.run({
        suggestion_id: `suggestion-${index}`,
        job_id: jobs[index % jobs.length]!.job_id,
        status,
        created_at: "2026-06-02T12:00:00+00:00",
        decided_at: "2026-06-02T12:05:00+00:00",
        decision: status,
      });
    });
    db.close();
  }

  it("materialises the funnel conversion by source and score band", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedConversionDb(dbPath);
      // Each asserted bucket clears MIN_CONVERSION_SAMPLE (5) so the read model
      // actually computes rates instead of suppressing them.
      seedJobs(dbPath, [
        { url: "https://example.com/li-1", site: "linkedin", fitScore: 8, applied: true, outcomes: ["interview"] },
        { url: "https://example.com/li-2", site: "linkedin", fitScore: 8, applied: true, outcomes: ["interview"] },
        { url: "https://example.com/li-3", site: "linkedin", fitScore: 8, applied: true, outcomes: ["recruiter_reply"] },
        { url: "https://example.com/li-4", site: "linkedin", fitScore: 8, applied: true },
        { url: "https://example.com/li-5", site: "linkedin", fitScore: 8, applied: true },
        { url: "https://example.com/gh-1", site: "greenhouse", fitScore: 6, applied: true, outcomes: ["offer"] },
        { url: "https://example.com/gh-2", site: "greenhouse", fitScore: 6, applied: true, outcomes: ["interview"] },
        { url: "https://example.com/gh-3", site: "greenhouse", fitScore: 6, applied: true, outcomes: ["rejection"] },
        { url: "https://example.com/gh-4", site: "greenhouse", fitScore: 6, applied: true },
        { url: "https://example.com/gh-5", site: "greenhouse", fitScore: 6, applied: true },
      ]);
      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
        expect(res.statusCode, res.body).toBe(200);
        const conversion = res.json().conversion;

        expect(conversion.totals).toEqual({
          applied: 10, reply: 6, interview: 4, offer: 1, rejection: 1,
          replyRate: 0.6, interviewRate: 0.4, offerRate: 0.1, rejectionRate: 0.1,
          costPerInterview: null,
        });
        const bySource = Object.fromEntries(
          conversion.bySource.map((g: { source: string }) => [g.source, g]),
        );
        expect(bySource.linkedin).toMatchObject({
          applied: 5, reply: 3, interview: 2, offer: 0, rejection: 0,
          replyRate: 0.6, interviewRate: 0.4,
        });
        expect(bySource.greenhouse).toMatchObject({
          applied: 5, reply: 3, interview: 2, offer: 1, rejection: 1,
          replyRate: 0.6, interviewRate: 0.4, offerRate: 0.2, rejectionRate: 0.2,
        });
        const byBand = Object.fromEntries(
          conversion.byBand.map((g: { band: string }) => [g.band, g]),
        );
        expect(byBand.strong).toMatchObject({ applied: 5, reply: 3, interview: 2, replyRate: 0.6 });
        expect(byBand.moderate).toMatchObject({ applied: 5, offer: 1, offerRate: 0.2 });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("suppresses rates below the minimum sample size while keeping raw counts", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedConversionDb(dbPath);
      // Three sources / bands at applied sample sizes 1, 4 (MIN - 1) and 5 (MIN).
      seedJobs(dbPath, [
        // n = 1: the exact defect scenario — one application, one reply.
        { url: "https://example.com/solo", site: "linkedin", fitScore: 8, applied: true, outcomes: ["recruiter_reply"] },
        // n = 4: MIN_CONVERSION_SAMPLE - 1, still suppressed.
        { url: "https://example.com/four-1", site: "greenhouse", fitScore: 6, applied: true, outcomes: ["recruiter_reply"] },
        { url: "https://example.com/four-2", site: "greenhouse", fitScore: 6, applied: true, outcomes: ["recruiter_reply"] },
        { url: "https://example.com/four-3", site: "greenhouse", fitScore: 6, applied: true },
        { url: "https://example.com/four-4", site: "greenhouse", fitScore: 6, applied: true },
        // n = 5: MIN_CONVERSION_SAMPLE, rates become visible.
        { url: "https://example.com/five-1", site: "lever", fitScore: 4, applied: true, outcomes: ["recruiter_reply"] },
        { url: "https://example.com/five-2", site: "lever", fitScore: 4, applied: true, outcomes: ["recruiter_reply"] },
        { url: "https://example.com/five-3", site: "lever", fitScore: 4, applied: true, outcomes: ["recruiter_reply"] },
        { url: "https://example.com/five-4", site: "lever", fitScore: 4, applied: true },
        { url: "https://example.com/five-5", site: "lever", fitScore: 4, applied: true },
      ]);
      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
        expect(res.statusCode, res.body).toBe(200);
        const conversion = res.json().conversion;

        const bySource = Object.fromEntries(
          conversion.bySource.map((g: { source: string }) => [g.source, g]),
        );
        // INVARIANT: n = 1 keeps its raw counts but reports NO rate (never 100%).
        expect(bySource.linkedin).toEqual({
          source: "linkedin",
          applied: 1,
          reply: 1,
          interview: 0,
          offer: 0,
          rejection: 0,
          replyRate: null,
          interviewRate: null,
          offerRate: null,
          rejectionRate: null,
          costPerInterview: null,
        });
        // Boundary: MIN - 1 stays suppressed, counts still visible.
        expect(bySource.greenhouse).toMatchObject({ applied: 4, reply: 2, replyRate: null });
        // Boundary: exactly MIN applications -> rate is computed.
        expect(bySource.lever).toMatchObject({ applied: 5, reply: 3, replyRate: 0.6 });

        const byBand = Object.fromEntries(
          conversion.byBand.map((g: { band: string }) => [g.band, g]),
        );
        expect(byBand.strong).toMatchObject({ applied: 1, reply: 1, replyRate: null });
        expect(byBand.weak).toMatchObject({ applied: 5, reply: 3, replyRate: 0.6 });

        // Totals clear the threshold (10 applied) so their rates are still shown.
        expect(conversion.totals).toMatchObject({ applied: 10, reply: 6, replyRate: 0.6 });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("returns outcome analytics by score band, fit band, and apply mode with gated rates", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedConversionDb(dbPath);
      const modernTemplate = { id: "template-modern", name: "Modern compact" };
      const plainTemplate = { id: "template-plain", name: "Plain ATS" };
      seedJobs(dbPath, [
        { url: "https://example.com/manual-1", site: "linkedin", fitScore: 8, fitBand: "strong", applied: true, manualMarked: true, outcomes: ["recruiter_reply"], template: plainTemplate, policyVersion: 4 },
        { url: "https://example.com/manual-2", site: "linkedin", fitScore: 8, fitBand: "strong", applied: true, manualMarked: true, outcomes: ["recruiter_reply"], template: plainTemplate, policyVersion: 4 },
        { url: "https://example.com/manual-3", site: "linkedin", fitScore: 8, fitBand: "strong", applied: true, manualMarked: true, outcomes: ["interview"], template: plainTemplate, policyVersion: 4 },
        { url: "https://example.com/manual-4", site: "linkedin", fitScore: 8, fitBand: "strong", applied: true, manualMarked: true, template: plainTemplate, policyVersion: 4 },
        { url: "https://example.com/manual-5", site: "linkedin", fitScore: 8, fitBand: "strong", applied: true, manualMarked: true, template: plainTemplate, policyVersion: 4 },
        { url: "https://example.com/live-1", site: "greenhouse", fitScore: 9, fitBand: "excellent", applied: false, applyRun: { status: "succeeded" }, outcomes: ["interview"], template: modernTemplate, policyVersion: 3 },
        { url: "https://example.com/live-2", site: "greenhouse", fitScore: 9, fitBand: "excellent", applied: false, applyRun: { status: "succeeded" }, outcomes: ["interview"], template: modernTemplate, policyVersion: 3 },
        { url: "https://example.com/live-3", site: "greenhouse", fitScore: 9, fitBand: "excellent", applied: false, applyRun: { status: "succeeded" }, template: modernTemplate, policyVersion: 3 },
        { url: "https://example.com/live-4", site: "greenhouse", fitScore: 9, fitBand: "excellent", applied: false, applyRun: { status: "succeeded" }, template: modernTemplate, policyVersion: 3 },
        { url: "https://example.com/live-5", site: "greenhouse", fitScore: 9, fitBand: "excellent", applied: false, applyRun: { status: "succeeded" }, template: modernTemplate, policyVersion: 3 },
        { url: "https://example.com/external", site: "lever", fitScore: 4, fitBand: "stretch", applied: true, outcomes: ["applied_confirmation", "recruiter_reply"] },
        { url: "https://example.com/dry-run", site: "lever", fitScore: 2, fitBand: "poor", applied: false, applyRun: { status: "dry_run_complete", dryRun: true }, outcomes: ["recruiter_reply"] },
      ]);
      seedSuggestions(dbPath, ["accepted", "accepted", "accepted", "corrected", "ignored"]);
      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/analytics/outcomes" });
        expect(res.statusCode, res.body).toBe(200);
        const analytics = res.json();

        expect(analytics.minSample).toBe(5);
        expect(analytics.totals).toMatchObject({ n: 11, applied: 11, reply: 6 });
        const byScoreBand = Object.fromEntries(
          analytics.byScoreBand.map((g: { scoreBand: string }) => [g.scoreBand, g]),
        );
        expect(byScoreBand.perfect).toMatchObject({ n: 5, applied: 5, reply: 2, replyRate: 0.4 });
        expect(byScoreBand.strong).toMatchObject({ n: 5, applied: 5, reply: 3, replyRate: 0.6 });
        expect(byScoreBand.weak).toMatchObject({ n: 1, applied: 1, reply: 1, replyRate: null });

        const byFitBand = Object.fromEntries(
          analytics.byFitBand.map((g: { fitBand: string }) => [g.fitBand, g]),
        );
        expect(byFitBand.excellent).toMatchObject({ n: 5, applied: 5, reply: 2, replyRate: 0.4 });
        expect(byFitBand.strong).toMatchObject({ n: 5, applied: 5, reply: 3, replyRate: 0.6 });
        expect(byFitBand.stretch).toMatchObject({ n: 1, applied: 1, reply: 1, replyRate: null });
        expect(byFitBand.poor).toBeUndefined();

        const byApplyMode = Object.fromEntries(
          analytics.byApplyMode.map((g: { applyMode: string }) => [g.applyMode, g]),
        );
        expect(byApplyMode.automated_live).toMatchObject({ n: 5, applied: 5, reply: 2, replyRate: 0.4 });
        expect(byApplyMode.manual_marked).toMatchObject({ n: 5, applied: 5, reply: 3, replyRate: 0.6 });
        expect(byApplyMode.external_confirmed).toMatchObject({ n: 1, applied: 1, reply: 1, replyRate: null });

        const byTemplate = Object.fromEntries(
          analytics.byTemplate.map((g: { templateId: string }) => [g.templateId, g]),
        );
        expect(byTemplate["template-modern"]).toMatchObject({
          templateName: "Modern compact",
          n: 5,
          applied: 5,
          reply: 2,
          replyRate: 0.4,
        });
        expect(byTemplate["template-plain"]).toMatchObject({
          templateName: "Plain ATS",
          n: 5,
          applied: 5,
          reply: 3,
          replyRate: 0.6,
        });
        expect(byTemplate.unreported).toMatchObject({ n: 1, applied: 1, reply: 1, replyRate: null });

        const byPolicy = Object.fromEntries(
          analytics.byPolicy.map((g: { policyLabel: string }) => [g.policyLabel, g]),
        );
        expect(byPolicy["Policy v3"]).toMatchObject({ tailoringPolicyVersion: 3, n: 5, replyRate: 0.4 });
        expect(byPolicy["Policy v4"]).toMatchObject({ tailoringPolicyVersion: 4, n: 5, replyRate: 0.6 });
        expect(byPolicy.Unreported).toMatchObject({ tailoringPolicyVersion: null, n: 1, replyRate: null });
        expect(analytics.timeToResponse).toEqual({ n: 6, medianMinutes: 5760 });
        expect(analytics.suggestionAccuracy).toEqual({
          n: 5,
          decided: 5,
          accepted: 3,
          corrected: 1,
          ignored: 1,
          acceptanceRate: 0.6,
        });
        expect(res.body).not.toContain("note");
        expect(res.body).not.toContain("body_text");
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("keeps accepted replacement resumes in their base template and policy buckets", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedConversionDb(dbPath);
      const modernTemplate = { id: "template-modern", name: "Modern compact" };
      seedJobs(dbPath, [
        { url: "https://example.com/replacement-1", site: "greenhouse", fitScore: 9, fitBand: "excellent", applied: true, outcomes: ["interview"], template: modernTemplate, policyVersion: 3 },
        { url: "https://example.com/replacement-2", site: "greenhouse", fitScore: 9, fitBand: "excellent", applied: true, outcomes: ["interview"], template: modernTemplate, policyVersion: 3 },
        { url: "https://example.com/replacement-3", site: "greenhouse", fitScore: 9, fitBand: "excellent", applied: true, outcomes: ["interview"], template: modernTemplate, policyVersion: 3 },
        { url: "https://example.com/replacement-4", site: "greenhouse", fitScore: 9, fitBand: "excellent", applied: true, outcomes: ["interview"], template: modernTemplate, policyVersion: 3 },
        { url: "https://example.com/replacement-5", site: "greenhouse", fitScore: 9, fitBand: "excellent", applied: true, outcomes: ["interview"], template: modernTemplate, policyVersion: 3 },
      ]);
      for (let index = 1; index <= 5; index += 1) {
        seedAcceptedReplacementResume(dbPath, `https://example.com/replacement-${index}`);
      }
      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/analytics/outcomes" });
        expect(res.statusCode, res.body).toBe(200);
        const analytics = res.json();
        expect(analytics.byTemplate).toEqual([
          expect.objectContaining({
            templateId: "template-modern",
            templateName: "Modern compact",
            n: 5,
            reply: 5,
            replyRate: 1,
          }),
        ]);
        expect(analytics.byPolicy).toEqual([
          expect.objectContaining({
            tailoringPolicyVersion: 3,
            policyLabel: "Policy v3",
            n: 5,
            reply: 5,
            replyRate: 1,
          }),
        ]);
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("breaks equal template-count and name ties by template id", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedConversionDb(dbPath);
      const fixturePath = path.join(
        fileURLToPath(new URL("../../..", import.meta.url)),
        "packages/domain-types/test/fixtures/dashboard_template_order.json",
      );
      const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
        entries: Array<{
          templateId: string;
          templateName: string;
          applied: number;
        }>;
        expectedTemplateIds: string[];
      };
      seedJobs(
        dbPath,
        fixture.entries.flatMap((entry, entryIndex) =>
          Array.from({ length: entry.applied }, (_, applicationIndex) => ({
            url: `https://example.com/template-order-${entryIndex}-${applicationIndex}`,
            site: "greenhouse",
            fitScore: 9,
            applied: true,
            template: { id: entry.templateId, name: entry.templateName },
          })),
        ),
      );
      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/analytics/outcomes" });
        expect(res.statusCode, res.body).toBe(200);
        expect(
          res.json().byTemplate.map(
            (entry: { templateId: string }) => entry.templateId,
          ),
        ).toEqual(fixture.expectedTemplateIds);
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("returns an empty conversion with null rates when nothing is applied", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedConversionDb(dbPath);
      seedJobs(dbPath, [
        { url: "https://example.com/discovered", site: "linkedin", fitScore: 7, applied: false },
      ]);
      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        const res = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
        expect(res.statusCode, res.body).toBe(200);
        const conversion = res.json().conversion;
        expect(conversion.totals).toEqual({
          applied: 0, reply: 0, interview: 0, offer: 0, rejection: 0,
          replyRate: null, interviewRate: null, offerRate: null, rejectionRate: null,
          costPerInterview: null,
        });
        expect(conversion.bySource).toEqual([]);
        expect(conversion.byBand).toEqual([]);
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });
});

describe("direct projection publication", () => {
  it.each([
    { family: "contacts", refresh: refreshContactProjections, canonical: "contacts",
      tables: ["contact_projections"], failureTable: "contact_projections", idColumn: "contact_id" },
    { family: "research", refresh: refreshContactResearchProjections, canonical: "contact_research_tasks",
      tables: ["contact_research_task_projections"], failureTable: "contact_research_task_projections", idColumn: "task_id" },
    { family: "outreach and follow-ups", refresh: refreshOutreachProjections, canonical: "outreach_threads",
      tables: ["outreach_thread_projections", "due_follow_up_projections"], failureTable: "due_follow_up_projections", idColumn: "thread_id" },
  ])("rolls back partial $family publication and preserves caller rollback", ({ refresh, canonical, tables, failureTable, idColumn }) => {
    const { dbPath, cleanup } = withTempDb();
    try {
      initializeExactV7Database(dbPath);
      const db = new Database(dbPath);
      const observer = new Database(dbPath);
      try {
        const originalAt = "2026-09-01T00:00:00Z";
        const changedAt = "2026-09-01T01:00:00Z";
        for (const id of ["a", "b"]) {
          db.prepare(`INSERT INTO contacts (tenant_id, contact_id, created_at, updated_at)
            VALUES ('local', ?, ?, ?)`).run(id, originalAt, originalAt);
          db.prepare(`INSERT INTO contact_research_tasks (tenant_id, task_id, updated_at)
            VALUES ('local', ?, ?)`).run(id, originalAt);
          db.prepare(`INSERT INTO outreach_threads (tenant_id, thread_id, contact_id,
            created_at, updated_at, follow_up_due_at, follow_up_basis, follow_up_state)
            VALUES ('local', ?, ?, ?, ?, ?, 'manual', 'scheduled')`).run(id, id, originalAt, originalAt, changedAt);
        }
        const snapshot = (connection = db): unknown[] => tables.map(
          (table) => connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        );
        refresh(db);
        const before = snapshot();
        for (const table of tables) {
          expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 2 });
        }
        db.prepare(`UPDATE ${canonical} SET updated_at = ?`).run(changedAt);
        // Row a has already been written when row b fails. For outreach the
        // entire thread table has been written before the follow-up failure.
        db.exec(`CREATE TEMP TRIGGER fail_direct_projection BEFORE INSERT ON ${failureTable}
          WHEN NEW.${idColumn} = 'b'
          BEGIN SELECT RAISE(ABORT, 'direct projection fixture failure'); END`);
        expect(() => refresh(db)).toThrow("direct projection fixture failure");
        expect(db.inTransaction).toBe(false);
        expect(snapshot(observer)).toEqual(before);
        db.exec("DROP TRIGGER fail_direct_projection");

        db.exec("BEGIN IMMEDIATE");
        db.prepare(`UPDATE ${canonical} SET updated_at = '2026-09-01T02:00:00Z'`).run();
        refresh(db);
        expect(db.inTransaction).toBe(true);
        expect(snapshot()).not.toEqual(before);
        expect(snapshot(observer)).toEqual(before);
        db.exec("ROLLBACK");
        expect(snapshot()).toEqual(before);
        expect(db.prepare(`SELECT DISTINCT updated_at FROM ${canonical}`).all()).toEqual([{ updated_at: changedAt }]);

        refresh(db);
        expect(db.inTransaction).toBe(false);
        expect(snapshot(observer)).toEqual(snapshot());
        for (const table of tables) {
          expect(observer.prepare(`SELECT DISTINCT updated_at FROM ${table}`).all()).toEqual([{ updated_at: changedAt }]);
        }
      } finally {
        observer.close();
        db.close();
      }
    } finally {
      cleanup();
    }
  });
});

describe("consumer watermark discipline", () => {
  const watermarkName = `typescript:${PROJECTION_WATERMARK_NAME}:local`;
  function readWatermarkRow(
    db: InstanceType<typeof Database>,
  ): { last_event_id: number; updated_at: string } | undefined {
    return db
      .prepare("SELECT last_event_id, updated_at FROM event_watermarks WHERE projection_name = ?")
      .get(watermarkName) as { last_event_id: number; updated_at: string } | undefined;
  }

  it("replays local changes without consuming legacy opaque-tenant cursors", () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      try {
        refreshProjections(db);
        db.prepare("UPDATE jobs SET title = 'Changed' WHERE job_id = ?").run(EVENT_JOB_ID);
        const eventId = Number(db.prepare(
          `INSERT INTO job_events (tenant_id, job_id, identity_version, event_type, occurred_at, payload_json)
           VALUES ('local', ?, 1, 'JobUpdated', '2026-09-01T00:00:00Z', '{}')`,
        ).run(EVENT_JOB_ID).lastInsertRowid);
        const legacyRows = ["python:local", "typescript:local"].map((tenantId, index) => ({
          projection_name: `${PROJECTION_WATERMARK_NAME}:${tenantId}`,
          last_event_id: 10_000 + index,
          updated_at: "2026-08-31T00:00:00Z",
        }));
        for (const row of legacyRows) {
          db.prepare(`INSERT OR REPLACE INTO event_watermarks (projection_name, last_event_id, updated_at)
            VALUES (?, ?, ?)`).run(row.projection_name, row.last_event_id, row.updated_at);
        }
        refreshProjections(db);
        expect(db.prepare("SELECT title FROM job_list_projections WHERE job_id = ?").get(EVENT_JOB_ID)).toEqual({ title: "Changed" });
        expect(db.prepare("SELECT last_event_id FROM event_watermarks WHERE projection_name = ?").get(
          `typescript:${PROJECTION_WATERMARK_NAME}:local`,
        )).toEqual({ last_event_id: eventId });
        for (const row of legacyRows) {
          expect(db.prepare("SELECT * FROM event_watermarks WHERE projection_name = ?").get(row.projection_name)).toEqual(row);
        }
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  it.each([
    ["evidence_usage_projections", false],
    ["evidence_usage_projections", true],
    ["event_watermarks", false],
    ["event_watermarks", true],
  ] as const)("rolls back a failed %s replacement (caller transaction: %s)", (failureTable, nested) => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      try {
        db.exec(`
          INSERT INTO candidate_profile_skill_categories
            (tenant_id, profile_id, category_id, position_index, label)
          VALUES ('local', 'default', 'fixture', 0, 'Fixture');
          INSERT INTO candidate_profile_skill_items
            (tenant_id, profile_id, category_id, item_index, item_text)
          VALUES ('local', 'default', 'fixture', 0, 'Python');
        `);
        const event = db.prepare(
          `INSERT INTO job_events (tenant_id, job_id, identity_version, event_type, occurred_at, payload_json)
           VALUES ('local', ?, 1, 'JobDiscovered', '2026-09-01T00:00:00Z', '{}')`,
        );
        event.run(EVENT_JOB_ID);
        refreshProjections(db);
        const snapshot = (connection = db): unknown[] =>
          ["job_list_projections", "job_detail_projections", "dashboard_projections",
            "evidence_usage_projections", "event_watermarks"].map(
            (table) => connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          );
        const before = snapshot();
        expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_usage_projections").get()).toEqual({ count: 1 });
        db.exec(`CREATE TEMP TRIGGER fail_projection BEFORE INSERT ON ${failureTable}
          BEGIN SELECT RAISE(ABORT, 'projection fixture failure'); END`);
        const update = (): void => {
          db.prepare("UPDATE jobs SET title = 'Changed' WHERE job_id = ?").run(EVENT_JOB_ID);
          event.run(EVENT_JOB_ID);
          expect(() => refreshProjections(db)).toThrow("projection fixture failure");
          expect(db.inTransaction).toBe(nested);
          expect(snapshot()).toEqual(before);
        };
        if (nested) db.transaction(update).immediate();
        else update();
        const observer = new Database(dbPath);
        try {
          expect(observer.prepare("SELECT title FROM jobs WHERE job_id = ?").get(EVENT_JOB_ID)).toEqual({ title: "Changed" });
          expect(snapshot(observer)).toEqual(before);
        } finally {
          observer.close();
        }
        db.exec("DROP TRIGGER fail_projection");
        refreshProjections(db);
        expect(db.inTransaction).toBe(false);
        expect(db.prepare("SELECT title FROM job_list_projections WHERE job_id = ?").get(EVENT_JOB_ID)).toEqual({ title: "Changed" });
        expect(readWatermarkRow(db)?.last_event_id).toBe(2);
        const settled = snapshot();
        refreshProjections(db);
        expect(snapshot()).toEqual(settled);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  it.each([false, true])("leaves a successful nested refresh under caller commit/rollback control (%s)", (commit) => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      const observer = new Database(dbPath);
      try {
        refreshProjections(db);
        const before = observer.prepare("SELECT title FROM job_list_projections WHERE job_id = ?").get(EVENT_JOB_ID);
        db.exec("BEGIN IMMEDIATE");
        db.prepare("UPDATE jobs SET title = 'Changed' WHERE job_id = ?").run(EVENT_JOB_ID);
        db.prepare(
          `INSERT INTO job_events (tenant_id, job_id, identity_version, event_type, occurred_at, payload_json)
           VALUES ('local', ?, 1, 'JobDiscovered', '2026-09-01T00:00:00Z', '{}')`,
        ).run(EVENT_JOB_ID);
        refreshProjections(db);
        expect(db.inTransaction).toBe(true);
        expect(observer.prepare("SELECT title FROM job_list_projections WHERE job_id = ?").get(EVENT_JOB_ID)).toEqual(before);
        db.exec(commit ? "COMMIT" : "ROLLBACK");
        expect(observer.prepare("SELECT title FROM job_list_projections WHERE job_id = ?").get(EVENT_JOB_ID)).toEqual(commit ? { title: "Changed" } : before);
        expect(readWatermarkRow(db)?.last_event_id ?? 0).toBe(commit ? 1 : 0);
      } finally {
        observer.close();
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  it("bounds events within each tenant and leaves other consumer cursors untouched", () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      try {
        const event = db.prepare(
          `INSERT INTO job_events (tenant_id, job_id, identity_version, event_type, occurred_at, payload_json)
           VALUES (?, NULL, 1, 'CandidateProfileUpdated', '2026-09-01T00:00:00Z', '{}')`,
        );
        db.transaction(() => {
          for (let i = 0; i < REFRESH_EVENT_BATCH_LIMIT; i += 1) event.run("foreign");
        })();
        const foreignLast = REFRESH_EVENT_BATCH_LIMIT;
        const localLast = Number(event.run("local").lastInsertRowid);
        setWatermark(db, PROJECTION_WATERMARK_NAME, localLast);
        setWatermark(db, `python:${PROJECTION_WATERMARK_NAME}:local`, localLast);
        refreshProjections(db, "local");
        expect(readWatermarkRow(db)?.last_event_id).toBe(localLast);
        expect(db.prepare("SELECT last_event_id FROM event_watermarks WHERE projection_name = ?").get(
          `typescript:${PROJECTION_WATERMARK_NAME}:foreign`,
        )).toBeUndefined();
        // Stop below the cap for the foreign pass so no asynchronous work
        // outlives this fixture. The local pass had to skip the full foreign cap.
        setWatermark(db, `typescript:${PROJECTION_WATERMARK_NAME}:foreign`, 1);
        refreshProjections(db, "foreign");
        expect(db.prepare("SELECT projection_name, last_event_id FROM event_watermarks ORDER BY projection_name").all()).toEqual([
          { projection_name: PROJECTION_WATERMARK_NAME, last_event_id: localLast },
          { projection_name: `python:${PROJECTION_WATERMARK_NAME}:local`, last_event_id: localLast },
          { projection_name: `typescript:${PROJECTION_WATERMARK_NAME}:foreign`, last_event_id: foreignLast },
          { projection_name: watermarkName, last_event_id: localLast },
        ]);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  it("advances a ready native recovery proof with the pipeline-step fold", () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      const workflowId = "discover-native-proof";
      const runId = "00000000-0000-4000-8000-000000000090";
      db.prepare(
        `INSERT INTO discovery_execution_jobs (
           tenant_id, discover_workflow_id, discover_run_id, job_id,
           cohort_kind, work_plan_state, linked_at
         ) VALUES ('local', ?, ?, ?, 'observed_this_run', 'pending', ?)`,
      ).run(workflowId, runId, EVENT_JOB_ID, "2026-08-13T12:00:00.000Z");
      db.prepare(
        `INSERT INTO discovery_execution_recoveries (
           tenant_id, discover_workflow_id, discover_run_id, state, mode,
           decoder_version, history_event_id, expected_membership_count,
           persisted_membership_count, expected_step_count, persisted_step_count,
           key_digest, last_error_code, updated_at
         ) VALUES ('local', ?, ?, 'ready', 'native', 3, 12, 1, 1, 0, 0, ?, NULL, ?)`,
      ).run(
        workflowId,
        runId,
        recoveryKeyDigest([EVENT_JOB_ID], []),
        "2026-08-13T12:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO job_events (
           tenant_id, job_id, identity_version, stage, event_type, level,
           message, occurred_at, payload_json
         ) VALUES ('local', NULL, 1, 'discover', 'PipelineStepQueued', 'info',
                   'source family queued', ?, ?)`,
      ).run(
        "2026-08-13T12:00:01.000Z",
        JSON.stringify({
          execution: {
            tenantId: "local",
            workflowId,
            temporalRunId: runId,
          },
          stepKind: "source_family",
          itemKey: "family:jobspy",
          attempt: 1,
          queuedAt: "2026-08-13T12:00:01.000Z",
          detail: { code: "source_family", itemCount: 1 },
        }),
      );

      refreshProjections(db);

      const manifest = db.prepare(
        `SELECT state, history_event_id, expected_membership_count,
                persisted_membership_count, expected_step_count,
                persisted_step_count, key_digest
           FROM discovery_execution_recoveries
          WHERE tenant_id = 'local' AND discover_workflow_id = ? AND discover_run_id = ?`,
      ).get(workflowId, runId) as {
        state: string;
        history_event_id: number;
        expected_membership_count: number;
        persisted_membership_count: number;
        expected_step_count: number;
        persisted_step_count: number;
        key_digest: string;
      };
      expect(manifest).toEqual({
        state: "ready",
        history_event_id: 12,
        expected_membership_count: 1,
        persisted_membership_count: 1,
        expected_step_count: 1,
        persisted_step_count: 1,
        key_digest: recoveryKeyDigest(
          [EVENT_JOB_ID],
          [["source_family", "family:jobspy"]],
        ),
      });
      db.close();
    } finally {
      cleanup();
    }
  });

  it("never rewinds the watermark and keeps updated_at on a stale write", () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      setWatermark(db, watermarkName, 10);
      const afterAdvance = readWatermarkRow(db)!;
      expect(afterAdvance.last_event_id).toBe(10);

      setWatermark(db, watermarkName, 5);
      const afterStaleWrite = readWatermarkRow(db)!;
      expect(afterStaleWrite.last_event_id).toBe(10);
      expect(afterStaleWrite.updated_at).toBe(afterAdvance.updated_at);

      setWatermark(db, watermarkName, 15);
      expect(readWatermarkRow(db)!.last_event_id).toBe(15);
      db.close();
    } finally {
      cleanup();
    }
  });

  it("caps the synchronous fold and drains the remainder in the background", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      seedSchema(dbPath);
      const db = new Database(dbPath);
      refreshProjections(db);
      const start = readWatermarkRow(db)?.last_event_id ?? 0;
      const readTitle = (): string =>
        (db.prepare("SELECT title FROM job_list_projections WHERE job_id = ?").get(EVENT_JOB_ID) as { title: string })
          .title;
      const staleTitle = readTitle();

      const filler = db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) VALUES ('local', NULL, 1, 'discover', 'JobDiscovered', 'info', 'filler', ?, '{}')",
      );
      const bulk = db.transaction(() => {
        for (let i = 0; i < REFRESH_EVENT_BATCH_LIMIT; i += 1) {
          filler.run(`2026-08-09T00:00:${String(i % 60).padStart(2, "0")}Z`);
        }
      });
      bulk();
      db.prepare("UPDATE jobs SET title = ? WHERE job_id = ?").run("Event-Driven Engineer (Renamed)", EVENT_JOB_ID);
      db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) VALUES ('local', ?, 1, 'discover', 'JobUpdated', 'info', 'rename', '2026-08-09T00:01:00Z', '{}')",
      ).run(EVENT_JOB_ID);
      const maxEventId = Number(
        (db.prepare("SELECT MAX(event_id) AS m FROM job_events").get() as { m: number }).m,
      );
      const expectedFirstStop = Number(
        (
          db
            .prepare(
              "SELECT event_id FROM job_events WHERE event_id > ? ORDER BY event_id ASC LIMIT 1 OFFSET ?",
            )
            .get(start, REFRESH_EVENT_BATCH_LIMIT - 1) as { event_id: number }
        ).event_id,
      );

      refreshProjections(db);
      // Synchronous view right after the single call: stopped exactly at the
      // batch cap, with the rename event beyond it still unfolded.
      expect(readWatermarkRow(db)!.last_event_id).toBe(expectedFirstStop);
      expect(readWatermarkRow(db)!.last_event_id).toBeLessThan(maxEventId);
      expect(readTitle()).toBe(staleTitle);

      // The background drain finishes the backlog without another read.
      await vi.waitFor(
        () => {
          expect(readWatermarkRow(db)!.last_event_id).toBe(maxEventId);
          expect(readTitle()).toBe("Event-Driven Engineer (Renamed)");
        },
        { timeout: 5000, interval: 25 },
      );
      db.close();
    } finally {
      cleanup();
    }
  });
});
