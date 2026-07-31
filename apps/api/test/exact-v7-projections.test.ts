import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { refreshProjections } from "../src/projections.js";
import { EXACT_V7_SCHEMA_MANIFEST, schemaManifest } from "../src/schema-manifest.js";
import { initializeExactV7Database } from "./v7-schema.js";

const JOB_ID = "00000000-0000-4000-8000-000000000071";
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
    const before = schemaManifest(db, EXACT_V7_SCHEMA_MANIFEST.version);
    expect(before).toEqual(EXACT_V7_SCHEMA_MANIFEST);

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
    expect(schemaManifest(db, EXACT_V7_SCHEMA_MANIFEST.version)).toEqual(before);
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
});
