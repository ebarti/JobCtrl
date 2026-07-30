/**
 * Contact & Outreach (ninth context) — supervised research read model + the
 * candidate-confirmation write path (R6 Phase 2).
 *
 * Research runs (fetch + LLM) execute on the Python worker via Temporal; this
 * module hosts the two TS-side surfaces: the projection-backed reads (task list
 * + task detail with candidate values joined from canonical rows) and the
 * candidate-confirmation state transition (integration.md §6.8). Confirmation is
 * the explicit user command that promotes a needs_review candidate into a stored
 * Contact fact (INV-4), preserving the candidate's research provenance while
 * marking it user-confirmed (INV-2). There is no send transport here (INV-1).
 *
 * Sensitivity (plan §6): candidate attribute VALUES live only in
 * ``contact_candidates.attributes_json`` and reach the client solely through the
 * detail DTO — never in event payloads, projections, logs, or telemetry.
 */

import crypto from "node:crypto";

import type {
  CandidateStatus,
  ConfirmContactCandidateResponse,
  ContactAttributeDto,
  ContactCandidateDto,
  ContactDetail,
  ContactResearchListQuery,
  ContactResearchSourceAttempt,
  ContactResearchTaskDetail,
  ContactResearchTaskSummary,
  ContactRole,
  ResearchTaskStatus,
} from "./contracts.js";
import { CONTACT_ROLES } from "@jobctrl/domain-types";
import { ensureContactTables, getContactDetail } from "./contacts.js";
import {
  allRows,
  getRow,
  hasCompositeJobIdForeignKeyAction,
  jobReferenceColumn,
  jobReferenceForUrl,
  tableColumnSet,
  tableIndexColumns,
  tableExists,
  type SqliteDatabase,
  type SqliteValue,
} from "./db.js";
import { refreshContactResearchProjections, refreshProjections } from "./projections.js";

const TENANT_ID = "local";

export class ContactResearchNotFoundError extends Error {}
export class ContactResearchInputError extends Error {}

export function ensureContactResearchTables(db: SqliteDatabase): void {
  ensureContactTables(db);
  const schemaVersion = Number(db.pragma("user_version", { simple: true }));
  const stableReferences = schemaVersion >= 24;
  const referenceColumn = stableReferences ? "job_id" : "job_url";
  const foreignKey = stableReferences
    ? `, FOREIGN KEY (tenant_id, job_id)
         REFERENCES jobs(tenant_id, job_id) ON DELETE RESTRICT`
    : "";
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_research_tasks (
      tenant_id            TEXT NOT NULL DEFAULT 'local',
      task_id              TEXT NOT NULL,
      employer             TEXT,
      ${referenceColumn}    TEXT,
      status               TEXT NOT NULL DEFAULT 'queued',
      source_attempts_json TEXT NOT NULL DEFAULT '[]',
      started_at           TEXT,
      updated_at           TEXT NOT NULL,
      needs_review_at      TEXT,
      completed_at         TEXT,
      failed_at            TEXT,
      error_class          TEXT,
      PRIMARY KEY (tenant_id, task_id)
      ${foreignKey}
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
    CREATE INDEX IF NOT EXISTS idx_contact_candidates_task
      ON contact_candidates(tenant_id, task_id, status);
  `);
  const columns = tableColumnSet(db, "contact_research_tasks");
  if (
    stableReferences
    && (!columns.has("job_id") || columns.has("job_url"))
  ) {
    throw new Error(
      "Schema v24 requires stable contact_research_tasks.job_id references.",
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_contact_research_tasks_lookup
       ON contact_research_tasks(tenant_id, employer, ${referenceColumn})`,
  );
  if (
    stableReferences
    && (
      !hasCompositeJobIdForeignKeyAction(
        db,
        "contact_research_tasks",
        "job_id",
        "RESTRICT",
      )
      || tableIndexColumns(
        db,
        "contact_research_tasks",
        "idx_contact_research_tasks_lookup",
      ).join(",") !== "tenant_id,employer,job_id"
    )
  ) {
    throw new Error(
      "Schema v24 requires the restrictive contact-research JobId contract.",
    );
  }
}

// ---------------------------------------------------------------------------
// Reads (projection-backed list; canonical join for candidate values)
// ---------------------------------------------------------------------------

