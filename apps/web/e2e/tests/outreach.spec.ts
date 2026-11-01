import type { LogOutreachSendResponse } from "@jobctrl/contracts";
import { expect, test } from "@playwright/test";
import type { OutreachThreadResponse } from "@jobctrl/contracts";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

const CONTACT_ID = "contact-e2e-outreach";
const CONTACT_THREAD_ID = "thread-e2e-contact";
const DUE_THREAD_ID = "thread-e2e-due";
const FUTURE_THREAD_ID = "thread-e2e-future";
const TASK_ID = "task-e2e-outreach";
const CANDIDATE_ID = "candidate-e2e-outreach";
const ACQUISITION_TASK_ID = "contact-research-e2e-oversize";
const ACQUISITION_SOURCE_URL = "https://contact-research-e2e.example/team";
const repoRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
type DbIdentity = { dev: bigint; ino: bigint };
type OwnedResearchDb = { db: Database.Database; identity: DbIdentity; verify(): void; close(): void };
type AcquisitionCleanup = { seedCommitted(identity: DbIdentity): void; taskCommitted(): void; cleanup(): void };
const { createAcquisitionCleanup, openOwnedResearchDb } = createRequire(import.meta.url)("../fixtures/owned-research-db.cjs") as {
  createAcquisitionCleanup(open: (expected: DbIdentity) => OwnedResearchDb, taskId: string, jobId: string): AcquisitionCleanup;
  openOwnedResearchDb(
    dbPath: string,
    open: (filename: string) => Database.Database,
    env: NodeJS.ProcessEnv,
    expected?: DbIdentity | null,
  ): OwnedResearchDb;
};
let acquisitionCleanup: AcquisitionCleanup | null = null;
let acquisitionCase = false;
let acquisitionIdentity: DbIdentity | null = null;

function openOwnedAcquisitionDb(dbPath: string, expected: DbIdentity | null = null) {
  return openOwnedResearchDb(dbPath, (filename) => new Database(filename, { fileMustExist: true }), process.env, expected);
}

const NOW = "2026-07-06T09:00:00.000Z";
const PAST_DUE_AT = "2020-01-02T10:00:00.000Z";
const FUTURE_DUE_AT = "2099-01-02T10:00:00.000Z";

function publishedRevision(response: OutreachThreadResponse, draftId: string) {
  const draft = response.thread?.drafts.find((item) => item.draftId === draftId);
  if (!draft) throw new Error(`Missing synthetic published draft: ${draftId}`);
  return { ...response, publication: { threadId: draft.threadId, draftId: draft.draftId, generation: draft.generation } };
}

const SENSITIVE_VALUES = [
  "Casey Recruiter",
  "casey.recruiter@example.test",
  "Dana Lee",
  "dana.lee@example.test",
  "Hi Casey, I saw the platform role and wanted to introduce myself.",
];

