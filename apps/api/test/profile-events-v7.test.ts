import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { recordProfileUpdatedEvent } from "../src/profile-events.js";
import { initializeExactDatabase } from "./exact-schema.js";

const JOB_ID = "00000000-0000-4000-8000-000000000091";
const NOW = "2026-07-31T13:00:00Z";
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function exactDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-profile-events-v7-"));
  const dbPath = path.join(dir, "jobs.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

describe("exact-v7 profile events", () => {
  it("records profile audit events without altering accepted material rows", () => {
    const db = exactDatabase();

    db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, tailored_resume_path)
       VALUES ('local', ?, 'https://example.com/jobs/profile-events', '/legacy/resume.pdf')`,
    ).run(JOB_ID);

    db.prepare(
      `INSERT INTO job_materials (
         tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
       ) VALUES ('local', ?, 1, 'resume_approved', ?, ?, '{}')`,
    ).run(JOB_ID, NOW, NOW);
    db.prepare(
      `INSERT INTO job_materials_artifacts (
         tenant_id, job_id, generation, artifact_type, artifact_id, status,
         path, render_format, metadata_json, created_at
       ) VALUES ('local', ?, 1, 'tailored_resume', 'profile-resume', 'approved',
                 '/canonical/resume.pdf', 'pdf', '{}', ?)`,
    ).run(JOB_ID, NOW);
    const before = db.prepare("SELECT * FROM job_materials_artifacts").all();

    const event = recordProfileUpdatedEvent(db, ["resume", "preferences"], NOW);
    expect(event).toMatchObject({
      eventId: expect.any(Number),
      event: { tenantId: "local", eventType: "ProfileUpdated" },
    });
    const row = db
      .prepare(
        `SELECT tenant_id, job_id, identity_version, stage, event_type, payload_json
           FROM job_events
          WHERE event_type = 'ProfileUpdated'`,
      )
      .get() as {
      tenant_id: string;
      job_id: string | null;
      identity_version: number;
      stage: string | null;
      event_type: string;
      payload_json: string;
    };
    expect(row).toMatchObject({
      tenant_id: "local",
      job_id: null,
      identity_version: 1,
      stage: null,
      event_type: "ProfileUpdated",
    });
    expect(JSON.parse(row.payload_json)).toMatchObject({
      tenantId: "local",
      changedSections: ["resume", "preferences"],
    });
    expect(JSON.stringify(row)).not.toContain("job_url");
    expect(db.prepare("SELECT * FROM job_materials_artifacts").all()).toEqual(before);
  });
});