type ResearchTaskProjectionRow = {
  task_id: string;
  employer: string | null;
  job_id: string | null;
  status: string | null;
  candidate_count: number | null;
  needs_review_count: number | null;
  confirmed_count: number | null;
  started_at: string | null;
  updated_at: string | null;
  needs_review_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error_class: string | null;
};

export function listResearchTasks(
  db: SqliteDatabase,
  query: ContactResearchListQuery = { jobId: "", employer: "" },
): ContactResearchTaskSummary[] {
  ensureContactResearchTables(db);
  refreshProjections(db, TENANT_ID);
  const filters: string[] = ["tenant_id = ?"];
  const params: SqliteValue[] = [TENANT_ID];
  const jobId = (query.jobId ?? "").trim();
  const employer = (query.employer ?? "").trim();
  if (jobId) {
    filters.push("job_id = ?");
    params.push(jobId);
  }
  if (employer) {
    filters.push("employer = ?");
    params.push(employer);
  }
  const rows = allRows<ResearchTaskProjectionRow>(
    db,
    `SELECT * FROM contact_research_task_projections WHERE ${filters.join(" AND ")}
     ORDER BY updated_at DESC, task_id ASC`,
    params,
  );
  return rows.map(toSummary);
}

export function getResearchTaskDetail(
  db: SqliteDatabase,
  taskId: string,
): ContactResearchTaskDetail | null {
  ensureContactResearchTables(db);
  refreshProjections(db, TENANT_ID);
  const task = loadTaskRow(db, taskId);
  if (!task) {
    return null;
  }
  const candidates = loadCandidates(db, taskId);
  return {
    ...taskSummaryFromCanonical(task, candidates),
    sourceAttempts: parseSourceAttempts(task.source_attempts_json),
    candidates,
  };
}

/**
 * Pre-create a ``queued`` research task synchronously so the UI can read it the
 * instant the run is requested (before the async worker transitions it). Emits
 * ``ContactResearchTaskStarted``; the worker later advances it to running ->
 * needs_review (its repository does not re-emit Started because the row exists).
 */
export function createQueuedResearchTask(
  db: SqliteDatabase,
  input: { taskId: string; employer: string | null; jobId: string | null },
): ContactResearchTaskSummary {
  ensureContactResearchTables(db);
  const now = new Date().toISOString();
  const referenceColumn = jobReferenceColumn(
    db,
    "contact_research_tasks",
  );
  const referenceValue = physicalResearchJobReference(
    db,
    input.jobId,
  );
  db.prepare(
    `INSERT INTO contact_research_tasks (
       tenant_id, task_id, employer, ${referenceColumn}, status, source_attempts_json, started_at, updated_at
     ) VALUES (?, ?, ?, ?, 'queued', '[]', ?, ?)
     ON CONFLICT(tenant_id, task_id) DO NOTHING`,
  ).run(
    TENANT_ID,
    input.taskId,
    input.employer,
    referenceValue,
    now,
    now,
  );
  recordEvent(db, {
    jobUrl: input.jobId,
    eventType: "ContactResearchTaskStarted",
    entityKind: "contact_research",
    entityRef: input.taskId,
    payload: {
      tenantId: TENANT_ID,
      taskId: input.taskId,
      employer: input.employer,
      jobId: input.jobId,
      startedAt: now,
    },
  });
  refreshContactResearchProjections(db, TENANT_ID);
  const task = loadTaskRow(db, input.taskId);
  return task
    ? taskSummaryFromCanonical(task, [])
    : ({
        taskId: input.taskId,
        employer: input.employer,
        jobId: input.jobId,
        status: "queued",
        candidateCount: 0,
        needsReviewCount: 0,
        confirmedCount: 0,
        startedAt: now,
        updatedAt: now,
        needsReviewAt: null,
        completedAt: null,
        failedAt: null,
        errorClass: null,
      } satisfies ContactResearchTaskSummary);
}

// ---------------------------------------------------------------------------
// Confirm candidate (the explicit user command — INV-4)
// ---------------------------------------------------------------------------