test("two contact editors retain a stale draft and reconcile explicitly on a narrow viewport", async ({ page }) => {
  const dbPath = loadE2eDbPath();
  seedOutreachPlanner(dbPath);
  await page.setViewportSize({ width: 390, height: 844 });
  const newer = await page.context().newPage();
  try {
    await page.goto(`/outreach/${CONTACT_ID}`);
    await newer.goto(`/outreach/${CONTACT_ID}`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await newer.getByRole("button", { name: "Edit", exact: true }).click();
    const staleEditor = page.getByRole("dialog", { name: "Edit contact" });
    const newerEditor = newer.getByRole("dialog", { name: "Edit contact" });
    await staleEditor.getByLabel("Employer", { exact: true }).fill("Stale draft employer");
    await newerEditor.getByRole("combobox", { name: "Role" }).click();
    await newer.getByRole("option", { name: "Warm intro" }).click();
    await newerEditor.getByRole("button", { name: "Add fact" }).click();
    await newerEditor.getByLabel("Value", { exact: true }).last().fill("newer@example.test");
    const updated = newer.waitForResponse((response) => response.url().endsWith(`/v1/contacts/${CONTACT_ID}`) && response.request().method() === "PATCH");
    await newerEditor.getByRole("button", { name: "save contact", exact: true }).click();
    expect((await updated).status()).toBe(200);
    await expect(newerEditor).toBeHidden();
    const db = new Database(dbPath);
    const snapshot = () => ({
      contact: db.prepare("SELECT * FROM contacts WHERE contact_id = ?").get(CONTACT_ID),
      facts: db.prepare("SELECT * FROM contact_attributes WHERE contact_id = ? ORDER BY attribute_id").all(CONTACT_ID),
      events: db.prepare("SELECT * FROM job_events WHERE entity_kind = 'contact' AND entity_ref = ? ORDER BY event_id").all(CONTACT_ID),
      drafts: db.prepare("SELECT * FROM outreach_drafts WHERE thread_id = ? ORDER BY draft_id").all(CONTACT_THREAD_ID),
      sends: db.prepare("SELECT * FROM outreach_send_logs WHERE thread_id = ? ORDER BY send_log_id").all(CONTACT_THREAD_ID),
    });
    try {
      const accepted = snapshot();
      const rejected = page.waitForResponse((response) => response.url().endsWith(`/v1/contacts/${CONTACT_ID}`) && response.request().method() === "PATCH");
      await staleEditor.getByRole("button", { name: "save contact", exact: true }).click();
      expect((await rejected).status()).toBe(409);
      await expect(staleEditor.getByRole("alert")).toContainText("Your draft is retained");
      await expect(staleEditor.getByLabel("Employer", { exact: true })).toHaveValue("Stale draft employer");
      expect(snapshot()).toEqual(accepted);
      await expect(staleEditor.getByRole("button", { name: "save contact", exact: true })).toBeDisabled();
      const load = staleEditor.getByRole("button", { name: "Load latest contact", exact: true });
      await load.focus();
      await page.keyboard.press("Enter");
      await expect(staleEditor.getByText("newer@example.test", { exact: true })).toBeVisible();
      const review = staleEditor.getByRole("button", { name: "Reconcile changes", exact: true });
      await review.focus();
      await page.keyboard.press("Enter");
      await expect(staleEditor.getByLabel("Employer", { exact: true })).toHaveValue("Stale draft employer");
      await expect(staleEditor.getByRole("combobox", { name: "Role" })).toContainText("Warm intro");
      await expect(staleEditor.getByLabel("Value", { exact: true }).last()).toHaveValue("newer@example.test");
      expect(await staleEditor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const saved = page.waitForResponse((response) => response.url().endsWith(`/v1/contacts/${CONTACT_ID}`) && response.request().method() === "PATCH");
      await staleEditor.getByRole("button", { name: "save contact", exact: true }).focus();
      await page.keyboard.press("Enter");
      expect((await saved).status()).toBe(200);
      await expect(staleEditor).toBeHidden();
      const reconciled = snapshot();
      expect(reconciled.contact).toMatchObject({ employer: "Stale draft employer", role: "warm_intro" });
      expect(reconciled.facts).toHaveLength(4);
      expect(reconciled.facts).toEqual(accepted.facts);
      expect(reconciled.events).toHaveLength(accepted.events.length + 1);
      expect(reconciled.drafts).toEqual(accepted.drafts);
      expect(reconciled.sends).toEqual(accepted.sends);
      await expect(page.getByRole("heading", { name: "Casey Recruiter", exact: true })).toBeVisible();
    } finally { db.close(); }
  } finally { await newer.close(); }
});

test("reconciliation preserves the newer identity of a duplicate contact fact", async ({ page }) => {
  const dbPath = loadE2eDbPath();
  seedOutreachPlanner(dbPath);
  const newer = await page.context().newPage();
  try {
    await page.goto(`/outreach/${CONTACT_ID}`);
    await newer.goto(`/outreach/${CONTACT_ID}`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await newer.getByRole("button", { name: "Edit", exact: true }).click();
    const staleEditor = page.getByRole("dialog", { name: "Edit contact" });
    const newerEditor = newer.getByRole("dialog", { name: "Edit contact" });
    await staleEditor.getByRole("button", { name: "Remove fact 1" }).click();
    await newerEditor.getByRole("button", { name: "Add fact" }).click();
    await newerEditor.getByLabel("Value", { exact: true }).last().fill("casey.recruiter@example.test");
    const updated = newer.waitForResponse((response) => response.url().endsWith(`/v1/contacts/${CONTACT_ID}`) && response.request().method() === "PATCH");
    await newerEditor.getByRole("button", { name: "save contact", exact: true }).click();
    expect((await updated).status()).toBe(200);
    const db = new Database(dbPath);
    try {
      const facts = () => db.prepare("SELECT * FROM contact_attributes WHERE contact_id = ? AND attribute_kind = 'email' ORDER BY attribute_id").all(CONTACT_ID) as Array<{ attribute_id: string }>;
      const accepted = facts();
      expect(accepted).toHaveLength(2);
      const added = accepted.find((fact) => fact.attribute_id !== "attr-e2e-email")!;
      const rejected = page.waitForResponse((response) => response.url().endsWith(`/v1/contacts/${CONTACT_ID}`) && response.request().method() === "PATCH");
      await staleEditor.getByRole("button", { name: "save contact", exact: true }).click();
      expect((await rejected).status()).toBe(409);
      await staleEditor.getByRole("button", { name: "Load latest contact" }).click();
      await expect(staleEditor.getByRole("heading", { name: "Latest saved contact" })).toBeVisible();
      await staleEditor.getByRole("button", { name: "Reconcile changes" }).click();
      const saved = page.waitForResponse((response) => response.url().endsWith(`/v1/contacts/${CONTACT_ID}`) && response.request().method() === "PATCH");
      await staleEditor.getByRole("button", { name: "save contact", exact: true }).click();
      expect((await saved).status()).toBe(200);
      expect(facts()).toEqual([added]);
    } finally { db.close(); }
  } finally { await newer.close(); }
});

test.afterEach(() => {
  if (acquisitionCase) {
    try {
      acquisitionCleanup?.cleanup();
    } finally {
      acquisitionCase = false;
      acquisitionIdentity = null;
      acquisitionCleanup = null;
    }
    return;
  }
  const db = new Database(loadE2eDbPath());
  try {
    db.transaction(() => {
      db.prepare(
        "DELETE FROM application_outcomes WHERE tenant_id = 'local' AND outcome_id = 'outcome-e2e-outreach' AND job_id = ?",
      ).run(QA_PLATFORM_JOB_ID);
      // A later canonical metadata refresh must not inherit this fixture's
      // applied status. Rebuild through the normal API from remaining facts.
      db.prepare(
        "DELETE FROM job_list_projections WHERE tenant_id = 'local' AND job_id = ?",
      ).run(QA_PLATFORM_JOB_ID);
    })();
  } finally {
    db.close();
  }
});

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return Boolean(row);
}

function resetOutreachSeed(db: Database.Database): void {
  const priorConfirmed = tableExists(db, "contact_candidates")
    ? (
        db
          .prepare(
            "SELECT confirmed_contact_id FROM contact_candidates WHERE tenant_id = 'local' AND task_id = ?",
          )
          .all(TASK_ID) as Array<{ confirmed_contact_id: string | null }>
      )
        .map((row) => row.confirmed_contact_id)
        .filter((id): id is string => Boolean(id))
    : [];
  const contactIds = [CONTACT_ID, ...priorConfirmed];
  for (const contactId of contactIds) {
    db.prepare(
      "DELETE FROM contact_attributes WHERE tenant_id = 'local' AND contact_id = ?",
    ).run(contactId);
    db.prepare(
      "DELETE FROM contacts WHERE tenant_id = 'local' AND contact_id = ?",
    ).run(contactId);
  }
  db.prepare(
    "DELETE FROM contact_candidates WHERE tenant_id = 'local' AND task_id = ?",
  ).run(TASK_ID);
  db.prepare(
    "DELETE FROM contact_research_tasks WHERE tenant_id = 'local' AND task_id = ?",
  ).run(TASK_ID);
  db.prepare(
    "DELETE FROM outreach_send_logs WHERE tenant_id = 'local' AND thread_id IN (?, ?, ?)",
  ).run(CONTACT_THREAD_ID, DUE_THREAD_ID, FUTURE_THREAD_ID);
  db.prepare(
    "DELETE FROM outreach_drafts WHERE tenant_id = 'local' AND thread_id IN (?, ?, ?)",
  ).run(CONTACT_THREAD_ID, DUE_THREAD_ID, FUTURE_THREAD_ID);
  db.prepare(
    "DELETE FROM outreach_threads WHERE tenant_id = 'local' AND thread_id IN (?, ?, ?)",
  ).run(CONTACT_THREAD_ID, DUE_THREAD_ID, FUTURE_THREAD_ID);
  db.prepare(
    "DELETE FROM application_outcomes WHERE tenant_id = 'local' AND outcome_id = ?",
  ).run("outcome-e2e-outreach");
}

function seedOutreachPlanner(dbPath: string, existing?: Database.Database): void {
  const db = existing ?? new Database(dbPath);
  try {
    resetOutreachSeed(db);

    db.prepare(
      `INSERT INTO contacts (
         tenant_id, contact_id, employer, job_id, role, created_at, updated_at, deleted_at
       ) VALUES ('local', ?, 'GitLab', ?, 'recruiter', ?, ?, NULL)`,
    ).run(CONTACT_ID, QA_PLATFORM_JOB_ID, NOW, NOW);
    const insertAttribute = db.prepare(
      `INSERT INTO contact_attributes (
         tenant_id, attribute_id, contact_id, attribute_kind, value_json,
         source_kind, source_ref, capture_method, confidence, user_confirmed, recorded_at
       ) VALUES ('local', ?, ?, ?, ?, 'user_imported_list', 'import:outreach-e2e.csv#row-1', 'csv_import', 0.95, 1, ?)`,
    );
    insertAttribute.run(
      "attr-e2e-name",
      CONTACT_ID,
      "name",
      JSON.stringify("Casey Recruiter"),
      NOW,
    );
    insertAttribute.run(
      "attr-e2e-title",
      CONTACT_ID,
      "title",
      JSON.stringify("Platform recruiter"),
      NOW,
    );
    insertAttribute.run(
      "attr-e2e-email",
      CONTACT_ID,
      "email",
      JSON.stringify("casey.recruiter@example.test"),
      NOW,
    );

    db.prepare(
      `INSERT INTO contact_research_tasks (
         tenant_id, task_id, employer, job_id, status, source_attempts_json,
         started_at, updated_at, needs_review_at, completed_at, failed_at, error_class
       ) VALUES ('local', ?, 'GitLab', ?, 'needs_review', ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(
      TASK_ID,
      QA_PLATFORM_JOB_ID,
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
         tenant_id, thread_id, contact_id, job_id, created_at, updated_at,
         follow_up_due_at, follow_up_basis, follow_up_state
       ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertThread.run(
      CONTACT_THREAD_ID,
      CONTACT_ID,
      null,
      NOW,
      NOW,
      FUTURE_DUE_AT,
      "manual",
      "scheduled",
    );
    insertThread.run(
      DUE_THREAD_ID,
      CONTACT_ID,
      QA_PLATFORM_JOB_ID,
      NOW,
      NOW,
      PAST_DUE_AT,
      "application_submitted",
      "scheduled",
    );
    insertThread.run(
      FUTURE_THREAD_ID,
      CONTACT_ID,
      QA_PLATFORM_JOB_ID,
      NOW,
      NOW,
      FUTURE_DUE_AT,
      "no_reply_nudge",
      "scheduled",
    );

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
      validation: {
        passed: false,
        errors: ["Unsupported metric 40%."],
        warnings: [],
      },
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
         tenant_id, outcome_id, job_id, kind, source, note, occurred_at, recorded_at,
         suggestion_id, evidence_id, interview_prep_generation, created_by
       ) VALUES ('local', 'outcome-e2e-outreach', ?, 'applied_confirmation', 'e2e_seed',
         NULL, '2026-07-01T12:00:00.000Z', ?, NULL, NULL, NULL, 'e2e')`,
    ).run(QA_PLATFORM_JOB_ID, NOW);

    // This fixture writes canonical rows directly. Clear the derived read
    // models so the next public API read rematerializes every outreach surface
    // from those canonical rows instead of serving the earlier QA seed.
    for (const table of [
      "contact_projections",
      "contact_research_task_projections",
      "outreach_thread_projections",
      "due_follow_up_projections",
    ]) {
      if (tableExists(db, table)) {
        db.prepare(`DELETE FROM ${table} WHERE tenant_id = 'local'`).run();
      }
    }
  } finally {
    if (!existing) db.close();
  }
}

function assertSensitiveValuesStayOutOfEventsAndProjections(
  dbPath: string,
): void {
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
        projectionRows.push(
          ...(db.prepare(`SELECT * FROM ${table}`).all() as Array<
            Record<string, unknown>
          >),
        );
      }
    }
    const storedOutsideCanonicalRows = JSON.stringify({
      eventRows,
      projectionRows,
    });
    for (const value of SENSITIVE_VALUES) {
      expect(storedOutsideCanonicalRows).not.toContain(value);
    }
  } finally {
    db.close();
  }
}

