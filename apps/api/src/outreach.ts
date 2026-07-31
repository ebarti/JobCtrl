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
 * copied out by the browser clipboard, and a send log only records a user-attested
 * fact after the user sends through their own channel.
 */

import { randomUUID } from "node:crypto";

import type {
  DueFollowUpSummary,
  FollowUpState,
  OutreachClaimProvenanceDto,
  OutreachDraftDto,
  OutreachDraftGateResults,
  OutreachDraftKind,
  OutreachDraftStatus,
  OutreachFollowUp,
  OutreachSendLogDto,
  OutreachThreadDetail,
  OutreachThreadSummary,
} from "./contracts.js";
import {
  OUTREACH_DRAFT_KINDS,
  OUTREACH_DRAFT_STATUSES,
  OUTREACH_SEND_CHANNELS,
} from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase } from "./db.js";
import { refreshOutreachProjections } from "./projections.js";

// Conservative follow-up cadence (plan §16 res. 5), mirrored from the Python
// domain (``FIRST_FOLLOW_UP_DAYS`` / ``SUBSEQUENT_NUDGE_DAYS``). Surfaced-only,
// user-editable suggestions — never auto-acted, never sent (INV-1).
const FIRST_FOLLOW_UP_DAYS = 7;
const SUBSEQUENT_NUDGE_DAYS = 14;

const TENANT_ID = "local";
const OUTREACH_SEND_CHANNEL_SET = new Set<string>(OUTREACH_SEND_CHANNELS);
const CANONICAL_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class OutreachNotFoundError extends Error {}
export class OutreachInputError extends Error {}
export class OutreachDraftGatesNotPassedError extends Error {}

// ---------------------------------------------------------------------------
// Reads (canonical join — the thread summary + every generation's full content)
// ---------------------------------------------------------------------------

export function getOutreachThreadForContact(
  db: SqliteDatabase,
  contactId: string,
  jobId?: string | null,
): OutreachThreadDetail | null {
  const stableJobId = canonicalJobId(jobId);
  refreshOutreachProjections(db, TENANT_ID);
  const thread = loadThreadForContact(db, contactId, stableJobId);
  return thread ? buildThreadDetail(db, thread) : null;
}

export function getOutreachThreadDetail(
  db: SqliteDatabase,
  threadId: string,
): OutreachThreadDetail | null {
  refreshOutreachProjections(db, TENANT_ID);
  const thread = loadThreadRow(db, threadId);
  return thread ? buildThreadDetail(db, thread) : null;
}

/** Resolve the existing thread id for a (contact, job) pair, or null to mint one. */
export function findOutreachThreadIdForContact(
  db: SqliteDatabase,
  contactId: string,
  jobId?: string | null,
): string | null {
  const stableJobId = canonicalJobId(jobId);
  const thread = loadThreadForContact(db, contactId, stableJobId);
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
  const jobId = thread.job_id ?? null;
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
      jobId,
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

  refreshOutreachProjections(db, TENANT_ID);
  return buildThreadDetail(db, loadThreadRow(db, threadId) ?? thread);
}

