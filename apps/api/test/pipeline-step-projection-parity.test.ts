/**
 * Cross-runtime parity for ``pipeline_step_projections``.
 *
 * The Python half lives at
 * ``workers/automation/tests/test_pipeline_step_projection.py``. Both runtimes
 * fold the same shared event fixture so duplicate, retry, late-event, privacy,
 * and shared-watermark behavior cannot drift independently.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECTION_WATERMARK_NAME } from "../src/contracts.js";
import { ensureProjectionTables, refreshProjections } from "../src/projections.js";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "../../../packages/domain-types/test/fixtures/pipeline_step_projection_parity.json",
    import.meta.url,
  ),
);

interface FixtureEvent {
  eventType: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

interface Fixture {
  tenantId: string;
  events: FixtureEvent[];
  sensitiveValues: string[];
  expected: Array<Record<string, unknown>>;
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
const databases: Database.Database[] = [];

afterEach(() => {
  while (databases.length) {
    databases.pop()?.close();
  }
});

function emptyDb(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE job_events (
      event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url       TEXT,
      stage         TEXT,
      event_type    TEXT NOT NULL,
      level         TEXT NOT NULL DEFAULT 'info',
      message       TEXT,
      occurred_at   TEXT NOT NULL,
      payload_json  TEXT
    );
  `);
  return db;
}

function seedEvents(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO job_events (
       event_id, job_url, stage, event_type, level, message, occurred_at,
       payload_json
     ) VALUES (?, NULL, 'workflow', ?, 'info', NULL, ?, ?)`,
  );
  fixture.events.forEach((event, index) => {
    insert.run(index + 1, event.eventType, event.occurredAt, JSON.stringify(event.payload));
  });
}

function seededDb(): Database.Database {
  const db = emptyDb();
  seedEvents(db);
  return db;
}

function normalize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    workflowId: row.discover_workflow_id,
    temporalRunId: row.discover_run_id,
    stepKind: row.step_kind,
    itemKey: row.item_key,
    state: row.state,
    attempt: Number(row.attempt),
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    errorCode: row.error_code,
    retryable: Number(row.retryable) === 1,
    detailCode: row.detail_code,
    detailCount: row.detail_count === null ? null : Number(row.detail_count),
    lastEventId: Number(row.last_event_id),
    lastUpdatedAt: row.last_updated_at,
  };
}

function projected(db: Database.Database): Array<Record<string, unknown>> {
  const rows = db
    .prepare(
      `SELECT *
       FROM pipeline_step_projections
       WHERE tenant_id = ?
       ORDER BY discover_workflow_id, discover_run_id, step_kind, item_key`,
    )
    .all(fixture.tenantId) as Array<Record<string, unknown>>;
  return rows.map(normalize);
}

describe("pipeline_step_projections cross-runtime parity", () => {
  it("folds attempts, duplicates, and late events to the shared expected rows", () => {
    const db = seededDb();

    refreshProjections(db, fixture.tenantId);

    expect(projected(db)).toEqual(fixture.expected);
    const serialized = JSON.stringify(
      db.prepare("SELECT * FROM pipeline_step_projections").all(),
    );
    for (const sensitiveValue of fixture.sensitiveValues) {
      expect(serialized).not.toContain(sensitiveValue);
    }
  });

  it("is idempotent across repeated full-history folds", () => {
    const db = seededDb();
    refreshProjections(db, fixture.tenantId);
    const first = projected(db);

    refreshProjections(db, fixture.tenantId);

    expect(projected(db)).toEqual(first);
  });

  it("backfills lifecycle rows after another runtime advanced the watermark", () => {
    const db = seededDb();
    ensureProjectionTables(db);
    const maxEventId = fixture.events.length;
    db.prepare(
      `INSERT INTO event_watermarks (projection_name, last_event_id, updated_at)
       VALUES (?, ?, ?)`,
    ).run(
      PROJECTION_WATERMARK_NAME,
      maxEventId,
      fixture.events[fixture.events.length - 1]!.occurredAt,
    );

    refreshProjections(db, fixture.tenantId);

    expect(projected(db)).toEqual(fixture.expected);
    const watermark = db
      .prepare("SELECT last_event_id FROM event_watermarks WHERE projection_name = ?")
      .get(PROJECTION_WATERMARK_NAME) as { last_event_id: number };
    expect(Number(watermark.last_event_id)).toBe(maxEventId);
  });
});