test("contact research shows an activity's oversized-page failure through the API", async ({ page }, testInfo) => {
  acquisitionCase = true;
  acquisitionCleanup = createAcquisitionCleanup(
    (identity) => openOwnedAcquisitionDb(loadE2eDbPath(), identity), ACQUISITION_TASK_ID, QA_PLATFORM_JOB_ID,
  );
  const dbPath = loadE2eDbPath();
  let priorCandidate: unknown;
  const initial = openOwnedAcquisitionDb(dbPath);
  acquisitionIdentity = initial.identity;
  try {
    initial.db.transaction(() => {
      initial.verify();
      expect(initial.db.prepare("SELECT 1 FROM contact_research_tasks WHERE tenant_id = 'local' AND task_id = ?")
        .get(ACQUISITION_TASK_ID)).toBeUndefined();
      expect(initial.db.prepare("SELECT 1 FROM contact_research_task_projections WHERE tenant_id = 'local' AND task_id = ?")
        .get(ACQUISITION_TASK_ID)).toBeUndefined();
      expect(initial.db.prepare("SELECT 1 FROM job_events WHERE tenant_id = 'local' AND entity_kind = 'contact_research' AND entity_ref = ?")
        .get(ACQUISITION_TASK_ID)).toBeUndefined();
      seedOutreachPlanner(dbPath, initial.db);
      priorCandidate = initial.db.prepare("SELECT * FROM contact_candidates WHERE tenant_id = 'local' AND candidate_id = ?")
        .get(CANDIDATE_ID);
      expect(priorCandidate).toBeDefined();
      initial.verify();
    })();
    acquisitionCleanup.seedCommitted(initial.identity);
  } finally {
    initial.close();
  }

  const worker = spawnSync(
    path.join(repoRoot, "workers/automation/.venv/bin/python"),
    [path.join(repoRoot, "apps/web/e2e/fixtures/contact-research-acquisition.py"), dbPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env["PATH"]!,
        HOME: process.env["JOBCTRL_E2E_SERVICE_HOME"]!,
        TMPDIR: process.env["TMPDIR"]!,
        JOBCTRL_DIR: process.env["JOBCTRL_E2E_APP_DIR"]!,
        JOBCTRL_E2E_APP_DIR: process.env["JOBCTRL_E2E_APP_DIR"]!,
        JOBCTRL_E2E_DB_PATH: dbPath,
        JOBCTRL_E2E_WORKSPACE: process.env["JOBCTRL_E2E_WORKSPACE"]!,
        JOBCTRL_RUNTIME_MODE: "source",
        LANGFUSE_DISABLE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: path.join(repoRoot, "workers/automation/src"),
      },
    },
  );
  expect(worker.status, worker.stderr).toBe(0);
  const workerResult = JSON.parse(worker.stdout) as {
    persistedTask: {
      tenant_id: string; task_id: string; employer: string; job_id: string; status: string;
      source_attempts_json: string; started_at: string; updated_at: string; needs_review_at: string;
      completed_at: string | null; failed_at: string | null; error_class: string | null;
    };
  };
  expect(workerResult).toMatchObject({
    output: { taskId: ACQUISITION_TASK_ID, status: "needs_review", candidateCount: 0, attemptCount: 1 },
    responseClosed: true, responseRead: false, requests: 1, modelCalls: 0,
  });
  const produced = workerResult.persistedTask;
  expect(produced).toMatchObject({
    tenant_id: "local", task_id: ACQUISITION_TASK_ID, job_id: QA_PLATFORM_JOB_ID, status: "needs_review",
  });
  expect(JSON.parse(produced.source_attempts_json)).toMatchObject([{
    sourceRef: ACQUISITION_SOURCE_URL, outcome: "response_too_large",
    detail: "The page is too large; choose a smaller public page.",
  }]);
  const saved = openOwnedAcquisitionDb(dbPath, acquisitionIdentity);
  try {
    saved.db.transaction(() => {
      saved.verify();
      // Copy the exact canonical row emitted by the in-memory activity into the
      // existing owned API fixture; the worker never opens the workspace DB.
      saved.db.prepare(`INSERT INTO contact_research_tasks (
        tenant_id, task_id, employer, job_id, status, source_attempts_json,
        started_at, updated_at, needs_review_at, completed_at, failed_at, error_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        produced.tenant_id, produced.task_id, produced.employer, produced.job_id, produced.status,
        produced.source_attempts_json, produced.started_at, produced.updated_at, produced.needs_review_at,
        produced.completed_at, produced.failed_at, produced.error_class,
      );
      saved.verify();
    })();
    acquisitionCleanup.taskCommitted();
    const task = saved.db.prepare("SELECT status, source_attempts_json FROM contact_research_tasks WHERE tenant_id = 'local' AND task_id = ?")
      .get(ACQUISITION_TASK_ID) as { status: string; source_attempts_json: string };
    expect(task.status).toBe("needs_review");
    expect(JSON.parse(task.source_attempts_json)).toMatchObject([{
      sourceRef: ACQUISITION_SOURCE_URL, outcome: "response_too_large",
      detail: "The page is too large; choose a smaller public page.",
    }]);
    expect(saved.db.prepare("SELECT * FROM contact_candidates WHERE tenant_id = 'local' AND candidate_id = ?")
      .get(CANDIDATE_ID)).toEqual(priorCandidate);
    saved.verify();
  } finally {
    saved.close();
  }

  await page.goto("/jobs");
  await expect(page).toHaveTitle(/JobCtrl/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const row = page.locator("table.jobs-data-grid-table tbody tr").filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const apiRead = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/v1/contacts/research/${ACQUISITION_TASK_ID}` &&
    response.request().method() === "GET" && response.status() === 200,
  );
  await row.getByRole("rowheader").click();
  const jobDrawer = page.getByRole("article", { name: "Job details" });
  await expect(jobDrawer).toBeVisible();
  await jobDrawer.getByRole("button", { name: /· Contacts/ }).click();
  expect(await (await apiRead).json()).toMatchObject({
    ok: true,
    task: {
      taskId: ACQUISITION_TASK_ID, candidateCount: 0,
      sourceAttempts: [{ sourceRef: ACQUISITION_SOURCE_URL, outcome: "response_too_large" }],
    },
  });
  const research = jobDrawer.locator(".job-research-section");
  await expect(research.getByText("Dana Lee").first()).toBeVisible();
  const failedTask = research.locator(".research-task-row").filter({ hasText: ACQUISITION_SOURCE_URL });
  await expect(failedTask).toHaveCount(1);
  await failedTask.locator("summary", { hasText: "Sources attempted" }).click();
  await expect(failedTask.getByText("Page too large", { exact: true })).toBeVisible();
  await expect(failedTask.getByText("The page is too large; choose a smaller public page.")).toBeVisible();
  await expect(failedTask.getByText("No contacts found", { exact: true })).toHaveCount(0);
  await testInfo.attach("contact-research-oversize", { body: await page.screenshot(), contentType: "image/png" });
});

test("Outreach planner: seeded contacts, supervised research, draft review, send log, and follow-up reminders", async ({
  page,
}, testInfo) => {
  const dbPath = loadE2eDbPath();
  seedOutreachPlanner(dbPath);

  await page.goto("/jobs");
  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("rowheader").click();

  const jobDrawer = page.getByRole("article", { name: "Job details" });
  await expect(jobDrawer).toBeVisible({ timeout: 10_000 });
  await jobDrawer.getByRole("button", { name: /· Contacts/ }).click();

  const contactsPanel = jobDrawer.locator(".job-contacts-section");
  await expect(contactsPanel.getByText("Casey Recruiter")).toBeVisible();
  const caseyContact = contactsPanel
    .locator(".job-contact-row")
    .filter({ hasText: "Casey Recruiter" });
  await caseyContact.getByRole("button", { name: "Show provenance" }).click();
  await expect(contactsPanel.getByText("Imported list").first()).toBeVisible();
  await expect(
    contactsPanel.getByText("import:outreach-e2e.csv#row-1").first(),
  ).toBeVisible();
  await expect(
    contactsPanel.getByText("Confirmed by you").first(),
  ).toBeVisible();

  const researchPanel = jobDrawer.locator(".job-research-section");
  await expect(researchPanel.getByLabel("Research candidates")).toBeVisible();
  await expect(researchPanel.getByText("Dana Lee").first()).toBeVisible();
  await expect(
    researchPanel.getByText("dana.lee@example.test").first(),
  ).toBeVisible();
  await expect(
    researchPanel.getByText("Public web page").first(),
  ).toBeVisible();
  await expect(
    researchPanel.getByText("https://example.test/team").first(),
  ).toBeVisible();
  await researchPanel
    .locator("summary", { hasText: "Sources attempted" })
    .click();
  await expect(
    researchPanel.getByText("source fetched under e2e policy"),
  ).toBeVisible();
  await expect(
    researchPanel.getByText("login-walled page routed to manual capture"),
  ).toBeVisible();

  const [confirmResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(
            `/v1/contacts/research/${TASK_ID}/candidates/${CANDIDATE_ID}/confirm`,
          ) && response.request().method() === "POST",
      { timeout: 30_000 },
    ),
    researchPanel.getByRole("button", { name: "Confirm contact" }).click(),
  ]);
  expect(confirmResponse.status()).toBe(200);
  expect(await confirmResponse.json()).toMatchObject({ ok: true });
  await expect(
    researchPanel.getByText("Confirmed into your contacts."),
  ).toBeVisible();

  await page.goto("/outreach");
  await expect(
    page.getByRole("heading", { name: "Follow-ups due" }),
  ).toBeVisible();
  await expect(page.getByText("application_submitted")).toBeVisible();
  await expect(page.getByText("no_reply_nudge")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open contact Casey Recruiter: View details" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open contact Dana Lee: View details" }),
  ).toBeVisible();

  await page
    .locator("tr")
    .filter({ hasText: "Casey Recruiter" })
    .getByRole("rowheader")
    .click();
  const contactDialog = page.getByRole("article", { name: "Contact details" });
  await expect(contactDialog).toBeVisible({ timeout: 10_000 });
  await expect(contactDialog.getByText("Facts and provenance")).toBeVisible();
  await expect(
    contactDialog.getByRole("heading", { name: "Approved message" }),
  ).toBeVisible();
  await expect(
    contactDialog.getByRole("button", { name: "Copy approved message" }),
  ).toBeVisible();
  await expect(
    contactDialog.getByRole("button", { name: /^send$/i }),
  ).toHaveCount(0);

  await contactDialog
    .locator("summary", { hasText: "Provenance and gate results" })
    .click();
  await expect(
    contactDialog.getByText("Truthfulness gates passed").first(),
  ).toBeVisible();
  await expect(
    contactDialog.getByText("Bound to imported recruiter name.").first(),
  ).toBeVisible();
  await expect(
    contactDialog.getByText("Truthfulness gates blocked this draft").first(),
  ).toBeVisible();
  await expect(
    contactDialog.getByRole("button", { name: "Approve draft" }),
  ).toBeDisabled();

  await contactDialog
    .getByRole("button", { name: "Revise approved message" })
    .click();
  await expect(contactDialog.getByLabel("Edit message")).toBeVisible();
  await expect(
    contactDialog.getByRole("heading", { name: "Approved message" }),
  ).toBeVisible();

  await contactDialog.getByRole("button", { name: "Log a send" }).click();
  await contactDialog.getByRole("combobox", { name: "Channel" }).click();
  await page.getByRole("option", { name: "LinkedIn message" }).click();
  await contactDialog.getByLabel("Date you sent it").fill("2026-07-06");
  let acceptedBeforeLoss: LogOutreachSendResponse | undefined;
  let originalPayload: string | null = null;
  await page.route(`**/v1/outreach/threads/${CONTACT_THREAD_ID}/send-logs`, async (route) => {
    if (acceptedBeforeLoss) return route.continue();
    originalPayload = route.request().postData();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    acceptedBeforeLoss = await response.json() as LogOutreachSendResponse;
    await route.abort("failed");
  });
  await contactDialog.getByRole("button", { name: "Record send" }).click();
  await expect(contactDialog.locator(".send-log-form").getByRole("alert")).toBeVisible();
  await expect(contactDialog.getByLabel("Date you sent it")).toHaveValue("2026-07-06");
  await expect(contactDialog.getByLabel("Date you sent it")).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("send-log-lost-ack.png") });
  const [sendLogResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(`/v1/outreach/threads/${CONTACT_THREAD_ID}/send-logs`) &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    ),
    contactDialog.getByRole("button", { name: "Record send" }).click(),
  ]);
  expect(sendLogResponse.status()).toBe(200);
  expect(await sendLogResponse.json()).toEqual(acceptedBeforeLoss);
  expect(sendLogResponse.request().postData()).toBe(originalPayload);
  const acceptedId = acceptedBeforeLoss!.sendLog.sendLogId;
  const verificationDb = new Database(dbPath, { readonly: true });
  try {
    expect(verificationDb.prepare("SELECT count(*) AS n FROM outreach_send_logs WHERE tenant_id='local' AND send_log_id=?").get(acceptedId)).toEqual({ n: 1 });
    expect(verificationDb.prepare("SELECT count(*) AS n FROM job_events WHERE tenant_id='local' AND event_type='OutreachSendLogged' AND json_extract(payload_json, '$.sendLogId')=?").get(acceptedId)).toEqual({ n: 1 });
  } finally { verificationDb.close(); }
  await expect(contactDialog.getByText("linkedin_message")).toBeVisible();

  const [completeResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(
            `/v1/outreach/threads/${CONTACT_THREAD_ID}/follow-up/complete`,
          ) && response.request().method() === "POST",
      { timeout: 30_000 },
    ),
    contactDialog.getByRole("button", { name: "Mark done" }).click(),
  ]);
  expect(completeResponse.status()).toBe(200);
  await expect(
    contactDialog.getByText(
      "Last follow-up completed. Schedule a new reminder:",
    ),
  ).toBeVisible();

  assertSensitiveValuesStayOutOfEventsAndProjections(dbPath);
});

