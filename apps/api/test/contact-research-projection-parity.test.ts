/**
 * Cross-runtime parity for ``contact_research_task_projections`` (R6 Phase 2).
 *
 * The TS half of the TS<->Python drift guard. The Python half lives at
 * ``workers/automation/tests/test_contact_research_projection_parity.py``. Both
 * load the SAME shared fixture, seed the SAME canonical
 * ``contact_research_tasks`` / ``contact_candidates`` rows, run their OWN
 * projection refresh, and assert the resulting projection rows equal the
 * fixture's ``expected`` block. It also asserts no candidate VALUE leaks into the
 * projection (sensitivity rule, plan §6).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { ensureContactResearchTables } from "../src/contact-research.js";
import { refreshProjections } from "../src/projections.js";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "../../../packages/domain-types/test/fixtures/contact_research_projection_parity.json",
    import.meta.url,
  ),
);

interface Fixture {
  tenantId: string;
  tasks: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-research-parity-"));
  const db = new Database(path.join(dir, "jobs.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  ensureContactResearchTables(db);
  const insertTask = db.prepare(
    `INSERT INTO contact_research_tasks (
       tenant_id, task_id, employer, job_url, status, source_attempts_json,
       started_at, updated_at, needs_review_at, completed_at, failed_at, error_class
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const task of fixture.tasks) {
    insertTask.run(
      fixture.tenantId,
      task.taskId,
      task.employer,
      task.jobUrl,
      task.status,
      JSON.stringify(task.sourceAttempts ?? []),
      task.startedAt,
      task.updatedAt,
      task.needsReviewAt,
      task.completedAt,
      task.failedAt,
      task.errorClass,
    );
  }
  const insertCandidate = db.prepare(
    `INSERT INTO contact_candidates (
       tenant_id, candidate_id, task_id, role, attributes_json,
       source_kind, source_ref, capture_method, confidence, status,
       proposed_at, confirmed_contact_id, confirmed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const candidate of fixture.candidates) {
    insertCandidate.run(
      fixture.tenantId,
      candidate.candidateId,
      candidate.taskId,
      candidate.role,
      JSON.stringify(candidate.attributes ?? []),
      candidate.sourceKind,
      candidate.sourceRef,
      candidate.captureMethod,
      candidate.confidence,
      candidate.status,
      candidate.proposedAt,
      candidate.confirmedContactId,
      candidate.confirmedAt,
    );
  }
  return db;
}

function normalize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    taskId: row.task_id,
    employer: row.employer,
    jobId: row.job_id,
    status: row.status,
    candidateCount: Number(row.candidate_count),
    needsReviewCount: Number(row.needs_review_count),
    confirmedCount: Number(row.confirmed_count),
    sourceAttempts: JSON.parse(String(row.source_attempts_json)),
    candidates: JSON.parse(String(row.candidates_json)),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    needsReviewAt: row.needs_review_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    errorClass: row.error_class,
  };
}

describe("contact_research_task_projections cross-runtime parity", () => {
  it("materialises the projection from canonical rows matching the shared fixture", () => {
    const db = seededDb();
    refreshProjections(db, fixture.tenantId);
    const rows = db
      .prepare("SELECT * FROM contact_research_task_projections WHERE tenant_id = ?")
      .all(fixture.tenantId) as Array<Record<string, unknown>>;

    const projected = rows
      .map(normalize)
      .sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
    const expected = [...fixture.expected].sort((a, b) =>
      String(a.taskId).localeCompare(String(b.taskId)),
    );
    expect(projected).toEqual(expected);
  });

  it("never persists a candidate value into the projection (sensitivity)", () => {
    const db = seededDb();
    refreshProjections(db, fixture.tenantId);
    const rows = db
      .prepare("SELECT * FROM contact_research_task_projections WHERE tenant_id = ?")
      .all(fixture.tenantId) as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(rows);
    for (const secret of fixture.sensitiveValues) {
      expect(serialized).not.toContain(secret);
    }
  });
});
