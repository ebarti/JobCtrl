import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { JobListQuery } from "../src/contracts.js";
import {
  buildDashboardSummary,
  getJobDetail,
  listActivity,
  listJobs,
} from "../src/read-model.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { EXACT_V7_SCHEMA_MANIFEST, schemaManifest } from "../src/schema-manifest.js";
import { hideJob, restoreJob, softDeleteJob, unhideJob } from "../src/write-model.js";
import { initializeExactV7Database } from "./v7-schema.js";

const JOB_ID = "00000000-0000-4000-8000-000000000081";
const HIDDEN_JOB_ID = "00000000-0000-4000-8000-000000000082";
const DELETED_JOB_ID = "00000000-0000-4000-8000-000000000083";
const OTHER_TENANT = "other";
const JOB_URL = "https://jobs.example.test/read-model";
const APPLICATION_URL = "https://apply.example.test/read-model";
const SOURCE_URL = "https://source.example.test/read-model";
const NOW = "2026-07-31T12:00:00Z";
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function seededDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-read-model-v7-"));
  const dbPath = path.join(dir, "jobs.db");
  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  seedBuiltInTemplate(db);
  insertJob(db, "local", JOB_ID, JOB_URL, "Local exact-v7 job", APPLICATION_URL);
  insertJob(db, OTHER_TENANT, JOB_ID, "https://jobs.example.test/other", "Other tenant job", "https://apply.example.test/other");
  insertJob(db, "local", HIDDEN_JOB_ID, "https://jobs.example.test/hidden", "Hidden job", "https://apply.example.test/hidden");
  insertJob(db, "local", DELETED_JOB_ID, "https://jobs.example.test/deleted", "Deleted job", "https://apply.example.test/deleted");

  db.prepare(
    `INSERT INTO job_source_observations (
       tenant_id, source_observation_id, job_id, source_id, source_native_id,
       observed_url, normalized_observed_url, observed_at
     ) VALUES ('local', 'local-source', ?, 'source:local', 'local-1', ?, ?, ?)`,
  ).run(JOB_ID, SOURCE_URL, SOURCE_URL, NOW);
  db.prepare(
    `INSERT INTO job_canonical_identities (
       tenant_id, job_id, canonical_url, ats_kind, source_native_id, confidence, resolved_at
     ) VALUES ('local', ?, ?, 'greenhouse', 'local-1', 1, ?)`,
  ).run(JOB_ID, SOURCE_URL, NOW);
  db.prepare(
    `INSERT INTO job_locators (
       tenant_id, job_id, locator_kind, locator_value, is_current, first_seen_at, last_seen_at
     ) VALUES ('local', ?, 'posting_url', ?, 1, ?, ?)`,
  ).run(JOB_ID, SOURCE_URL, NOW, NOW);
  db.prepare(
    `INSERT INTO job_stage_states (
       tenant_id, job_id, stage, state, updated_at, retryable, version
     ) VALUES ('local', ?, 'score', 'failed', ?, 0, 1)`,
  ).run(JOB_ID, NOW);
  db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, occurred_at, payload_json
     ) VALUES ('local', ?, 1, 'score', 'StageFailed', ?, '{"retryable":false}')`,
  ).run(JOB_ID, NOW);
  db.prepare(
    `INSERT INTO job_materials (
       tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
     ) VALUES ('local', ?, 1, 'resume_approved', ?, ?, '{}')`,
  ).run(JOB_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       tenant_id, job_id, generation, artifact_type, artifact_id, status, path, render_format,
       size_bytes, metadata_json, created_at
     ) VALUES ('local', ?, 1, 'tailored_resume', 'resume-local', 'approved', ?, 'pdf', 12, '{}', ?)`,
  ).run(JOB_ID, path.join(os.tmpdir(), "missing-read-model-v7.pdf"), NOW);
  db.prepare(
    `INSERT INTO application_review_decisions (
       tenant_id, decision_id, job_id, decision, reason, decided_by, decided_at
     ) VALUES ('local', 'local-review', ?, 'approved', 'because', 'user', ?)`,
  ).run(JOB_ID, NOW);
  db.prepare(
    `INSERT INTO application_outcomes (
       tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at
     ) VALUES ('local', 'local-outcome', ?, 'interview', 'manual', ?, ?)`,
  ).run(JOB_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO application_outcome_suggestions (
       tenant_id, suggestion_id, job_id, suggested_kind, confidence, rationale, status, created_at
     ) VALUES ('local', 'local-suggestion', ?, 'offer', 0.9, 'private rationale', 'pending', ?)`,
  ).run(JOB_ID, NOW);
  db.prepare(
    `INSERT INTO application_outcomes (
       tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at
     ) VALUES (?, 'other-outcome', ?, 'rejection', 'manual', ?, ?)`,
  ).run(OTHER_TENANT, JOB_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO jobctrl_hidden_jobs (tenant_id, job_id, hidden_at)
     VALUES ('local', ?, ?)`,
  ).run(HIDDEN_JOB_ID, NOW);
  db.prepare(
    `INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at)
     VALUES ('local', ?, ?)`,
  ).run(DELETED_JOB_ID, NOW);
  return db;
}