// Presentation fixture: worker/HTTP tests separately establish persistence.
// Keep this on the existing owned Playwright services and synthetic seed.
test("Outreach conflict retains edits and completed checks after the review card disappears", async ({ page }) => {
  const dbPath = loadE2eDbPath();
  seedOutreachPlanner(dbPath);
  const edited = "Synthetic edit retained for deliberate reconciliation.";
  let attempts = 0;
  await page.route(`**/v1/outreach/threads/${CONTACT_THREAD_ID}/drafts`, async (route) => {
    attempts += 1;
    const db = new Database(dbPath);
    try {
      // Simulate a concurrent accepted review while the revision is delayed.
      db.prepare("UPDATE outreach_drafts SET status='rejected', rejected_at=?, reason='Synthetic concurrent review' WHERE tenant_id='local' AND draft_id='draft-e2e-blocked'").run(NOW);
    } finally { db.close(); }
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({
      ok: false, error: "outreach_publication_conflict", outcome: "conflict", threadId: CONTACT_THREAD_ID,
      message: "Outreach changed while this draft was being verified.",
      unpublishedDraft: {
        bodyText: edited, kind: "intro_request", provenance: [],
        gateResults: {
          passed: true, computedAgainst: "rendered_draft", determinationIds: ["synthetic-claim-check", "synthetic-quality-check"],
          lineAnchors: [], sourceContext: null, fabrications: [],
          validation: { passed: true, errors: [], warnings: [] },
          judge: { approved: true, score: 0.9, criterionScores: {}, issues: [], notes: "Explicit synthetic quality review" },
        },
      },
    }) });
  });
  await page.goto(`/outreach/${CONTACT_ID}`);
  const panel = page.getByRole("article", { name: "Contact details" });
  await expect(panel.getByRole("heading", { name: "Draft under review" })).toBeVisible();
  await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
  await panel.getByRole("textbox", { name: "Edit message" }).fill(edited);
  await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
  const conflict = panel.getByRole("group", { name: "Unpublished revision" });
  await expect(conflict).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Draft under review" })).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Approved message" })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Edit message" })).toHaveValue(edited);
  await conflict.getByText("Unpublished message and completed verification").click();
  await expect(conflict.getByText(/synthetic-claim-check/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Revise draft", exact: true })).toBeDisabled();
  expect(attempts).toBe(1);
  await conflict.getByRole("checkbox", { name: /I compared the current thread/ }).check();
  await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(panel.getByRole("button", { name: "Revise draft", exact: true })).toBeDisabled();
});