export function confirmContactCandidate(
  db: SqliteDatabase,
  taskId: string,
  candidateId: string,
  role?: ContactRole,
): ConfirmContactCandidateResponse {
  ensureContactResearchTables(db);
  const task = loadTaskRow(db, taskId);
  if (!task) {
    throw new ContactResearchNotFoundError(`Research task ${taskId} not found`);
  }
  const candidate = getRow<CandidateRow>(
    db,
    "SELECT * FROM contact_candidates WHERE tenant_id = ? AND task_id = ? AND candidate_id = ?",
    [TENANT_ID, taskId, candidateId],
  );
  if (!candidate) {
    throw new ContactResearchNotFoundError(`Candidate ${candidateId} not found`);
  }
  if (String(candidate.status) !== "needs_review") {
    throw new ContactResearchInputError(`Candidate ${candidateId} is not awaiting review`);
  }

  const now = new Date().toISOString();
  const contactId = crypto.randomUUID();
  const attributes = parseCandidateAttributes(candidate.attributes_json);
  const contactRole = role ?? normalizeRole(candidate.role);
  const employer = task.employer ?? null;
  const jobId = task.job_url ?? null;

  const transaction = db.transaction(() => {
    const contactReferenceColumn = jobReferenceColumn(db, "contacts");
    const contactReferenceValue =
      jobId === null
        ? null
        : jobReferenceForUrl(db, "contacts", jobId, TENANT_ID);
    db.prepare(
      `INSERT INTO contacts (tenant_id, contact_id, employer, ${contactReferenceColumn}, role, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      TENANT_ID,
      contactId,
      employer,
      contactReferenceValue,
      contactRole,
      now,
      now,
    );
    const insertAttr = db.prepare(
      `INSERT INTO contact_attributes (
         tenant_id, attribute_id, contact_id, attribute_kind, value_json,
         source_kind, source_ref, capture_method, confidence, user_confirmed, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    recordEvent(db, {
      jobUrl: jobId,
      eventType: "ContactCreated",
      entityKind: "contact",
      entityRef: contactId,
      payload: { tenantId: TENANT_ID, contactId, employer, jobId, role: contactRole, createdAt: now },
    });
    for (const attribute of attributes) {
      const attributeId = attribute.attributeId || crypto.randomUUID();
      insertAttr.run(
        TENANT_ID,
        attributeId,
        contactId,
        attribute.kind,
        JSON.stringify(attribute.value),
        attribute.provenance.sourceKind,
        attribute.provenance.sourceRef,
        attribute.provenance.captureMethod,
        attribute.provenance.confidence,
        now,
      );
      recordEvent(db, {
        jobUrl: jobId,
        eventType: "ContactAttributeRecorded",
        entityKind: "contact",
        entityRef: contactId,
        payload: {
          tenantId: TENANT_ID,
          contactId,
          attributeId,
          attributeKind: attribute.kind,
          sourceKind: attribute.provenance.sourceKind,
          sourceRef: attribute.provenance.sourceRef,
          captureMethod: attribute.provenance.captureMethod,
          confidence: attribute.provenance.confidence,
          userConfirmed: true,
          recordedAt: now,
        },
      });
    }
    db.prepare(
      `UPDATE contact_candidates
         SET status = 'confirmed', confirmed_contact_id = ?, confirmed_at = ?
       WHERE tenant_id = ? AND task_id = ? AND candidate_id = ?`,
    ).run(contactId, now, TENANT_ID, taskId, candidateId);

    const remaining =
      getRow<{ c: number }>(
        db,
        "SELECT COUNT(*) AS c FROM contact_candidates WHERE tenant_id = ? AND task_id = ? AND status = 'needs_review'",
        [TENANT_ID, taskId],
      )?.c ?? 0;
    if (remaining === 0) {
      const confirmedCount =
        getRow<{ c: number }>(
          db,
          "SELECT COUNT(*) AS c FROM contact_candidates WHERE tenant_id = ? AND task_id = ? AND status = 'confirmed'",
          [TENANT_ID, taskId],
        )?.c ?? 0;
      db.prepare(
        "UPDATE contact_research_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE tenant_id = ? AND task_id = ?",
      ).run(now, now, TENANT_ID, taskId);
      recordEvent(db, {
        jobUrl: jobId,
        eventType: "ContactResearchTaskCompleted",
        entityKind: "contact_research",
        entityRef: taskId,
        payload: { tenantId: TENANT_ID, taskId, confirmedCount, completedAt: now },
      });
    } else {
      db.prepare(
        "UPDATE contact_research_tasks SET updated_at = ? WHERE tenant_id = ? AND task_id = ?",
      ).run(now, TENANT_ID, taskId);
    }
  });
  transaction();

  refreshProjections(db, TENANT_ID);
  refreshContactResearchProjections(db, TENANT_ID);

  const contact = getContactDetail(db, contactId);
  if (!contact) {
    throw new ContactResearchNotFoundError(`Contact ${contactId} not found after confirmation`);
  }
  const refreshed = loadTaskRow(db, taskId);
  return {
    ok: true,
    contact,
    task: refreshed
      ? taskSummaryFromCanonical(refreshed, loadCandidates(db, taskId))
      : ({} as ContactResearchTaskSummary),
  } satisfies ConfirmContactCandidateResponse;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type TaskRow = {
  task_id: string;
  employer: string | null;
  job_url: string | null;
  status: string | null;
  source_attempts_json: string | null;
  started_at: string | null;
  updated_at: string | null;
  needs_review_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error_class: string | null;
};

type CandidateRow = {
  candidate_id: string;
  task_id: string;
  role: string | null;
  attributes_json: string | null;
  source_kind: string;
  source_ref: string;
  capture_method: string | null;
  confidence: number | null;
  status: string | null;
  proposed_at: string | null;
  confirmed_contact_id: string | null;
  confirmed_at: string | null;
};

function loadTaskRow(db: SqliteDatabase, taskId: string): TaskRow | null {
  const referenceColumn = jobReferenceColumn(
    db,
    "contact_research_tasks",
  );
  const stableReferences = referenceColumn === "job_id";
  return (
    getRow<TaskRow>(
      db,
      `SELECT contact_research_tasks.task_id,
              contact_research_tasks.employer,
              ${stableReferences
                ? "jobs.url"
                : "contact_research_tasks.job_url"} AS job_url,
              contact_research_tasks.status,
              contact_research_tasks.source_attempts_json,
              contact_research_tasks.started_at,
              contact_research_tasks.updated_at,
              contact_research_tasks.needs_review_at,
              contact_research_tasks.completed_at,
              contact_research_tasks.failed_at,
              contact_research_tasks.error_class
         FROM contact_research_tasks
         ${stableReferences
           ? `LEFT JOIN jobs
                ON jobs.tenant_id = contact_research_tasks.tenant_id
               AND jobs.job_id = contact_research_tasks.job_id`
           : ""}
        WHERE contact_research_tasks.tenant_id = ?
          AND contact_research_tasks.task_id = ?`,
      [TENANT_ID, taskId],
    ) ?? null
  );
}

function physicalResearchJobReference(
  db: SqliteDatabase,
  jobUrl: string | null,
): string | null {
  if (jobUrl === null) {
    return null;
  }
  try {
    return jobReferenceForUrl(
      db,
      "contact_research_tasks",
      jobUrl,
      TENANT_ID,
    );
  } catch {
    throw new ContactResearchInputError(
      `No stable Job identity exists for ${jobUrl}.`,
    );
  }
}

function loadCandidates(db: SqliteDatabase, taskId: string): ContactCandidateDto[] {
  const rows = allRows<CandidateRow>(
    db,
    `SELECT * FROM contact_candidates
     WHERE tenant_id = ? AND task_id = ?
     ORDER BY proposed_at ASC, candidate_id ASC`,
    [TENANT_ID, taskId],
  );
  return rows.map((row) => ({
    candidateId: String(row.candidate_id),
    taskId: String(row.task_id),
    role: normalizeRole(row.role),
    status: normalizeCandidateStatus(row.status),
    confidence: Number(row.confidence ?? 0),
    provenance: {
      sourceKind: String(row.source_kind) as ContactCandidateDto["provenance"]["sourceKind"],
      sourceRef: String(row.source_ref),
      captureMethod: String(row.capture_method ?? "llm_assisted"),
      capturedAt: String(row.proposed_at ?? ""),
      confidence: Number(row.confidence ?? 0),
      userConfirmed: String(row.status) === "confirmed",
    },
    attributes: parseCandidateAttributes(row.attributes_json),
    confirmedContactId: row.confirmed_contact_id ?? null,
    confirmedAt: row.confirmed_at ?? null,
  }));
}

function toSummary(row: ResearchTaskProjectionRow): ContactResearchTaskSummary {
  return {
    taskId: String(row.task_id),
    employer: row.employer ?? null,
    jobId: row.job_id ?? null,
    status: normalizeStatus(row.status),
    candidateCount: Number(row.candidate_count ?? 0),
    needsReviewCount: Number(row.needs_review_count ?? 0),
    confirmedCount: Number(row.confirmed_count ?? 0),
    startedAt: row.started_at ?? null,
    updatedAt: row.updated_at ?? null,
    needsReviewAt: row.needs_review_at ?? null,
    completedAt: row.completed_at ?? null,
    failedAt: row.failed_at ?? null,
    errorClass: row.error_class ?? null,
  };
}

function taskSummaryFromCanonical(
  task: TaskRow,
  candidates: ContactCandidateDto[],
): ContactResearchTaskSummary {
  return {
    taskId: String(task.task_id),
    employer: task.employer ?? null,
    jobId: task.job_url ?? null,
    status: normalizeStatus(task.status),
    candidateCount: candidates.length,
    needsReviewCount: candidates.filter((candidate) => candidate.status === "needs_review").length,
    confirmedCount: candidates.filter((candidate) => candidate.status === "confirmed").length,
    startedAt: task.started_at ?? null,
    updatedAt: task.updated_at ?? null,
    needsReviewAt: task.needs_review_at ?? null,
    completedAt: task.completed_at ?? null,
    failedAt: task.failed_at ?? null,
    errorClass: task.error_class ?? null,
  };
}

function parseSourceAttempts(raw: string | null): ContactResearchSourceAttempt[] {
  const parsed = parseJsonArray(raw);
  return parsed
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      sourceKind: String(item.sourceKind ?? ""),
      sourceRef: String(item.sourceRef ?? ""),
      outcome: String(item.outcome ?? ""),
      attemptedAt: String(item.attemptedAt ?? ""),
      detail: String(item.detail ?? ""),
    }));
}

