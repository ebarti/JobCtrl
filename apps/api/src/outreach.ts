/**
 * Contact & Outreach (ninth context) — outreach-thread read model + the
 * approve/reject write transitions (R6 Phase 3).
 *
 * Draft generation/revision (LLM + the reused materials truthfulness gate stack)
 * runs synchronously on the Python worker via ``generate_outreach_draft``; this
 * module hosts the TS-side surfaces: the canonical-join reads (a thread resolved
 * by contact or by id, with each generation's body, gate results, and claim
 * provenance) and the approve/reject state transitions.
 *
 * Approval is HARD-gated on the persisted ``gate_results_json.passed`` (INV-5): a
 * draft whose gate record does not confirm ``passed`` can never be approved. There
 * is NO send transport anywhere in this module (INV-1) — an approved draft is
 * copied out by the browser clipboard, never sent — so no ``outreach_send_logs``
 * write exists here.
 */

import type {
  OutreachClaimProvenanceDto,
  OutreachDraftDto,
  OutreachDraftGateResults,
  OutreachDraftKind,
  OutreachDraftStatus,
  OutreachThreadDetail,
  OutreachThreadSummary,
} from "./contracts.js";
import { OUTREACH_DRAFT_KINDS, OUTREACH_DRAFT_STATUSES } from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { refreshOutreachProjections, refreshProjections } from "./projections.js";

const TENANT_ID = "local";

export class OutreachNotFoundError extends Error {}
export class OutreachInputError extends Error {}
export class OutreachDraftGatesNotPassedError extends Error {}

