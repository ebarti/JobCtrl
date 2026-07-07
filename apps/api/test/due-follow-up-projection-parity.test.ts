/**
 * Cross-runtime parity for ``due_follow_up_projections`` (R6 Phase 4).
 *
 * The TS half of the TS<->Python drift guard. The Python half lives at
 * ``workers/automation/tests/test_due_follow_up_projection_parity.py``. Both load
 * the SAME shared fixture, seed the SAME canonical ``outreach_threads`` rows (with
 * their follow-up columns), run their OWN projection refresh, and assert the
 * resulting ``due_follow_up_projections`` rows equal the fixture's ``expected``
 * block. Only threads with ``follow_up_state = 'scheduled'`` are projected.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { ensureOutreachTables } from "../src/outreach.js";
import { refreshProjections } from "../src/projections.js";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "../../../packages/domain-types/test/fixtures/due_follow_up_projection_parity.json",
    import.meta.url,
  ),
);

interface Fixture {
  tenantId: string;
  threads: Array<Record<string, unknown>>;
  expected: Array<Record<string, unknown>>;
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
});

function seededDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctl-due-followup-parity-"));
  const db = new Database(path.join(dir, "jobs.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  ensureOutreachTables(db);
  const insertThread = db.prepare(
    `INSERT INTO outreach_threads (
       tenant_id, thread_id, contact_id, job_url, created_at, updated_at,
       follow_up_due_at, follow_up_basis, follow_up_state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const thread of fixture.threads) {
    insertThread.run(
      fixture.tenantId,
      thread.threadId,
      thread.contactId,
      thread.jobUrl,
      thread.createdAt,
      thread.updatedAt,
      thread.followUpDueAt,
      thread.followUpBasis,
      thread.followUpState,
    );
  }
  return db;
}

function normalize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    threadId: row.thread_id,
    contactId: row.contact_id,
    jobId: row.job_id,
    dueAt: row.due_at,
    basis: row.basis,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUpdatedAt: row.last_updated_at,
  };
}

describe("due_follow_up_projections cross-runtime parity", () => {
  it("materialises only scheduled follow-ups matching the shared fixture", () => {
    const db = seededDb();
    refreshProjections(db, fixture.tenantId);
    const rows = db
      .prepare("SELECT * FROM due_follow_up_projections WHERE tenant_id = ?")
      .all(fixture.tenantId) as Array<Record<string, unknown>>;

    const projected = rows
      .map(normalize)
      .sort((a, b) => String(a.threadId).localeCompare(String(b.threadId)));
    const expected = [...fixture.expected].sort((a, b) =>
      String(a.threadId).localeCompare(String(b.threadId)),
    );
    expect(projected).toEqual(expected);
  });

  it("is idempotent across repeated refreshes", () => {
    const db = seededDb();
    refreshProjections(db, fixture.tenantId);
    const first = (
      db
        .prepare("SELECT * FROM due_follow_up_projections WHERE tenant_id = ?")
        .all(fixture.tenantId) as Array<Record<string, unknown>>
    ).map(normalize);
    refreshProjections(db, fixture.tenantId);
    const second = (
      db
        .prepare("SELECT * FROM due_follow_up_projections WHERE tenant_id = ?")
        .all(fixture.tenantId) as Array<Record<string, unknown>>
    ).map(normalize);
    expect(second).toEqual(first);
  });
});
