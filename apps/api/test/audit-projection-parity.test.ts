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

import { buildApp } from "../src/server.js";

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
    bulletProvenanceJson: unknown;
    coverageAuditJson: unknown;
    voicePassJson: unknown;
  };
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

function withTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-audit-parity-"));
  const dbPath = path.join(dir, "jobs.db");
  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Create the minimal canonical schema the projection builder reads from. */
function seedSchema(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      title TEXT,
      company TEXT,
      salary TEXT,
      description TEXT,
      location TEXT,
      site TEXT,
      strategy TEXT,
      discovered_at TEXT,
      full_description TEXT,
      application_url TEXT,
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
      apply_attempts INTEGER DEFAULT 0
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
    CREATE TABLE job_stage_states (
      job_url TEXT NOT NULL,
      stage TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER DEFAULT 0,
      max_attempts INTEGER,
      started_at TEXT,
      updated_at TEXT NOT NULL,
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
      coverage_json TEXT,
      voice_json TEXT,
      PRIMARY KEY (job_url, generation, bullet_id)
    );
    CREATE TABLE jobhunter_hidden_jobs (
      job_url TEXT PRIMARY KEY,
      hidden_at TEXT NOT NULL,
      reason TEXT,
      unhidden_at TEXT
    );
    CREATE TABLE application_outcomes (
      tenant_id     TEXT NOT NULL DEFAULT 'local',
      outcome_id    TEXT NOT NULL,
      job_key       TEXT NOT NULL,
      kind          TEXT NOT NULL,
      source        TEXT NOT NULL,
      note          TEXT,
      occurred_at   TEXT NOT NULL,
      recorded_at   TEXT NOT NULL,
      suggestion_id TEXT,
      evidence_id   TEXT,
      created_by    TEXT NOT NULL DEFAULT 'user',
      PRIMARY KEY (tenant_id, outcome_id)
    );
    CREATE TABLE application_outcome_suggestions (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      suggestion_id TEXT NOT NULL,
      job_key TEXT NOT NULL,
      evidence_id TEXT,
      suggested_kind TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      rationale TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decision TEXT,
      decision_reason TEXT,
      decided_outcome_id TEXT,
      PRIMARY KEY (tenant_id, suggestion_id)
    );
  `);
  db.close();
}

/** Seed the canonical rows exactly as the Python repositories write them. */
function seedRows(dbPath: string): void {
  const db = new Database(dbPath);
  const jobUrl = fixture.job.url;
  db.prepare(
    `INSERT INTO jobs (
       url, title, company, site, strategy, location, salary, description,
       full_description, application_url, apply_status, applied_at,
       score_reasoning, discovered_at
     ) VALUES (@url, @title, @company, @site, @strategy, @location, @salary, @description,
       @full_description, @application_url, @apply_status, @applied_at,
       @score_reasoning, @discovered_at)`,
  ).run({
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
       job_url, version, tenant_id, fit_score, breakdown_json, keywords_json,
       scored_at, correction_json, criteria_json, trace_json
     ) VALUES (@job_url, @version, 'local', @fit_score, @breakdown_json, @keywords_json,
       @scored_at, @correction_json, @criteria_json, @trace_json)`,
  );
  for (const score of fixture.rows.jobScores) insertScore.run({ job_url: jobUrl, ...score });

  const insertStage = db.prepare(
    `INSERT INTO job_stage_states (
       job_url, stage, state, attempt_count, max_attempts, started_at, updated_at,
       finished_at, duration_ms, error_code, error_message, retryable,
       blocked_by_json, next_action
     ) VALUES (@job_url, @stage, @state, @attempt_count, @max_attempts, @started_at, @updated_at,
       @finished_at, @duration_ms, @error_code, @error_message, @retryable,
       @blocked_by_json, @next_action)`,
  );
  for (const stage of fixture.rows.jobStageStates) insertStage.run({ job_url: jobUrl, ...stage });

  const insertAnalysis = db.prepare(
    `INSERT INTO job_employer_analysis (
       job_url, generation, tenant_id, snapshot_hash, prompt_version, sdk_set_version,
       cache_key, role_framing, inferred_seniority, ideal_candidate_narrative,
       requirements_json, keywords_json, agreement_json, legs_attempted, legs_succeeded, created_at
     ) VALUES (@job_url, @generation, 'local', @snapshot_hash, @prompt_version, @sdk_set_version,
       @cache_key, @role_framing, @inferred_seniority, @ideal_candidate_narrative,
       @requirements_json, @keywords_json, @agreement_json, @legs_attempted, @legs_succeeded, @created_at)`,
  );
  for (const row of fixture.rows.jobEmployerAnalysis) {
    insertAnalysis.run({ job_url: jobUrl, ...row });
  }
  const insertSub = db.prepare(
    `INSERT INTO job_employer_analysis_sub_analyses (job_url, generation, model_id, tenant_id, analysis_json)
     VALUES (@job_url, @generation, @model_id, 'local', @analysis_json)`,
  );
  for (const sub of fixture.rows.jobEmployerAnalysisSubAnalyses) {
    insertSub.run({ job_url: jobUrl, ...sub });
  }
  const insertFailure = db.prepare(
    `INSERT INTO job_employer_analysis_failures (job_url, generation, model_id, tenant_id, error, raw_output)
     VALUES (@job_url, @generation, @model_id, 'local', @error, @raw_output)`,
  );
  for (const failure of fixture.rows.jobEmployerAnalysisFailures) {
    insertFailure.run({ job_url: jobUrl, ...failure });
  }

  const { generation, createdAt } = fixture.job;
  db.prepare(
    `INSERT INTO job_materials (job_url, generation, tenant_id, status, created_at, updated_at)
     VALUES (?, ?, 'local', 'complete', ?, ?)`,
  ).run(jobUrl, generation, createdAt, createdAt);
  const insertArtifact = db.prepare(
    `INSERT INTO job_materials_artifacts (
       job_url, generation, artifact_type, artifact_id, status, path,
       render_format, size_bytes, metadata_json, created_at
     ) VALUES (@job_url, @generation, @artifact_type, @artifact_id, @status, @path,
       @render_format, @size_bytes, @metadata_json, @created_at)`,
  );
  for (const artifact of fixture.rows.artifacts) {
    insertArtifact.run({
      job_url: jobUrl,
      generation,
      created_at: createdAt,
      metadata_json: "{}",
      ...artifact,
    });
  }
  const insertProvenance = db.prepare(
    `INSERT INTO job_bullet_provenance (
       job_url, generation, bullet_id, tenant_id, artifact_id, section, source_id,
       evidence_ids_json, requirement_ids_json, matched_keywords_json,
       transform_type, control, rationale, generated_text, position, created_at,
       coverage_json, voice_json
     ) VALUES (@job_url, @generation, @bullet_id, 'local', @artifact_id, @section, @source_id,
       @evidence_ids_json, @requirement_ids_json, @matched_keywords_json,
       @transform_type, @control, @rationale, @generated_text, @position, @created_at,
       @coverage_json, @voice_json)`,
  );
  for (const bullet of fixture.rows.bulletProvenance) {
    insertProvenance.run({ job_url: jobUrl, ...bullet });
  }
  db.prepare(
    `INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
     VALUES (?, 'tailor', 'ResumeApproved', 'info', 'approved', ?, '{}')`,
  ).run(jobUrl, createdAt);

  // Dashboard-aggregate-only jobs: they feed ONLY the tenant dashboard totals
  // (the job_list/job_detail assertions target the primary job). See the fixture
  // `dashboardAggregateJobs` notes for the two divergences they cover.
  const insertAggJob = db.prepare(
    `INSERT INTO jobs (url, title, company, site, strategy, location,
       apply_status, applied_at, tailored_resume_path, discovered_at)
     VALUES (@url, @title, @company, @site, @strategy, @location,
       @apply_status, @applied_at, @tailored_resume_path, @discovered_at)`,
  );
  const insertAggStage = db.prepare(
    `INSERT INTO job_stage_states (job_url, stage, state, attempt_count, max_attempts,
       started_at, updated_at, finished_at, duration_ms, retryable)
     VALUES (@job_url, @stage, @state, 1, 1, @ts, @ts, @finished_at, 0, 1)`,
  );
  const insertAggScore = db.prepare(
    `INSERT INTO job_scores (job_url, version, tenant_id, fit_score, breakdown_json,
       keywords_json, scored_at, correction_json, criteria_json, trace_json)
     VALUES (@job_url, 1, 'local', @fit_score, @breakdown_json, '[]', @scored_at, NULL, '{}', '{}')`,
  );
  const insertHidden = db.prepare(
    `INSERT INTO jobhunter_hidden_jobs (job_url, hidden_at, reason, unhidden_at)
     VALUES (?, ?, 'parity', NULL)`,
  );
  for (const agg of fixture.dashboardAggregateJobs) {
    insertAggJob.run({
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
        job_url: agg.url,
        stage: st.stage,
        state: st.state,
        ts: agg.discoveredAt,
        finished_at: st.state === "succeeded" ? agg.discoveredAt : null,
      });
    }
    if (agg.fitScore != null) {
      insertAggScore.run({
        job_url: agg.url,
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
      insertHidden.run(agg.url, agg.discoveredAt);
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
    `INSERT INTO jobs (url, title, site, fit_score, apply_status, applied_at, discovered_at)
     VALUES (@url, @title, @site, @fit_score, 'applied', @applied_at, @discovered_at)`,
  );
  const insertConversionStage = db.prepare(
    `INSERT INTO job_stage_states (
       job_url, stage, state, attempt_count, max_attempts, started_at, updated_at,
       finished_at, duration_ms, retryable
     ) VALUES (@job_url, @stage, 'succeeded', 1, @max_attempts, @at, @at, @at, 1000, 1)`,
  );
  for (const job of fixture.rows.conversionJobs) {
    insertConversionJob.run({
      url: job.url,
      title: job.title,
      site: job.site,
      fit_score: job.fitScore,
      applied_at: job.appliedAt,
      discovered_at: job.discoveredAt,
    });
    for (const [stage, maxAttempts] of conversionStages) {
      insertConversionStage.run({
        job_url: job.url,
        stage,
        max_attempts: maxAttempts,
        at: job.appliedAt,
      });
    }
  }
  const insertOutcome = db.prepare(
    `INSERT INTO application_outcomes (tenant_id, outcome_id, job_key, kind, source, occurred_at, recorded_at)
     VALUES ('local', @outcome_id, @job_key, @kind, 'manual', @at, @at)`,
  );
  for (const outcome of fixture.rows.applicationOutcomes) {
    insertOutcome.run({
      outcome_id: outcome.outcomeId,
      job_key: outcome.jobKey,
      kind: outcome.kind,
      at: "2026-06-11T09:00:00+00:00",
    });
  }
  const insertSuggestion = db.prepare(
    `INSERT INTO application_outcome_suggestions (
       tenant_id, suggestion_id, job_key, suggested_kind, confidence, rationale,
       status, created_at, decided_at, decision
     ) VALUES ('local', @suggestion_id, @job_key, 'recruiter_reply', 0.9, '',
       @status, @at, @at, @status)`,
  );
  for (const suggestion of fixture.rows.applicationOutcomeSuggestions) {
    insertSuggestion.run({
      suggestion_id: suggestion.suggestionId,
      job_key: suggestion.jobKey,
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
      seedSchema(dbPath);
      seedRows(dbPath);

      const app = buildApp({
        dbPath,
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
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
            .prepare("SELECT employer_analysis_json FROM job_detail_projections WHERE job_id = ?")
            .get(fixture.job.url) as { employer_analysis_json: string | null };
          expect(detail?.employer_analysis_json).not.toBeNull();
          expect(JSON.parse(detail.employer_analysis_json!)).toEqual(
            fixture.expected.employerAnalysisJson,
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
        // (verbatim) on the job detail.
        expect(detailRes.json().employerAnalysis).toEqual(fixture.expected.employerAnalysisJson);

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
      seedSchema(dbPath);
      seedRows(dbPath);

      const app = buildApp({
        dbPath,
        settingsPath: path.join(path.dirname(dbPath), "dashboard.json"),
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
              .get(fixture.job.url) as Record<string, unknown> | undefined,
            jobDetail: db
              .prepare("SELECT * FROM job_detail_projections WHERE job_id = ?")
              .get(fixture.job.url) as Record<string, unknown> | undefined,
            dashboard: db
              .prepare("SELECT * FROM dashboard_projections WHERE tenant_id = 'local'")
              .get() as Record<string, unknown> | undefined,
          };

          for (const table of ["jobList", "jobDetail", "dashboard"] as const) {
            const row = rows[table];
            expect(row, `${table} projection row missing`).toBeTruthy();
            const jsonCols = fixture.projectionParity.jsonColumns[table];
            const nonDet = fixture.projectionParity.nonDeterministicColumns[table];
            const expectedCols = fixture.expectedProjections[table];

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
            expect(normalizeRow(row!, jsonCols, nonDet)).toEqual(expectedCols);
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
