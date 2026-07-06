/**
 * Cross-runtime parity for ``contact_projections`` (R6 Phase 1).
 *
 * The TS half of the TS<->Python drift guard. The Python half lives at
 * ``workers/automation/tests/test_contact_projection_parity.py``. Both load the
 * SAME shared fixture, seed the SAME canonical ``contacts`` /
 * ``contact_attributes`` rows, run their OWN projection refresh, and assert the
 * resulting ``contact_projections`` rows equal the fixture's ``expected`` block
 * (JSON columns compared parsed). It also asserts no attribute VALUE leaks into
 * the projection (sensitivity rule, plan §6).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { ensureContactTables } from "../src/contacts.js";
import { refreshProjections } from "../src/projections.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../packages/domain-types/test/fixtures/contact_projection_parity.json", import.meta.url),
);

interface Fixture {
  tenantId: string;
  contacts: Array<{
    contactId: string;
    employer: string | null;
    jobUrl: string | null;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-contact-parity-"));
  const db = new Database(path.join(dir, "jobs.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  ensureContactTables(db);
  const insertContact = db.prepare(
    `INSERT INTO contacts (tenant_id, contact_id, employer, job_url, role, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  for (const contact of fixture.contacts) {
    insertContact.run(
      fixture.tenantId,
      contact.contactId,
      contact.employer,
      contact.jobUrl,
      contact.role,
      contact.createdAt,
      contact.updatedAt,
    );
  }
  const insertAttribute = db.prepare(
    `INSERT INTO contact_attributes (
       tenant_id, attribute_id, contact_id, attribute_kind, value_json,
       source_kind, source_ref, capture_method, confidence, user_confirmed, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const attribute of fixture.attributes) {
    insertAttribute.run(
      fixture.tenantId,
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

describe("contact_projections cross-runtime parity", () => {
  it("materialises the projection from canonical rows matching the shared fixture", () => {
    const db = seededDb();
    refreshProjections(db, fixture.tenantId);
    const rows = db
      .prepare("SELECT * FROM contact_projections WHERE tenant_id = ?")
      .all(fixture.tenantId) as Array<Record<string, unknown>>;

    const projected = rows
      .map(normalize)
      .sort((a, b) => String(a.contactId).localeCompare(String(b.contactId)));
    const expected = [...fixture.expected].sort((a, b) =>
      String(a.contactId).localeCompare(String(b.contactId)),
    );
    expect(projected).toEqual(expected);
  });

  it("never persists an attribute value into the projection (sensitivity)", () => {
    const db = seededDb();
    refreshProjections(db, fixture.tenantId);
    const rows = db
      .prepare("SELECT * FROM contact_projections WHERE tenant_id = ?")
      .all(fixture.tenantId) as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(rows);
    for (const secret of fixture.sensitiveValues) {
      expect(serialized).not.toContain(secret);
    }
  });
});