export function ensureOutreachTables(db: SqliteDatabase): void {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_outreach_threads_contact
      ON outreach_threads(tenant_id, contact_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_drafts_thread
      ON outreach_drafts(tenant_id, thread_id, generation DESC);
  `);
}

// ---------------------------------------------------------------------------
// Reads (canonical join — the thread summary + every generation's full content)
// ---------------------------------------------------------------------------

export function getOutreachThreadForContact(
  db: SqliteDatabase,
  contactId: string,
  jobId?: string | null,
): OutreachThreadDetail | null {
  ensureOutreachTables(db);
  refreshProjections(db, TENANT_ID);
  const thread = loadThreadForContact(db, contactId, jobId ?? null);
  return thread ? buildThreadDetail(db, thread) : null;
}

export function getOutreachThreadDetail(
  db: SqliteDatabase,
  threadId: string,
): OutreachThreadDetail | null {
  ensureOutreachTables(db);
  refreshProjections(db, TENANT_ID);
  const thread = loadThreadRow(db, threadId);
  return thread ? buildThreadDetail(db, thread) : null;
}

/** Resolve the existing thread id for a (contact, job) pair, or null to mint one. */
export function findOutreachThreadIdForContact(
  db: SqliteDatabase,
  contactId: string,
  jobId?: string | null,
): string | null {
  ensureOutreachTables(db);
  const thread = loadThreadForContact(db, contactId, jobId ?? null);
  return thread ? String(thread.thread_id) : null;
}

// ---------------------------------------------------------------------------
// Approve / reject (TS-API transitions — the sole approval authority is INV-5)
// ---------------------------------------------------------------------------

export function approveOutreachDraft(
  db: SqliteDatabase,
  threadId: string,
  draftId: string,
): OutreachThreadDetail {
  ensureOutreachTables(db);
  const thread = loadThreadRow(db, threadId);
  if (!thread) {
    throw new OutreachNotFoundError(`Outreach thread ${threadId} not found`);
  }
  const draft = loadDraftRow(db, threadId, draftId);
  if (!draft) {
    throw new OutreachNotFoundError(`Outreach draft ${draftId} not found`);
  }
  // INV-5: the persisted gate outcome is the only approval authority. A draft
  // whose gate record does not confirm ``passed`` can never be approved.
  if (!gateResultsPassed(draft.gate_results_json)) {
    throw new OutreachDraftGatesNotPassedError(
      `Outreach draft ${draftId} did not pass the truthfulness gate stack`,
    );
  }
  if (String(draft.status) !== "candidate") {
    throw new OutreachInputError(`Outreach draft ${draftId} is not awaiting approval`);
  }

  const now = new Date().toISOString();
  const jobUrl = thread.job_url ?? null;
  const transaction = db.transaction(() => {
    // Supersede the prior approved draft (if any). This is internal generation
    // bookkeeping — it emits no event, exactly like the Python repository.
    db.prepare(
      `UPDATE outreach_drafts SET status = 'superseded'
       WHERE tenant_id = ? AND thread_id = ? AND status = 'approved'`,
    ).run(TENANT_ID, threadId);
    db.prepare(
      `UPDATE outreach_drafts SET status = 'approved', approved_at = ?
       WHERE tenant_id = ? AND thread_id = ? AND draft_id = ?`,
    ).run(now, TENANT_ID, threadId, draftId);
    db.prepare(
      `UPDATE outreach_threads SET updated_at = ? WHERE tenant_id = ? AND thread_id = ?`,
    ).run(now, TENANT_ID, threadId);
    recordEvent(db, {
      jobUrl,
      eventType: "OutreachDraftApproved",
      threadId,
      payload: {
        tenantId: TENANT_ID,
        threadId,
        draftId,
        generation: Number(draft.generation ?? 0),
        approvedAt: now,
      },
    });
  });
  transaction();

  refreshProjections(db, TENANT_ID);
  refreshOutreachProjections(db, TENANT_ID);
  return buildThreadDetail(db, loadThreadRow(db, threadId) ?? thread);
}

export function rejectOutreachDraft(
  db: SqliteDatabase,
  threadId: string,
  draftId: string,
  reason = "",
): OutreachThreadDetail {
  ensureOutreachTables(db);
  const thread = loadThreadRow(db, threadId);
  if (!thread) {
    throw new OutreachNotFoundError(`Outreach thread ${threadId} not found`);
  }
  const draft = loadDraftRow(db, threadId, draftId);
  if (!draft) {
    throw new OutreachNotFoundError(`Outreach draft ${draftId} not found`);
  }
  // INV-5: only a candidate can be rejected. An approved draft is never touched —
  // the last accepted artifact stays reviewable until a replacement is approved.
  if (String(draft.status) !== "candidate") {
    throw new OutreachInputError(`Outreach draft ${draftId} is not awaiting review`);
  }

  const now = new Date().toISOString();
  const jobUrl = thread.job_url ?? null;
  const transaction = db.transaction(() => {
    db.prepare(
      `UPDATE outreach_drafts SET status = 'rejected', rejected_at = ?, reason = ?
       WHERE tenant_id = ? AND thread_id = ? AND draft_id = ?`,
    ).run(now, reason, TENANT_ID, threadId, draftId);
    db.prepare(
      `UPDATE outreach_threads SET updated_at = ? WHERE tenant_id = ? AND thread_id = ?`,
    ).run(now, TENANT_ID, threadId);
    recordEvent(db, {
      jobUrl,
      eventType: "OutreachDraftRejected",
      threadId,
      payload: {
        tenantId: TENANT_ID,
        threadId,
        draftId,
        generation: Number(draft.generation ?? 0),
        rejectedAt: now,
      },
    });
  });
  transaction();

  refreshProjections(db, TENANT_ID);
  refreshOutreachProjections(db, TENANT_ID);
  return buildThreadDetail(db, loadThreadRow(db, threadId) ?? thread);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ThreadRow = {
  thread_id: string;
  contact_id: string;
  job_url: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type DraftRow = {
  draft_id: string;
  thread_id: string;
  generation: number | null;
  kind: string | null;
  status: string | null;
  body_text: string | null;
  gate_results_json: string | null;
  provenance_json: string | null;
  created_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  reason: string | null;
};

const EMPTY_GATE_RESULTS: OutreachDraftGateResults = {
  passed: false,
  computedAgainst: "rendered_draft_text",
  fabrications: [],
  validation: { passed: false, errors: [], warnings: [] },
  judge: null,
};

function loadThreadRow(db: SqliteDatabase, threadId: string): ThreadRow | null {
  return (
    getRow<ThreadRow>(
      db,
      "SELECT thread_id, contact_id, job_url, created_at, updated_at FROM outreach_threads WHERE tenant_id = ? AND thread_id = ?",
      [TENANT_ID, threadId],
    ) ?? null
  );
}

function loadThreadForContact(
  db: SqliteDatabase,
  contactId: string,
  jobId: string | null,
): ThreadRow | null {
  const job = (jobId ?? "").trim();
  if (job) {
    return (
      getRow<ThreadRow>(
        db,
        "SELECT thread_id, contact_id, job_url, created_at, updated_at FROM outreach_threads WHERE tenant_id = ? AND contact_id = ? AND job_url = ?",
        [TENANT_ID, contactId, job],
      ) ?? null
    );
  }
  return (
    getRow<ThreadRow>(
      db,
      "SELECT thread_id, contact_id, job_url, created_at, updated_at FROM outreach_threads WHERE tenant_id = ? AND contact_id = ? AND job_url IS NULL",
      [TENANT_ID, contactId],
    ) ?? null
  );
}

function loadDraftRow(db: SqliteDatabase, threadId: string, draftId: string): DraftRow | null {
  return (
    getRow<DraftRow>(
      db,
      "SELECT * FROM outreach_drafts WHERE tenant_id = ? AND thread_id = ? AND draft_id = ?",
      [TENANT_ID, threadId, draftId],
    ) ?? null
  );
}

function buildThreadDetail(db: SqliteDatabase, thread: ThreadRow): OutreachThreadDetail {
  const drafts = loadDrafts(db, String(thread.thread_id));
  return { ...summarize(thread, drafts), drafts };
}

function summarize(thread: ThreadRow, drafts: OutreachDraftDto[]): OutreachThreadSummary {
  let latestGeneration = 0;
  let latestStatus: OutreachDraftStatus | null = null;
  let hasApprovedDraft = false;
  let approvedDraftId: string | null = null;
  for (const draft of drafts) {
    latestGeneration = draft.generation;
    latestStatus = draft.status;
    if (draft.status === "approved") {
      hasApprovedDraft = true;
      approvedDraftId = draft.draftId;
    }
  }
  return {
    threadId: String(thread.thread_id),
    contactId: String(thread.contact_id),
    jobId: thread.job_url ?? null,
    draftCount: drafts.length,
    latestGeneration,
    hasApprovedDraft,
    approvedDraftId,
    latestStatus,
    createdAt: thread.created_at ?? null,
    updatedAt: thread.updated_at ?? null,
  };
}

function loadDrafts(db: SqliteDatabase, threadId: string): OutreachDraftDto[] {
  const rows = allRows<DraftRow>(
    db,
    `SELECT draft_id, thread_id, generation, kind, status, body_text,
            gate_results_json, provenance_json, created_at, approved_at, rejected_at, reason
     FROM outreach_drafts
     WHERE tenant_id = ? AND thread_id = ?
     ORDER BY generation ASC, draft_id ASC`,
    [TENANT_ID, threadId],
  );
  return rows.map((row) => ({
    draftId: String(row.draft_id),
    threadId: String(row.thread_id),
    generation: Number(row.generation ?? 0),
    kind: normalizeKind(row.kind),
    status: normalizeStatus(row.status),
    bodyText: row.body_text ?? "",
    gateResults: parseGateResults(row.gate_results_json),
    provenance: parseProvenance(row.provenance_json),
    createdAt: row.created_at ?? null,
    approvedAt: row.approved_at ?? null,
    rejectedAt: row.rejected_at ?? null,
    reason: row.reason ?? "",
  }));
}

/** INV-5 authority: the persisted gate outcome, read robustly at the boundary. */
function gateResultsPassed(raw: string | null): boolean {
  return parseGateResults(raw).passed === true;
}

function parseGateResults(raw: string | null): OutreachDraftGateResults {
  if (!raw) {
    return emptyGateResults();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as OutreachDraftGateResults;
    }
    return emptyGateResults();
  } catch {
    return emptyGateResults();
  }
}

function emptyGateResults(): OutreachDraftGateResults {
  return {
    ...EMPTY_GATE_RESULTS,
    fabrications: [],
    validation: { ...EMPTY_GATE_RESULTS.validation, errors: [], warnings: [] },
  };
}

function parseProvenance(raw: string | null): OutreachClaimProvenanceDto[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OutreachClaimProvenanceDto[]) : [];
  } catch {
    return [];
  }
}

function normalizeKind(value: string | null | undefined): OutreachDraftKind {
  const text = (value ?? "").trim();
  return (OUTREACH_DRAFT_KINDS as readonly string[]).includes(text)
    ? (text as OutreachDraftKind)
    : "intro_request";
}

function normalizeStatus(value: string | null | undefined): OutreachDraftStatus {
  const text = (value ?? "").trim();
  return (OUTREACH_DRAFT_STATUSES as readonly string[]).includes(text)
    ? (text as OutreachDraftStatus)
    : "candidate";
}

function recordEvent(
  db: SqliteDatabase,
  event: {
    jobUrl: string | null;
    eventType: string;
    threadId: string;
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
    entity_kind: "outreach",
    entity_ref: event.threadId,
  };
  const entries = Object.entries(values).filter(([name]) => columns.has(name));
  db.prepare(
    `INSERT INTO job_events (${entries.map(([name]) => name).join(", ")}) VALUES (${entries
      .map(() => "?")
      .join(", ")})`,
  ).run(...entries.map(([, value]) => value));
}
