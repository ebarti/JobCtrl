import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDiscoveryControlTables,
} from "../src/discovery-controls.js";
import { buildApp } from "../src/server.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

const NOW = "2026-07-30T12:00:00.000Z";
const UUID_SHAPED_URL =
  "11111111-1111-4111-8111-111111111111";
const TARGET_JOB_ID =
  "22222222-2222-4222-8222-222222222222";

let db: Database.Database | undefined;
let cleanup: (() => void) | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  cleanup?.();
  cleanup = undefined;
});

function createDatabase(
  schemaVersion = 26,
  foreignKeys = true,
): {
  db: Database.Database;
  dbPath: string;
  dir: string;
} {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-discovery-feedback-v26-"),
  );
  const dbPath = path.join(dir, "jobs.db");
  const opened = new Database(dbPath);
  opened.pragma(
    `foreign_keys = ${foreignKeys ? "ON" : "OFF"}`,
  );
  opened.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
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
      apply_attempts INTEGER DEFAULT 0,
      agent_id TEXT,
      last_attempted_at TEXT,
      apply_duration_ms INTEGER,
      apply_task_id TEXT,
      verification_confidence TEXT,
      UNIQUE (tenant_id, job_id)
    );
    CREATE TABLE job_identity_aliases (
      tenant_id TEXT NOT NULL,
      alias_kind TEXT NOT NULL,
      alias_value TEXT NOT NULL,
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retired_at TEXT,
      PRIMARY KEY (tenant_id, alias_kind, alias_value)
    );
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      stage TEXT,
      event_type TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT,
      entity_kind TEXT,
      entity_ref TEXT
    );
    PRAGMA user_version = ${schemaVersion};
  `);
  cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db: opened, dbPath, dir };
}

function insertJob(
  opened: Database.Database,
  url: string,
  jobId: string,
): void {
  opened.prepare(
    `INSERT INTO jobs (
       url, tenant_id, job_id, title, company, discovered_at
     ) VALUES (?, 'local', ?, 'Platform Engineer', 'ExampleCo', ?)`,
  ).run(url, jobId, NOW);
}

describe("schema-v26 Discovery feedback references", () => {
  it("stores a URL-first stable JobId while preserving the URL event boundary", async () => {
    const created = createDatabase();
    db = created.db;
    insertJob(db, UUID_SHAPED_URL, TARGET_JOB_ID);
    insertJob(
      db,
      "https://careers.example.test/uuid-id-owner",
      UUID_SHAPED_URL,
    );
    db.close();
    db = undefined;

    const app = buildApp({
      dbPath: created.dbPath,
      configPath: path.join(created.dir, "config.json"),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/discovery/feedback",
        payload: {
          jobKey: UUID_SHAPED_URL,
          sourceId: "source:one",
          kind: "bad_source",
          note: "private reviewer note",
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        jobKey: UUID_SHAPED_URL,
        sourceId: "source:one",
        kind: "bad_source",
      });

      db = new Database(created.dbPath);
      const stored = db
        .prepare(
          `SELECT job_id, note
             FROM discovery_feedback`,
        )
        .get() as {
        job_id: string;
        note: string;
      };
      expect(stored).toEqual({
        job_id: TARGET_JOB_ID,
        note: "private reviewer note",
      });
      const event = db
        .prepare(
          `SELECT job_url, payload_json
             FROM job_events
            WHERE event_type = 'DiscoveryFeedbackRecorded'`,
        )
        .get() as {
        job_url: string;
        payload_json: string;
      };
      expect(event.job_url).toBe(UUID_SHAPED_URL);
      expect(JSON.parse(event.payload_json)).toMatchObject({
        jobId: UUID_SHAPED_URL,
        sourceId: "source:one",
        kind: "bad_source",
      });
      expect(event.payload_json).not.toContain(
        "private reviewer note",
      );
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown canonical link before writing feedback or an event", async () => {
    const created = createDatabase();
    db = created.db;
    db.close();
    db = undefined;
    const app = buildApp({
      dbPath: created.dbPath,
      configPath: path.join(created.dir, "config.json"),
    });
    try {
      const missingUrl =
        "https://careers.example.test/missing";
      const response = await app.inject({
        method: "POST",
        url: "/v1/discovery/feedback",
        payload: {
          jobKey: missingUrl,
          kind: "irrelevant",
          note: "private rejected note",
        },
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({
        ok: false,
        error: "not_found",
        message: `No stable Job identity for ${missingUrl}.`,
      });

      db = new Database(created.dbPath);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM discovery_feedback",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM job_events
              WHERE event_type = 'DiscoveryFeedbackRecorded'`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
    }
  });

  it.each([true, false])(
    "purges canonical feedback during permanent deletion with foreign keys %s",
    (foreignKeys) => {
      const created = createDatabase(26, foreignKeys);
      db = created.db;
      const targetUrl =
        "https://careers.example.test/delete";
      insertJob(db, targetUrl, TARGET_JOB_ID);
      ensureDiscoveryControlTables(db);
      db.prepare(
        `INSERT INTO discovery_feedback (
           tenant_id, feedback_id, job_id, source_id,
           kind, note, recorded_at
         ) VALUES (
           'local', 'feedback:delete', ?, 'source:delete',
           'bad_source', 'private deletion note', ?
         )`,
      ).run(TARGET_JOB_ID, NOW);

      expect(permanentlyDeleteJob(db, targetUrl)).toEqual({
        ok: true,
        count: 1,
        jobKeys: [targetUrl],
      });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM discovery_feedback",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM jobs",
          )
          .get(),
      ).toEqual({ count: 0 });
    },
  );

  it("fails closed when a v26 stamp has a legacy feedback table", () => {
    const created = createDatabase(25);
    db = created.db;
    ensureDiscoveryControlTables(db);
    db.pragma("user_version = 26");

    expect(() => ensureDiscoveryControlTables(db!)).toThrow(
      "Schema v26 requires stable discovery_feedback.job_id references.",
    );
  });
});
