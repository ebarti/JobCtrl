import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { hasCompositeJobIdForeignKey, tableColumnSet } from "../src/db.js";
import {
  ensureRepeatApplicationTables,
  evaluateRepeatApplication,
  recordRepeatApplicationOverride,
} from "../src/repeat-application.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

const NOW = "2026-07-30T10:00:00.000Z";
const UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111";
const TARGET_JOB_ID = "22222222-2222-4222-8222-222222222222";
const PRIOR_JOB_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_JOB_ID = "44444444-4444-4444-8444-444444444444";
const DELETE_JOB_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_PRIOR_JOB_ID = "66666666-6666-4666-8666-666666666666";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function createDatabase(
  schemaVersion = 23,
  foreignKeys = true,
): Database.Database {
  const opened = new Database(":memory:");
  opened.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  opened.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      title TEXT,
      company TEXT,
      application_url TEXT,
      applied_at TEXT,
      apply_status TEXT,
      discovered_at TEXT,
      UNIQUE (tenant_id, job_id)
    );
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE job_identity_aliases (
      tenant_id TEXT NOT NULL,
      alias_kind TEXT NOT NULL,
      alias_value TEXT NOT NULL,
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retired_at TEXT,
      PRIMARY KEY (tenant_id, alias_kind, alias_value)
    );
    PRAGMA user_version = ${schemaVersion};
  `);
  return opened;
}

function insertJob(input: {
  url: string;
  jobId: string;
  tenantId?: string;
  title?: string;
  company?: string;
}): void {
  db!
    .prepare(
      `INSERT INTO jobs (
       url, tenant_id, job_id, title, company, application_url, discovered_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.url,
      input.tenantId ?? "local",
      input.jobId,
      input.title ?? "Senior Platform Engineer",
      input.company ?? "ExampleCo",
      `${input.url}/apply`,
      NOW,
    );
}

function indexColumns(tableName: string, indexName: string): string[] {
  const exists = db!
    .prepare(`PRAGMA index_list("${tableName}")`)
    .all()
    .some((row) => (row as { name: string }).name === indexName);
  if (!exists) return [];
  return (
    db!.prepare(`PRAGMA index_info("${indexName}")`).all() as Array<{
      seqno: number;
      name: string;
    }>
  )
    .sort((left, right) => left.seqno - right.seqno)
    .map((row) => row.name);
}

function hasUniqueIndexColumns(
  tableName: string,
  columns: readonly string[],
): boolean {
  const indexes = db!
    .prepare(`PRAGMA index_list("${tableName}")`)
    .all() as Array<{ name: string; unique: number }>;
  return indexes.some((index) => {
    const actual = indexColumns(tableName, index.name);
    return (
      Boolean(index.unique) &&
      actual.length === columns.length &&
      actual.every((column, position) => column === columns[position])
    );
  });
}

