import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  ensureApplicationFeedbackTables,
  listJobApplicationOutcomes,
  recordManualApplicationOutcome,
} from "../src/application-feedback.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

const UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111";
const URL_OWNER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const ID_TEXT_OWNER_URL = "https://example.com/jobs/id-text-owner";
const OTHER_TENANT_URL = "https://example.com/jobs/other-tenant-outcome";

function createSchema(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
  db.pragma("user_version = 21");
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      title TEXT,
      application_url TEXT,
      tailored_resume_path TEXT,
      cover_letter_path TEXT,
      UNIQUE (tenant_id, job_id)
    );
  `);
}

function seedCollisionGraph(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO jobs (
       url, tenant_id, job_id, title, application_url
     ) VALUES (?, ?, ?, 'Platform Engineer', NULL)`,
  );
  insert.run(UUID_SHAPED_URL, "local", URL_OWNER_JOB_ID);
  insert.run(ID_TEXT_OWNER_URL, "local", UUID_SHAPED_URL);
  insert.run(OTHER_TENANT_URL, "tenant-b", URL_OWNER_JOB_ID);
}

function seedOutcome(
  db: Database.Database,
  input: {
    tenantId: string;
    outcomeId: string;
    jobId: string;
  },
): void {
  db.prepare(
    `INSERT INTO application_outcomes (
       tenant_id, outcome_id, job_id, kind, source, occurred_at,
       recorded_at, created_by
     ) VALUES (?, ?, ?, 'interview', 'manual', ?, ?, 'user')`,
  ).run(
    input.tenantId,
    input.outcomeId,
    input.jobId,
    "2026-07-30T10:00:00.000Z",
    "2026-07-30T10:00:00.000Z",
  );
}

describe("schema-v21 reviewed application-outcome API compatibility", () => {
  it("stores a UUID-shaped posting URL under its URL owner's JobId", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedCollisionGraph(db);
    ensureApplicationFeedbackTables(db);

    const result = recordManualApplicationOutcome(
      db,
      UUID_SHAPED_URL,
      {
        kind: "interview",
        occurredAt: "2026-07-30T10:00:00.000Z",
        note: "Recruiter screen booked.",
      },
    );

    expect(result.outcome).toMatchObject({
      jobKey: UUID_SHAPED_URL,
      kind: "interview",
    });
    expect(
      db.prepare(
        `SELECT tenant_id, job_id, kind
           FROM application_outcomes`,
      ).get(),
    ).toEqual({
      tenant_id: "local",
      job_id: URL_OWNER_JOB_ID,
      kind: "interview",
    });
    expect(
      listJobApplicationOutcomes(db, UUID_SHAPED_URL),
    ).toMatchObject({
      ok: true,
      jobKey: UUID_SHAPED_URL,
      outcomes: [
        expect.objectContaining({
          jobKey: UUID_SHAPED_URL,
          kind: "interview",
        }),
      ],
    });
    db.close();
  });

  it("deletes only the URL owner's outcome history with cascades off", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedCollisionGraph(db);
    ensureApplicationFeedbackTables(db);
    seedOutcome(db, {
      tenantId: "local",
      outcomeId: "url-owner",
      jobId: URL_OWNER_JOB_ID,
    });
    seedOutcome(db, {
      tenantId: "local",
      outcomeId: "id-owner",
      jobId: UUID_SHAPED_URL,
    });
    seedOutcome(db, {
      tenantId: "tenant-b",
      outcomeId: "other-tenant",
      jobId: URL_OWNER_JOB_ID,
    });

    expect(permanentlyDeleteJob(db, UUID_SHAPED_URL)).toEqual({
      ok: true,
      count: 1,
      jobKeys: [UUID_SHAPED_URL],
    });
    expect(
      db.prepare(
        `SELECT tenant_id, outcome_id, job_id
           FROM application_outcomes
          ORDER BY tenant_id, outcome_id`,
      ).all(),
    ).toEqual([
      {
        tenant_id: "local",
        outcome_id: "id-owner",
        job_id: UUID_SHAPED_URL,
      },
      {
        tenant_id: "tenant-b",
        outcome_id: "other-tenant",
        job_id: URL_OWNER_JOB_ID,
      },
    ]);
    expect(
      db.prepare("SELECT url FROM jobs ORDER BY url").all(),
    ).toEqual([
      { url: ID_TEXT_OWNER_URL },
      { url: OTHER_TENANT_URL },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it.each([
    [0, "job_key"],
    [20, "job_key"],
    [21, "job_id"],
  ])(
    "creates the version-aware outcome reference at schema %i",
    (schemaVersion, expectedReference) => {
      const db = new Database(":memory:");
      db.pragma(`user_version = ${schemaVersion}`);
      db.exec(`
        CREATE TABLE jobs (
          url TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'local',
          job_id TEXT NOT NULL,
          UNIQUE (tenant_id, job_id)
        );
      `);
      ensureApplicationFeedbackTables(db);
      const columns = new Set(
        (db.prepare("PRAGMA table_info(application_outcomes)").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      expect(columns.has(expectedReference)).toBe(true);
      expect(
        columns.has(expectedReference === "job_id" ? "job_key" : "job_id"),
      ).toBe(false);
      db.close();
    },
  );
});
