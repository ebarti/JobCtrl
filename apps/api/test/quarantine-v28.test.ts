import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  decideQuarantineEntry,
  ensureDiscoveryControlTables,
  listQuarantine,
} from "../src/discovery-controls.js";
import { tableColumnSet } from "../src/db.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

const NOW = "2026-07-30T12:00:00.000Z";
const CANONICAL_URL =
  "https://careers.example.test/quarantine-canonical";
const POSTING_URL =
  "https://legacy.example.test/quarantine-posting";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const LOSING_JOB_ID = "33333333-3333-4333-8333-333333333333";
const LOSING_URL =
  "https://careers.example.test/quarantine-collision";

let db: Database.Database | undefined;
let cleanup: (() => void) | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  cleanup?.();
  cleanup = undefined;
});

function createDatabase(
  schemaVersion = 28,
  foreignKeys = true,
): Database.Database {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-quarantine-v28-"),
  );
  cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const opened = new Database(path.join(dir, "jobs.db"));
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
      entity_ref TEXT,
      FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
    );
    PRAGMA user_version = ${schemaVersion};
  `);
  return opened;
}

function insertJob(opened: Database.Database): void {
  opened.prepare(
    `INSERT INTO jobs (
       url, tenant_id, job_id, title, company, discovered_at
     ) VALUES (?, 'local', ?, 'Platform Engineer', 'ExampleCo', ?)`,
  ).run(CANONICAL_URL, JOB_ID, NOW);
  opened.prepare(
    `INSERT INTO job_identity_aliases (
       tenant_id, alias_kind, alias_value, job_id, created_at
     ) VALUES ('local', 'posting_url', ?, ?, ?)`,
  ).run(POSTING_URL, JOB_ID, NOW);
}

function insertQuarantine(opened: Database.Database): void {
  opened.prepare(
    `INSERT INTO discovery_quarantine_entries (
       tenant_id, job_id, title, company, source_id,
       posting_url, reason, confidence, snapshot_version,
       captured_at, notice_text, status
     ) VALUES (
       'local', ?, 'Platform Engineer', 'ExampleCo',
       'source:alias', ?, 'unknown_active_state', 0.4, 3,
       ?, 'Private review context stays canonical.', 'pending'
     )`,
  ).run(JOB_ID, POSTING_URL, NOW);
}

describe("schema-v28 Discovery quarantine references", () => {
  it("recovers the stable current-authority contract", () => {
    db = createDatabase();
    ensureDiscoveryControlTables(db);

    expect(
      tableColumnSet(db, "discovery_quarantine_entries"),
    ).toContain("job_id");
    expect(
      tableColumnSet(db, "discovery_quarantine_entries"),
    ).not.toContain("job_key");
    const actions = new Set(
      (
        db
          .prepare(
            'PRAGMA foreign_key_list("discovery_quarantine_entries")',
          )
          .all() as Array<{ on_delete: string }>
      ).map((row) => row.on_delete),
    );
    expect(actions).toEqual(new Set(["CASCADE"]));
    expect(
      (
        db
          .prepare(
            'PRAGMA index_info("idx_discovery_quarantine_status")',
          )
          .all() as Array<{ seqno: number; name: string }>
      )
        .sort((left, right) => left.seqno - right.seqno)
        .map((row) => row.name),
    ).toEqual(["tenant_id", "status", "captured_at"]);
  });

  it("lists and decides by the preserved posting URL", () => {
    db = createDatabase();
    insertJob(db);
    ensureDiscoveryControlTables(db);
    insertQuarantine(db);

    expect(listQuarantine(db)).toEqual({
      ok: true,
      entries: [
        {
          jobId: POSTING_URL,
          jobKey: POSTING_URL,
          title: "Platform Engineer",
          company: "ExampleCo",
          sourceId: "source:alias",
          postingUrl: POSTING_URL,
          reason: "unknown_active_state",
          confidence: 0.4,
          snapshotVersion: 3,
          capturedAt: NOW,
          noticeText: "Private review context stays canonical.",
        },
      ],
    });

    expect(
      decideQuarantineEntry(db, POSTING_URL, {
        decision: "approve",
        reason: "Reviewed",
      }),
    ).toMatchObject({
      ok: true,
      jobKey: POSTING_URL,
      decision: "approve",
    });
    expect(
      db
        .prepare(
          `SELECT job_id, posting_url, status,
                  decision_reason, decided_at
             FROM discovery_quarantine_entries`,
        )
        .get(),
    ).toMatchObject({
      job_id: JOB_ID,
      posting_url: POSTING_URL,
      status: "approve",
      decision_reason: "Reviewed",
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
    expect(event.job_url).toBe(CANONICAL_URL);
    expect(JSON.parse(event.payload_json)).toMatchObject({
      jobId: POSTING_URL,
      sourceId: "source:alias",
      kind: "useful",
    });
    expect(event.payload_json).not.toContain(JOB_ID);
    expect(event.payload_json).not.toContain(
      "Private review context",
    );
  });

  it("decides a collision-rehomed row by the exact listed URL", () => {
    db = createDatabase();
    insertJob(db);
    db.prepare(
      `INSERT INTO jobs (
         url, tenant_id, job_id, title, company, discovered_at
       ) VALUES (?, 'local', ?, 'Duplicate Engineer', 'ExampleCo', ?)`,
    ).run(LOSING_URL, LOSING_JOB_ID, NOW);
    db.prepare(
      `INSERT INTO job_identity_aliases (
         tenant_id, alias_kind, alias_value, job_id, created_at
       ) VALUES ('local', 'posting_url', ?, ?, ?)`,
    ).run(LOSING_URL, LOSING_JOB_ID, NOW);
    ensureDiscoveryControlTables(db);
    db.prepare(
      `INSERT INTO discovery_quarantine_entries (
         tenant_id, job_id, title, company, source_id,
         posting_url, reason, confidence, snapshot_version,
         captured_at, notice_text, status
       ) VALUES (
         'local', ?, 'Duplicate Engineer', 'ExampleCo',
         'source:collision', ?, 'unknown_active_state', 0.3, 2,
         ?, 'Collision review context.', 'pending'
       )`,
    ).run(LOSING_JOB_ID, LOSING_URL, NOW);

    db.prepare(
      `UPDATE discovery_quarantine_entries
       SET job_id = ?
       WHERE tenant_id = 'local' AND job_id = ?`,
    ).run(JOB_ID, LOSING_JOB_ID);
    db.prepare(
      `DELETE FROM job_identity_aliases
       WHERE tenant_id = 'local' AND job_id = ?`,
    ).run(LOSING_JOB_ID);
    db.prepare(
      `DELETE FROM jobs
       WHERE tenant_id = 'local' AND job_id = ?`,
    ).run(LOSING_JOB_ID);

    const listed = listQuarantine(db);
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({
      jobId: LOSING_URL,
      jobKey: LOSING_URL,
      postingUrl: LOSING_URL,
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM job_identity_aliases
           WHERE tenant_id = 'local' AND alias_value = ?`,
        )
        .get(LOSING_URL),
    ).toEqual({ count: 0 });

    expect(
      decideQuarantineEntry(db, listed.entries[0]!.jobKey, {
        decision: "approve",
        reason: "Reviewed after collision",
      }),
    ).toMatchObject({
      ok: true,
      jobKey: LOSING_URL,
      decision: "approve",
    });
    expect(
      db
        .prepare(
          `SELECT job_id, status, decision_reason
           FROM discovery_quarantine_entries`,
        )
        .get(),
    ).toEqual({
      job_id: JOB_ID,
      status: "approve",
      decision_reason: "Reviewed after collision",
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
    expect(event.job_url).toBe(CANONICAL_URL);
    expect(JSON.parse(event.payload_json)).toMatchObject({
      jobId: LOSING_URL,
      sourceId: "source:collision",
      kind: "useful",
    });
    expect(event.payload_json).not.toContain(JOB_ID);
    expect(event.payload_json).not.toContain(
      "Collision review context",
    );
  });

  it("rolls back the decision when audit-event persistence fails", () => {
    db = createDatabase();
    insertJob(db);
    ensureDiscoveryControlTables(db);
    insertQuarantine(db);
    db.exec(`
      CREATE TRIGGER reject_quarantine_feedback_event
      BEFORE INSERT ON job_events
      WHEN NEW.event_type = 'DiscoveryFeedbackRecorded'
      BEGIN
        SELECT RAISE(ABORT, 'injected event failure');
      END;
    `);

    expect(() =>
      decideQuarantineEntry(db!, POSTING_URL, {
        decision: "approve",
        reason: "Must roll back",
      }),
    ).toThrow("injected event failure");
    expect(
      db
        .prepare(
          `SELECT status, decision_reason, decided_at
           FROM discovery_quarantine_entries`,
        )
        .get(),
    ).toEqual({
      status: "pending",
      decision_reason: null,
      decided_at: null,
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM job_events
           WHERE event_type = 'DiscoveryFeedbackRecorded'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it.each([true, false])(
    "purges quarantine during permanent deletion with foreign keys %s",
    (foreignKeys) => {
      db = createDatabase(28, foreignKeys);
      insertJob(db);
      ensureDiscoveryControlTables(db);
      insertQuarantine(db);

      expect(
        permanentlyDeleteJob(db, CANONICAL_URL),
      ).toEqual({
        ok: true,
        count: 1,
        jobKeys: [CANONICAL_URL],
      });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
               FROM discovery_quarantine_entries`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
      ).toEqual({ count: 0 });
    },
  );

  it("fails closed when a v28 stamp has a legacy table", () => {
    db = createDatabase(27);
    ensureDiscoveryControlTables(db);
    db.pragma("user_version = 28");

    expect(() => ensureDiscoveryControlTables(db!)).toThrow(
      "Schema v28 requires stable Discovery quarantine JobId references.",
    );
  });
});
