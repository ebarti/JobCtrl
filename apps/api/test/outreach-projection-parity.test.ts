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

import { refreshOutreachProjections } from "../src/projections.js";
import { initializeExactV7Database } from "./v7-schema.js";

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
  const dbPath = path.join(dir, "jobs.db");
  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const insertJob = db.prepare(
    `INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)`,
  );
  const insertThread = db.prepare(
    `INSERT INTO outreach_threads (
       tenant_id, thread_id, contact_id, job_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const thread of fixture.threads) {
    if (thread.jobId) {
      const jobId = String(thread.jobId);
      insertJob.run(fixture.tenantId, jobId, `https://example.test/jobs/${jobId}`);
    }
    insertThread.run(
      fixture.tenantId,
      thread.threadId,
      thread.contactId,
      thread.jobId,
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
    refreshOutreachProjections(db, fixture.tenantId);
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
    refreshOutreachProjections(db, fixture.tenantId);
    const rows = db
      .prepare("SELECT * FROM outreach_thread_projections WHERE tenant_id = ?")
      .all(fixture.tenantId) as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(rows);
    for (const secret of fixture.sensitiveValues) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps the same canonical JobId isolated by tenant", () => {
    const db = seededDb();
    const jobId = String(fixture.threads[0]!.jobId);
    db.prepare(`INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)`).run(
      "other",
      jobId,
      `https://example.test/jobs/${jobId}`,
    );
    db.prepare(
      `INSERT INTO outreach_threads (
         tenant_id, thread_id, contact_id, job_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("other", "thread-a", "contact-other", jobId, "2026-07-07T00:00:00Z", "2026-07-07T00:00:00Z");

    refreshOutreachProjections(db, fixture.tenantId);
    refreshOutreachProjections(db, "other");

    expect(
      db
        .prepare("SELECT tenant_id, contact_id, job_id FROM outreach_thread_projections ORDER BY tenant_id, thread_id")
        .all(),
    ).toEqual([
      { tenant_id: "local", contact_id: "contact-a", job_id: jobId },
      { tenant_id: "local", contact_id: "contact-b", job_id: null },
      { tenant_id: "other", contact_id: "contact-other", job_id: jobId },
    ]);
  });
});
