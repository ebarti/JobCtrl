import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db.js";
import { rebuildTenantDeleteProjections } from "../src/projections.js";
import { schemaManifest, EXACT_V9_SCHEMA_MANIFEST } from "../src/schema-manifest.js";
import { permanentlyDeleteJob } from "../src/write-model.js";
import { initializeExactV7Database } from "./v7-schema.js";

const JOB_ID = "00000000-0000-4000-8000-0000000000d1";
const ANCHOR_JOB_ID = "00000000-0000-4000-8000-0000000000d2";
const REDISCOVERED_JOB_ID = "00000000-0000-4000-8000-0000000000d3";
const OTHER_TENANT = "other";
const JOB_URL = "https://jobs.example.test/permanent-delete";
const SOURCE_URL = "https://source.example.test/permanent-delete";
const NOW = "2026-07-31T15:00:00Z";
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function exactDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-permanent-delete-v7-"));
  const dbPath = path.join(dir, "jobs.db");
  initializeExactV7Database(dbPath);
  const db = openDatabase(dbPath);
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function insertJob(db: Database.Database, tenantId: string, jobId: string, url: string): void {
  db.prepare(
    `INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at, application_url)
     VALUES (?, ?, ?, ?, 'Example', 'example', ?, ?)`,
  ).run(tenantId, jobId, url, `Job ${jobId.slice(-3)}`, NOW, `${url}/apply`);
}