// Presentation-only response fixture; normal HTTP/RPC creation races are
// separately exercised by the API/worker regressions.
test("Generation conflict keeps its completed proposal through a failed deliberate retry", async ({ page }) => {
  seedOutreachPlanner(loadE2eDbPath());
  const body = "Synthetic generated proposal retained for comparison.";
  let calls = 0;
  await page.route(`**/v1/contacts/${CONTACT_ID}/outreach/drafts`, async (route) => {
    calls += 1;
    if (calls > 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic generation provider unavailable" }) });
      return;
    }
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({
      ok: false, error: "outreach_publication_conflict", outcome: "conflict", threadId: "unpublished-competing-thread",
      message: "Outreach changed while this draft was being verified.",
      unpublishedDraft: {
        bodyText: body, kind: "intro_request",
        provenance: [{ claimId: "synthetic-generated-claim", section: "body", generatedText: body, contactFactIds: [], profileGrounded: false, rationale: "Explicit synthetic source choice" }],
        gateResults: {
          passed: true, computedAgainst: "rendered_draft", determinationIds: ["synthetic-generated-check", "synthetic-quality-check"],
          lineAnchors: [], sourceContext: null, fabrications: [],
          validation: { passed: true, errors: [], warnings: [] },
          judge: { approved: true, score: 0.9, criterionScores: {}, issues: [], notes: "Explicit synthetic quality review" },
        },
      },
    }) });
  });
  await page.goto(`/outreach/${CONTACT_ID}`);
  const panel = page.getByRole("article", { name: "Contact details" });
  await expect(panel.getByRole("heading", { name: "Approved message" })).toBeVisible();
  await panel.getByRole("button", { name: "Generate draft", exact: true }).click();
  const proposal = panel.getByRole("group", { name: "Unpublished draft" });
  await expect(proposal).toBeVisible();
  await proposal.getByText("Unpublished message and completed verification").click();
  await expect(proposal.getByText(body, { exact: true })).toBeVisible();
  await expect(proposal.getByText(/synthetic-generated-check/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Generate draft", exact: true })).toBeDisabled();
  expect(calls).toBe(1);
  await proposal.getByRole("checkbox", { name: /I compared the current thread/ }).check();
  await panel.getByRole("button", { name: "Generate draft", exact: true }).click();
  await expect(panel.getByText("Synthetic generation provider unavailable")).toBeVisible();
  await expect(proposal.getByText(body, { exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Approved message" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Generate draft", exact: true })).toBeDisabled();
  expect(calls).toBe(2);
});

