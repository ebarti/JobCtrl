import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { ensureContactResearchTables } from "../src/contact-research.js";
import {
  ensureOutreachTables,
  findOutreachThreadIdForContact,
  getOutreachThreadForContact,
  OutreachInputError,
} from "../src/outreach.js";
import {
  jobReferenceColumn,
  tableColumnSet,
} from "../src/db.js";
import { refreshProjections } from "../src/projections.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

const NOW = "2026-07-30T12:00:00.000Z";
const UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111";
const TARGET_JOB_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_JOB_ID = "33333333-3333-4333-8333-333333333333";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function createDatabase(
  foreignKeys = true,
  schemaVersion = 25,
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
      salary TEXT,
      description TEXT,
      location TEXT,
      site TEXT,
      strategy TEXT,
      discovered_at TEXT,
      full_description TEXT,
      application_url TEXT,
      detail_scraped_at TEXT,
      detail_error TEXT,
      fit_score INTEGER,
      score_reasoning TEXT,
      scored_at TEXT,
      tailored_resume_path TEXT,
      tailored_at TEXT,
      tailor_attempts INTEGER DEFAULT 0,
      cover_letter_path TEXT,
      cover_letter_at TEXT,
      cover_attempts INTEGER DEFAULT 0,
      applied_at TEXT,
      apply_status TEXT,
      apply_error TEXT,
      apply_attempts INTEGER DEFAULT 0,
      agent_id TEXT,
      last_attempted_at TEXT,
      apply_duration_ms INTEGER,
      apply_task_id TEXT,
      verification_confidence TEXT,
      UNIQUE (tenant_id, job_id)
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
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      stage TEXT,
      event_type TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT,
      entity_kind TEXT,
      entity_ref TEXT
    );
    PRAGMA user_version = ${schemaVersion};
  `);
  ensureContactResearchTables(opened);
  ensureOutreachTables(opened);
  return opened;
}

function insertJob(
  url: string,
  jobId: string,
  company = "ExampleCo",
): void {
  db!.prepare(
    `INSERT INTO jobs (
       url, tenant_id, job_id, title, company, discovered_at
     ) VALUES (?, 'local', ?, 'Platform Engineer', ?, ?)`,
  ).run(url, jobId, company, NOW);
}

function indexColumns(table: string, name: string): string[] {
  return (
    db!.prepare(`PRAGMA index_info("${name}")`).all() as Array<{
      seqno: number;
      name: string;
    }>
  )
    .sort((left, right) => left.seqno - right.seqno)
    .map((row) => row.name);
}

describe("schema-v25 OutreachThread references", () => {
  it("recovers a stable nullable reference table with a restrictive FK", () => {
    db = createDatabase();

    expect(tableColumnSet(db, "outreach_threads")).toContain("job_id");
    expect(tableColumnSet(db, "outreach_threads")).not.toContain(
      "job_url",
    );
    expect(
      indexColumns(
        "outreach_threads",
        "idx_outreach_threads_contact",
      ),
    ).toEqual(["tenant_id", "contact_id", "job_id"]);
    const actions = new Set(
      (
        db
          .prepare('PRAGMA foreign_key_list("outreach_threads")')
          .all() as Array<{ on_delete: string }>
      ).map((row) => row.on_delete),
    );
    expect(actions).toEqual(new Set(["RESTRICT"]));
  });

  it("fails closed when a v25 stamp has a legacy outreach table", () => {
    db = createDatabase(true, 24);
    db.pragma("user_version = 25");

    expect(() => ensureOutreachTables(db!)).toThrow(
      "Schema v25 requires stable outreach_threads.job_id references.",
    );
  });

  it("resolves UUID-shaped URL inputs URL-first and projects URLs", () => {
    db = createDatabase();
    insertJob(UUID_SHAPED_URL, TARGET_JOB_ID);
    insertJob(
      "https://careers.example.test/uuid-id-owner",
      UUID_SHAPED_URL,
    );
    db.prepare(
      `INSERT INTO outreach_threads (
         tenant_id, thread_id, contact_id, job_id,
         created_at, updated_at
       ) VALUES ('local', 'thread:uuid-url', 'contact:one', ?, ?, ?)`,
    ).run(TARGET_JOB_ID, NOW, NOW);
    db.prepare(
      `INSERT INTO outreach_drafts (
         tenant_id, draft_id, thread_id, generation, kind,
         status, gate_results_json, created_at
       ) VALUES (
         'local', 'draft:one', 'thread:uuid-url', 1,
         'intro_request', 'candidate', '{"passed":true}', ?
       )`,
    ).run(NOW);

    expect(
      findOutreachThreadIdForContact(
        db,
        "contact:one",
        UUID_SHAPED_URL,
      ),
    ).toBe("thread:uuid-url");
    const detail = getOutreachThreadForContact(
      db,
      "contact:one",
      UUID_SHAPED_URL,
    );
    expect(detail?.jobId).toBe(UUID_SHAPED_URL);
    expect(
      db
        .prepare(
          "SELECT job_id FROM outreach_thread_projections",
        )
        .get(),
    ).toEqual({ job_id: UUID_SHAPED_URL });
  });

  it("fails closed when a linked URL has no stable Job identity", () => {
    db = createDatabase();

    expect(() =>
      findOutreachThreadIdForContact(
        db!,
        "contact:missing",
        "https://missing.example.test/job",
      ),
    ).toThrow(OutreachInputError);
  });

  function assertPermanentDeletionBehavior(
    foreignKeys: boolean,
  ): void {
    db = createDatabase(foreignKeys);
    const targetUrl = "https://careers.example.test/delete";
    const otherUrl = "https://careers.example.test/keep";
    insertJob(targetUrl, TARGET_JOB_ID);
    insertJob(otherUrl, OTHER_JOB_ID, "OtherCo");
    expect(jobReferenceColumn(db, "outreach_threads")).toBe("job_id");

    db.exec(`
      INSERT INTO contacts (
        tenant_id, contact_id, employer, job_id, role,
        created_at, updated_at
      ) VALUES
        ('local', 'contact:employer', 'ExampleCo', '${TARGET_JOB_ID}', 'other', '${NOW}', '${NOW}'),
        ('local', 'contact:job-only', NULL, '${TARGET_JOB_ID}', 'other', '${NOW}', '${NOW}'),
        ('local', 'contact:other', 'OtherCo', '${OTHER_JOB_ID}', 'other', '${NOW}', '${NOW}');
      INSERT INTO outreach_threads (
        tenant_id, thread_id, contact_id, job_id,
        created_at, updated_at, follow_up_due_at,
        follow_up_basis, follow_up_state
      ) VALUES
        ('local', 'thread:employer', 'contact:employer', '${TARGET_JOB_ID}', '${NOW}', '${NOW}', '${NOW}', 'application_submitted', 'scheduled'),
        ('local', 'thread:job-only', 'contact:job-only', '${TARGET_JOB_ID}', '${NOW}', '${NOW}', NULL, NULL, 'none'),
        ('local', 'thread:other', 'contact:other', '${OTHER_JOB_ID}', '${NOW}', '${NOW}', NULL, NULL, 'none');
      INSERT INTO outreach_drafts (
        tenant_id, draft_id, thread_id, generation, kind,
        status, gate_results_json, created_at
      ) VALUES
        ('local', 'draft:employer', 'thread:employer', 1, 'intro_request', 'approved', '{"passed":true}', '${NOW}'),
        ('local', 'draft:job-only', 'thread:job-only', 1, 'intro_request', 'approved', '{"passed":true}', '${NOW}'),
        ('local', 'draft:other', 'thread:other', 1, 'intro_request', 'approved', '{"passed":true}', '${NOW}');
      INSERT INTO outreach_send_logs (
        tenant_id, send_log_id, thread_id, draft_id,
        channel, sent_at, logged_at
      ) VALUES
        ('local', 'send:employer', 'thread:employer', 'draft:employer', 'other', '${NOW}', '${NOW}'),
        ('local', 'send:job-only', 'thread:job-only', 'draft:job-only', 'other', '${NOW}', '${NOW}'),
        ('local', 'send:other', 'thread:other', 'draft:other', 'other', '${NOW}', '${NOW}');
    `);
    refreshProjections(db);

    expect(permanentlyDeleteJob(db, targetUrl)).toEqual({
      ok: true,
      count: 1,
      jobKeys: [targetUrl],
    });

    expect(
      db
        .prepare(
          "SELECT thread_id, job_id FROM outreach_threads ORDER BY thread_id",
        )
        .all(),
    ).toEqual([
      { thread_id: "thread:employer", job_id: null },
      { thread_id: "thread:other", job_id: OTHER_JOB_ID },
    ]);
    expect(
      db
        .prepare(
          "SELECT draft_id FROM outreach_drafts ORDER BY draft_id",
        )
        .all(),
    ).toEqual([
      { draft_id: "draft:employer" },
      { draft_id: "draft:other" },
    ]);
    expect(
      db
        .prepare(
          "SELECT send_log_id FROM outreach_send_logs ORDER BY send_log_id",
        )
        .all(),
    ).toEqual([
      { send_log_id: "send:employer" },
      { send_log_id: "send:other" },
    ]);
    expect(
      db
        .prepare(
          "SELECT contact_id, job_id FROM contacts ORDER BY contact_id",
        )
        .all(),
    ).toEqual([
      { contact_id: "contact:employer", job_id: null },
      { contact_id: "contact:other", job_id: OTHER_JOB_ID },
    ]);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE url = ?").get(
        targetUrl,
      ),
    ).toEqual({ c: 0 });

    refreshProjections(db);
    expect(
      db
        .prepare(
          "SELECT thread_id, job_id FROM outreach_thread_projections ORDER BY thread_id",
        )
        .all(),
    ).toEqual([
      { thread_id: "thread:employer", job_id: null },
      { thread_id: "thread:other", job_id: otherUrl },
    ]);
    expect(
      db
        .prepare(
          "SELECT thread_id, job_id FROM due_follow_up_projections ORDER BY thread_id",
        )
        .all(),
    ).toEqual([
      { thread_id: "thread:employer", job_id: null },
    ]);
  }

  it.each([true, false])(
    "detaches preserved history and purges job-only outreach (foreign keys: %s)",
    assertPermanentDeletionBehavior,
  );
});