function insertJob(
  db: Database.Database,
  tenantId: string,
  jobId: string,
  url: string,
  title: string,
  applicationUrl: string,
): void {
  db.prepare(
    `INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at, application_url)
     VALUES (?, ?, ?, ?, 'Example', 'example', ?, ?)`,
  ).run(tenantId, jobId, url, title, NOW, applicationUrl);
  db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, occurred_at
     ) VALUES (?, ?, 1, 'discover', 'JobDiscovered', ?)`,
  ).run(tenantId, jobId, NOW);
}

function seedBuiltInTemplate(db: Database.Database): void {
  db.prepare(
    `INSERT INTO resume_templates (
       tenant_id, template_id, display_name, status, built_in, created_at, updated_at
     ) VALUES ('local', 'built_in:modern-html', 'Modern HTML', 'active', 1, ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO resume_template_versions (
       tenant_id, version_id, template_id, version_number, display_name, status,
       theme_json, layout_json, content_hash, created_at
     ) VALUES ('local', 'built_in:modern-html:v1', 'built_in:modern-html', 1,
               'Modern HTML', 'active', ?, '{}', 'seed-hash', ?)`,
  ).run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME), NOW);
}

const activeJobQuery: JobListQuery = {
  page: 1,
  pageSize: 50,
  q: "",
  sort: "discovered_at",
  dir: "desc",
  deleted: "active",
  applyStatus: "all",
  source: "",
  company: "",
  discoveredSince: undefined,
  scoredSince: undefined,
};

describe("exact-v7 read model job ids", () => {
  it("keeps same-UUID tenants isolated while preserving URL locators and material/template state", () => {
    const db = seededDatabase();
    const before = schemaManifest(db, EXACT_V7_SCHEMA_MANIFEST.version);

    const jobs = listJobs(db, activeJobQuery);
    const detail = getJobDetail(db, JOB_ID);
    const byPostingUrl = getJobDetail(db, SOURCE_URL);
    const dashboard = buildDashboardSummary(db);

    expect(jobs.items.map((job) => job.jobKey)).toEqual([JOB_ID]);
    expect(jobs.items[0]).toMatchObject({
      jobKey: JOB_ID,
      url: JOB_URL,
      applicationUrl: APPLICATION_URL,
      postingSourceUrl: SOURCE_URL,
    });
    expect(detail?.job.url).toBe(JOB_URL);
    expect(byPostingUrl?.job.jobKey).toBe(JOB_ID);
    expect(detail?.artifacts).toEqual([
      expect.objectContaining({ artifactId: "resume-local", jobKey: JOB_ID, resumeTemplate: expect.any(Object) }),
    ]);
    expect(detail?.job.resumeTemplate).toEqual(expect.any(Object));
    expect(detail?.stages.find((stage) => stage.stage === "score")).toMatchObject({ retryable: false });
    expect(dashboard.totals.jobs).toBe(1);
    expect(schemaManifest(db, EXACT_V7_SCHEMA_MANIFEST.version)).toEqual(before);
  });

  it("filters hidden and deleted jobs and uses only tenant-scoped events and audit rows", () => {
    const db = seededDatabase();

    const detail = getJobDetail(db, JOB_ID);
    const activity = listActivity(db, {
      page: 1,
      pageSize: 50,
      q: "",
      sort: "occurred_at",
      dir: "desc",
      level: "",
      stage: "",
      eventType: "",
    });

    expect(listJobs(db, { ...activeJobQuery, deleted: "hidden" }).items.map((job) => job.jobKey)).toEqual([
      HIDDEN_JOB_ID,
    ]);
    expect(listJobs(db, { ...activeJobQuery, deleted: "deleted" }).items.map((job) => job.jobKey)).toEqual([
      DELETED_JOB_ID,
    ]);
    expect(detail?.auditHistory.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["review:local-review", "outcome:local-outcome", "suggestion:local-suggestion"]),
    );
    expect(detail?.auditHistory.map((entry) => entry.id)).not.toContain("outcome:other-outcome");
    expect(activity.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ jobKey: JOB_ID, eventType: "StageFailed" })]),
    );
    expect(activity.items.some((item) => item.jobKey === HIDDEN_JOB_ID || item.jobKey === DELETED_JOB_ID)).toBe(false);
    expect(getJobDetail(db, "not-a-canonical-job-id")).toBeNull();
  });

  it("resolves URL locators once and writes reversible lifecycle state with canonical job ids", () => {
    const db = seededDatabase();

    expect(softDeleteJob(db, JOB_URL, { reason: "not relevant" })).toMatchObject({
      ok: true,
      count: 1,
      jobKeys: [JOB_ID],
    });
    expect(
      db.prepare("SELECT tenant_id, job_id, reason, restored_at FROM jobctrl_deleted_jobs WHERE tenant_id = 'local' AND job_id = ?").get(JOB_ID),
    ).toMatchObject({ tenant_id: "local", job_id: JOB_ID, reason: "not relevant", restored_at: null });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM jobctrl_deleted_jobs WHERE tenant_id = ? AND job_id = ?").get(OTHER_TENANT, JOB_ID),
    ).toMatchObject({ count: 0 });

    expect(restoreJob(db, APPLICATION_URL)).toMatchObject({ ok: true, count: 1, jobKeys: [JOB_ID] });
    expect(
      db.prepare("SELECT restored_at FROM jobctrl_deleted_jobs WHERE tenant_id = 'local' AND job_id = ?").get(JOB_ID),
    ).toMatchObject({ restored_at: expect.any(String) });

    expect(hideJob(db, SOURCE_URL, { reason: "later" })).toMatchObject({
      ok: true,
      count: 1,
      jobKeys: [JOB_ID],
    });
    expect(unhideJob(db, JOB_ID)).toMatchObject({ ok: true, count: 1, jobKeys: [JOB_ID] });
    expect(
      db.prepare("SELECT unhidden_at FROM jobctrl_hidden_jobs WHERE tenant_id = 'local' AND job_id = ?").get(JOB_ID),
    ).toMatchObject({ unhidden_at: expect.any(String) });

    const lifecycleEvents = db
      .prepare(
        `SELECT tenant_id, job_id, identity_version, event_type, payload_json
           FROM job_events
          WHERE tenant_id = 'local'
            AND job_id = ?
            AND event_type IN ('JobDeleted', 'JobRestored', 'JobHidden', 'JobUnhidden')
          ORDER BY event_id`,
      )
      .all(JOB_ID) as Array<{
        tenant_id: string;
        job_id: string;
        identity_version: number;
        event_type: string;
        payload_json: string;
      }>;
    expect(lifecycleEvents.map((event) => event.event_type)).toEqual([
      "JobDeleted",
      "JobRestored",
      "JobHidden",
      "JobUnhidden",
    ]);
    expect(lifecycleEvents.every((event) => event.tenant_id === "local" && event.job_id === JOB_ID)).toBe(true);
    expect(lifecycleEvents.every((event) => event.identity_version === 1)).toBe(true);
    expect(lifecycleEvents.map((event) => JSON.parse(event.payload_json))).toEqual(
      expect.arrayContaining([expect.objectContaining({ tenantId: "local", jobId: JOB_ID })]),
    );
    expect(JSON.stringify(lifecycleEvents)).not.toContain("job_url");
  });
});
