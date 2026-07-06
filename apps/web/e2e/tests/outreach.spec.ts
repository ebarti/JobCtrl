import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

interface State {
  workspace?: { dbPath?: string };
}

function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const next = path.dirname(current);
    if (next === current) {
      throw new Error(`Could not find repo root above ${start}`);
    }
    current = next;
  }
  throw new Error(`Could not find repo root within 10 ancestors of ${start}`);
}

function loadDbPath(): string {
  const stateFile = path.join(findRepoRoot(process.cwd()), ".jobhunter-e2e-state.json");
  const raw = fs.readFileSync(stateFile, "utf-8");
  const state = JSON.parse(raw) as State;
  if (!state.workspace?.dbPath) {
    throw new Error("E2E state file is missing workspace.dbPath; global-setup did not run.");
  }
  return state.workspace.dbPath;
}

const JOB_URL = "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";
const CONTACT_ID = "contact-e2e-outreach";
const CONTACT_THREAD_ID = "thread-e2e-contact";
const DUE_THREAD_ID = "thread-e2e-due";
const FUTURE_THREAD_ID = "thread-e2e-future";
const TASK_ID = "task-e2e-outreach";
const CANDIDATE_ID = "candidate-e2e-outreach";

const NOW = "2026-07-06T09:00:00.000Z";
const PAST_DUE_AT = "2020-01-02T10:00:00.000Z";
const FUTURE_DUE_AT = "2099-01-02T10:00:00.000Z";

