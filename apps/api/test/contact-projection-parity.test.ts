/**
 * Cross-runtime exact-v7 parity for ``contact_projections``. The Python half
 * reads the same fixture and lives at
 * ``workers/automation/tests/test_contact_projection_parity.py``.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { refreshContactProjections } from "../src/projections.js";
import { initializeExactV7Database } from "./v7-schema.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../packages/domain-types/test/fixtures/contact_projection_parity.json", import.meta.url),
);

interface TenantFixture {
  tenantId: string;
  jobs: Array<{ jobId: string; url: string }>;
  contacts: Array<{
    contactId: string;
    employer: string | null;
    jobId: string | null;
    role: string;
    createdAt: string;
    updatedAt: string;
  }>;
  attributes: Array<{
    attributeId: string;
    contactId: string;
    kind: string;
    value: string;
    sourceKind: string;
    sourceRef: string;
    captureMethod: string;
    confidence: number;
    userConfirmed: boolean;
    recordedAt: string;
  }>;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-contact-parity-"));
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
  const insertContact = db.prepare(
    `INSERT INTO contacts (tenant_id, contact_id, employer, job_id, role, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const insertAttribute = db.prepare(
    `INSERT INTO contact_attributes (
       tenant_id, attribute_id, contact_id, attribute_kind, value_json,
       source_kind, source_ref, capture_method, confidence, user_confirmed, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const tenant of fixture.tenants) {
    for (const job of tenant.jobs) {
      insertJob.run(tenant.tenantId, job.jobId, job.url);
    }
    for (const contact of tenant.contacts) {
      insertContact.run(
        tenant.tenantId,
        contact.contactId,
        contact.employer,
        contact.jobId,
        contact.role,
        contact.createdAt,
        contact.updatedAt,
      );
    }
    for (const attribute of tenant.attributes) {
      insertAttribute.run(
        tenant.tenantId,
        attribute.attributeId,
        attribute.contactId,
        attribute.kind,
        JSON.stringify(attribute.value),
        attribute.sourceKind,
        attribute.sourceRef,
        attribute.captureMethod,
        attribute.confidence,
        attribute.userConfirmed ? 1 : 0,
        attribute.recordedAt,
      );
    }
  }
  return db;
}

function normalize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    contactId: row.contact_id,
    employer: row.employer,
    jobId: row.job_id,
    role: row.role,
    attributeCount: Number(row.attribute_count),
    confirmedCount: Number(row.confirmed_count),
    sourceKinds: JSON.parse(String(row.source_kinds_json)),
    provenance: JSON.parse(String(row.provenance_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function expectedFor(tenant: TenantFixture): Array<Record<string, unknown>> {
  return [...tenant.expected].sort((a, b) => String(a.contactId).localeCompare(String(b.contactId)));
}

function projectedFor(db: Database.Database, tenant: TenantFixture): Array<Record<string, unknown>> {
  return (db
    .prepare("SELECT * FROM contact_projections WHERE tenant_id = ?")
    .all(tenant.tenantId) as Array<Record<string, unknown>>)
    .map(normalize)
    .sort((a, b) => String(a.contactId).localeCompare(String(b.contactId)));
}

describe("contact_projections cross-runtime parity", () => {
  it("materialises the exact-v7 projections from the shared fixture", () => {
    const db = seededDb();
    for (const tenant of fixture.tenants) {
      refreshContactProjections(db, tenant.tenantId);
      expect(projectedFor(db, tenant)).toEqual(expectedFor(tenant));
    }
  });

  it("isolates the same canonical JobId across tenants", () => {
    const db = seededDb();
    const [local, other] = fixture.tenants;
    expect(local).toBeDefined();
    expect(other).toBeDefined();
    refreshContactProjections(db, local!.tenantId);
    expect(projectedFor(db, local!)).toEqual(expectedFor(local!));
    expect(projectedFor(db, other!)).toEqual([]);
    refreshContactProjections(db, other!.tenantId);
    expect(projectedFor(db, other!)).toEqual(expectedFor(other!));
    expect(projectedFor(db, local!)).toEqual(expectedFor(local!));
  });

  it("never persists an attribute value into projections", () => {
    const db = seededDb();
    for (const tenant of fixture.tenants) {
      refreshContactProjections(db, tenant.tenantId);
    }
    const serialized = JSON.stringify(
      db.prepare("SELECT * FROM contact_projections ORDER BY tenant_id, contact_id").all(),
    );
    for (const secret of fixture.sensitiveValues) {
      expect(serialized).not.toContain(secret);
    }
  });
});
