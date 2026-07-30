import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDiscoveryControlTables,
  seedExtensionManualCapture,
} from "../src/discovery-controls.js";
import { tableColumnSet } from "../src/db.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

const NOW = "2026-07-30T12:00:00.000Z";
const JOB_URL = "https://careers.example.test/manual-capture";
const CANONICAL_JOB_URL = "https://careers.example.test/canonical";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

let db: Database.Database | undefined;
let cleanup: (() => void) | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  cleanup?.();
  cleanup = undefined;
});

function createDatabase(
  schemaVersion = 27,
  foreignKeys = true,
): Database.Database {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-manual-capture-v27-"),
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
  return opened;
}

function insertJob(
  opened: Database.Database,
  url = JOB_URL,
): void {
  opened.prepare(
    `INSERT INTO jobs (
       url, tenant_id, job_id, title, company, discovered_at
     ) VALUES (?, 'local', ?, 'Platform Engineer', 'ExampleCo', ?)`,
  ).run(url, JOB_ID, NOW);
}

const extensionCapture = {
  captureId: "capture-stable-v27",
  originatingUrl: JOB_URL,
  captureMode: "current_page" as const,
  capturedUrl: JOB_URL,
  contentText: "Visible user-mediated posting text.",
  futureManualActionRequired: true,
  captureClient: "browser_extension" as const,
  extensionVersion: "0.3.0",
};

describe("schema-v27 manual-capture references", () => {
  it("recovers the stable nullable reference contract", () => {
    db = createDatabase();
    ensureDiscoveryControlTables(db);

    expect(tableColumnSet(db, "manual_capture_queue")).toContain(
      "job_id",
    );
    expect(
      tableColumnSet(db, "manual_capture_queue"),
    ).not.toContain("job_key");
    const actions = new Set(
      (
        db
          .prepare(
            'PRAGMA foreign_key_list("manual_capture_queue")',
          )
          .all() as Array<{ on_delete: string }>
      ).map((row) => row.on_delete),
    );
    expect(actions).toEqual(new Set(["CASCADE"]));
    expect(
      (
        db
          .prepare(
            'PRAGMA index_info("idx_manual_capture_queue_job")',
          )
          .all() as Array<{ seqno: number; name: string }>
      )
        .sort((left, right) => left.seqno - right.seqno)
        .map((row) => row.name),
    ).toEqual(["tenant_id", "job_id", "status"]);
  });

  it("projects imported stable storage back to the captured posting URL", () => {
    db = createDatabase();
    insertJob(db, CANONICAL_JOB_URL);
    const seeded = seedExtensionManualCapture(
      db,
      extensionCapture,
    );
    expect("ok" in seeded).toBe(false);
    const itemId = "itemId" in seeded ? seeded.itemId : "";
    expect(itemId).not.toBe("");
    const importedAt = "2026-07-30T12:05:00.000Z";
    db.prepare(
      `UPDATE manual_capture_queue
          SET status = 'imported',
              imported_at = ?,
              capture_mode = ?,
              captured_url = ?,
              content_sha256 = ?,
              content_length = ?,
              note = ?,
              future_manual_action_required = 1,
              retry_context_json = ?,
              job_id = ?
        WHERE tenant_id = 'local' AND item_id = ?`,
    ).run(
      importedAt,
      extensionCapture.captureMode,
      JOB_URL,
      "a".repeat(64),
      extensionCapture.contentText.length,
      "private: capture note",
      JSON.stringify({
        manual_capture_provenance: {
          source_kind: "user_mediated_capture",
          originating_url: JOB_URL,
          source_id: "manual_capture:extension",
          capture_mode: extensionCapture.captureMode,
          captured_at: importedAt,
          future_manual_action_required: true,
          capture_client: "browser_extension",
          extension_version: "0.3.0",
        },
      }),
      JOB_ID,
      itemId,
    );

    expect(
      seedExtensionManualCapture(db, extensionCapture),
    ).toMatchObject({
      ok: true,
      itemId,
      jobKey: JOB_URL,
      importedAt,
      provenance: {
        sourceKind: "user_mediated_capture",
        originatingUrl: JOB_URL,
        captureMode: "current_page",
        futureManualActionRequired: true,
        captureClient: "browser_extension",
        extensionVersion: "0.3.0",
      },
    });
    expect(
      db
        .prepare(
          `SELECT job_id, captured_url, note
             FROM manual_capture_queue
            WHERE item_id = ?`,
        )
        .get(itemId),
    ).toEqual({
      job_id: JOB_ID,
      captured_url: JOB_URL,
      note: "private: capture note",
    });
  });

  it.each([true, false])(
    "purges an imported capture during permanent deletion with foreign keys %s",
    (foreignKeys) => {
      db = createDatabase(27, foreignKeys);
      insertJob(db);
      ensureDiscoveryControlTables(db);
      db.prepare(
        `INSERT INTO manual_capture_queue (
           tenant_id, item_id, originating_url, reason,
           retry_context_json, required_at, status,
           imported_at, captured_url, note, job_id
         ) VALUES (
           'local', 'capture:delete', ?, 'login_required',
           '{"private":"delete"}', ?, 'imported',
           ?, ?, 'private deletion note', ?
         )`,
      ).run(JOB_URL, NOW, NOW, JOB_URL, JOB_ID);

      expect(permanentlyDeleteJob(db, JOB_URL)).toEqual({
        ok: true,
        count: 1,
        jobKeys: [JOB_URL],
      });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM manual_capture_queue",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM jobs")
          .get(),
      ).toEqual({ count: 0 });
    },
  );

  it("fails closed when a v27 stamp has a legacy queue", () => {
    db = createDatabase(26);
    ensureDiscoveryControlTables(db);
    db.pragma("user_version = 27");

    expect(() => ensureDiscoveryControlTables(db!)).toThrow(
      "Schema v27 requires stable manual_capture_queue.job_id references.",
    );
  });
});