function countRows(db: Database.Database, tableName: string, whereSql: string, params: unknown[] = []): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${whereSql}`).get(...params) as {
    count: number;
  };
  return Number(row.count);
}

function rowSnapshot(db: Database.Database, tableName: string, whereSql: string, params: unknown[] = []): unknown[] {
  return db.prepare(`SELECT * FROM ${tableName} WHERE ${whereSql} ORDER BY rowid`).all(...params);
}

function seedExactV7DeleteGraph(db: Database.Database): void {
  insertJob(db, "local", JOB_ID, JOB_URL);
  insertJob(db, "local", ANCHOR_JOB_ID, "https://jobs.example.test/permanent-delete-anchor");
  insertJob(db, OTHER_TENANT, JOB_ID, "https://jobs.example.test/permanent-delete-other");

  const insertLocator = db.prepare(
    `INSERT INTO job_locators (
       tenant_id, job_id, locator_kind, locator_value, is_current, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
  );
  insertLocator.run("local", JOB_ID, "posting_url", JOB_URL, NOW, NOW);
  insertLocator.run(OTHER_TENANT, JOB_ID, "posting_url", "https://jobs.example.test/permanent-delete-other", NOW, NOW);
  db.prepare(
    `INSERT INTO job_canonical_identities (
       tenant_id, job_id, canonical_url, ats_kind, source_native_id, confidence, resolved_at
     ) VALUES ('local', ?, ?, 'greenhouse', 'permanent-delete', 1, ?)`,
  ).run(JOB_ID, SOURCE_URL, NOW);
  db.prepare(
    `INSERT INTO job_source_observations (
       tenant_id, source_observation_id, job_id, source_id, source_native_id,
       observed_url, normalized_observed_url, observed_at
     ) VALUES ('local', 'source-observation-1', ?, 'example', 'permanent-delete', ?, ?, ?)`,
  ).run(JOB_ID, SOURCE_URL, SOURCE_URL, NOW);

  db.prepare(
    `INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at, reason)
     VALUES ('local', ?, ?, 'test tombstone')`,
  ).run(JOB_ID, NOW);
  db.prepare(
    `INSERT INTO jobctrl_hidden_jobs (tenant_id, job_id, hidden_at, reason)
     VALUES ('local', ?, ?, 'test suppression')`,
  ).run(JOB_ID, NOW);
  db.prepare(
    `INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at)
     VALUES ('local', ?, 'apply', 'failed', ?)`,
  ).run(JOB_ID, NOW);
  db.prepare(
    `INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, occurred_at)
     VALUES ('local', ?, 1, 'apply', 'StageFailed', ?)`,
  ).run(JOB_ID, NOW);
  const insertIndependentEvent = db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, occurred_at,
       payload_json, entity_kind, entity_ref
     ) VALUES ('local', ?, 1, NULL, ?, ?, ?, ?, ?)`,
  );
  insertIndependentEvent.run(
    JOB_ID,
    "ContactTimelineRecorded",
    NOW,
    JSON.stringify({ jobId: JOB_ID, nested: { jobId: JOB_ID }, note: "contact audit" }),
    "contact",
    "contact-1",
  );
  insertIndependentEvent.run(
    JOB_ID,
    "ContactResearchCompleted",
    NOW,
    JSON.stringify({ jobId: JOB_ID, taskId: "research-1", note: "research audit" }),
    "contact_research",
    "research-1",
  );
  insertIndependentEvent.run(
    JOB_ID,
    "OutreachDrafted",
    NOW,
    JSON.stringify({ jobId: ANCHOR_JOB_ID, threadId: "thread-1", note: "outreach audit" }),
    "outreach",
    "thread-1",
  );
  db.prepare(
    `INSERT INTO application_email_evidence (
       tenant_id, evidence_id, job_id, provider, provider_message_id, to_addresses_json, linked_at, body_text
     ) VALUES ('local', 'private-email', ?, 'gmail', 'msg-private', '[]', ?, 'private email body')`,
  ).run(JOB_ID, NOW);
  db.prepare(
    `INSERT INTO application_outcomes (
       tenant_id, outcome_id, job_id, kind, source, note, occurred_at, recorded_at
     ) VALUES ('local', 'private-outcome', ?, 'interview', 'manual', 'private outcome note', ?, ?)`,
  ).run(JOB_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO job_materials (
       tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
     ) VALUES ('local', ?, 1, 'resume_approved', ?, ?, '{"private":true}')`,
  ).run(JOB_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       tenant_id, job_id, generation, artifact_type, artifact_id, status, path, render_format, metadata_json, created_at
     ) VALUES ('local', ?, 1, 'tailored_resume', 'private-artifact', 'approved', '/private/resume.pdf', 'pdf', '{}', ?)`,
  ).run(JOB_ID, NOW);

  db.prepare(
    `INSERT INTO job_duplicate_links (
       tenant_id, duplicate_link_id, surviving_job_id, superseded_job_or_observation_id, reason, confidence, linked_at
     ) VALUES ('local', 'target-survives', ?, 'old-observation', 'same posting', 1, ?)`,
  ).run(JOB_ID, NOW);
  db.prepare(
    `INSERT INTO job_duplicate_links (
       tenant_id, duplicate_link_id, surviving_job_id, superseded_job_or_observation_id, reason, confidence, linked_at
     ) VALUES ('local', 'target-superseded', ?, ?, 'same posting', 1, ?)`,
  ).run(ANCHOR_JOB_ID, JOB_ID, NOW);
  db.prepare(
    `INSERT INTO job_rejected_duplicate_links (
       tenant_id, owner_job_id, candidate_url, reason, rejected_at
     ) VALUES ('local', ?, ?, 'rejected candidate', ?)`,
  ).run(ANCHOR_JOB_ID, SOURCE_URL, NOW);

  db.prepare(
    `INSERT INTO application_repeat_overrides (
       tenant_id, override_id, target_job_id, prior_job_id, relationship,
       evidence_fingerprint, evidence_json, reason, confirmed_by, confirmed_at
     ) VALUES ('local', 'repeat-cross', ?, ?, 'same employer', 'repeat-fingerprint', ?, 'test', 'user', ?)`,
  ).run(ANCHOR_JOB_ID, JOB_ID, JSON.stringify({ priorJobId: JOB_ID }), NOW);
  db.prepare(
    `INSERT INTO application_repeat_override_consumptions (tenant_id, override_id, run_id, consumed_at)
     VALUES ('local', 'repeat-cross', 'repeat-run', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO application_repeat_audit (
       tenant_id, audit_id, audit_key, target_job_id, action, evidence_fingerprint,
       evidence_json, override_id, actor, occurred_at
     ) VALUES ('local', 'repeat-audit', 'repeat-audit-key', ?, 'override_confirmed',
               'repeat-fingerprint', ?, 'repeat-cross', 'user', ?)`,
  ).run(ANCHOR_JOB_ID, JSON.stringify([{ priorApplication: { jobId: JOB_ID } }]), NOW);
  db.prepare(
    `INSERT INTO application_repeat_audit (
       tenant_id, audit_id, audit_key, target_job_id, action, evidence_fingerprint,
       evidence_json, override_id, actor, occurred_at
     ) VALUES ('local', 'repeat-audit-payload', 'repeat-audit-payload-key', ?, 'blocked',
               'repeat-payload', ?, NULL, 'system', ?)`,
  ).run(
    ANCHOR_JOB_ID,
    JSON.stringify([{ priorApplication: { jobId: JOB_ID, title: "Previous role" } }]),
    NOW,
  );
  db.prepare(
    `INSERT INTO application_repeat_audit (
       tenant_id, audit_id, audit_key, target_job_id, action, evidence_fingerprint,
       evidence_json, override_id, actor, occurred_at
     ) VALUES ('local', 'repeat-audit-near-match', 'repeat-audit-near-match-key', ?, 'allowed',
               'repeat-near-match', ?, NULL, 'system', ?)`,
  ).run(
    ANCHOR_JOB_ID,
    JSON.stringify([{ priorApplication: { jobId: ANCHOR_JOB_ID, title: JOB_ID }, note: JOB_ID }]),
    NOW,
  );

  db.prepare(
    `INSERT INTO contacts (tenant_id, contact_id, employer, job_id, role, created_at, updated_at)
     VALUES ('local', 'contact-1', 'Example', ?, 'recruiter', ?, ?)`,
  ).run(JOB_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO contact_attributes (
       tenant_id, attribute_id, contact_id, attribute_kind, source_kind, source_ref, capture_method, recorded_at
     ) VALUES ('local', 'attribute-1', 'contact-1', 'email', 'user_entered', 'manual', 'manual', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO contact_research_tasks (
       tenant_id, task_id, employer, job_id, status, source_attempts_json, updated_at
     ) VALUES ('local', 'research-1', 'Example', ?, 'completed', '[]', ?)`,
  ).run(JOB_ID, NOW);
  db.prepare(
    `INSERT INTO contact_candidates (
       tenant_id, candidate_id, task_id, source_kind, source_ref, capture_method, proposed_at
     ) VALUES ('local', 'candidate-1', 'research-1', 'public_web_page', 'https://example.test', 'manual', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO outreach_threads (tenant_id, thread_id, contact_id, job_id, created_at, updated_at)
     VALUES ('local', 'thread-1', 'contact-1', ?, ?, ?)`,
  ).run(JOB_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO outreach_drafts (tenant_id, draft_id, thread_id, kind, body_text, created_at)
     VALUES ('local', 'draft-1', 'thread-1', 'initial', 'reviewable draft', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO outreach_send_logs (tenant_id, send_log_id, thread_id, draft_id, channel, sent_at, logged_at)
     VALUES ('local', 'send-1', 'thread-1', 'draft-1', 'email', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO operational_attempt_metrics (tenant_id, occurred_at, stage, attempt_kind, outcome, job_id)
     VALUES ('local', ?, 'discover', 'fetch', 'succeeded', ?)`,
  ).run(NOW, JOB_ID);

  for (const [tableName, idColumn, idValue] of [
    ["contact_projections", "contact_id", "contact-1"],
    ["contact_research_task_projections", "task_id", "research-1"],
  ] as const) {
    db.prepare(`INSERT INTO ${tableName} (tenant_id, ${idColumn}, job_id) VALUES ('local', ?, ?)`).run(idValue, JOB_ID);
  }
  for (const tableName of ["outreach_thread_projections", "due_follow_up_projections"]) {
    db.prepare(`INSERT INTO ${tableName} (tenant_id, thread_id, contact_id, job_id) VALUES ('local', 'thread-1', 'contact-1', ?)`).run(JOB_ID);
  }

  db.prepare(`INSERT INTO apply_run_projections (run_id, tenant_id, job_id) VALUES ('apply-target', 'local', ?)`).run(JOB_ID);
  db.prepare(`INSERT INTO artifact_list_projections (artifact_id, tenant_id, job_id) VALUES ('artifact-target', 'local', ?)`).run(JOB_ID);
  db.prepare(`INSERT INTO job_list_projections (tenant_id, job_id) VALUES ('local', ?), ('local', ?)`).run(JOB_ID, ANCHOR_JOB_ID);
  db.prepare(`INSERT INTO job_detail_projections (tenant_id, job_id) VALUES ('local', ?), ('local', ?)`).run(JOB_ID, ANCHOR_JOB_ID);
  db.prepare(`INSERT INTO evidence_usage_projections (tenant_id, projection_kind, projection_id, title, payload_json)
              VALUES ('local', 'entry', 'stale-target', 'stale target', '{}'), (?, 'entry', 'other-evidence', 'other evidence', '{}')`).run(OTHER_TENANT);
  db.prepare(`INSERT INTO dashboard_projections (tenant_id, total_jobs, generated_at) VALUES ('local', 2, ?), (?, 1, ?)`).run(NOW, OTHER_TENANT, NOW);
  for (const projectionName of [
    "operations_projections", "operations_projections:python:local", "operations_projections:typescript:local",
  ]) {
    db.prepare(`INSERT INTO event_watermarks (projection_name, last_event_id, updated_at) VALUES (?, 999, ?)`).run(projectionName, NOW);
  }
}

describe("exact-v7 permanent job deletion", () => {
  it("purges only the local Job aggregate, preserves independent history, and permits rediscovery", () => {
    const db = exactDatabase();
    seedExactV7DeleteGraph(db);
    const manifestBefore = schemaManifest(db, EXACT_V9_SCHEMA_MANIFEST.version);
    const otherJobsBefore = rowSnapshot(db, "jobs", "tenant_id = ? AND job_id = ?", [OTHER_TENANT, JOB_ID]);
    const otherLocatorsBefore = rowSnapshot(db, "job_locators", "tenant_id = ? AND job_id = ?", [OTHER_TENANT, JOB_ID]);
    const otherEvidenceBefore = rowSnapshot(db, "evidence_usage_projections", "tenant_id = ?", [OTHER_TENANT]);
    const otherDashboardBefore = rowSnapshot(db, "dashboard_projections", "tenant_id = ?", [OTHER_TENANT]);

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(permanentlyDeleteJob(db, JOB_URL)).toEqual({ ok: true, count: 1, jobKeys: [JOB_ID] });

    for (const tableName of [
      "jobs",
      "job_locators",
      "jobctrl_deleted_jobs",
      "jobctrl_hidden_jobs",
      "job_stage_states",
      "job_materials",
      "job_materials_artifacts",
      "application_email_evidence",
      "application_outcomes",
      "apply_run_projections",
      "artifact_list_projections",
      "job_detail_projections",
      "job_list_projections",
    ]) {
      expect(countRows(db, tableName, "tenant_id = ? AND job_id = ?", ["local", JOB_ID])).toBe(0);
    }
    expect(countRows(db, "job_events", "tenant_id = ? AND job_id = ?", ["local", JOB_ID])).toBe(0);
    const detachedEvents = db.prepare(
      `SELECT job_id, event_type, payload_json, entity_kind, entity_ref
         FROM job_events
        WHERE tenant_id = 'local'
          AND entity_kind IN ('contact', 'contact_research', 'outreach')
        ORDER BY entity_kind`,
    ).all() as Array<{
      job_id: string | null;
      event_type: string;
      payload_json: string | null;
      entity_kind: string;
      entity_ref: string | null;
    }>;
    expect(detachedEvents).toEqual([
      expect.objectContaining({
        job_id: null,
        event_type: "ContactTimelineRecorded",
        entity_kind: "contact",
        entity_ref: "contact-1",
      }),
      expect.objectContaining({
        job_id: null,
        event_type: "ContactResearchCompleted",
        entity_kind: "contact_research",
        entity_ref: "research-1",
      }),
      expect.objectContaining({
        job_id: null,
        event_type: "OutreachDrafted",
        entity_kind: "outreach",
        entity_ref: "thread-1",
      }),
    ]);
    expect(JSON.parse(detachedEvents[0]!.payload_json!)).toEqual({ nested: { jobId: JOB_ID }, note: "contact audit" });
    expect(JSON.parse(detachedEvents[1]!.payload_json!)).toEqual({ taskId: "research-1", note: "research audit" });
    expect(JSON.parse(detachedEvents[2]!.payload_json!)).toEqual({
      jobId: ANCHOR_JOB_ID,
      threadId: "thread-1",
      note: "outreach audit",
    });
    expect(countRows(db, "job_duplicate_links", "tenant_id = ? AND (surviving_job_id = ? OR superseded_job_or_observation_id = ?)", ["local", JOB_ID, JOB_ID])).toBe(0);
    expect(countRows(db, "job_rejected_duplicate_links", "tenant_id = ? AND candidate_url = ?", ["local", SOURCE_URL])).toBe(0);
    expect(countRows(db, "application_repeat_override_consumptions", "tenant_id = ? AND override_id = ?", ["local", "repeat-cross"])).toBe(0);
    expect(countRows(db, "application_repeat_audit", "tenant_id = ? AND audit_id = ?", ["local", "repeat-audit"])).toBe(0);
    expect(countRows(db, "application_repeat_audit", "tenant_id = ? AND audit_id = ?", ["local", "repeat-audit-payload"])).toBe(0);
    expect(countRows(db, "application_repeat_audit", "tenant_id = ? AND audit_id = ?", ["local", "repeat-audit-near-match"])).toBe(1);

    for (const tableName of ["contacts", "contact_research_tasks", "outreach_threads", "operational_attempt_metrics"]) {
      expect(rowSnapshot(db, tableName, "tenant_id = 'local'")).toEqual(
        expect.arrayContaining([expect.objectContaining({ job_id: null })]),
      );
    }
    for (const tableName of [
      "contact_projections",
      "contact_research_task_projections",
      "outreach_thread_projections",
      "due_follow_up_projections",
    ]) {
      expect(rowSnapshot(db, tableName, "tenant_id = 'local'")).toEqual(
        expect.arrayContaining([expect.objectContaining({ job_id: null })]),
      );
    }
    for (const tableName of ["contact_attributes", "contact_candidates", "outreach_drafts", "outreach_send_logs"]) {
      expect(countRows(db, tableName, "tenant_id = 'local'")).toBe(1);
    }

    expect(db.prepare("SELECT total_jobs FROM dashboard_projections WHERE tenant_id = 'local'").get()).toEqual({ total_jobs: 1 });
    expect(countRows(db, "evidence_usage_projections", "tenant_id = 'local'")).toBe(0);
    for (const projectionName of [
      "operations_projections", "operations_projections:python:local", "operations_projections:typescript:local",
    ]) {
      expect(rowSnapshot(db, "event_watermarks", "projection_name = ?", [projectionName])).toEqual([
        expect.objectContaining({ last_event_id: 999, updated_at: NOW }),
      ]);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(schemaManifest(db, EXACT_V9_SCHEMA_MANIFEST.version)).toEqual(manifestBefore);

    expect(rowSnapshot(db, "jobs", "tenant_id = ? AND job_id = ?", [OTHER_TENANT, JOB_ID])).toEqual(otherJobsBefore);
    expect(rowSnapshot(db, "job_locators", "tenant_id = ? AND job_id = ?", [OTHER_TENANT, JOB_ID])).toEqual(otherLocatorsBefore);
    expect(rowSnapshot(db, "evidence_usage_projections", "tenant_id = ?", [OTHER_TENANT])).toEqual(otherEvidenceBefore);
    expect(rowSnapshot(db, "dashboard_projections", "tenant_id = ?", [OTHER_TENANT])).toEqual(otherDashboardBefore);

    insertJob(db, "local", REDISCOVERED_JOB_ID, JOB_URL);
    db.prepare(
      `INSERT INTO job_locators (
         tenant_id, job_id, locator_kind, locator_value, is_current, first_seen_at, last_seen_at
       ) VALUES ('local', ?, 'posting_url', ?, 1, ?, ?)`,
    ).run(REDISCOVERED_JOB_ID, SOURCE_URL, NOW, NOW);
    expect(db.prepare("SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?").get(JOB_URL)).toEqual({
      job_id: REDISCOVERED_JOB_ID,
    });

    rebuildTenantDeleteProjections(db, "local");
    expect(db.prepare("SELECT total_jobs FROM dashboard_projections WHERE tenant_id = 'local'").get()).toEqual({ total_jobs: 1 });
  });
});