const SENSITIVE_VALUES = [
  "Casey Recruiter",
  "casey.recruiter@example.test",
  "Dana Lee",
  "dana.lee@example.test",
  "Hi Casey, I saw the platform role and wanted to introduce myself.",
];

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return Boolean(row);
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  if (!columns.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureOutreachSeedTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      tenant_id   TEXT NOT NULL DEFAULT 'local',
      contact_id  TEXT NOT NULL,
      employer    TEXT,
      job_url     TEXT,
      role        TEXT NOT NULL DEFAULT 'other',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      PRIMARY KEY (tenant_id, contact_id)
    );
    CREATE TABLE IF NOT EXISTS contact_attributes (
      tenant_id      TEXT NOT NULL DEFAULT 'local',
      attribute_id   TEXT NOT NULL,
      contact_id     TEXT NOT NULL,
      attribute_kind TEXT NOT NULL,
      value_json     TEXT,
      source_kind    TEXT NOT NULL,
      source_ref     TEXT NOT NULL,
      capture_method TEXT NOT NULL,
      confidence     REAL NOT NULL DEFAULT 0,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      recorded_at    TEXT NOT NULL,
      PRIMARY KEY (tenant_id, attribute_id)
    );
    CREATE TABLE IF NOT EXISTS contact_research_tasks (
      tenant_id            TEXT NOT NULL DEFAULT 'local',
      task_id              TEXT NOT NULL,
      employer             TEXT,
      job_url              TEXT,
      status               TEXT NOT NULL DEFAULT 'queued',
      source_attempts_json TEXT NOT NULL DEFAULT '[]',
      started_at           TEXT,
      updated_at           TEXT NOT NULL,
      needs_review_at      TEXT,
      completed_at         TEXT,
      failed_at            TEXT,
      error_class          TEXT,
      PRIMARY KEY (tenant_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS contact_candidates (
      tenant_id            TEXT NOT NULL DEFAULT 'local',
      candidate_id         TEXT NOT NULL,
      task_id              TEXT NOT NULL,
      role                 TEXT NOT NULL DEFAULT 'other',
      attributes_json      TEXT,
      source_kind          TEXT NOT NULL,
      source_ref           TEXT NOT NULL,
      capture_method       TEXT NOT NULL,
      confidence           REAL NOT NULL DEFAULT 0,
      status               TEXT NOT NULL DEFAULT 'needs_review',
      proposed_at          TEXT NOT NULL,
      confirmed_contact_id TEXT,
      confirmed_at         TEXT,
      PRIMARY KEY (tenant_id, candidate_id)
    );
    CREATE TABLE IF NOT EXISTS outreach_threads (
      tenant_id        TEXT NOT NULL DEFAULT 'local',
      thread_id        TEXT NOT NULL,
      contact_id       TEXT NOT NULL,
      job_url          TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      follow_up_due_at TEXT,
      follow_up_basis  TEXT,
      follow_up_state  TEXT NOT NULL DEFAULT 'none',
      PRIMARY KEY (tenant_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS outreach_drafts (
      tenant_id         TEXT NOT NULL DEFAULT 'local',
      draft_id          TEXT NOT NULL,
      thread_id         TEXT NOT NULL,
      generation        INTEGER NOT NULL DEFAULT 1,
      kind              TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'candidate',
      body_text         TEXT,
      gate_results_json TEXT,
      provenance_json   TEXT,
      created_at        TEXT NOT NULL,
      approved_at       TEXT,
      rejected_at       TEXT,
      reason            TEXT,
      PRIMARY KEY (tenant_id, draft_id)
    );
    CREATE TABLE IF NOT EXISTS outreach_send_logs (
      tenant_id        TEXT NOT NULL DEFAULT 'local',
      send_log_id      TEXT NOT NULL,
      thread_id        TEXT NOT NULL,
      draft_id         TEXT NOT NULL,
      channel          TEXT NOT NULL,
      sent_at          TEXT NOT NULL,
      logged_at        TEXT NOT NULL,
      PRIMARY KEY (tenant_id, send_log_id)
    );
    CREATE TABLE IF NOT EXISTS application_outcomes (
      tenant_id     TEXT NOT NULL DEFAULT 'local',
      outcome_id    TEXT NOT NULL,
      job_key       TEXT NOT NULL,
      kind          TEXT NOT NULL,
      source        TEXT NOT NULL,
      note          TEXT,
      occurred_at   TEXT NOT NULL,
      recorded_at   TEXT NOT NULL,
      suggestion_id TEXT,
      evidence_id   TEXT,
      interview_prep_generation INTEGER,
      created_by    TEXT NOT NULL DEFAULT 'user',
      PRIMARY KEY (tenant_id, outcome_id)
    );
  `);
  ensureColumn(db, "application_outcomes", "note", "TEXT");
  ensureColumn(db, "application_outcomes", "suggestion_id", "TEXT");
  ensureColumn(db, "application_outcomes", "evidence_id", "TEXT");
  ensureColumn(db, "application_outcomes", "interview_prep_generation", "INTEGER");
  ensureColumn(db, "application_outcomes", "created_by", "TEXT NOT NULL DEFAULT 'user'");
  if (tableExists(db, "job_events")) {
    ensureColumn(db, "job_events", "entity_kind", "TEXT");
    ensureColumn(db, "job_events", "entity_ref", "TEXT");
  }
}

function resetOutreachSeed(db: Database.Database): void {
  const priorConfirmed = tableExists(db, "contact_candidates")
    ? (db
        .prepare(
          "SELECT confirmed_contact_id FROM contact_candidates WHERE tenant_id = 'local' AND task_id = ?",
        )
        .all(TASK_ID) as Array<{ confirmed_contact_id: string | null }>)
        .map((row) => row.confirmed_contact_id)
        .filter((id): id is string => Boolean(id))
    : [];
  const contactIds = [CONTACT_ID, ...priorConfirmed];
  for (const contactId of contactIds) {
    db.prepare("DELETE FROM contact_attributes WHERE tenant_id = 'local' AND contact_id = ?").run(
      contactId,
    );
    db.prepare("DELETE FROM contacts WHERE tenant_id = 'local' AND contact_id = ?").run(contactId);
  }
  db.prepare("DELETE FROM contact_candidates WHERE tenant_id = 'local' AND task_id = ?").run(TASK_ID);
  db.prepare("DELETE FROM contact_research_tasks WHERE tenant_id = 'local' AND task_id = ?").run(TASK_ID);
  db.prepare("DELETE FROM outreach_send_logs WHERE tenant_id = 'local' AND thread_id IN (?, ?, ?)").run(
    CONTACT_THREAD_ID,
    DUE_THREAD_ID,
    FUTURE_THREAD_ID,
  );
  db.prepare("DELETE FROM outreach_drafts WHERE tenant_id = 'local' AND thread_id IN (?, ?, ?)").run(
    CONTACT_THREAD_ID,
    DUE_THREAD_ID,
    FUTURE_THREAD_ID,
  );
  db.prepare("DELETE FROM outreach_threads WHERE tenant_id = 'local' AND thread_id IN (?, ?, ?)").run(
    CONTACT_THREAD_ID,
    DUE_THREAD_ID,
    FUTURE_THREAD_ID,
  );
  db.prepare("DELETE FROM application_outcomes WHERE tenant_id = 'local' AND outcome_id = ?").run(
    "outcome-e2e-outreach",
  );
}

function seedOutreachPlanner(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    ensureOutreachSeedTables(db);
    resetOutreachSeed(db);

    db.prepare(
      `INSERT INTO contacts (
         tenant_id, contact_id, employer, job_url, role, created_at, updated_at, deleted_at
       ) VALUES ('local', ?, 'GitLab', ?, 'recruiter', ?, ?, NULL)`,
    ).run(CONTACT_ID, JOB_URL, NOW, NOW);
    const insertAttribute = db.prepare(
      `INSERT INTO contact_attributes (
         tenant_id, attribute_id, contact_id, attribute_kind, value_json,
         source_kind, source_ref, capture_method, confidence, user_confirmed, recorded_at
       ) VALUES ('local', ?, ?, ?, ?, 'user_imported_list', 'import:outreach-e2e.csv#row-1', 'csv_import', 0.95, 1, ?)`,
    );
    insertAttribute.run("attr-e2e-name", CONTACT_ID, "name", JSON.stringify("Casey Recruiter"), NOW);
    insertAttribute.run("attr-e2e-title", CONTACT_ID, "title", JSON.stringify("Platform recruiter"), NOW);
    insertAttribute.run(
      "attr-e2e-email",
      CONTACT_ID,
      "email",
      JSON.stringify("casey.recruiter@example.test"),
      NOW,
    );

    db.prepare(
      `INSERT INTO contact_research_tasks (
         tenant_id, task_id, employer, job_url, status, source_attempts_json,
         started_at, updated_at, needs_review_at, completed_at, failed_at, error_class
       ) VALUES ('local', ?, 'GitLab', ?, 'needs_review', ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(
      TASK_ID,
      JOB_URL,
      JSON.stringify([
        {
          sourceKind: "public_web_page",
          sourceRef: "https://example.test/team",
          outcome: "fetched",
          attemptedAt: NOW,
          detail: "source fetched under e2e policy",
        },
        {
          sourceKind: "public_web_page",
          sourceRef: "https://example.test/login-only",
          outcome: "manual_capture_required",
          attemptedAt: NOW,
          detail: "login-walled page routed to manual capture",
        },
      ]),
      NOW,
      NOW,
      NOW,
    );
    db.prepare(
      `INSERT INTO contact_candidates (
         tenant_id, candidate_id, task_id, role, attributes_json, source_kind,
         source_ref, capture_method, confidence, status, proposed_at, confirmed_contact_id, confirmed_at
       ) VALUES ('local', ?, ?, 'hiring_manager', ?, 'public_web_page',
         'https://example.test/team', 'llm_assisted', 0.82, 'needs_review', ?, NULL, NULL)`,
    ).run(
      CANDIDATE_ID,
      TASK_ID,
      JSON.stringify([
        {
          attributeId: "candidate-e2e-name",
          kind: "name",
          value: "Dana Lee",
          provenance: {
            sourceKind: "public_web_page",
            sourceRef: "https://example.test/team",
            captureMethod: "llm_assisted",
            capturedAt: NOW,
            confidence: 0.82,
            userConfirmed: false,
          },
        },
        {
          attributeId: "candidate-e2e-email",
          kind: "email",
          value: "dana.lee@example.test",
          provenance: {
            sourceKind: "public_web_page",
            sourceRef: "https://example.test/team",
            captureMethod: "llm_assisted",
            capturedAt: NOW,
            confidence: 0.82,
            userConfirmed: false,
          },
        },
      ]),
      NOW,
    );

    const insertThread = db.prepare(
      `INSERT INTO outreach_threads (
         tenant_id, thread_id, contact_id, job_url, created_at, updated_at,
         follow_up_due_at, follow_up_basis, follow_up_state
       ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertThread.run(CONTACT_THREAD_ID, CONTACT_ID, null, NOW, NOW, FUTURE_DUE_AT, "manual", "scheduled");
    insertThread.run(DUE_THREAD_ID, CONTACT_ID, JOB_URL, NOW, NOW, PAST_DUE_AT, "application_submitted", "scheduled");
    insertThread.run(FUTURE_THREAD_ID, CONTACT_ID, JOB_URL, NOW, NOW, FUTURE_DUE_AT, "no_reply_nudge", "scheduled");

    const passedGate = {
      passed: true,
      computedAgainst: "rendered_draft_text",
      fabrications: [],
      validation: { passed: true, errors: [], warnings: [] },
      judge: {
        approved: true,
        score: 0.94,
        criterionScores: { truthfulness: 0.94 },
        issues: [],
        notes: "Grounded in imported contact facts and profile evidence.",
      },
    };
    const blockedGate = {
      passed: false,
      computedAgainst: "rendered_draft_text",
      fabrications: [
        {
          kind: "unsupported_metric",
          token: "40%",
          control: "never_fabricate",
          section: "outreach[1]",
          generatedText: "I improved onboarding speed by 40%.",
        },
      ],
      validation: { passed: false, errors: ["Unsupported metric 40%."], warnings: [] },
      judge: {
        approved: false,
        score: 0.32,
        criterionScores: { truthfulness: 0.32 },
        issues: ["Unsupported metric."],
        notes: "The metric is not present in the evidence corpus.",
      },
    };
    const provenance = [
      {
        claimId: "claim-e2e-name",
        generatedText: "Hi Casey",
        section: "greeting",
        contactFactIds: ["attr-e2e-name"],
        profileGrounded: false,
        rationale: "Bound to imported recruiter name.",
      },
      {
        claimId: "claim-e2e-profile",
        generatedText: "I work on platform reliability.",
        section: "body",
        contactFactIds: [],
        profileGrounded: true,
        rationale: "Grounded in synthetic profile evidence.",
      },
    ];
    const insertDraft = db.prepare(
      `INSERT INTO outreach_drafts (
         tenant_id, draft_id, thread_id, generation, kind, status, body_text,
         gate_results_json, provenance_json, created_at, approved_at, rejected_at, reason
       ) VALUES ('local', ?, ?, ?, 'intro_request', ?, ?, ?, ?, ?, ?, NULL, '')`,
    );
    insertDraft.run(
      "draft-e2e-approved",
      CONTACT_THREAD_ID,
      1,
      "approved",
      "Hi Casey, I saw the platform role and wanted to introduce myself.",
      JSON.stringify(passedGate),
      JSON.stringify(provenance),
      NOW,
      NOW,
    );
    insertDraft.run(
      "draft-e2e-blocked",
      CONTACT_THREAD_ID,
      2,
      "candidate",
      "Hi Casey, I improved onboarding speed by 40%.",
      JSON.stringify(blockedGate),
      JSON.stringify(provenance),
      NOW,
      null,
    );
    db.prepare(
      `INSERT INTO outreach_send_logs (
         tenant_id, send_log_id, thread_id, draft_id, channel, sent_at, logged_at
       ) VALUES ('local', 'send-log-e2e-existing', ?, 'draft-e2e-approved', 'email', '2026-07-05', ?)`,
    ).run(CONTACT_THREAD_ID, NOW);
    db.prepare(
      `INSERT INTO application_outcomes (
         tenant_id, outcome_id, job_key, kind, source, note, occurred_at, recorded_at,
         suggestion_id, evidence_id, interview_prep_generation, created_by
       ) VALUES ('local', 'outcome-e2e-outreach', ?, 'applied_confirmation', 'e2e_seed',
         NULL, '2026-07-01T12:00:00.000Z', ?, NULL, NULL, NULL, 'e2e')`,
    ).run(JOB_URL, NOW);
  } finally {
    db.close();
  }
}

function assertSensitiveValuesStayOutOfEventsAndProjections(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    const eventRows = db
      .prepare(
        `SELECT event_type, message, payload_json, entity_kind, entity_ref
         FROM job_events
         WHERE event_type LIKE 'Contact%'
            OR event_type LIKE 'Outreach%'
            OR event_type LIKE 'FollowUp%'`,
      )
      .all() as Array<Record<string, unknown>>;
    const projectionRows: Array<Record<string, unknown>> = [];
    for (const table of [
      "contact_projections",
      "contact_research_task_projections",
      "outreach_thread_projections",
      "due_follow_up_projections",
    ]) {
      if (tableExists(db, table)) {
        projectionRows.push(...(db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>));
      }
    }
    const storedOutsideCanonicalRows = JSON.stringify({ eventRows, projectionRows });
    for (const value of SENSITIVE_VALUES) {
      expect(storedOutsideCanonicalRows).not.toContain(value);
    }
  } finally {
    db.close();
  }
}

test("Outreach planner: seeded contacts, supervised research, draft review, send log, and follow-up reminders", async ({
  page,
}) => {
  const dbPath = loadDbPath();
  seedOutreachPlanner(dbPath);

  await page.goto("/jobs");
  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row
    .getByRole("button", { name: /^Open job Director of Platform Engineering/ })
    .click();

  const jobDrawer = page.getByRole("dialog", { name: "Job details" });
  await expect(jobDrawer).toBeVisible({ timeout: 10_000 });

  const contactsPanel = jobDrawer.locator(".job-contacts-section");
  await expect(contactsPanel.getByText("Casey Recruiter")).toBeVisible();
  await contactsPanel.getByRole("button", { name: "show provenance" }).click();
  await expect(contactsPanel.getByText("Imported list").first()).toBeVisible();
  await expect(contactsPanel.getByText("import:outreach-e2e.csv#row-1").first()).toBeVisible();
  await expect(contactsPanel.getByText("Confirmed by you").first()).toBeVisible();

  const researchPanel = jobDrawer.locator(".job-research-section");
  await expect(researchPanel.getByLabel("Research candidates")).toBeVisible();
  await expect(researchPanel.getByText("Dana Lee").first()).toBeVisible();
  await expect(researchPanel.getByText("dana.lee@example.test").first()).toBeVisible();
  await expect(researchPanel.getByText("Public web page").first()).toBeVisible();
  await expect(researchPanel.getByText("https://example.test/team").first()).toBeVisible();
  await researchPanel.locator("summary", { hasText: "Sources attempted" }).click();
  await expect(researchPanel.getByText("source fetched under e2e policy")).toBeVisible();
  await expect(researchPanel.getByText("login-walled page routed to manual capture")).toBeVisible();

  const [confirmResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/contacts/research/${TASK_ID}/candidates/${CANDIDATE_ID}/confirm`) &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    ),
    researchPanel.getByRole("button", { name: "confirm contact" }).click(),
  ]);
  expect(confirmResponse.status()).toBe(200);
  expect(await confirmResponse.json()).toMatchObject({ ok: true });
  await expect(researchPanel.getByText("Confirmed into your contacts.")).toBeVisible();

  await page.goto("/outreach");
  await expect(page.getByRole("heading", { name: "Follow-ups due" })).toBeVisible();
  await expect(page.getByText("application_submitted")).toBeVisible();
  await expect(page.getByText("no_reply_nudge")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Open contact Casey Recruiter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open contact Dana Lee" })).toBeVisible();

  await page.getByRole("button", { name: "Open contact Casey Recruiter" }).click();
  const contactDialog = page.getByRole("dialog", { name: "Contact details" });
  await expect(contactDialog).toBeVisible({ timeout: 10_000 });
  await expect(contactDialog.getByText("Facts and provenance")).toBeVisible();
  await expect(contactDialog.getByRole("heading", { name: "Approved message" })).toBeVisible();
  await expect(contactDialog.getByRole("button", { name: "copy approved message" })).toBeVisible();
  await expect(contactDialog.getByRole("button", { name: /^send$/i })).toHaveCount(0);

  await contactDialog.locator("summary", { hasText: "Provenance and gate results" }).click();
  await expect(contactDialog.getByText("Truthfulness gates passed").first()).toBeVisible();
  await expect(contactDialog.getByText("Bound to imported recruiter name.").first()).toBeVisible();
  await expect(contactDialog.getByText("Truthfulness gates blocked this draft").first()).toBeVisible();
  await expect(contactDialog.getByRole("button", { name: "approve draft" })).toBeDisabled();

  await contactDialog.getByRole("button", { name: "revise approved message" }).click();
  await expect(contactDialog.getByLabel("Edit message")).toBeVisible();
  await expect(contactDialog.getByRole("heading", { name: "Approved message" })).toBeVisible();

  await contactDialog.getByRole("button", { name: "log a send" }).click();
  await contactDialog.getByLabel("Channel").selectOption("linkedin_message");
  await contactDialog.getByLabel("Date you sent it").fill("2026-07-06");
  const [sendLogResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/outreach/threads/${CONTACT_THREAD_ID}/send-logs`) &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    ),
    contactDialog.getByRole("button", { name: "record send" }).click(),
  ]);
  expect(sendLogResponse.status()).toBe(200);
  await expect(contactDialog.getByText("linkedin_message")).toBeVisible();

  const [completeResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/outreach/threads/${CONTACT_THREAD_ID}/follow-up/complete`) &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    ),
    contactDialog.getByRole("button", { name: "mark done" }).click(),
  ]);
  expect(completeResponse.status()).toBe(200);
  await expect(contactDialog.getByText("Last follow-up completed. Schedule a new reminder:")).toBeVisible();

  assertSensitiveValuesStayOutOfEventsAndProjections(dbPath);
});
