import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createContact,
  ensureContactTables,
  updateContact,
} from "../src/contacts.js";
import {
  confirmContactCandidate,
  createQueuedResearchTask,
  ensureContactResearchTables,
} from "../src/contact-research.js";
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
  schemaVersion = 24,
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

describe("schema-v24 Contact and contact-research references", () => {
  it("recovers stable nullable reference tables with restrictive FKs", () => {
    db = createDatabase();

    expect(tableColumnSet(db, "contacts")).toContain("job_id");
    expect(tableColumnSet(db, "contacts")).not.toContain("job_url");
    expect(tableColumnSet(db, "contact_research_tasks")).toContain(
      "job_id",
    );
    expect(
      tableColumnSet(db, "contact_research_tasks"),
    ).not.toContain("job_url");
    expect(indexColumns("contacts", "idx_contacts_lookup")).toEqual([
      "tenant_id",
      "employer",
      "job_id",
    ]);
    expect(
      indexColumns(
        "contact_research_tasks",
        "idx_contact_research_tasks_lookup",
      ),
    ).toEqual(["tenant_id", "employer", "job_id"]);
    for (const table of ["contacts", "contact_research_tasks"]) {
      const actions = new Set(
        (
          db
            .prepare(`PRAGMA foreign_key_list("${table}")`)
            .all() as Array<{ on_delete: string }>
        ).map((row) => row.on_delete),
      );
      expect(actions).toEqual(new Set(["RESTRICT"]));
    }
  });

  it("fails closed when a v24 stamp has legacy contact tables", () => {
    db = createDatabase(true, 23);
    db.pragma("user_version = 24");

    expect(() => ensureContactTables(db!)).toThrow(
      "Schema v24 requires stable contacts.job_id references.",
    );
  });

  it("stores UUID-shaped URL inputs URL-first while projecting URLs", () => {
    db = createDatabase();
    insertJob(UUID_SHAPED_URL, TARGET_JOB_ID);
    insertJob(
      "https://careers.example.test/uuid-id-owner",
      UUID_SHAPED_URL,
    );

    const contact = createContact(db, {
      employer: "ExampleCo",
      jobId: UUID_SHAPED_URL,
      role: "recruiter",
      attributes: [{ kind: "name", value: "Private Person" }],
    });
    const task = createQueuedResearchTask(db, {
      taskId: "task:uuid-url",
      employer: "ExampleCo",
      jobId: UUID_SHAPED_URL,
    });

    expect(contact.jobId).toBe(UUID_SHAPED_URL);
    expect(task.jobId).toBe(UUID_SHAPED_URL);
    expect(
      db
        .prepare("SELECT job_id FROM contacts")
        .get(),
    ).toEqual({ job_id: TARGET_JOB_ID });
    expect(
      db
        .prepare("SELECT job_id FROM contact_research_tasks")
        .get(),
    ).toEqual({ job_id: TARGET_JOB_ID });
    const payloads = (
      db
        .prepare(
          "SELECT payload_json FROM job_events ORDER BY event_id",
        )
        .all() as Array<{ payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json) as {
      jobId?: string;
    });
    expect(
      payloads.filter((payload) => payload.jobId).map(
        (payload) => payload.jobId,
      ),
    ).toEqual([UUID_SHAPED_URL, UUID_SHAPED_URL]);

    const updated = updateContact(db, contact.contactId, {
      jobId: "https://careers.example.test/uuid-id-owner",
    });
    expect(updated.jobId).toBe(
      "https://careers.example.test/uuid-id-owner",
    );
    expect(
      db
        .prepare("SELECT job_id FROM contacts")
        .get(),
    ).toEqual({ job_id: UUID_SHAPED_URL });
  });

  it("promotes a research candidate into a stable linked Contact", () => {
    db = createDatabase();
    const jobUrl = "https://careers.example.test/research";
    insertJob(jobUrl, TARGET_JOB_ID);
    createQueuedResearchTask(db, {
      taskId: "task:confirm",
      employer: "ExampleCo",
      jobId: jobUrl,
    });
    db.prepare(
      `INSERT INTO contact_candidates (
         tenant_id, candidate_id, task_id, role, attributes_json,
         source_kind, source_ref, capture_method, confidence,
         status, proposed_at
       ) VALUES (
         'local', 'candidate:confirm', 'task:confirm', 'recruiter', ?,
         'public_web_page', 'https://example.test/team',
         'llm_assisted', 0.8, 'needs_review', ?
       )`,
    ).run(
      JSON.stringify([
        {
          attributeId: "attribute:confirm",
          kind: "name",
          value: "Private Person",
          provenance: {
            sourceKind: "public_web_page",
            sourceRef: "https://example.test/team",
            captureMethod: "llm_assisted",
            capturedAt: NOW,
            confidence: 0.8,
            userConfirmed: false,
          },
        },
      ]),
      NOW,
    );

    const confirmed = confirmContactCandidate(
      db,
      "task:confirm",
      "candidate:confirm",
    );

    expect(confirmed.contact.jobId).toBe(jobUrl);
    expect(
      db
        .prepare(
          "SELECT job_id FROM contacts WHERE contact_id = ?",
        )
        .get(confirmed.contact.contactId),
    ).toEqual({ job_id: TARGET_JOB_ID });
    expect(confirmed.task.status).toBe("completed");
  });

  it("fails closed when a linked URL has no stable Job identity", () => {
    db = createDatabase();

    expect(() =>
      createContact(db!, {
        employer: "ExampleCo",
        jobId: "https://missing.example.test/job",
        role: "other",
        attributes: [],
      }),
    ).toThrow("No stable Job identity exists");
    expect(() =>
      createQueuedResearchTask(db!, {
        taskId: "task:missing",
        employer: "ExampleCo",
        jobId: "https://missing.example.test/job",
      }),
    ).toThrow("No stable Job identity exists");
  });

  it("detaches employer records and purges job-only records with FKs off", () => {
    db = createDatabase(false);
    const targetUrl = "https://careers.example.test/delete";
    const otherUrl = "https://careers.example.test/keep";
    insertJob(targetUrl, TARGET_JOB_ID);
    insertJob(otherUrl, OTHER_JOB_ID, "OtherCo");
    expect(jobReferenceColumn(db, "contacts")).toBe("job_id");

    db.exec(`
      INSERT INTO contacts (
        tenant_id, contact_id, employer, job_id, role,
        created_at, updated_at
      ) VALUES
        ('local', 'contact:employer', 'ExampleCo', '${TARGET_JOB_ID}', 'other', '${NOW}', '${NOW}'),
        ('local', 'contact:job-only', NULL, '${TARGET_JOB_ID}', 'other', '${NOW}', '${NOW}'),
        ('local', 'contact:other', 'OtherCo', '${OTHER_JOB_ID}', 'other', '${NOW}', '${NOW}');
      INSERT INTO contact_attributes (
        tenant_id, attribute_id, contact_id, attribute_kind,
        value_json, source_kind, source_ref, capture_method,
        confidence, user_confirmed, recorded_at
      ) VALUES
        ('local', 'attribute:employer', 'contact:employer', 'name', '"Employer Person"', 'user_entered', 'user_entered', 'manual', 1, 1, '${NOW}'),
        ('local', 'attribute:job-only', 'contact:job-only', 'name', '"Job Person"', 'user_entered', 'user_entered', 'manual', 1, 1, '${NOW}'),
        ('local', 'attribute:other', 'contact:other', 'name', '"Other Person"', 'user_entered', 'user_entered', 'manual', 1, 1, '${NOW}');
      INSERT INTO contact_research_tasks (
        tenant_id, task_id, employer, job_id, status, updated_at
      ) VALUES
        ('local', 'task:employer', 'ExampleCo', '${TARGET_JOB_ID}', 'queued', '${NOW}'),
        ('local', 'task:job-only', NULL, '${TARGET_JOB_ID}', 'queued', '${NOW}'),
        ('local', 'task:other', 'OtherCo', '${OTHER_JOB_ID}', 'queued', '${NOW}');
      INSERT INTO contact_candidates (
        tenant_id, candidate_id, task_id, role, attributes_json,
        source_kind, source_ref, capture_method, confidence,
        status, proposed_at
      ) VALUES
        ('local', 'candidate:employer', 'task:employer', 'other', '[]', 'user_entered', 'user_entered', 'manual', 1, 'needs_review', '${NOW}'),
        ('local', 'candidate:job-only', 'task:job-only', 'other', '[]', 'user_entered', 'user_entered', 'manual', 1, 'needs_review', '${NOW}'),
        ('local', 'candidate:other', 'task:other', 'other', '[]', 'user_entered', 'user_entered', 'manual', 1, 'needs_review', '${NOW}');
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
          "SELECT contact_id, job_id FROM contacts ORDER BY contact_id",
        )
        .all(),
    ).toEqual([
      { contact_id: "contact:employer", job_id: null },
      { contact_id: "contact:other", job_id: OTHER_JOB_ID },
    ]);
    expect(
      db
        .prepare(
          "SELECT attribute_id FROM contact_attributes ORDER BY attribute_id",
        )
        .all(),
    ).toEqual([
      { attribute_id: "attribute:employer" },
      { attribute_id: "attribute:other" },
    ]);
    expect(
      db
        .prepare(
          "SELECT task_id, job_id FROM contact_research_tasks ORDER BY task_id",
        )
        .all(),
    ).toEqual([
      { task_id: "task:employer", job_id: null },
      { task_id: "task:other", job_id: OTHER_JOB_ID },
    ]);
    expect(
      db
        .prepare(
          "SELECT candidate_id FROM contact_candidates ORDER BY candidate_id",
        )
        .all(),
    ).toEqual([
      { candidate_id: "candidate:employer" },
      { candidate_id: "candidate:other" },
    ]);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE url = ?").get(
        targetUrl,
      ),
    ).toEqual({ c: 0 });

    refreshProjections(db);
    const projected = db
      .prepare(
        "SELECT contact_id, job_id FROM contact_projections ORDER BY contact_id",
      )
      .all();
    expect(projected).toEqual([
      { contact_id: "contact:employer", job_id: null },
      { contact_id: "contact:other", job_id: otherUrl },
    ]);
  });
});