export function rejectOutreachDraft(
  db: SqliteDatabase,
  threadId: string,
  draftId: string,
  reason = "",
): OutreachThreadDetail {
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
  const jobId = thread.job_id ?? null;
  const transaction = db.transaction(() => {
    db.prepare(
      `UPDATE outreach_drafts SET status = 'rejected', rejected_at = ?, reason = ?
       WHERE tenant_id = ? AND thread_id = ? AND draft_id = ?`,
    ).run(now, reason, TENANT_ID, threadId, draftId);
    db.prepare(
      `UPDATE outreach_threads SET updated_at = ? WHERE tenant_id = ? AND thread_id = ?`,
    ).run(now, TENANT_ID, threadId);
    recordEvent(db, {
      jobId,
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

  refreshOutreachProjections(db, TENANT_ID);
  return buildThreadDetail(db, loadThreadRow(db, threadId) ?? thread);
}

// ---------------------------------------------------------------------------
// Send log (user-attested — the ONLY path to "sent", INV-1) + follow-ups
//
// JobCtrl NEVER sends. `logOutreachSend` records a fact the USER asserts, only
// over an APPROVED draft; "approve draft" and "log send" are distinct actions. No
// function here opens any transport. Follow-ups are surfaced-only: scheduling
// derives a suggested date the user can edit, and the due list is a projected
// computation over schedule + clock — never an action, never a send.
// ---------------------------------------------------------------------------

export function logOutreachSend(
  db: SqliteDatabase,
  threadId: string,
  draftId: string,
  channel: string,
  sentAt: string,
): OutreachThreadDetail {
  const thread = loadThreadRow(db, threadId);
  if (!thread) {
    throw new OutreachNotFoundError(`Outreach thread ${threadId} not found`);
  }
  const draft = loadDraftRow(db, threadId, draftId);
  if (!draft) {
    throw new OutreachNotFoundError(`Outreach draft ${draftId} not found`);
  }
  // INV-1: a thread can only be "sent" over a draft the user actually approved.
  if (String(draft.status) !== "approved") {
    throw new OutreachInputError(
      `Outreach draft ${draftId} must be approved before a send can be logged`,
    );
  }
  const trimmedChannel = channel.trim();
  const trimmedSentAt = sentAt.trim();
  if (!trimmedChannel || !trimmedSentAt) {
    throw new OutreachInputError("A send log requires a channel and a sent date");
  }
  if (!OUTREACH_SEND_CHANNEL_SET.has(trimmedChannel)) {
    throw new OutreachInputError("A send log channel must be one of the supported labels");
  }

  const now = new Date().toISOString();
  const sendLogId = randomUUID();
  const jobId = thread.job_id ?? null;
  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO outreach_send_logs (
         tenant_id, send_log_id, thread_id, draft_id, channel, sent_at, logged_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(TENANT_ID, sendLogId, threadId, draftId, trimmedChannel, trimmedSentAt, now);
    db.prepare(
      `UPDATE outreach_threads SET updated_at = ? WHERE tenant_id = ? AND thread_id = ?`,
    ).run(now, TENANT_ID, threadId);
    recordEvent(db, {
      jobId,
      eventType: "OutreachSendLogged",
      threadId,
      payload: {
        tenantId: TENANT_ID,
        threadId,
        draftId,
        channel: trimmedChannel,
        sentAt: trimmedSentAt,
        loggedAt: now,
      },
    });
  });
  transaction();

  refreshOutreachProjections(db, TENANT_ID);
  return buildThreadDetail(db, loadThreadRow(db, threadId) ?? thread);
}

export function scheduleOutreachFollowUp(
  db: SqliteDatabase,
  threadId: string,
  options: {
    dueAt?: string;
    basis?: string;
    hasLoggedReply?: boolean;
  } = {},
): OutreachThreadDetail {
  const thread = loadThreadRow(db, threadId);
  if (!thread) {
    throw new OutreachNotFoundError(`Outreach thread ${threadId} not found`);
  }
  let dueAt = (options.dueAt ?? "").trim();
  let basis = options.basis ?? "";
  if (!dueAt) {
    const submittedAt = latestApplicationSubmittedAt(db, thread);
    const suggestion = deriveFollowUpDueAt({
      submittedAt,
      lastDueAt: thread.follow_up_due_at ?? "",
      hasLoggedReply: options.hasLoggedReply ?? false,
    });
    if (!suggestion) {
      throw new OutreachInputError(
        "Cannot suggest a follow-up date: record an application submission first, or provide a due date",
      );
    }
    dueAt = suggestion.dueAt;
    basis = basis || suggestion.basis;
  }
  basis = basis || "manual";

  const now = new Date().toISOString();
  const jobId = thread.job_id ?? null;
  const transaction = db.transaction(() => {
    db.prepare(
      `UPDATE outreach_threads
       SET follow_up_due_at = ?, follow_up_basis = ?, follow_up_state = 'scheduled', updated_at = ?
       WHERE tenant_id = ? AND thread_id = ?`,
    ).run(dueAt, basis, now, TENANT_ID, threadId);
    recordEvent(db, {
      jobId,
      eventType: "FollowUpScheduled",
      threadId,
      payload: {
        tenantId: TENANT_ID,
        threadId,
        jobId,
        dueAt,
        basis,
        scheduledAt: now,
      },
    });
  });
  transaction();

  refreshOutreachProjections(db, TENANT_ID);
  return buildThreadDetail(db, loadThreadRow(db, threadId) ?? thread);
}

export function completeOutreachFollowUp(
  db: SqliteDatabase,
  threadId: string,
): OutreachThreadDetail {
  return transitionFollowUp(db, threadId, {
    to: "completed",
    eventType: "FollowUpCompleted",
    buildPayload: (now) => ({ tenantId: TENANT_ID, threadId, completedAt: now }),
  });
}

export function dismissOutreachFollowUp(
  db: SqliteDatabase,
  threadId: string,
): OutreachThreadDetail {
  return transitionFollowUp(db, threadId, {
    to: "dismissed",
    eventType: "FollowUpDismissed",
    buildPayload: (now) => ({ tenantId: TENANT_ID, threadId, reason: "", dismissedAt: now }),
  });
}

function transitionFollowUp(
  db: SqliteDatabase,
  threadId: string,
  spec: {
    to: "completed" | "dismissed";
    eventType: string;
    buildPayload: (now: string) => Record<string, unknown>;
  },
): OutreachThreadDetail {
  const thread = loadThreadRow(db, threadId);
  if (!thread) {
    throw new OutreachNotFoundError(`Outreach thread ${threadId} not found`);
  }
  if (normalizeFollowUpState(thread.follow_up_state) !== "scheduled") {
    throw new OutreachInputError(`Outreach thread ${threadId} has no scheduled follow-up`);
  }
  const now = new Date().toISOString();
  const jobId = thread.job_id ?? null;
  const transaction = db.transaction(() => {
    db.prepare(
      `UPDATE outreach_threads SET follow_up_state = ?, updated_at = ?
       WHERE tenant_id = ? AND thread_id = ?`,
    ).run(spec.to, now, TENANT_ID, threadId);
    recordEvent(db, {
      jobId,
      eventType: spec.eventType,
      threadId,
      payload: spec.buildPayload(now),
    });
  });
  transaction();

  refreshOutreachProjections(db, TENANT_ID);
  return buildThreadDetail(db, loadThreadRow(db, threadId) ?? thread);
}

/**
 * Due-follow-ups read model (plan §9, §10). Reads the projected scheduled
 * follow-ups and computes `isDue` over the clock at read time — a derived signal,
 * never an action. Only follow-ups whose date has arrived are returned.
 */
export function getDueFollowUps(db: SqliteDatabase, now: Date = new Date()): DueFollowUpSummary[] {
  refreshOutreachProjections(db, TENANT_ID);
  if (!tableExists(db, "due_follow_up_projections")) {
    return [];
  }
  const rows = allRows<{
    thread_id: string;
    contact_id: string;
    job_id: string | null;
    due_at: string | null;
    basis: string | null;
    state: string | null;
  }>(
    db,
    `SELECT thread_id, contact_id, job_id, due_at, basis, state
     FROM due_follow_up_projections
     WHERE tenant_id = ?
     ORDER BY due_at ASC, thread_id ASC`,
    [TENANT_ID],
  );
  const nowMs = now.getTime();
  const due: DueFollowUpSummary[] = [];
  for (const row of rows) {
    const dueAt = row.due_at ?? null;
    const isDue = dueAt != null && new Date(dueAt).getTime() <= nowMs;
    if (!isDue) {
      continue;
    }
    due.push({
      threadId: String(row.thread_id),
      contactId: String(row.contact_id),
      jobId: row.job_id ?? null,
      dueAt,
      basis: row.basis ?? "",
      state: normalizeFollowUpState(row.state),
      isDue: true,
    });
  }
  return due;
}

function deriveFollowUpDueAt(opts: {
  submittedAt: string;
  lastDueAt: string;
  hasLoggedReply: boolean;
}): { dueAt: string; basis: string } | null {
  if (opts.hasLoggedReply) {
    return null;
  }
  if (!opts.submittedAt.trim()) {
    return null;
  }
  if (opts.lastDueAt.trim()) {
    return {
      dueAt: addCalendarDays(opts.lastDueAt, SUBSEQUENT_NUDGE_DAYS),
      basis: "no_reply_nudge",
    };
  }
  return {
    dueAt: addCalendarDays(opts.submittedAt, FIRST_FOLLOW_UP_DAYS),
    basis: "application_submitted",
  };
}

function latestApplicationSubmittedAt(db: SqliteDatabase, thread: ThreadRow): string {
  const jobId = thread.job_id ?? "";
  if (!jobId) {
    return "";
  }
  if (tableExists(db, "application_outcomes")) {
    const outcome = getRow<{ occurred_at: string | null }>(
      db,
      `SELECT occurred_at
       FROM application_outcomes
       WHERE tenant_id = ? AND job_id = ? AND kind = 'applied_confirmation'
       ORDER BY occurred_at DESC, recorded_at DESC
       LIMIT 1`,
      [TENANT_ID, jobId],
    );
    if (outcome?.occurred_at) {
      return outcome.occurred_at;
    }
  }
  if (tableExists(db, "job_events")) {
    const submitted = getRow<{ occurred_at: string | null }>(
      db,
      `SELECT occurred_at
       FROM job_events
       WHERE tenant_id = ? AND job_id = ? AND event_type = 'ApplicationSubmitted'
       ORDER BY occurred_at DESC
       LIMIT 1`,
      [TENANT_ID, jobId],
    );
    if (submitted?.occurred_at) {
      return submitted.occurred_at;
    }
  }
  return "";
}

function addCalendarDays(iso: string, days: number): string {
  const base = new Date(iso);
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ThreadRow = {
  thread_id: string;
  contact_id: string;
  job_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  follow_up_due_at: string | null;
  follow_up_basis: string | null;
  follow_up_state: string | null;
};

type SendLogRow = {
  send_log_id: string;
  thread_id: string;
  draft_id: string;
  channel: string | null;
  sent_at: string | null;
  logged_at: string | null;
};

const THREAD_COLUMNS =
  "thread_id, contact_id, job_id, created_at, updated_at, " +
  "follow_up_due_at, follow_up_basis, follow_up_state";

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
      `SELECT ${THREAD_COLUMNS} FROM outreach_threads WHERE tenant_id = ? AND thread_id = ?`,
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
        `SELECT ${THREAD_COLUMNS} FROM outreach_threads WHERE tenant_id = ? AND contact_id = ? AND job_id = ?`,
        [TENANT_ID, contactId, job],
      ) ?? null
    );
  }
  return (
    getRow<ThreadRow>(
      db,
      `SELECT ${THREAD_COLUMNS} FROM outreach_threads WHERE tenant_id = ? AND contact_id = ? AND job_id IS NULL`,
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
  const threadId = String(thread.thread_id);
  const drafts = loadDrafts(db, threadId);
  const sendLogs = loadSendLogs(db, threadId);
  return {
    ...summarize(thread, drafts),
    drafts,
    sendLogs,
    followUp: buildFollowUp(thread),
    // INV-1: "sent" is derived from the presence of a user-attested send log.
    isSent: sendLogs.length > 0,
  };
}

function loadSendLogs(db: SqliteDatabase, threadId: string): OutreachSendLogDto[] {
  const rows = allRows<SendLogRow>(
    db,
    `SELECT send_log_id, thread_id, draft_id, channel, sent_at, logged_at
     FROM outreach_send_logs
     WHERE tenant_id = ? AND thread_id = ?
     ORDER BY logged_at ASC, send_log_id ASC`,
    [TENANT_ID, threadId],
  );
  return rows.map((row) => ({
    sendLogId: String(row.send_log_id),
    threadId: String(row.thread_id),
    draftId: String(row.draft_id),
    channel: row.channel ?? "",
    sentAt: row.sent_at ?? "",
    loggedAt: row.logged_at ?? "",
  }));
}

function buildFollowUp(thread: ThreadRow): OutreachFollowUp | null {
  const state = normalizeFollowUpState(thread.follow_up_state);
  if (state === "none") {
    return null;
  }
  return {
    state,
    dueAt: thread.follow_up_due_at ?? null,
    basis: thread.follow_up_basis ?? "",
  };
}

function normalizeFollowUpState(value: string | null | undefined): FollowUpState {
  switch ((value ?? "none").trim()) {
    case "scheduled":
      return "scheduled";
    case "completed":
      return "completed";
    case "dismissed":
      return "dismissed";
    default:
      return "none";
  }
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
    jobId: thread.job_id ?? null,
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
    jobId: string | null;
    eventType: string;
    threadId: string;
    payload: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level,
       message, occurred_at, payload_json, entity_kind, entity_ref, idempotency_key
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TENANT_ID,
    event.jobId,
    1,
    null,
    event.eventType,
    "info",
    null,
    new Date().toISOString(),
    JSON.stringify(event.payload),
    "outreach",
    event.threadId,
    null,
  );
}

function canonicalJobId(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  if (!CANONICAL_JOB_ID.test(value)) {
    throw new OutreachInputError("jobId must be a canonical UUID");
  }
  return value;
}
