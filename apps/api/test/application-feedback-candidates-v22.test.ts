import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  decideOutcomeSuggestion,
  ensureApplicationFeedbackTables,
  listJobApplicationOutcomes,
} from "../src/application-feedback.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

const UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111";
const URL_OWNER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const ID_TEXT_OWNER_URL = "https://example.com/jobs/id-text-owner";
const OTHER_TENANT_URL = "https://example.com/jobs/other-tenant-candidate";
const NOW = "2026-07-30T10:00:00.000Z";

function createSchema(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
  db.pragma("user_version = 22");
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

function seedCandidatePair(
  db: Database.Database,
  input: {
    tenantId: string;
    marker: string;
    jobId: string;
    evidenceId?: string;
    suggestionId?: string;
    providerMessageId?: string;
  },
): void {
  const evidenceId = input.evidenceId ?? `evidence:${input.marker}`;
  db.prepare(
    `INSERT INTO application_email_evidence (
       tenant_id, evidence_id, job_id, provider, provider_message_id,
       provider_thread_id, from_address, to_addresses_json, subject,
       snippet, received_at, linked_at, link_confidence,
       link_signals_json, body_text, body_sha256, body_stored_at
     ) VALUES (?, ?, ?, 'gmail', ?, ?, ?, '[]', ?, ?, ?, ?, 0.91,
               '["recipient"]', ?, ?, ?)`,
  ).run(
    input.tenantId,
    evidenceId,
    input.jobId,
    input.providerMessageId ?? `message:${input.marker}`,
    `thread:${input.marker}`,
    `from:${input.marker}@example.com`,
    `subject:${input.marker}`,
    `snippet:${input.marker}`,
    NOW,
    NOW,
    `private-body:${input.marker}`,
    `sha256:${input.marker}`,
    NOW,
  );
  db.prepare(
    `INSERT INTO application_outcome_suggestions (
       tenant_id, suggestion_id, job_id, evidence_id, suggested_kind,
       confidence, rationale, status, created_at
     ) VALUES (?, ?, ?, ?, 'interview', 0.87, ?, 'pending', ?)`,
  ).run(
    input.tenantId,
    input.suggestionId ?? `suggestion:${input.marker}`,
    input.jobId,
    evidenceId,
    `rationale:${input.marker}`,
    NOW,
  );
}

function columns(
  db: Database.Database,
  table: string,
): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
}

