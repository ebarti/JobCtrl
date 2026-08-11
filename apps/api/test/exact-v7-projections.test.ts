import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { refreshProjections } from "../src/projections.js";
import { EXACT_V8_SCHEMA_MANIFEST, schemaManifest } from "../src/schema-manifest.js";
import { initializeExactV7Database } from "./v7-schema.js";

const JOB_ID = "00000000-0000-4000-8000-000000000071";
const ARTIFACT_JOB_ID = "00000000-0000-4000-8000-000000000072";
const UNKNOWN_COMPANY_JOB_ID = "00000000-0000-4000-8000-000000000073";
const STALE_WIDE_JOB_ID = "00000000-0000-4000-8000-000000000074";
const CANONICAL_FACTS_JOB_ID = "00000000-0000-4000-8000-000000000075";
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("exact-v7 projection refresh", () => {
  it("rebuilds only the requested tenant and leaves the schema manifest unchanged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-v7-projections-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "jobs.db");
    initializeExactV7Database(dbPath);
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    const before = schemaManifest(db, EXACT_V8_SCHEMA_MANIFEST.version);
    expect(before).toEqual(EXACT_V8_SCHEMA_MANIFEST);

    const insertJob = db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
       VALUES (?, ?, ?, ?, 'Example', 'example', '2026-07-31T12:00:00Z')`,
    );
    insertJob.run("local", JOB_ID, "https://jobs.example.test/local", "Local title");
    insertJob.run("other", JOB_ID, "https://jobs.example.test/other", "Other title");
    db.prepare(
      `INSERT INTO job_enrichments (
         tenant_id, job_id, current_status, application_url, updated_at
       ) VALUES ('local', ?, 'completed', 'https://apply.example.test/local', '2026-07-31T12:00:00Z')`,
    ).run(JOB_ID);
    db.prepare(
      `INSERT INTO job_stage_states (
         tenant_id, job_id, stage, state, updated_at, retryable, version
       ) VALUES ('local', ?, 'discover', 'succeeded', '2026-07-31T12:00:00Z', 0, 1)`,
    ).run(JOB_ID);
    db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, occurred_at
       ) VALUES ('local', ?, 1, 'discover', 'JobDiscovered', '2026-07-31T12:00:00Z')`,
    ).run(JOB_ID);

    refreshProjections(db, "local");
    expect(
      db
        .prepare("SELECT title, application_url FROM job_list_projections WHERE tenant_id = ? AND job_id = ?")
        .get("local", JOB_ID),
    ).toEqual({ title: "Local title", application_url: "https://apply.example.test/local" });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM job_list_projections WHERE tenant_id = 'other'").get(),
    ).toEqual({ count: 0 });

    db.prepare("UPDATE jobs SET title = ? WHERE tenant_id = ? AND job_id = ?").run(
      "Local title refreshed",
      "local",
      JOB_ID,
    );
    db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, occurred_at
       ) VALUES ('local', ?, 1, 'discover', 'JobUpdated', '2026-07-31T12:01:00Z')`,
    ).run(JOB_ID);
    refreshProjections(db, "local");
    expect(
      db
        .prepare("SELECT title FROM job_list_projections WHERE tenant_id = ? AND job_id = ?")
        .get("local", JOB_ID),
    ).toEqual({ title: "Local title refreshed" });

    refreshProjections(db, "other");
    expect(
      db
        .prepare("SELECT title FROM job_list_projections WHERE tenant_id = ? AND job_id = ?")
        .get("other", JOB_ID),
    ).toEqual({ title: "Other title" });
    expect(schemaManifest(db, EXACT_V8_SCHEMA_MANIFEST.version)).toEqual(before);
    db.close();
  });

  it("projects contact and outreach job ids from exact-v7 canonical rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-v7-contact-projections-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "jobs.db");
    initializeExactV7Database(dbPath);
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");

    db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
       VALUES ('local', ?, 'https://jobs.example.test/contact', 'Contact title', 'Example', 'example', ?)`,
    ).run(JOB_ID, "2026-07-31T12:00:00Z");
    db.prepare(
      `INSERT INTO contacts (tenant_id, contact_id, employer, job_id, role, created_at, updated_at)
       VALUES ('local', 'contact-local', 'Example', ?, 'recruiter', ?, ?)`,
    ).run(JOB_ID, "2026-07-31T12:00:00Z", "2026-07-31T12:00:00Z");
    db.prepare(
      `INSERT INTO contact_research_tasks (
         tenant_id, task_id, employer, job_id, status, source_attempts_json, updated_at
       ) VALUES ('local', 'research-local', 'Example', ?, 'queued', '[]', ?)`,
    ).run(JOB_ID, "2026-07-31T12:00:00Z");
    db.prepare(
      `INSERT INTO outreach_threads (
         tenant_id, thread_id, contact_id, job_id, created_at, updated_at,
         follow_up_due_at, follow_up_basis, follow_up_state
       ) VALUES ('local', 'thread-local', 'contact-local', ?, ?, ?, ?, 'manual', 'scheduled')`,
    ).run(
      JOB_ID,
      "2026-07-31T12:00:00Z",
      "2026-07-31T12:00:00Z",
      "2026-08-07T12:00:00Z",
    );
    const recordEvent = db.prepare(
      `INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, occurred_at)
       VALUES ('local', ?, 1, 'contact', ?, '2026-07-31T12:00:00Z')`,
    );
    recordEvent.run(JOB_ID, "ContactCreated");
    recordEvent.run(JOB_ID, "ContactResearchTaskStarted");
    recordEvent.run(JOB_ID, "FollowUpScheduled");

    refreshProjections(db, "local");

    expect(
      db.prepare("SELECT job_id FROM contact_projections WHERE tenant_id = 'local' AND contact_id = 'contact-local'").get(),
    ).toEqual({ job_id: JOB_ID });
    expect(
      db.prepare("SELECT job_id FROM contact_research_task_projections WHERE tenant_id = 'local' AND task_id = 'research-local'").get(),
    ).toEqual({ job_id: JOB_ID });
    expect(
      db.prepare("SELECT job_id FROM outreach_thread_projections WHERE tenant_id = 'local' AND thread_id = 'thread-local'").get(),
    ).toEqual({ job_id: JOB_ID });
    expect(
      db.prepare("SELECT job_id FROM due_follow_up_projections WHERE tenant_id = 'local' AND thread_id = 'thread-local'").get(),
    ).toEqual({ job_id: JOB_ID });
    db.close();
  });

  it("removes unregistered artifact siblings and preserves both registered artifact sources after reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-v7-artifact-refresh-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "jobs.db");
    initializeExactV7Database(dbPath);
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");

    db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
       VALUES ('local', ?, 'https://jobs.example.test/artifacts', 'Artifact title', 'Example', 'greenhouse', ?)`,
    ).run(ARTIFACT_JOB_ID, "2026-07-31T12:00:00Z");
    db.prepare(
      `INSERT INTO job_materials (
         tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
       ) VALUES ('local', ?, 1, 'resume_approved', ?, ?, '{}')`,
    ).run(ARTIFACT_JOB_ID, "2026-07-31T12:00:00Z", "2026-07-31T12:00:00Z");
    db.prepare(
      `INSERT INTO job_materials_artifacts (
         tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
         render_format, size_bytes, metadata_json, created_at
       ) VALUES ('local', ?, 1, 'tailored_resume', 'registered-resume', 'approved',
                 '/tmp/registered-resume.txt', 'text', 12, '{}', ?)`,
    ).run(ARTIFACT_JOB_ID, "2026-07-31T12:00:00Z");
    const genericArtifactId = String(
      db
        .prepare(
          `INSERT INTO job_artifacts (
             tenant_id, job_id, stage, artifact_type, status, path, created_at, size_bytes
           ) VALUES ('local', ?, 'apply', 'application_log', 'completed',
                     '/tmp/registered-application.log', ?, 24)`,
        )
        .run(ARTIFACT_JOB_ID, "2026-07-31T12:00:00Z").lastInsertRowid,
    );
    const shadowedGenericArtifactId = String(
      db
        .prepare(
          `INSERT INTO job_artifacts (
             tenant_id, job_id, stage, artifact_type, status, path, created_at, size_bytes
           ) VALUES ('local', ?, 'tailor', 'tailored_resume', 'completed',
                     '/tmp/registered-resume.txt', ?, 12)`,
        )
        .run(ARTIFACT_JOB_ID, "2026-07-31T12:00:00Z").lastInsertRowid,
    );

    refreshProjections(db, "local");
    db.prepare(
      `INSERT INTO artifact_list_projections (
         artifact_id, tenant_id, job_id, job_title, job_employer, artifact_type,
         status, local_path
       ) VALUES (?, 'local', ?, 'Artifact title', 'Example', 'tailored_resume',
                 'completed', '/tmp/registered-resume.txt')`,
    ).run(shadowedGenericArtifactId, ARTIFACT_JOB_ID);
    db.prepare(
      `INSERT INTO artifact_list_projections (
         artifact_id, tenant_id, job_id, job_title, job_employer, artifact_type,
         status, local_path, generation
       ) VALUES ('phantom-resume-pdf', 'local', ?, 'Artifact title', 'Example',
                 'resume_pdf', 'approved', '/tmp/registered-resume.pdf', 1)`,
    ).run(ARTIFACT_JOB_ID);

    refreshProjections(db, "local");
    expect(
      db
        .prepare(
          `SELECT artifact_id, artifact_type, local_path
             FROM artifact_list_projections
            WHERE tenant_id = 'local' AND job_id = ?
            ORDER BY artifact_id`,
        )
        .all(ARTIFACT_JOB_ID),
    ).toEqual([
      {
        artifact_id: genericArtifactId,
        artifact_type: "application_log",
        local_path: "/tmp/registered-application.log",
      },
      {
        artifact_id: "registered-resume",
        artifact_type: "tailored_resume",
        local_path: "/tmp/registered-resume.txt",
      },
    ]);
    db.close();

    const reopened = new Database(dbPath);
    reopened.pragma("foreign_keys = ON");
    refreshProjections(reopened, "local");
    expect(
      reopened
        .prepare(
          `SELECT artifact_id, artifact_type, local_path
             FROM artifact_list_projections
            WHERE tenant_id = 'local' AND job_id = ?
            ORDER BY artifact_id`,
        )
        .all(ARTIFACT_JOB_ID),
    ).toEqual([
      {
        artifact_id: genericArtifactId,
        artifact_type: "application_log",
        local_path: "/tmp/registered-application.log",
      },
      {
        artifact_id: "registered-resume",
        artifact_type: "tailored_resume",
        local_path: "/tmp/registered-resume.txt",
      },
    ]);
    reopened.close();
  });

  it("ignores stale wide values and derives list, detail, and dashboard facts from canonical rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-v7-canonical-projections-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "jobs.db");
    initializeExactV7Database(dbPath);
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");

    const insertJob = db.prepare(
      `INSERT INTO jobs (
         tenant_id, job_id, url, title, company, site, discovered_at,
         fit_score, score_reasoning, tailored_resume_path, cover_letter_path,
         apply_status, applied_at
       ) VALUES (
         'local', @job_id, @url, @title, 'Example', 'example', '2026-07-31T12:00:00Z',
         10, 'stale score reasoning', '/tmp/stale-resume.txt', '/tmp/stale-cover.txt',
         'applied', '2026-07-30T12:00:00Z'
       )`,
    );
    insertJob.run({
      job_id: STALE_WIDE_JOB_ID,
      url: "https://jobs.example.test/stale-wide",
      title: "Stale wide values only",
    });
    insertJob.run({
      job_id: CANONICAL_FACTS_JOB_ID,
      url: "https://jobs.example.test/canonical-facts",
      title: "Canonical facts",
    });

    const insertEvent = db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, occurred_at
       ) VALUES ('local', ?, 1, ?, ?, ?)`,
    );
    insertEvent.run(STALE_WIDE_JOB_ID, "discover", "JobDiscovered", "2026-07-31T12:00:00Z");
    insertEvent.run(CANONICAL_FACTS_JOB_ID, "discover", "JobDiscovered", "2026-07-31T12:00:00Z");
    insertEvent.run(
      CANONICAL_FACTS_JOB_ID,
      "apply",
      "ApplicationManuallyMarked",
      "2026-07-31T12:30:00Z",
    );

    db.prepare(
      `INSERT INTO job_scores (
         tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at
       ) VALUES ('local', ?, 1, 7, '{"reasoning":"canonical score reasoning"}', '[]', ?)`,
    ).run(CANONICAL_FACTS_JOB_ID, "2026-07-31T12:15:00Z");
    db.prepare(
      `INSERT INTO job_artifacts (
         tenant_id, job_id, stage, artifact_type, status, path, created_at, size_bytes
       ) VALUES ('local', ?, 'tailor', 'tailored_resume', 'active',
                 '/tmp/canonical-resume.txt', '2026-07-31T12:20:00Z', 12)`,
    ).run(CANONICAL_FACTS_JOB_ID);
    db.prepare(
      `INSERT INTO job_materials (
         tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
       ) VALUES ('local', ?, 1, 'resume_approved', ?, ?, '{}')`,
    ).run(CANONICAL_FACTS_JOB_ID, "2026-07-31T12:20:00Z", "2026-07-31T12:20:00Z");
    db.prepare(
      `INSERT INTO job_materials_artifacts (
         tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
         render_format, size_bytes, metadata_json, created_at
       ) VALUES ('local', ?, 1, 'cover_letter', 'canonical-cover', 'approved',
                 '/tmp/canonical-cover.txt', 'text', 12, '{}', '2026-07-31T12:20:00Z')`,
    ).run(CANONICAL_FACTS_JOB_ID);

    refreshProjections(db, "local");

    expect(
      db
        .prepare(
          `SELECT fit_score, score_reasoning, has_resume, has_cover_letter, has_pdf,
                  apply_status, applied_at, apply_mode, artifact_count
             FROM job_list_projections
            WHERE tenant_id = 'local' AND job_id = ?`,
        )
        .get(STALE_WIDE_JOB_ID),
    ).toEqual({
      fit_score: null,
      score_reasoning: "",
      has_resume: 0,
      has_cover_letter: 0,
      has_pdf: 0,
      apply_status: null,
      applied_at: null,
      apply_mode: null,
      artifact_count: 0,
    });
    expect(
      db
        .prepare(
          `SELECT fit_score, score_reasoning, has_resume, has_cover_letter,
                  apply_status, applied_at, apply_mode
             FROM job_list_projections
            WHERE tenant_id = 'local' AND job_id = ?`,
        )
        .get(CANONICAL_FACTS_JOB_ID),
    ).toEqual({
      fit_score: 7,
      score_reasoning: "canonical score reasoning",
      has_resume: 1,
      has_cover_letter: 1,
      apply_status: "applied",
      applied_at: "2026-07-31T12:30:00Z",
      apply_mode: "manual_marked",
    });
    expect(
      db
        .prepare(
          `SELECT score_breakdown_json, score_reasoning, score_version, scored_at
             FROM job_detail_projections
            WHERE tenant_id = 'local' AND job_id = ?`,
        )
        .get(STALE_WIDE_JOB_ID),
    ).toEqual({
      score_breakdown_json: null,
      score_reasoning: "",
      score_version: null,
      scored_at: null,
    });
    const dashboard = db
      .prepare(
        `SELECT ready, applied, score_distribution_json, outcome_conversion_json
           FROM dashboard_projections
          WHERE tenant_id = 'local'`,
      )
      .get() as {
      ready: number;
      applied: number;
      score_distribution_json: string;
      outcome_conversion_json: string;
    };
    expect(dashboard).toMatchObject({
      ready: 0,
      applied: 1,
      score_distribution_json: "[[7,1]]",
    });
    expect(JSON.parse(dashboard.outcome_conversion_json)).toMatchObject({
      totals: { applied: 1 },
      byBand: [{ band: "strong", applied: 1 }],
      byApplyMode: [{ applyMode: "manual_marked", applied: 1 }],
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM artifact_list_projections WHERE tenant_id = 'local' AND job_id = ?",
        )
        .get(STALE_WIDE_JOB_ID),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("uses explicit company truth without deriving employer from source or URL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-v7-company-projection-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "jobs.db");
    initializeExactV7Database(dbPath);
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");

    const insertJob = db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
       VALUES ('local', ?, ?, ?, ?, 'greenhouse', '2026-07-31T12:00:00Z')`,
    );
    insertJob.run(
      JOB_ID,
      "https://boards.greenhouse.io/acme/jobs/1",
      "Explicit company",
      "Acme",
    );
    insertJob.run(
      UNKNOWN_COMPANY_JOB_ID,
      "https://boards.greenhouse.io/fabricated-company/jobs/2",
      "Missing company",
      null,
    );

    refreshProjections(db, "local");
    expect(
      db
        .prepare(
          `SELECT job_id, employer, source
             FROM job_list_projections
            WHERE tenant_id = 'local'
            ORDER BY job_id`,
        )
        .all(),
    ).toEqual([
      { job_id: JOB_ID, employer: "Acme", source: "greenhouse" },
      { job_id: UNKNOWN_COMPANY_JOB_ID, employer: "Unknown company", source: "greenhouse" },
    ]);
    db.close();
  });
});