// Presentation fixture: a synthetic response and owned database model a saved
// revision; the HTTP/RPC worker races separately prove persistence authority.
test("Later typing remains available after the submitted revision succeeds", async ({ page }) => {
  const dbPath = loadE2eDbPath();
  seedOutreachPlanner(dbPath);
  const baseline = new Database(dbPath, { readonly: true });
  const approved = baseline.prepare("SELECT * FROM outreach_drafts WHERE tenant_id='local' AND draft_id='draft-e2e-approved'").get();
  const sends = baseline.prepare("SELECT * FROM outreach_send_logs WHERE tenant_id='local' AND thread_id=? ORDER BY send_log_id").all(CONTACT_THREAD_ID);
  const followUp = baseline.prepare("SELECT follow_up_due_at, follow_up_basis, follow_up_state FROM outreach_threads WHERE tenant_id='local' AND thread_id=?").get(CONTACT_THREAD_ID);
  baseline.close();

  const submitted = "Synthetic submitted revision A";
  const later = "Synthetic later edit B";
  const requests: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/v1/outreach/threads/${CONTACT_THREAD_ID}/drafts`, async (route) => {
    const body = route.request().postDataJSON() as { editedBodyText: string };
    requests.push(body.editedBodyText);
    if (requests.length === 1) await held;
    const db = new Database(dbPath);
    try {
      db.transaction(() => {
        db.prepare("UPDATE outreach_drafts SET status='superseded' WHERE tenant_id='local' AND thread_id=? AND status='candidate'").run(CONTACT_THREAD_ID);
        db.prepare(`INSERT INTO outreach_drafts
          (tenant_id, draft_id, thread_id, generation, kind, status, body_text, gate_results_json, provenance_json, created_at, approved_at, rejected_at, reason)
          SELECT 'local', ?, thread_id, (SELECT MAX(generation) + 1 FROM outreach_drafts WHERE tenant_id='local' AND thread_id=?),
            kind, 'candidate', ?, gate_results_json, provenance_json, ?, NULL, NULL, ''
          FROM outreach_drafts WHERE tenant_id='local' AND draft_id='draft-e2e-approved'`).run(`draft-e2e-published-${requests.length}`, CONTACT_THREAD_ID, body.editedBodyText, NOW);
      })();
    } finally { db.close(); }
    const current = await page.request.get(`/v1/contacts/${CONTACT_ID}/outreach`);
    expect(current.ok()).toBe(true);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(publishedRevision(await current.json(), `draft-e2e-published-${requests.length}`)) });
  });
  await page.goto(`/outreach/${CONTACT_ID}`);
  const panel = page.getByRole("article", { name: "Contact details" });
  await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
  const input = panel.getByRole("textbox", { name: "Edit message" });
  await input.fill(submitted);
  await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
  await expect.poll(() => requests).toEqual([submitted]);
  await input.fill(later);
  release();
  await expect(panel.getByText(/newer edits remain here and have not been verified/i)).toBeVisible();
  await expect(input).toHaveValue(later);
  await expect(panel.getByText(submitted, { exact: true }).first()).toBeVisible();
  expect(requests).toEqual([submitted]);
  await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
  await expect.poll(() => requests).toEqual([submitted, later]);
  await expect(input).toHaveCount(0);
  await expect(panel.getByText(later, { exact: true }).first()).toBeVisible();

  const after = new Database(dbPath, { readonly: true });
  try {
    expect(after.prepare("SELECT * FROM outreach_drafts WHERE tenant_id='local' AND draft_id='draft-e2e-approved'").get()).toEqual(approved);
    expect(after.prepare("SELECT * FROM outreach_send_logs WHERE tenant_id='local' AND thread_id=? ORDER BY send_log_id").all(CONTACT_THREAD_ID)).toEqual(sends);
    expect(after.prepare("SELECT follow_up_due_at, follow_up_basis, follow_up_state FROM outreach_threads WHERE tenant_id='local' AND thread_id=?").get(CONTACT_THREAD_ID)).toEqual(followUp);
  } finally { after.close(); }
});

// Synthetic publication and a withheld response body exercise the real editor,
// HTTP client and read API without running a model or sending a message.
test("An unconfirmed revision retains submitted and newer text until reviewed", async ({ page }, testInfo) => {
  const dbPath = loadE2eDbPath();
  seedOutreachPlanner(dbPath);
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  await page.addInitScript((threadId) => {
    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      originalTimeout(handler, timeout === 120_000 ? 2_000 : timeout, ...args)) as typeof window.setTimeout;
    const originalFetch = window.fetch.bind(window);
    let held = false;
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!held && init?.method === "POST" && url.endsWith(`/v1/outreach/threads/${threadId}/drafts`)) {
        held = true;
        await response.text();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"thread":'));
            init.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
          },
        });
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return response;
    };
  }, CONTACT_THREAD_ID);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/v1/outreach/threads/${CONTACT_THREAD_ID}/drafts`, async (route) => {
    const body = route.request().postDataJSON() as { editedBodyText: string };
    requests.push(body.editedBodyText);
    if (requests.length === 1) await held;
    const db = new Database(dbPath);
    try {
      db.transaction(() => {
        db.prepare("UPDATE outreach_drafts SET status='superseded' WHERE tenant_id='local' AND thread_id=? AND status='candidate'").run(CONTACT_THREAD_ID);
        db.prepare(`INSERT INTO outreach_drafts
          (tenant_id,draft_id,thread_id,generation,kind,status,body_text,gate_results_json,provenance_json,created_at,approved_at,rejected_at,reason)
          SELECT 'local',?,thread_id,(SELECT MAX(generation)+1 FROM outreach_drafts WHERE tenant_id='local' AND thread_id=?),
            kind,'candidate',?,gate_results_json,provenance_json,?,NULL,NULL,''
          FROM outreach_drafts WHERE tenant_id='local' AND draft_id='draft-e2e-approved'`)
          .run(`draft-e2e-timeout-${requests.length}`, CONTACT_THREAD_ID, body.editedBodyText, NOW);
      })();
    } finally { db.close(); }
    const current = await page.request.get(`/v1/contacts/${CONTACT_ID}/outreach`);
    expect(current.ok()).toBe(true);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(publishedRevision(await current.json(), `draft-e2e-timeout-${requests.length}`)) });
  });
  try {
    await page.goto(`/outreach/${CONTACT_ID}`);
    await expect(page).toHaveTitle(/JobCtrl/);
    const panel = page.getByRole("article", { name: "Contact details" });
    await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
    const input = panel.getByRole("textbox", { name: "Edit message" });
    await input.fill("Synthetic submitted A");
    await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
    await expect.poll(() => requests).toEqual(["Synthetic submitted A"]);
    await input.fill("Synthetic later B");
    release();
    const unconfirmed = panel.getByRole("group", { name: "Unconfirmed revision" });
    await expect(unconfirmed).toContainText("Synthetic submitted A");
    await expect(unconfirmed).toContainText("may have been saved");
    await expect(input).toHaveValue("Synthetic later B");
    await expect(panel.getByRole("button", { name: "Revise draft", exact: true })).toBeDisabled();
    expect(requests).toEqual(["Synthetic submitted A"]);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT body_text FROM outreach_drafts WHERE tenant_id='local' AND draft_id='draft-e2e-timeout-1'").get())
        .toEqual({ body_text: "Synthetic submitted A" });
      expect(db.prepare("SELECT status FROM outreach_drafts WHERE tenant_id='local' AND draft_id='draft-e2e-approved'").get())
        .toEqual({ status: "approved" });
    } finally { db.close(); }
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("outreach-unconfirmed-synthetic.png") });
    await unconfirmed.getByRole("checkbox", { name: /I checked the current thread/ }).check();
    await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
    await expect.poll(() => requests).toEqual(["Synthetic submitted A", "Synthetic later B"]);
    await expect(input).toHaveCount(0);
  } finally { release(); }
});