describe("schema-v23 repeat-application references", () => {
  it.each([
    [0, "target_job_key", "prior_job_key"],
    [22, "target_job_key", "prior_job_key"],
    [23, "target_job_id", "prior_job_id"],
  ])(
    "recovers missing tables for schema v%s",
    (schemaVersion, targetReference, priorReference) => {
      db = createDatabase(schemaVersion);

      ensureRepeatApplicationTables(db);

      const overrides = tableColumnSet(db, "application_repeat_overrides");
      const audit = tableColumnSet(db, "application_repeat_audit");
      expect(overrides.has(targetReference)).toBe(true);
      expect(overrides.has(priorReference)).toBe(true);
      expect(audit.has(targetReference)).toBe(true);
      if (schemaVersion === 23) {
        expect(
          hasCompositeJobIdForeignKey(
            db,
            "application_repeat_overrides",
            "target_job_id",
          ),
        ).toBe(true);
        expect(
          hasCompositeJobIdForeignKey(
            db,
            "application_repeat_overrides",
            "prior_job_id",
          ),
        ).toBe(true);
        expect(
          hasCompositeJobIdForeignKey(
            db,
            "application_repeat_audit",
            "target_job_id",
          ),
        ).toBe(true);
        expect(
          indexColumns(
            "application_repeat_overrides",
            "idx_application_repeat_overrides_target",
          ),
        ).toEqual(["tenant_id", "target_job_id", "confirmed_at"]);
        expect(
          indexColumns(
            "application_repeat_overrides",
            "idx_application_repeat_overrides_prior",
          ),
        ).toEqual(["tenant_id", "prior_job_id", "confirmed_at"]);
        expect(
          hasUniqueIndexColumns("application_repeat_override_consumptions", [
            "tenant_id",
            "run_id",
          ]),
        ).toBe(true);
        expect(
          db!
            .prepare(
              'PRAGMA foreign_key_list("application_repeat_override_consumptions")',
            )
            .all(),
        ).toEqual([]);
        expect(
          (
            db!
              .prepare('PRAGMA foreign_key_list("application_repeat_audit")')
              .all() as Array<{ table: string }>
          ).map((row) => row.table),
        ).toEqual(["jobs", "jobs"]);
      }
    },
  );

  it("fails closed when a database is stamped v23 with legacy tables", () => {
    db = createDatabase(22);
    ensureRepeatApplicationTables(db);
    db.pragma("user_version = 23");

    expect(() => ensureRepeatApplicationTables(db!)).toThrow(
      "Schema v23 requires stable repeat-application references.",
    );
  });

  it("stores stable ownership while projecting URL-shaped evidence", () => {
    db = createDatabase();
    ensureRepeatApplicationTables(db);
    const priorUrl = "https://careers.example.test/prior";
    const collidingOwnerUrl = "https://careers.example.test/uuid-id-owner";
    insertJob({
      url: UUID_SHAPED_URL,
      jobId: TARGET_JOB_ID,
    });
    insertJob({
      url: collidingOwnerUrl,
      jobId: UUID_SHAPED_URL,
    });
    insertJob({
      url: priorUrl,
      jobId: PRIOR_JOB_ID,
    });
    db.prepare(
      `INSERT INTO job_events (
         job_url, event_type, occurred_at
       ) VALUES (?, 'ApplicationSubmitted', ?)`,
    ).run(priorUrl, NOW);

    const initial = evaluateRepeatApplication(db, UUID_SHAPED_URL, {
      evaluatedAt: NOW,
    });
    expect(initial.status).toBe("confirmation_required");
    const response = recordRepeatApplicationOverride(db, UUID_SHAPED_URL, {
      evidenceFingerprint: initial.evidenceFingerprint!,
      priorJobKey: priorUrl,
      reason: "The first application was withdrawn.",
      confirmedBy: "qa-user",
    });

    expect(response.assessment).toMatchObject({
      status: "override_ready",
      override: {
        targetJobKey: UUID_SHAPED_URL,
        priorJobKey: priorUrl,
      },
    });
    expect(
      db
        .prepare(
          `SELECT target_job_id, prior_job_id, evidence_fingerprint,
                evidence_json
           FROM application_repeat_overrides`,
        )
        .get(),
    ).toMatchObject({
      target_job_id: TARGET_JOB_ID,
      prior_job_id: PRIOR_JOB_ID,
      evidence_fingerprint: initial.evidenceFingerprint,
      evidence_json: JSON.stringify(initial.matches),
    });
    expect(
      db
        .prepare(
          `SELECT DISTINCT target_job_id
           FROM application_repeat_audit`,
        )
        .all(),
    ).toEqual([{ target_job_id: TARGET_JOB_ID }]);
  });

  it("purges the complete repeat graph with foreign keys disabled", () => {
    db = createDatabase(23, false);
    ensureRepeatApplicationTables(db);
    const priorUrl = "https://careers.example.test/prior";
    const otherUrl = "https://careers.example.test/other";
    const collidingOwnerUrl = "https://careers.example.test/uuid-id-owner";
    const postingAlias = "https://legacy.example.test/deleted";
    insertJob({
      url: UUID_SHAPED_URL,
      jobId: DELETE_JOB_ID,
    });
    insertJob({
      url: collidingOwnerUrl,
      jobId: UUID_SHAPED_URL,
    });
    insertJob({
      url: priorUrl,
      jobId: PRIOR_JOB_ID,
    });
    insertJob({
      url: otherUrl,
      jobId: OTHER_JOB_ID,
    });
    insertJob({
      url: "https://blue.example.test/deleted-id-owner",
      jobId: DELETE_JOB_ID,
      tenantId: "blue",
    });
    insertJob({
      url: "https://blue.example.test/prior",
      jobId: OTHER_PRIOR_JOB_ID,
      tenantId: "blue",
    });
    db.prepare(
      `INSERT INTO job_identity_aliases (
         tenant_id, alias_kind, alias_value, job_id, created_at
       ) VALUES ('local', 'posting_url', ?, ?, ?)`,
    ).run(postingAlias, DELETE_JOB_ID, NOW);
    const evidenceOnlySnapshot = JSON.stringify([
      "legacy-scalar-entry",
      {
        priorApplication: {
          jobKey: priorUrl,
          title: "Selected active role",
        },
      },
      {
        priorApplication: {
          jobKey: postingAlias,
          title: "Deleted private role",
        },
      },
    ]);
    const overrides = [
      ["local", "override:target", DELETE_JOB_ID, PRIOR_JOB_ID, "[]"],
      ["local", "override:prior", OTHER_JOB_ID, DELETE_JOB_ID, "[]"],
      [
        "local",
        "override:evidence",
        OTHER_JOB_ID,
        PRIOR_JOB_ID,
        evidenceOnlySnapshot,
      ],
      ["local", "override:collision", UUID_SHAPED_URL, PRIOR_JOB_ID, "[]"],
      ["local", "override:unrelated", OTHER_JOB_ID, PRIOR_JOB_ID, "[]"],
      ["blue", "override:blue", DELETE_JOB_ID, OTHER_PRIOR_JOB_ID, "[]"],
    ] as const;
    const insertOverride = db.prepare(
      `INSERT INTO application_repeat_overrides (
         tenant_id, override_id, target_job_id, prior_job_id,
         relationship, evidence_fingerprint, evidence_json, reason,
         confirmed_by, confirmed_at
       ) VALUES (?, ?, ?, ?, 'canonical_identity', ?, ?, ?, 'qa-user', ?)`,
    );
    const insertConsumption = db.prepare(
      `INSERT INTO application_repeat_override_consumptions (
         tenant_id, override_id, run_id, consumed_at
       ) VALUES (?, ?, ?, ?)`,
    );
    for (const [
      tenantId,
      overrideId,
      targetJobId,
      priorJobId,
      evidenceJson,
    ] of overrides) {
      insertOverride.run(
        tenantId,
        overrideId,
        targetJobId,
        priorJobId,
        `fingerprint:${overrideId}`,
        evidenceJson,
        `reason:${overrideId}`,
        NOW,
      );
      insertConsumption.run(tenantId, overrideId, `run:${overrideId}`, NOW);
    }
    const insertAudit = db.prepare(
      `INSERT INTO application_repeat_audit (
         tenant_id, audit_id, audit_key, target_job_id, action,
         evidence_fingerprint, evidence_json, override_id, actor,
         reason, occurred_at
       ) VALUES (?, ?, ?, ?, 'override_recorded', ?, ?, ?, 'qa-user', ?, ?)`,
    );
    insertAudit.run(
      "local",
      "audit:target",
      "audit-key:target",
      DELETE_JOB_ID,
      "fingerprint:target",
      "[]",
      "override:target",
      "target",
      NOW,
    );
    insertAudit.run(
      "local",
      "audit:linked",
      "audit-key:linked",
      OTHER_JOB_ID,
      "fingerprint:linked",
      "[]",
      "override:prior",
      "linked",
      NOW,
    );
    insertAudit.run(
      "local",
      "audit:evidence",
      "audit-key:evidence",
      OTHER_JOB_ID,
      "fingerprint:evidence",
      evidenceOnlySnapshot,
      "override:evidence",
      "evidence",
      NOW,
    );
    insertAudit.run(
      "local",
      "audit:invalid",
      "audit-key:invalid",
      OTHER_JOB_ID,
      "fingerprint:invalid",
      "{not-json",
      "override:unrelated",
      "invalid",
      NOW,
    );
    insertAudit.run(
      "local",
      "audit:collision",
      "audit-key:collision",
      UUID_SHAPED_URL,
      "fingerprint:collision",
      "[]",
      "override:collision",
      "collision",
      NOW,
    );
    insertAudit.run(
      "blue",
      "audit:blue",
      "audit-key:blue",
      DELETE_JOB_ID,
      "fingerprint:blue",
      "[]",
      "override:blue",
      "blue",
      NOW,
    );

    expect(permanentlyDeleteJob(db, UUID_SHAPED_URL)).toMatchObject({
      ok: true,
      count: 1,
      jobKeys: [UUID_SHAPED_URL],
    });

    expect(
      db.prepare("SELECT 1 FROM jobs WHERE url = ?").get(UUID_SHAPED_URL),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT job_id FROM jobs WHERE url = ?")
        .get(collidingOwnerUrl),
    ).toEqual({ job_id: UUID_SHAPED_URL });
    expect(
      db
        .prepare(
          `SELECT tenant_id, override_id
           FROM application_repeat_overrides
          ORDER BY tenant_id, override_id`,
        )
        .all(),
    ).toEqual([
      { tenant_id: "blue", override_id: "override:blue" },
      { tenant_id: "local", override_id: "override:collision" },
      { tenant_id: "local", override_id: "override:unrelated" },
    ]);
    expect(
      db
        .prepare(
          `SELECT tenant_id, override_id
           FROM application_repeat_override_consumptions
          ORDER BY tenant_id, override_id`,
        )
        .all(),
    ).toEqual([
      { tenant_id: "blue", override_id: "override:blue" },
      { tenant_id: "local", override_id: "override:collision" },
      { tenant_id: "local", override_id: "override:unrelated" },
    ]);
    expect(
      db
        .prepare(
          `SELECT tenant_id, audit_id
           FROM application_repeat_audit
          ORDER BY tenant_id, audit_id`,
        )
        .all(),
    ).toEqual([
      { tenant_id: "blue", audit_id: "audit:blue" },
      { tenant_id: "local", audit_id: "audit:collision" },
      { tenant_id: "local", audit_id: "audit:invalid" },
    ]);
  });
});
