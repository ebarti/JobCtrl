/**
 * Cross-runtime projection parity for the read-model projections (AUDIT-02).
 *
 * The TS half of the genuine TS<->Python drift guard. The Python half lives at
 * ``workers/automation/tests/test_audit_projection_parity.py``. Both load the
 * SAME shared fixture (``packages/domain-types/test/fixtures/
 * audit_projection_parity.json``), seed the SAME canonical rows, run their OWN
 * projection builder, and assert the resulting projection columns equal the
 * fixture.
 *
 * Two layers of assertion:
 *  - the Phase 4 audit read shapes (employer analysis + provenance/coverage/voice)
 *    match the fixture's ``expected`` block, both as raw projection columns AND as
 *    the camelCase DTOs the read model serves, and
 *  - the FULL dual-written column set for job_list_projections /
 *    job_detail_projections / dashboard_projections matches the fixture's
 *    ``expectedProjections`` block key-for-key, PLUS a column-set guard: the set
 *    of columns the TS builder emits must equal the fixture's expected keys plus
 *    the wall-clock ``nonDeterministicColumns``. That guard fails if EITHER
 *    runtime's writer/schema grows a column the other lacks — the drift class
 *    that let the Python-omits-score-audit-columns bug ship (the earlier parity
 *    test asserted only 4 audit JSON columns and had no column-set guard).
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { buildApp } from "../src/server.js";
import { initializeExactV7Database } from "./v7-schema.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../packages/domain-types/test/fixtures/audit_projection_parity.json", import.meta.url),
);

type ProjectionTable = "jobList" | "jobDetail" | "dashboard";

interface Fixture {
  job: {
    url: string;
    title: string;
    company: string;
    site: string;
    strategy: string;
    location: string;
    salary: string;
    description: string;
    fullDescription: string;
    applicationUrl: string;
    applyStatus: string;
    appliedAt: string;
    scoreReasoning: string;
    discoveredAt: string;
    generation: number;
    createdAt: string;
  };
  rows: {
    jobScores: Array<Record<string, unknown>>;
    jobStageStates: Array<Record<string, unknown>>;
    jobEmployerAnalysis: Array<Record<string, unknown>>;
    jobEmployerAnalysisSubAnalyses: Array<Record<string, unknown>>;
    jobEmployerAnalysisFailures: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
    bulletProvenance: Array<Record<string, unknown>>;
    jobInterviewPrep: Array<Record<string, unknown>>;
    jobInterviewPrepItems: Array<Record<string, unknown>>;
    conversionJobs: Array<Record<string, unknown>>;
    applicationOutcomes: Array<Record<string, unknown>>;
    applicationOutcomeSuggestions: Array<Record<string, unknown>>;
  };
  dashboardAggregateJobs: Array<{
    hidden: boolean;
    url: string;
    title: string;
    company: string;
    site: string;
    strategy: string;
    location: string;
    applyStatus: string | null;
    appliedAt: string | null;
    tailoredResumePath: string | null;
    discoveredAt: string;
    fitScore: number | null;
    stages: Array<{ stage: string; state: string }>;
  }>;
  projectionParity: {
    jsonColumns: Record<ProjectionTable, string[]>;
    nonDeterministicColumns: Record<ProjectionTable, string[]>;
  };
  expectedProjections: Record<ProjectionTable, Record<string, unknown>>;
  expected: {
    employerAnalysisJson: unknown;
    interviewPrepJson: unknown;
    bulletProvenanceJson: unknown;
    coverageAuditJson: unknown;
    voicePassJson: unknown;
  };
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const FIXTURE_JOB_IDS = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
  "30000000-0000-4000-8000-000000000004",
  "30000000-0000-4000-8000-000000000005",
] as const;
const fixtureJobIdsByUrl = new Map(
  [
    fixture.job.url,
    ...fixture.dashboardAggregateJobs.map((job) => job.url),
    ...fixture.rows.conversionJobs.map((job) => String(job.url)),
  ].map((url, index) => [url, FIXTURE_JOB_IDS[index]!] as const),
);

function fixtureJobId(url: string): string {
  const jobId = fixtureJobIdsByUrl.get(url);
  if (!jobId) throw new Error(`missing exact-v7 JobId for fixture URL: ${url}`);
  return jobId;
}

function withExactV7JobIds<T>(value: T): T {
  if (typeof value === "string") {
    return (fixtureJobIdsByUrl.get(value) ?? value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => withExactV7JobIds(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withExactV7JobIds(item)]),
    ) as T;
  }
  return value;
}

function withExactV7ProjectionContract(
  value: Record<ProjectionTable, Record<string, unknown>>,
): Record<ProjectionTable, Record<string, unknown>> {
  const converted = withExactV7JobIds(value);
  converted.jobList.apply_mode = "automated_live";
  const outcomeConversion = converted.dashboard.outcome_conversion_json as {
    byApplyMode: Array<Record<string, unknown>>;
  };
  outcomeConversion.byApplyMode = [
    {
      applyMode: "automated_live",
      applied: 3,
      reply: 3,
      interview: 2,
      offer: 1,
      rejection: 1,
    },
  ];
  return converted;
}

function withTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-audit-parity-"));
  const dbPath = path.join(dir, "jobs.db");
  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function insertApplyRunProjection(
  db: Database.Database,
  jobId: string,
  startedAt: string,
  finishedAt: string,
): void {
  const runId = `apply:${jobId}`;
  db.prepare(
    `INSERT INTO apply_run_projections (
       run_id, tenant_id, job_id, job_title, job_employer, status, result,
       dry_run, started_at, finished_at, events_json
     ) VALUES (?, 'local', ?, '', '', 'succeeded', 'applied', 0, ?, ?, '[]')`,
  ).run(runId, jobId, startedAt, finishedAt);
}

/** Seed the canonical rows exactly as the Python repositories write them. */
function seedRows(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const jobUrl = fixture.job.url;
  const jobId = fixtureJobId(jobUrl);
  db.prepare(
    `INSERT INTO jobs (
       tenant_id, job_id, url, title, company, site, strategy, location, salary, description,
       full_description, application_url, apply_status, applied_at,
       score_reasoning, discovered_at
     ) VALUES ('local', @job_id, @url, @title, @company, @site, @strategy, @location, @salary, @description,
       @full_description, @application_url, @apply_status, @applied_at,
       @score_reasoning, @discovered_at)`,
  ).run({
    job_id: jobId,
    url: jobUrl,
    title: fixture.job.title,
    company: fixture.job.company,
    site: fixture.job.site,
    strategy: fixture.job.strategy,
    location: fixture.job.location,
    salary: fixture.job.salary,
    description: fixture.job.description,
    full_description: fixture.job.fullDescription,
    application_url: fixture.job.applicationUrl,
    apply_status: fixture.job.applyStatus,
    applied_at: fixture.job.appliedAt,
    score_reasoning: fixture.job.scoreReasoning,
    discovered_at: fixture.job.discoveredAt,
  });

  const insertScore = db.prepare(
    `INSERT INTO job_scores (
       job_id, version, tenant_id, fit_score, breakdown_json, keywords_json,
       scored_at, correction_json, criteria_json, trace_json
     ) VALUES (@job_id, @version, 'local', @fit_score, @breakdown_json, @keywords_json,
       @scored_at, @correction_json, @criteria_json, @trace_json)`,
  );
  for (const score of fixture.rows.jobScores) insertScore.run({ job_id: jobId, ...score });

  const insertStage = db.prepare(
    `INSERT INTO job_stage_states (
       job_id, stage, state, attempt_count, max_attempts, started_at, updated_at,
       finished_at, duration_ms, error_code, error_message, retryable,
       blocked_by_json, next_action, metadata_json
     ) VALUES (@job_id, @stage, @state, @attempt_count, @max_attempts, @started_at, @updated_at,
       @finished_at, @duration_ms, @error_code, @error_message, @retryable,
       @blocked_by_json, @next_action, @metadata_json)`,
  );
  for (const stage of fixture.rows.jobStageStates) {
    insertStage.run({ job_id: jobId, metadata_json: null, ...stage });
  }

  const insertAnalysis = db.prepare(
    `INSERT INTO job_employer_analysis (
       job_id, generation, tenant_id, snapshot_hash, prompt_version, sdk_set_version,
       cache_key, role_framing, inferred_seniority, ideal_candidate_narrative,
       requirements_json, keywords_json, agreement_json, legs_attempted, legs_succeeded, created_at
     ) VALUES (@job_id, @generation, 'local', @snapshot_hash, @prompt_version, @sdk_set_version,
       @cache_key, @role_framing, @inferred_seniority, @ideal_candidate_narrative,
       @requirements_json, @keywords_json, @agreement_json, @legs_attempted, @legs_succeeded, @created_at)`,
  );
  for (const row of fixture.rows.jobEmployerAnalysis) {
    insertAnalysis.run({ job_id: jobId, ...row });
  }
  const insertSub = db.prepare(
    `INSERT INTO job_employer_analysis_sub_analyses (job_id, generation, model_id, tenant_id, analysis_json)
     VALUES (@job_id, @generation, @model_id, 'local', @analysis_json)`,
  );
  for (const sub of fixture.rows.jobEmployerAnalysisSubAnalyses) {
    insertSub.run({ job_id: jobId, ...sub });
  }
  const insertFailure = db.prepare(
    `INSERT INTO job_employer_analysis_failures (job_id, generation, model_id, tenant_id, error, raw_output)
     VALUES (@job_id, @generation, @model_id, 'local', @error, @raw_output)`,
  );
  for (const failure of fixture.rows.jobEmployerAnalysisFailures) {
    insertFailure.run({ job_id: jobId, ...failure });
  }

  const { generation, createdAt } = fixture.job;
  db.prepare(
    `INSERT INTO job_materials (job_id, generation, tenant_id, status, created_at, updated_at)
     VALUES (?, ?, 'local', 'complete', ?, ?)`,
  ).run(jobId, generation, createdAt, createdAt);
  const insertArtifact = db.prepare(
    `INSERT INTO job_materials_artifacts (
       job_id, generation, artifact_type, artifact_id, status, path,
       render_format, size_bytes, metadata_json, created_at
     ) VALUES (@job_id, @generation, @artifact_type, @artifact_id, @status, @path,
       @render_format, @size_bytes, @metadata_json, @created_at)`,
  );
  for (const artifact of fixture.rows.artifacts) {
    insertArtifact.run({
      job_id: jobId,
      generation,
      created_at: createdAt,
      metadata_json: "{}",
      ...artifact,
    });
  }
  const insertProvenance = db.prepare(
    `INSERT INTO job_bullet_provenance (
       job_id, generation, bullet_id, tenant_id, artifact_id, section, source_id,
       evidence_ids_json, requirement_ids_json, matched_keywords_json,
       transform_type, control, rationale, generated_text, position, created_at,
       coverage_json, voice_json
     ) VALUES (@job_id, @generation, @bullet_id, 'local', @artifact_id, @section, @source_id,
       @evidence_ids_json, @requirement_ids_json, @matched_keywords_json,
       @transform_type, @control, @rationale, @generated_text, @position, @created_at,
       @coverage_json, @voice_json)`,
  );
  for (const bullet of fixture.rows.bulletProvenance) {
    insertProvenance.run({ job_id: jobId, ...bullet });
  }
  const insertInterviewPrep = db.prepare(
    `INSERT INTO job_interview_prep (
       job_id, generation, tenant_id, status, model, generated_at, gate_status,
       fabrication_findings_json, grounding_findings_json, judge_verdict,
       warnings_json, failure_reason
     ) VALUES (@job_id, @generation, 'local', @status, @model, @generated_at, @gate_status,
       @fabrication_findings_json, @grounding_findings_json, @judge_verdict,
       @warnings_json, @failure_reason)`,
  );
  for (const prep of fixture.rows.jobInterviewPrep) {
    insertInterviewPrep.run({ job_id: jobId, ...prep });
  }
  const insertInterviewPrepItem = db.prepare(
    `INSERT INTO job_interview_prep_items (
       job_id, generation, item_id, tenant_id, kind, title, generated_text,
       evidence_ids_json, requirement_ids_json, source_text_json, transform_type,
       control, grounding_audit_json, warnings_json, position
     ) VALUES (@job_id, @generation, @item_id, 'local', @kind, @title, @generated_text,
       @evidence_ids_json, @requirement_ids_json, @source_text_json, @transform_type,
       @control, @grounding_audit_json, @warnings_json, @position)`,
  );
  for (const item of fixture.rows.jobInterviewPrepItems) {
    insertInterviewPrepItem.run({ job_id: jobId, ...item });
  }
  db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
     ) VALUES ('local', ?, 1, 'tailor', 'ResumeApproved', 'info', 'approved', ?, '{}')`,
  ).run(jobId, createdAt);
  insertApplyRunProjection(db, jobId, fixture.job.discoveredAt, fixture.job.appliedAt);
  db.prepare(
    `INSERT INTO resume_templates (
       tenant_id, template_id, display_name, status, built_in, created_at, updated_at
     ) VALUES ('local', 'built_in:modern-html', 'Modern HTML', 'active', 1, ?, ?)`,
  ).run(createdAt, createdAt);
  db.prepare(
    `INSERT INTO resume_template_versions (
       tenant_id, version_id, template_id, version_number, display_name, status,
       theme_json, layout_json, content_hash, created_at
     ) VALUES ('local', 'built_in:modern-html:v1', 'built_in:modern-html', 1,
               'Modern HTML', 'active', ?, '{}', 'audit-parity-template', ?)`,
  ).run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME), createdAt);

  // Dashboard-aggregate-only jobs: they feed ONLY the tenant dashboard totals
  // (the job_list/job_detail assertions target the primary job). See the fixture
  // `dashboardAggregateJobs` notes for the two divergences they cover.
  const insertAggJob = db.prepare(
    `INSERT INTO jobs (tenant_id, job_id, url, title, company, site, strategy, location,
       apply_status, applied_at, tailored_resume_path, discovered_at)
     VALUES ('local', @job_id, @url, @title, @company, @site, @strategy, @location,
       @apply_status, @applied_at, @tailored_resume_path, @discovered_at)`,
  );
  const insertAggStage = db.prepare(
    `INSERT INTO job_stage_states (job_id, stage, state, attempt_count, max_attempts,
       started_at, updated_at, finished_at, duration_ms, retryable)
     VALUES (@job_id, @stage, @state, 1, 1, @ts, @ts, @finished_at, 0, 1)`,
  );
  const insertAggScore = db.prepare(
    `INSERT INTO job_scores (job_id, version, tenant_id, fit_score, breakdown_json,
       keywords_json, scored_at, correction_json, criteria_json, trace_json)
     VALUES (@job_id, 1, 'local', @fit_score, @breakdown_json, '[]', @scored_at, NULL, '{}', '{}')`,
  );
  const insertHidden = db.prepare(
    `INSERT INTO jobctrl_hidden_jobs (tenant_id, job_id, hidden_at, reason, unhidden_at)
     VALUES ('local', ?, ?, 'parity', NULL)`,
  );
  for (const agg of fixture.dashboardAggregateJobs) {
    const aggregateJobId = fixtureJobId(agg.url);
    insertAggJob.run({
      job_id: aggregateJobId,
      url: agg.url,
      title: agg.title,
      company: agg.company,
      site: agg.site,
      strategy: agg.strategy,
      location: agg.location,
      apply_status: agg.applyStatus,
      applied_at: agg.appliedAt,
      tailored_resume_path: agg.tailoredResumePath,
      discovered_at: agg.discoveredAt,
    });
    for (const st of agg.stages) {
      insertAggStage.run({
        job_id: aggregateJobId,
        stage: st.stage,
        state: st.state,
        ts: agg.discoveredAt,
        finished_at: st.state === "succeeded" ? agg.discoveredAt : null,
      });
    }
    if (agg.fitScore != null) {
      insertAggScore.run({
        job_id: aggregateJobId,
        fit_score: agg.fitScore,
        breakdown_json: JSON.stringify({
          technical_fit: agg.fitScore,
          experience_fit: agg.fitScore,
          role_fit: agg.fitScore,
          reasoning: "Aggregate fixture job.",
        }),
        scored_at: agg.discoveredAt,
      });
    }
    if (agg.hidden) {
      insertHidden.run(aggregateJobId, agg.discoveredAt);
    }
  }
  // Extra applied+scored jobs across a second source and score band so the
  // shared cross-runtime funnel is non-trivial (multi-entry bySource/byBand).
  const conversionStages: Array<[string, number]> = [
    ["discover", 1],
    ["enrich", 3],
    ["score", 3],
    ["tailor", 5],
    ["cover", 5],
    ["apply", 3],
  ];
  const insertConversionJob = db.prepare(
    `INSERT INTO jobs (tenant_id, job_id, url, title, site, fit_score, apply_status, applied_at, discovered_at)
     VALUES ('local', @job_id, @url, @title, @site, @fit_score, 'applied', @applied_at, @discovered_at)`,
  );
  const insertConversionScore = db.prepare(
    `INSERT INTO job_scores (
       job_id, version, tenant_id, fit_score, breakdown_json, keywords_json,
       scored_at, correction_json, criteria_json, trace_json
     ) VALUES (@job_id, 1, 'local', @fit_score, '{}', '[]', @scored_at, NULL, '{}', '{}')`,
  );
  const insertConversionStage = db.prepare(
    `INSERT INTO job_stage_states (
       job_id, stage, state, attempt_count, max_attempts, started_at, updated_at,
       finished_at, duration_ms, retryable
     ) VALUES (@job_id, @stage, 'succeeded', 1, @max_attempts, @at, @at, @at, 1000, 1)`,
  );
  for (const job of fixture.rows.conversionJobs) {
    const conversionJobId = fixtureJobId(String(job.url));
    insertConversionJob.run({
      job_id: conversionJobId,
      url: job.url,
      title: job.title,
      site: job.site,
      fit_score: job.fitScore,
      applied_at: job.appliedAt,
      discovered_at: job.discoveredAt,
    });
    insertConversionScore.run({
      job_id: conversionJobId,
      fit_score: job.fitScore,
      scored_at: job.appliedAt,
    });
    insertApplyRunProjection(db, conversionJobId, String(job.discoveredAt), String(job.appliedAt));
    for (const [stage, maxAttempts] of conversionStages) {
      insertConversionStage.run({
        job_id: conversionJobId,
        stage,
        max_attempts: maxAttempts,
        at: job.appliedAt,
      });
    }
  }
  const insertOutcome = db.prepare(
    `INSERT INTO application_outcomes (tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at)
     VALUES ('local', @outcome_id, @job_id, @kind, 'manual', @at, @at)`,
  );
  for (const outcome of fixture.rows.applicationOutcomes) {
    insertOutcome.run({
      outcome_id: outcome.outcomeId,
      job_id: fixtureJobId(String(outcome.jobKey)),
      kind: outcome.kind,
      at: "2026-06-11T09:00:00+00:00",
    });
  }
  const insertSuggestion = db.prepare(
    `INSERT INTO application_outcome_suggestions (
       tenant_id, suggestion_id, job_id, suggested_kind, confidence, rationale,
       status, created_at, decided_at, decision
     ) VALUES ('local', @suggestion_id, @job_id, 'recruiter_reply', 0.9, '',
       @status, @at, @at, @status)`,
  );
  for (const suggestion of fixture.rows.applicationOutcomeSuggestions) {
    insertSuggestion.run({
      suggestion_id: suggestion.suggestionId,
      job_id: fixtureJobId(String(suggestion.jobKey)),
      status: suggestion.status,
      at: "2026-06-11T09:05:00+00:00",
    });
  }
  db.close();
}

/**
 * Row -> comparable object: parse *_json columns, drop wall-clock columns.
 * Both runtimes serialise JSON columns with different whitespace and key order,
 * so the columns are compared as parsed objects, never as raw strings.
 */
function normalizeRow(
  row: Record<string, unknown>,
  jsonColumns: string[],
  nonDeterministic: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (nonDeterministic.includes(key)) continue;
    out[key] = jsonColumns.includes(key) && value != null ? JSON.parse(value as string) : value;
  }
  return out;
}

describe("Cross-runtime projection parity (AUDIT-02)", () => {
  it("the TS builder + read model agree with the Python builder on the audit read shapes", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      initializeExactV7Database(dbPath);
      seedRows(dbPath);

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        // A read triggers the TS projection refresh, which materialises the
        // audit projection columns from the canonical rows.
        const detailRes = await app.inject({
          method: "GET",
          url: `/v1/jobs/${encodeURIComponent(fixture.job.url)}`,
        });
        expect(detailRes.statusCode, detailRes.body).toBe(200);

        // (1) Builder-vs-builder parity: the TS projection COLUMNS the TS builder
        // wrote equal the SAME JSON the Python builder produces from these rows.
        const db = new Database(dbPath, { readonly: true });
        try {
          const detail = db
            .prepare(
              "SELECT employer_analysis_json, interview_prep_json FROM job_detail_projections WHERE job_id = ?",
            )
            .get(fixtureJobId(fixture.job.url)) as {
            employer_analysis_json: string | null;
            interview_prep_json: string | null;
          };
          expect(detail?.employer_analysis_json).not.toBeNull();
          expect(JSON.parse(detail.employer_analysis_json!)).toEqual(
            fixture.expected.employerAnalysisJson,
          );
          expect(detail?.interview_prep_json).not.toBeNull();
          expect(JSON.parse(detail.interview_prep_json!)).toEqual(
            withExactV7JobIds(fixture.expected.interviewPrepJson),
          );

          const artifact = db
            .prepare(
              `SELECT bullet_provenance_json, coverage_audit_json, voice_pass_json
                 FROM artifact_list_projections WHERE artifact_id = 'resume-1'`,
            )
            .get() as {
            bullet_provenance_json: string | null;
            coverage_audit_json: string | null;
            voice_pass_json: string | null;
          };
          expect(JSON.parse(artifact.bullet_provenance_json!)).toEqual(
            fixture.expected.bulletProvenanceJson,
          );
          expect(JSON.parse(artifact.coverage_audit_json!)).toEqual(fixture.expected.coverageAuditJson);
          expect(JSON.parse(artifact.voice_pass_json!)).toEqual(fixture.expected.voicePassJson);
        } finally {
          db.close();
        }

        // (2) Read path: the read model serves the canonical employer analysis
        // and interview prep on the job detail.
        expect(detailRes.json().employerAnalysis).toEqual(fixture.expected.employerAnalysisJson);
        expect(detailRes.json().interviewPrep).toEqual(
          withExactV7JobIds(fixture.expected.interviewPrepJson),
        );
        expect(JSON.stringify(detailRes.json().interviewPrep)).not.toContain("prompt");
        expect(JSON.stringify(detailRes.json().interviewPrep)).not.toContain("full_description");

        // (3) Read path: the artifact detail serves provenance + coverage + voice
        // converted to the camelCase DTO — derived from the SAME canonical rows.
        const artifactRes = await app.inject({ method: "GET", url: "/v1/artifacts/resume-1" });
        expect(artifactRes.statusCode, artifactRes.body).toBe(200);
        const explanation = artifactRes.json().tailoringExplanation;
        expect(explanation).not.toBeNull();
        expect(explanation.bulletProvenance).toEqual([
          {
            bulletId: "executive_profile#0",
            section: "executive_profile",
            sourceId: "executive_profile",
            evidenceIds: [],
            sourceText: [],
            requirementIds: [],
            matchedKeywords: [],
            transformType: "reframe",
            control: "rephrase_allowed",
            rationale: "Reframed summary.",
            generatedText: "Senior platform engineer.",
          },
          {
            bulletId: "experience:acme#0",
            section: "experience",
            sourceId: "acme",
            evidenceIds: ["ev_platform"],
            sourceText: [],
            requirementIds: ["r1"],
            matchedKeywords: ["developer platform"],
            transformType: "voice",
            control: "rephrase_allowed",
            rationale: "Voiced.",
            generatedText: "Owned the developer platform across the fleet.",
          },
        ]);
        expect(explanation.coverageAudit).toEqual({
          computedAgainst: "rendered_text",
          planned: ["developer platform", "kafka"],
          covered: ["developer platform"],
          declared: [],
          missing: ["kafka"],
          coveredBy: { "developer platform": "experience:acme#0" },
          declaredBy: {},
          counts: { planned: 2, covered: 1, declared: 0, missing: 1 },
        });
        expect(explanation.voicePass).toEqual({
          ran: true,
          accepted: true,
          model: "claude-opus-4-8",
          promptVersion: "voice-pass-v1",
          proxyDelta: { improved: true },
          reason: "",
          summaryRejectionReason: "",
          scopeViolations: [],
          finalJudge: {},
        });
        // (4) The derived keyword block mirrors the canonical coverage (Phase 4),
        // including the A6b declared bucket (empty here — no skills-only keyword).
        expect(explanation.keywords).toMatchObject({
          coverageRecorded: true,
          planned: ["developer platform", "kafka"],
          covered: ["developer platform"],
          declared: [],
          missing: ["kafka"],
          counts: { planned: 2, covered: 1, declared: 0, missing: 1 },
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("the TS builder writes the full projection column set the Python builder produces", async () => {
    const { dbPath, cleanup } = withTempDb();
    try {
      initializeExactV7Database(dbPath);
      seedRows(dbPath);

      const app = buildApp({
        dbPath,
        configPath: path.join(path.dirname(dbPath), "config.json"),
      });
      try {
        // The detail read triggers a full projection refresh (first run rebuilds
        // every dirty job + the dashboard) so all three tables are materialised.
        const detailRes = await app.inject({
          method: "GET",
          url: `/v1/jobs/${encodeURIComponent(fixture.job.url)}`,
        });
        expect(detailRes.statusCode, detailRes.body).toBe(200);

        // job_list.location (TS + Python both run the same location normalization),
        // dashboard.ready (both require has_resume==1), and the dashboard totals
        // (both exclude hidden jobs) are all genuinely asserted here: the primary
        // job.location is non-normalized and dashboardAggregateJobs seeds an
        // apply/pending-no-resume job plus a hidden applied job. See the fixture
        // notes.
        const db = new Database(dbPath, { readonly: true });
        try {
          const rows: Record<ProjectionTable, Record<string, unknown> | undefined> = {
            jobList: db
              .prepare("SELECT * FROM job_list_projections WHERE job_id = ?")
              .get(fixtureJobId(fixture.job.url)) as Record<string, unknown> | undefined,
            jobDetail: db
              .prepare("SELECT * FROM job_detail_projections WHERE job_id = ?")
              .get(fixtureJobId(fixture.job.url)) as Record<string, unknown> | undefined,
            dashboard: db
              .prepare("SELECT * FROM dashboard_projections WHERE tenant_id = 'local'")
              .get() as Record<string, unknown> | undefined,
          };

          for (const table of ["jobList", "jobDetail", "dashboard"] as const) {
            const row = rows[table];
            expect(row, `${table} projection row missing`).toBeTruthy();
            const jsonCols = fixture.projectionParity.jsonColumns[table];
            const nonDet = fixture.projectionParity.nonDeterministicColumns[table];
            const expectedCols = withExactV7ProjectionContract(fixture.expectedProjections)[table];

            // Column-set parity guard: the columns the builder emits must be
            // exactly the fixture's deterministic keys plus the wall-clock columns.
            // A one-sided column addition in either runtime fails here against the
            // shared fixture.
            expect(new Set(Object.keys(row!))).toEqual(
              new Set([...Object.keys(expectedCols), ...nonDet]),
            );
            // Wall-clock columns are excluded from value parity but must be written.
            for (const column of nonDet) {
              expect(row![column], `${table}.${column} not populated`).toBeTruthy();
            }
            const expected = table === "jobList"
              ? { ...expectedCols, artifact_count: fixture.rows.artifacts.length }
              : expectedCols;
            expect(normalizeRow(row!, jsonCols, nonDet)).toEqual(expected);
          }
        } finally {
          db.close();
        }
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });
});