function parseCandidateAttributes(raw: string | null): ContactAttributeDto[] {
  const parsed = parseJsonArray(raw);
  const attributes: ContactAttributeDto[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const provenance = (record.provenance ?? {}) as Record<string, unknown>;
    attributes.push({
      attributeId: String(record.attributeId ?? ""),
      kind: String(record.kind ?? ""),
      value: String(record.value ?? ""),
      provenance: {
        sourceKind: String(
          provenance.source_kind ?? provenance.sourceKind ?? "public_web_page",
        ) as ContactAttributeDto["provenance"]["sourceKind"],
        sourceRef: String(provenance.source_ref ?? provenance.sourceRef ?? ""),
        captureMethod: String(provenance.capture_method ?? provenance.captureMethod ?? "llm_assisted"),
        capturedAt: String(provenance.captured_at ?? provenance.capturedAt ?? ""),
        confidence: Number(provenance.confidence ?? 0),
        userConfirmed: Boolean(provenance.user_confirmed ?? provenance.userConfirmed ?? false),
      },
    });
  }
  return attributes;
}

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeRole(value: string | null | undefined): ContactRole {
  const text = (value ?? "").trim().toLowerCase();
  return (CONTACT_ROLES as readonly string[]).includes(text) ? (text as ContactRole) : "other";
}