function indexColumns(
  db: Database.Database,
  index: string,
): string[] {
  return (
    db.prepare(`PRAGMA index_info("${index}")`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function hasCompositeJobIdForeignKey(
  db: Database.Database,
  table: string,
): boolean {
  const rows = db
    .prepare(`PRAGMA foreign_key_list("${table}")`)
    .all() as Array<{
      id: number;
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
  const grouped = new Map<number, Set<string>>();
  const cascades = new Map<number, boolean>();
  for (const row of rows) {
    if (row.table !== "jobs") continue;
    const references = grouped.get(row.id) ?? new Set<string>();
    references.add(`${row.from}:${row.to}`);
    grouped.set(row.id, references);
    cascades.set(row.id, row.on_delete.toUpperCase() === "CASCADE");
  }
  return [...grouped.entries()].some(
    ([id, references]) =>
      cascades.get(id) === true &&
      references.size === 2 &&
      references.has("tenant_id:tenant_id") &&
      references.has("job_id:job_id"),
  );
}

describe("schema-v22 application-feedback candidate compatibility", () => {
  it("projects a UUID-shaped URL while storing its URL owner's JobId", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedCollisionGraph(db);
    ensureApplicationFeedbackTables(db);
    seedCandidatePair(db, {
      tenantId: "local",
      marker: "url-owner",
      jobId: URL_OWNER_JOB_ID,
      suggestionId: "suggestion-url-owner",
    });

    expect(
      listJobApplicationOutcomes(db, UUID_SHAPED_URL),
    ).toMatchObject({
      ok: true,
      jobKey: UUID_SHAPED_URL,
      suggestions: [
        {
          suggestionId: "suggestion-url-owner",
          jobKey: UUID_SHAPED_URL,
          evidenceId: "evidence:url-owner",
          suggestedKind: "interview",
          status: "pending",
        },
      ],
    });

    const decided = decideOutcomeSuggestion(
      db,
      "suggestion-url-owner",
      { decision: "accept" },
    );
    expect(decided.suggestion).toMatchObject({
      jobKey: UUID_SHAPED_URL,
      status: "accepted",
    });
    expect(decided.outcome).toMatchObject({
      jobKey: UUID_SHAPED_URL,
      kind: "interview",
      source: "email_suggestion",
    });
    expect(
      db.prepare(
        `SELECT job_id, status, decided_outcome_id
           FROM application_outcome_suggestions`,
      ).get(),
    ).toMatchObject({
      job_id: URL_OWNER_JOB_ID,
      status: "accepted",
    });
    expect(
      db.prepare("SELECT job_id FROM application_outcomes").get(),
    ).toEqual({ job_id: URL_OWNER_JOB_ID });
    db.close();
  });

  it("deletes only the URL owner's evidence graph with cascades off", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedCollisionGraph(db);
    ensureApplicationFeedbackTables(db);
    seedCandidatePair(db, {
      tenantId: "local",
      marker: "url-owner",
      jobId: URL_OWNER_JOB_ID,
    });
    seedCandidatePair(db, {
      tenantId: "local",
      marker: "id-owner",
      jobId: UUID_SHAPED_URL,
    });
    seedCandidatePair(db, {
      tenantId: "tenant-b",
      marker: "tenant-b",
      jobId: URL_OWNER_JOB_ID,
      evidenceId: "evidence:url-owner",
      suggestionId: "suggestion:url-owner",
      providerMessageId: "message:url-owner",
    });

    expect(permanentlyDeleteJob(db, UUID_SHAPED_URL)).toEqual({
      ok: true,
      count: 1,
      jobKeys: [UUID_SHAPED_URL],
    });
    expect(
      db.prepare(
        `SELECT tenant_id, evidence_id, job_id
           FROM application_email_evidence
          ORDER BY tenant_id, evidence_id`,
      ).all(),
    ).toEqual([
      {
        tenant_id: "local",
        evidence_id: "evidence:id-owner",
        job_id: UUID_SHAPED_URL,
      },
      {
        tenant_id: "tenant-b",
        evidence_id: "evidence:url-owner",
        job_id: URL_OWNER_JOB_ID,
      },
    ]);
    expect(
      db.prepare(
        `SELECT tenant_id, suggestion_id, job_id, evidence_id
           FROM application_outcome_suggestions
          ORDER BY tenant_id, suggestion_id`,
      ).all(),
    ).toEqual([
      {
        tenant_id: "local",
        suggestion_id: "suggestion:id-owner",
        job_id: UUID_SHAPED_URL,
        evidence_id: "evidence:id-owner",
      },
      {
        tenant_id: "tenant-b",
        suggestion_id: "suggestion:url-owner",
        job_id: URL_OWNER_JOB_ID,
        evidence_id: "evidence:url-owner",
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
    [21, "job_key"],
    [22, "job_id"],
  ])(
    "recovers candidate tables with the schema-%i reference",
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

      for (const table of [
        "application_email_evidence",
        "application_outcome_suggestions",
      ]) {
        expect(columns(db, table).has(expectedReference)).toBe(true);
        expect(
          columns(db, table).has(
            expectedReference === "job_id" ? "job_key" : "job_id",
          ),
        ).toBe(false);
        expect(
          hasCompositeJobIdForeignKey(db, table),
        ).toBe(schemaVersion === 22);
      }
      expect(
        indexColumns(db, "idx_application_email_evidence_job"),
      ).toEqual([
        "tenant_id",
        expectedReference,
        "received_at",
      ]);
      expect(
        indexColumns(
          db,
          "idx_application_outcome_suggestions_job",
        ),
      ).toEqual([
        "tenant_id",
        expectedReference,
        "status",
        "created_at",
      ]);
      const uniqueIndexes = db
        .prepare(
          'PRAGMA index_list("application_email_evidence")',
        )
        .all() as Array<{ name: string; unique: number }>;
      expect(
        uniqueIndexes.some(
          (index) =>
            index.unique === 1 &&
            indexColumns(db, index.name).join(",") ===
              "tenant_id,provider,provider_message_id",
        ),
      ).toBe(true);
      db.close();
    },
  );
});
