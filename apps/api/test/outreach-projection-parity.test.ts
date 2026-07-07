/**
 * Cross-runtime parity for ``outreach_thread_projections`` (R6 Phase 3).
 *
 * The TS half of the TS<->Python drift guard. The Python half lives at
 * ``workers/automation/tests/test_outreach_projection_parity.py``. Both load the
 * SAME shared fixture, seed the SAME canonical ``outreach_threads`` /
 * ``outreach_drafts`` rows, run their OWN projection refresh, and assert the
 * resulting projection rows equal the fixture's ``expected`` block (JSON columns
 * compared parsed). It also asserts that no draft body, gate internal, or
 * provenance rationale leaks into the projection (sensitivity rule, plan §6).
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
    "../../../packages/domain-types/test/fixtures/outreach_thread_projection_parity.json",
    import.meta.url,
  ),
);

interface Fixture {
  tenantId: string;
  threads: Array<Record<string, unknown>>;
  drafts: Array<Record<string, unknown>>;
  sensitiveValues: string[];
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-outreach-parity-"));
  const db = new Database(path.join(dir, "jobs.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  ensureOutreachTables(db);
  const insertThread = db.prepare(
    `INSERT INTO outreach_threads (
       tenant_id, thread_id, contact_id, job_url, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const thread of fixture.threads) {
    insertThread.run(
      fixture.tenantId,
      thread.threadId,
      thread.contactId,
      thread.jobUrl,
      thread.createdAt,
      thread.updatedAt,
    );
  }
  const insertDraft = db.prepare(
    `INSERT INTO outreach_drafts (
       tenant_id, draft_id, thread_id, generation, kind, status, body_text,
       gate_results_json, provenance_json, created_at, approved_at, rejected_at, reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const draft of fixture.drafts) {
    insertDraft.run(
      fixture.tenantId,
      draft.draftId,
      draft.threadId,
      draft.generation,
      draft.kind,
      draft.status,
      draft.bodyText,
      JSON.stringify(draft.gateResults ?? {}),
      JSON.stringify(draft.provenance ?? []),
      draft.createdAt,
      draft.approvedAt,
      draft.rejectedAt,
      draft.reason,
    );
  }
  return db;
}

function normalize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    threadId: row.thread_id,
    contactId: row.contact_id,
    jobId: row.job_id,
    draftCount: Number(row.draft_count),
    latestGeneration: Number(row.latest_generation),
    hasApprovedDraft: Boolean(row.has_approved_draft),
    approvedDraftId: row.approved_draft_id,
    latestStatus: row.latest_status,
    drafts: JSON.parse(String(row.drafts_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUpdatedAt: row.last_updated_at,
  };
}

describe("outreach_thread_projections cross-runtime parity", () => {
  it("materialises the projection from canonical rows matching the shared fixture", () => {
    const db = seededDb();
    refreshProjections(db, fixture.tenantId);
    const rows = db
      .prepare("SELECT * FROM outreach_thread_projections WHERE tenant_id = ?")
      .all(fixture.tenantId) as Array<Record<string, unknown>>;

    const projected = rows
      .map(normalize)
      .sort((a, b) => String(a.threadId).localeCompare(String(b.threadId)));
    const expected = [...fixture.expected].sort((a, b) =>
      String(a.threadId).localeCompare(String(b.threadId)),
    );
    expect(projected).toEqual(expected);
  });

  it("never persists a draft body, gate internal, or rationale into the projection", () => {
    const db = seededDb();
    refreshProjections(db, fixture.tenantId);
    const rows = db
      .prepare("SELECT * FROM outreach_thread_projections WHERE tenant_id = ?")
      .all(fixture.tenantId) as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(rows);
    for (const secret of fixture.sensitiveValues) {
      expect(serialized).not.toContain(secret);
    }
  });
});