function normalizeStatus(value: string | null | undefined): ResearchTaskStatus {
  const text = (value ?? "queued").trim();
  const allowed = ["queued", "running", "needs_review", "completed", "failed"];
  return (allowed.includes(text) ? text : "queued") as ResearchTaskStatus;
}

function normalizeCandidateStatus(value: string | null | undefined): CandidateStatus {
  const text = (value ?? "needs_review").trim();
  const allowed = ["needs_review", "confirmed", "dismissed"];
  return (allowed.includes(text) ? text : "needs_review") as CandidateStatus;
}

function recordEvent(
  db: SqliteDatabase,
  event: {
    jobUrl: string | null;
    eventType: string;
    entityKind: string;
    entityRef: string;
    payload: Record<string, unknown>;
  },
): void {
  if (!tableExists(db, "job_events")) {
    return;
  }
  const columns = new Set(
    allRows<{ name: string }>(db, "PRAGMA table_info(job_events)").map((row) => row.name),
  );
  const values: Record<string, SqliteValue> = {
    job_url: event.jobUrl,
    stage: null,
    event_type: event.eventType,
    level: "info",
    occurred_at: new Date().toISOString(),
    payload_json: JSON.stringify(event.payload),
    entity_kind: event.entityKind,
    entity_ref: event.entityRef,
  };
  const entries = Object.entries(values).filter(([name]) => columns.has(name));
  db.prepare(
    `INSERT INTO job_events (${entries.map(([name]) => name).join(", ")}) VALUES (${entries
      .map(() => "?")
      .join(", ")})`,
  ).run(...entries.map(([, value]) => value));
}
