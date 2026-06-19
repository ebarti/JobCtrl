/**
 * Cross-runtime projection parity for the Phase 4 audit tables (AUDIT-02).
 *
 * The TS half of the genuine TS<->Python drift guard. The Python half lives at
 * ``workers/automation/tests/test_audit_projection_parity.py``. Both load the
 * SAME shared fixture (``packages/domain-types/test/fixtures/
 * audit_projection_parity.json``), seed the SAME canonical rows, run their OWN
 * projection builder, and assert the resulting projection-column JSON equals the
 * fixture's ``expected`` block.
 *
 * Because both builders are checked against ONE expectation derived from the
 * canonical rows, a schema/serialisation drift in EITHER runtime fails its test
 * — unlike the earlier Phase-3 parity test, which hand-seeded the projection JSON
 * on the TS side only and so could not catch the Python builder drifting.
 *
 * This test exercises the REAL TS projection builder + read model end to end:
 *  - the TS builder writes ``artifact_list_projections.{bullet_provenance_json,
 *    coverage_audit_json,voice_pass_json}`` + ``job_detail_projections
 *    .employer_analysis_json`` from the canonical rows (asserted byte-for-byte
 *    against the same ``expected`` the Python builder produces), and
 *  - the read model serves the resulting DTOs (employer analysis verbatim;
 *    provenance/coverage/voice converted to camelCase).
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

interface Fixture {
  job: { url: string; title: string; site: string; generation: number; createdAt: string };
  rows: {
    jobEmployerAnalysis: Array<Record<string, unknown>>;
    jobEmployerAnalysisSubAnalyses: Array<Record<string, unknown>>;
    jobEmployerAnalysisFailures: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
    bulletProvenance: Array<Record<string, unknown>>;
  };
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
      site TEXT,
      salary TEXT DEFAULT ''
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
  `);
  db.close();
}

/** Seed the canonical rows exactly as the Python repositories write them. */
function seedRows(dbPath: string): void {
  const db = new Database(dbPath);
  const jobUrl = fixture.job.url;
  db.prepare("INSERT INTO jobs (url, title, site, salary) VALUES (?, ?, ?, '')").run(
    jobUrl,
    fixture.job.title,
    fixture.job.site,
  );
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
       @render_format, @size_bytes, '{}', @created_at)`,
  );
  for (const artifact of fixture.rows.artifacts) {
    insertArtifact.run({ job_url: jobUrl, generation, created_at: createdAt, ...artifact });
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
  db.close();
}

describe("Phase 4 cross-runtime audit projection parity (AUDIT-02)", () => {
  it("the TS builder + read model agree with the Python builder on the shared fixture", async () => {
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
          missing: ["kafka"],
          coveredBy: { "developer platform": "experience:acme#0" },
          counts: { planned: 2, covered: 1, missing: 1 },
        });
        expect(explanation.voicePass).toEqual({
          ran: true,
          accepted: true,
          model: "claude-opus-4-8",
          promptVersion: "voice-pass-v1",
          proxyDelta: { improved: true },
          reason: "",
        });
        // (4) The derived keyword block mirrors the canonical coverage (Phase 4).
        expect(explanation.keywords).toMatchObject({
          coverageRecorded: true,
          planned: ["developer platform", "kafka"],
          covered: ["developer platform"],
          missing: ["kafka"],
          counts: { planned: 2, covered: 1, missing: 1 },
        });
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });
});