for (const responseKind of ["invalid success", "server error"] as const) {
  test(`A ${responseKind} after a revision keeps both edits until review`, async ({ page }, testInfo) => {
    const dbPath = loadE2eDbPath();
    seedOutreachPlanner(dbPath);
    const requests: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/v1/outreach/threads/${CONTACT_THREAD_ID}/drafts`, async (route) => {
      const body = route.request().postDataJSON() as { editedBodyText: string };
      requests.push(body.editedBodyText);
      if (requests.length === 1) await held;
      const db = new Database(dbPath);
      try {
        db.transaction(() => {
          db.prepare("UPDATE outreach_drafts SET status='superseded' WHERE tenant_id='local' AND thread_id=? AND status='candidate'").run(CONTACT_THREAD_ID);
          db.prepare(`INSERT INTO outreach_drafts
            (tenant_id,draft_id,thread_id,generation,kind,status,body_text,gate_results_json,provenance_json,created_at,approved_at,rejected_at,reason)
            SELECT 'local',?,thread_id,(SELECT MAX(generation)+1 FROM outreach_drafts WHERE tenant_id='local' AND thread_id=?),
              kind,'candidate',?,gate_results_json,provenance_json,?,NULL,NULL,''
            FROM outreach_drafts WHERE tenant_id='local' AND draft_id='draft-e2e-approved'`)
            .run(`draft-e2e-unconfirmed-${requests.length}`, CONTACT_THREAD_ID, body.editedBodyText, NOW);
        })();
      } finally { db.close(); }
      if (requests.length === 1) {
        await route.fulfill(responseKind === "invalid success"
          ? { status: 200, contentType: "application/json", body: "null" }
          : { status: 500, contentType: "application/json", body: JSON.stringify({ error: "db_write_failed", message: "Synthetic post-commit failure" }) });
        return;
      }
      const current = await page.request.get(`/v1/contacts/${CONTACT_ID}/outreach`);
      expect(current.ok()).toBe(true);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(publishedRevision(await current.json(), `draft-e2e-unconfirmed-${requests.length}`)) });
    });
    try {
      await page.goto(`/outreach/${CONTACT_ID}`);
      const panel = page.getByRole("article", { name: "Contact details" });
      await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
      const input = panel.getByRole("textbox", { name: "Edit message" });
      await input.fill("Synthetic submitted A");
      await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
      await expect.poll(() => requests).toEqual(["Synthetic submitted A"]);
      await input.fill("Synthetic later B");
      release();
      const unconfirmed = panel.getByRole("group", { name: "Unconfirmed revision" });
      await expect(unconfirmed).toContainText("Synthetic submitted A");
      await expect(input).toHaveValue("Synthetic later B");
      await expect(panel.getByRole("button", { name: "Revise draft", exact: true })).toBeDisabled();
      expect(requests).toEqual(["Synthetic submitted A"]);
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.prepare("SELECT body_text FROM outreach_drafts WHERE tenant_id='local' AND draft_id='draft-e2e-unconfirmed-1'").get())
          .toEqual({ body_text: "Synthetic submitted A" });
      } finally { db.close(); }
      await page.screenshot({ path: testInfo.outputPath(`outreach-${responseKind.replace(" ", "-")}.png`) });
      await unconfirmed.getByRole("checkbox", { name: /I checked the current thread/ }).check();
      await panel.getByRole("button", { name: "Revise draft", exact: true }).click();
      await expect.poll(() => requests).toEqual(["Synthetic submitted A", "Synthetic later B"]);
      await expect(input).toHaveCount(0);
    } finally { release(); }
  });
}
