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
});
