/**
 * Cross-runtime exact-v7 parity for ``contact_research_task_projections``.
 * The Python half reads the same fixture and lives at
 * ``workers/automation/tests/test_contact_research_projection_parity.py``.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { refreshContactResearchTaskProjections } from "../src/contact-research.js";
import { initializeExactV7Database } from "./v7-schema.js";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "../../../packages/domain-types/test/fixtures/contact_research_projection_parity.json",
    import.meta.url,
  ),
);

interface TenantFixture {
  tenantId: string;
  jobs: Array<{ jobId: string; url: string }>;
  tasks: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  expected: Array<Record<string, unknown>>;
}

interface Fixture {
  tenants: TenantFixture[];
  sensitiveValues: string[];
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
});

function seededDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-research-parity-"));
  const dbPath = path.join(dir, "jobs.db");
  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const insertJob = db.prepare(
    `INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
     VALUES (?, ?, ?, 'Fixture job', '2026-07-31T12:00:00Z')`,
  );
  const insertTask = db.prepare(
    `INSERT INTO contact_research_tasks (
       tenant_id, task_id, employer, job_id, status, source_attempts_json,
       started_at, updated_at, needs_review_at, completed_at, failed_at, error_class
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCandidate = db.prepare(
    `INSERT INTO contact_candidates (
       tenant_id, candidate_id, task_id, role, attributes_json,
       source_kind, source_ref, capture_method, confidence, status,
       proposed_at, confirmed_contact_id, confirmed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const tenant of fixture.tenants) {
    for (const job of tenant.jobs) {
      insertJob.run(tenant.tenantId, job.jobId, job.url);
    }
    for (const task of tenant.tasks) {
      insertTask.run(
        tenant.tenantId,
        task.taskId,
        task.employer,
        task.jobId,
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
    for (const candidate of tenant.candidates) {
      insertCandidate.run(
        tenant.tenantId,
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

function expectedFor(tenant: TenantFixture): Array<Record<string, unknown>> {
  return [...tenant.expected].sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
}

function projectedFor(db: Database.Database, tenant: TenantFixture): Array<Record<string, unknown>> {
  return (db
    .prepare("SELECT * FROM contact_research_task_projections WHERE tenant_id = ?")
    .all(tenant.tenantId) as Array<Record<string, unknown>>)
    .map(normalize)
    .sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
}

describe("contact_research_task_projections cross-runtime parity", () => {
  it("materialises exact-v7 projections from the shared fixture", () => {
    const db = seededDb();
    for (const tenant of fixture.tenants) {
      refreshContactResearchTaskProjections(db, tenant.tenantId);
      expect(projectedFor(db, tenant)).toEqual(expectedFor(tenant));
    }
  });

  it("isolates the same canonical JobId across tenants", () => {
    const db = seededDb();
    const [local, other] = fixture.tenants;
    expect(local).toBeDefined();
    expect(other).toBeDefined();
    refreshContactResearchTaskProjections(db, local!.tenantId);
    expect(projectedFor(db, local!)).toEqual(expectedFor(local!));
    expect(projectedFor(db, other!)).toEqual([]);
    refreshContactResearchTaskProjections(db, other!.tenantId);
    expect(projectedFor(db, other!)).toEqual(expectedFor(other!));
    expect(projectedFor(db, local!)).toEqual(expectedFor(local!));
  });

  it("never persists a candidate value into projections", () => {
    const db = seededDb();
    for (const tenant of fixture.tenants) {
      refreshContactResearchTaskProjections(db, tenant.tenantId);
    }
    const serialized = JSON.stringify(
      db.prepare("SELECT * FROM contact_research_task_projections ORDER BY tenant_id, task_id").all(),
    );
    for (const secret of fixture.sensitiveValues) {
      expect(serialized).not.toContain(secret);
    }
  });
});
