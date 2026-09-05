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
  ContactResearchListQuery,
  ContactResearchSourceAttempt,
  ContactResearchTaskDetail,
  ContactResearchTaskSummary,
  ContactRole,
  ResearchTaskStatus,
} from "./contracts.js";
import { CONTACT_ROLES } from "@jobctrl/domain-types";
import { getContactDetail } from "./contacts.js";
import { allRows, getRow, type SqliteDatabase, type SqliteValue } from "./db.js";

const TENANT_ID = "local";
const CANONICAL_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ContactResearchNotFoundError extends Error {}
export class ContactResearchInputError extends Error {}

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
  refreshContactResearchTaskProjections(db, TENANT_ID);
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
  refreshContactResearchTaskProjections(db, TENANT_ID);
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
  const jobId = canonicalJobId(input.jobId);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO contact_research_tasks (
       tenant_id, task_id, employer, job_id, status, source_attempts_json, started_at, updated_at
     ) VALUES (?, ?, ?, ?, 'queued', '[]', ?, ?)
     ON CONFLICT(tenant_id, task_id) DO NOTHING`,
  ).run(TENANT_ID, input.taskId, input.employer, jobId, now, now);
  recordEvent(db, {
    jobId,
    eventType: "ContactResearchTaskStarted",
    entityKind: "contact_research",
    entityRef: input.taskId,
    payload: {
      tenantId: TENANT_ID,
      taskId: input.taskId,
      employer: input.employer,
      jobId,
      startedAt: now,
    },
  });
  refreshContactResearchTaskProjections(db, TENANT_ID);
  const task = loadTaskRow(db, input.taskId);
  return task
    ? taskSummaryFromCanonical(task, [])
    : ({
        taskId: input.taskId,
        employer: input.employer,
        jobId,
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
  const jobId = task.job_id ?? null;

  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO contacts (tenant_id, contact_id, employer, job_id, role, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(TENANT_ID, contactId, employer, jobId, contactRole, now, now);
    const insertAttr = db.prepare(
      `INSERT INTO contact_attributes (
         tenant_id, attribute_id, contact_id, attribute_kind, value_json,
         source_kind, source_ref, capture_method, confidence, user_confirmed, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    recordEvent(db, {
      jobId,
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
        jobId,
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
        jobId,
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

  refreshContactResearchTaskProjections(db, TENANT_ID);

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

/** Materialise research summaries directly from exact-v7 canonical rows. */
export function refreshContactResearchTaskProjections(
  db: SqliteDatabase,
  tenantId = TENANT_ID,
): void {
  const tasks = allRows<TaskRow>(
    db,
    `SELECT task_id, employer, job_id, status, source_attempts_json,
            started_at, updated_at, needs_review_at, completed_at, failed_at, error_class
     FROM contact_research_tasks
     WHERE tenant_id = ?`,
    [tenantId],
  );
  const liveIds = new Set<string>();
  const upsert = db.prepare(
    `INSERT INTO contact_research_task_projections (
       tenant_id, task_id, employer, job_id, status,
       candidate_count, needs_review_count, confirmed_count,
       source_attempts_json, candidates_json, started_at, updated_at,
       needs_review_at, completed_at, failed_at, error_class, last_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, task_id) DO UPDATE SET
       employer             = excluded.employer,
       job_id               = excluded.job_id,
       status               = excluded.status,
       candidate_count      = excluded.candidate_count,
       needs_review_count   = excluded.needs_review_count,
       confirmed_count      = excluded.confirmed_count,
       source_attempts_json = excluded.source_attempts_json,
       candidates_json      = excluded.candidates_json,
       started_at           = excluded.started_at,
       updated_at           = excluded.updated_at,
       needs_review_at      = excluded.needs_review_at,
       completed_at         = excluded.completed_at,
       failed_at            = excluded.failed_at,
       error_class          = excluded.error_class,
       last_updated_at      = excluded.last_updated_at`,
  );
  for (const task of tasks) {
    const taskId = String(task.task_id);
    liveIds.add(taskId);
    const candidateRows = allRows<CandidateRow>(
      db,
      `SELECT candidate_id, task_id, role, attributes_json, source_kind, source_ref,
              capture_method, confidence, status, proposed_at, confirmed_contact_id, confirmed_at
       FROM contact_candidates
       WHERE tenant_id = ? AND task_id = ?
       ORDER BY proposed_at ASC, candidate_id ASC`,
      [tenantId, taskId],
    );
    let needsReview = 0;
    let confirmed = 0;
    const candidates = candidateRows.map((candidate) => {
      const status = String(candidate.status ?? "needs_review");
      if (status === "needs_review") {
        needsReview += 1;
      } else if (status === "confirmed") {
        confirmed += 1;
      }
      return {
        candidateId: String(candidate.candidate_id),
        role: String(candidate.role ?? "other"),
        sourceKind: String(candidate.source_kind),
        sourceRef: String(candidate.source_ref),
        captureMethod: String(candidate.capture_method ?? "llm_assisted"),
        confidence: Number(candidate.confidence ?? 0),
        status,
        proposedAt: String(candidate.proposed_at ?? ""),
        confirmedContactId: candidate.confirmed_contact_id ?? null,
        confirmedAt: candidate.confirmed_at ?? null,
        attributeKinds: projectionAttributeKinds(candidate.attributes_json),
      };
    });
    upsert.run(
      tenantId,
      taskId,
      task.employer,
      task.job_id,
      String(task.status ?? "queued"),
      candidateRows.length,
      needsReview,
      confirmed,
      JSON.stringify(parseJsonArray(task.source_attempts_json)),
      JSON.stringify(candidates),
      task.started_at,
      task.updated_at,
      task.needs_review_at,
      task.completed_at,
      task.failed_at,
      task.error_class,
      task.updated_at,
    );
  }
  const existing = allRows<{ task_id: string }>(
    db,
    "SELECT task_id FROM contact_research_task_projections WHERE tenant_id = ?",
    [tenantId],
  );
  const drop = db.prepare(
    "DELETE FROM contact_research_task_projections WHERE tenant_id = ? AND task_id = ?",
  );
  for (const row of existing) {
    if (!liveIds.has(String(row.task_id))) {
      drop.run(tenantId, String(row.task_id));
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type TaskRow = {
  task_id: string;
  employer: string | null;
  job_id: string | null;
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
  return (
    getRow<TaskRow>(
      db,
      "SELECT * FROM contact_research_tasks WHERE tenant_id = ? AND task_id = ?",
      [TENANT_ID, taskId],
    ) ?? null
  );
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
    jobId: task.job_id ?? null,
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

function projectionAttributeKinds(attributesJson: string | null): string[] {
  const kinds: string[] = [];
  for (const item of parseJsonArray(attributesJson)) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const kind = String((item as Record<string, unknown>).kind ?? "").trim();
      if (kind) {
        kinds.push(kind);
      }
    }
  }
  return kinds;
}

function canonicalJobId(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (!CANONICAL_JOB_ID.test(trimmed)) {
    throw new ContactResearchInputError("jobId must be a canonical UUID");
  }
  return trimmed;
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
    jobId: string | null;
    eventType: string;
    entityKind: string;
    entityRef: string;
    payload: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level,
       message, occurred_at, payload_json, entity_kind, entity_ref, idempotency_key
     ) VALUES (?, ?, 1, NULL, ?, 'info', NULL, ?, ?, ?, ?, NULL)`,
  ).run(
    TENANT_ID,
    event.jobId,
    event.eventType,
    new Date().toISOString(),
    JSON.stringify(event.payload),
    event.entityKind,
    event.entityRef,
  );
}
