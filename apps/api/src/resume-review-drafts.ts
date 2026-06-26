import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ResumeCommentReply,
  ResumeCommentReplyDecision,
  ResumeCommentReplyRequest,
  ResumeCommentReplyResponse,
  ResumeCommentThread,
  ResumeCommentThreadState,
  ResumeLineAnchor,
  ResumeReviewCommentThreadSeedInput,
  ResumeReviewCommentThreadSeedRequest,
  ResumeReviewCommentThreadSeedResponse,
  ResumeReviewDraft,
  ResumeReviewDraftCreateRequest,
  ResumeReviewDraftRenderRequest,
  ResumeReviewDraftRenderResponse,
  ResumeReviewDraftResponse,
  ResumeReviewDraftRevision,
  ResumeReviewDraftRevisionResponse,
  ResumeReviewDraftRevisionSaveRequest,
  ResumeReviewDraftState,
  ResumeReviewEditDelta,
  ResumeReviewEditDeltaInput,
  ResumeReviewEditKind,
  TailoringFeedbackSignal,
  TailoringFeedbackSignalKind,
  TailoringFeedbackSourceKind,
} from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { ensureCurrentResumeTemplateMaterials } from "./resume-templates.js";
import { InputError } from "./write-model.js";

const DEFAULT_TENANT = "local";
const TEXT_PREVIEW_BYTE_LIMIT = 128_000;
const FEEDBACK_SUMMARY_LIMIT = 500;
const DRAFT_RENDERER_METADATA_SOURCE = "resume_review_draft";

interface ResumeReviewDraftRow extends Record<string, unknown> {
  draft_id: string;
  job_key: string;
  base_generation: number;
  base_resume_text_artifact_id: string | null;
  base_resume_pdf_artifact_id: string | null;
  renderer_format: string;
  state: string;
  current_revision_id: string | null;
  latest_revision_number: number;
  created_at: string;
  updated_at: string;
}

interface ResumeReviewDraftRevisionRow extends Record<string, unknown> {
  revision_id: string;
  draft_id: string;
  job_key: string;
  revision_number: number;
  plate_document_json: string | null;
  edited_text: string;
  created_at: string;
}

interface ResumeReviewEditDeltaRow extends Record<string, unknown> {
  delta_id: string;
  revision_id: string;
  draft_id: string;
  job_key: string;
  kind: string;
  section: string | null;
  semantic_id: string | null;
  line_anchor_json: string | null;
  before_text: string;
  after_text: string;
  created_at: string;
}

interface ResumeCommentThreadRow extends Record<string, unknown> {
  thread_id: string;
  draft_id: string;
  job_key: string;
  base_artifact_id: string | null;
  semantic_id: string | null;
  line_anchor_json: string | null;
  source_pin_id: string | null;
  risk_label: string | null;
  comment_body: string;
  lifecycle_state: string;
  anchor_resolved: number;
  created_at: string;
  updated_at: string;
}

interface ResumeCommentReplyRow extends Record<string, unknown> {
  reply_id: string;
  thread_id: string;
  draft_revision_id: string | null;
  author: string;
  decision: string;
  body: string;
  created_at: string;
}

interface TailoringFeedbackSignalRow extends Record<string, unknown> {
  signal_id: string;
  job_key: string;
  draft_id: string;
  draft_revision_id: string | null;
  source_kind: string;
  source_id: string;
  signal_kind: string;
  status: string;
  summary: string;
  section: string | null;
  semantic_id: string | null;
  created_at: string;
  reviewed_at: string | null;
}

interface MaterialArtifactRow extends Record<string, unknown> {
  artifact_id: string | null;
  artifact_type: string;
  generation: number;
  path: string | null;
  render_format: string | null;
  created_at: string | null;
}

interface BaseResumeMaterial {
  generation: number;
  resumeTextArtifactId: string | null;
  resumePdfArtifactId: string | null;
  rendererFormat: string;
}

interface ResumeReviewDraftValidation {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

interface RenderedResumeArtifacts {
  generation: number;
  resumeTextArtifactId: string;
  resumePdfArtifactId: string;
  layoutBoxCount: number;
}

interface ResumeLayoutBoxDraft {
  semanticId: string;
  pageNumber: number;
  lineNumber: number;
  textExcerpt: string;
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
}

export function ensureResumeReviewTables(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resume_review_drafts (
      tenant_id                    TEXT NOT NULL DEFAULT 'local',
      draft_id                     TEXT NOT NULL,
      job_key                      TEXT NOT NULL,
      base_generation              INTEGER NOT NULL,
      base_resume_text_artifact_id TEXT,
      base_resume_pdf_artifact_id  TEXT,
      renderer_format              TEXT NOT NULL DEFAULT 'unknown',
      state                        TEXT NOT NULL DEFAULT 'active',
      current_revision_id          TEXT,
      latest_revision_number       INTEGER NOT NULL DEFAULT 0,
      created_at                   TEXT NOT NULL,
      updated_at                   TEXT NOT NULL,
      PRIMARY KEY (tenant_id, draft_id)
    );
    CREATE INDEX IF NOT EXISTS idx_resume_review_drafts_job
      ON resume_review_drafts(tenant_id, job_key, state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS resume_review_draft_revisions (
      tenant_id           TEXT NOT NULL DEFAULT 'local',
      revision_id         TEXT NOT NULL,
      draft_id            TEXT NOT NULL,
      job_key             TEXT NOT NULL,
      revision_number     INTEGER NOT NULL,
      plate_document_json TEXT,
      edited_text         TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      PRIMARY KEY (tenant_id, revision_id),
      UNIQUE (tenant_id, draft_id, revision_number)
    );
    CREATE INDEX IF NOT EXISTS idx_resume_review_revisions_draft
      ON resume_review_draft_revisions(tenant_id, draft_id, revision_number DESC);

    CREATE TABLE IF NOT EXISTS resume_review_edit_deltas (
      tenant_id        TEXT NOT NULL DEFAULT 'local',
      delta_id         TEXT NOT NULL,
      revision_id      TEXT NOT NULL,
      draft_id         TEXT NOT NULL,
      job_key          TEXT NOT NULL,
      kind             TEXT NOT NULL,
      section          TEXT,
      semantic_id      TEXT,
      line_anchor_json TEXT,
      before_text      TEXT NOT NULL DEFAULT '',
      after_text       TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      PRIMARY KEY (tenant_id, delta_id)
    );
    CREATE INDEX IF NOT EXISTS idx_resume_review_edit_deltas_revision
      ON resume_review_edit_deltas(tenant_id, revision_id);

    CREATE TABLE IF NOT EXISTS resume_review_comment_threads (
      tenant_id        TEXT NOT NULL DEFAULT 'local',
      thread_id        TEXT NOT NULL,
      draft_id         TEXT NOT NULL,
      job_key          TEXT NOT NULL,
      base_artifact_id TEXT,
      semantic_id      TEXT,
      line_anchor_json TEXT,
      source_pin_id    TEXT,
      risk_label       TEXT,
      comment_body     TEXT NOT NULL DEFAULT '',
      lifecycle_state  TEXT NOT NULL DEFAULT 'open',
      anchor_resolved  INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY (tenant_id, thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_resume_review_comment_threads_draft
      ON resume_review_comment_threads(tenant_id, draft_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS resume_review_comment_replies (
      tenant_id         TEXT NOT NULL DEFAULT 'local',
      reply_id          TEXT NOT NULL,
      thread_id         TEXT NOT NULL,
      draft_revision_id TEXT,
      author            TEXT NOT NULL DEFAULT 'user',
      decision          TEXT NOT NULL,
      body              TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (tenant_id, reply_id)
    );
    CREATE INDEX IF NOT EXISTS idx_resume_review_comment_replies_thread
      ON resume_review_comment_replies(tenant_id, thread_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS tailoring_feedback_signals (
      tenant_id         TEXT NOT NULL DEFAULT 'local',
      signal_id         TEXT NOT NULL,
      job_key           TEXT NOT NULL,
      draft_id          TEXT NOT NULL,
      draft_revision_id TEXT,
      source_kind       TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      signal_kind       TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'candidate',
      summary           TEXT NOT NULL DEFAULT '',
      section           TEXT,
      semantic_id       TEXT,
      created_at        TEXT NOT NULL,
      reviewed_at       TEXT,
      PRIMARY KEY (tenant_id, signal_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tailoring_feedback_signals_job
      ON tailoring_feedback_signals(tenant_id, job_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tailoring_feedback_signals_draft
      ON tailoring_feedback_signals(tenant_id, draft_id, created_at DESC);
  `);
}

export function getResumeReviewDraftForJob(
  db: SqliteDatabase,
  jobKey: string,
): ResumeReviewDraftResponse | null {
  ensureResumeReviewTables(db);
  const row = getRow<ResumeReviewDraftRow>(
    db,
    `SELECT * FROM resume_review_drafts
     WHERE tenant_id = ? AND job_key = ? AND state = 'active'
     ORDER BY updated_at DESC, draft_id DESC
     LIMIT 1`,
    [DEFAULT_TENANT, jobKey],
  );
  return row ? { ok: true, draft: draftFromRow(db, row) } : null;
}

export function createOrLoadResumeReviewDraft(
  db: SqliteDatabase,
  jobKey: string,
  request: ResumeReviewDraftCreateRequest = {},
): ResumeReviewDraftResponse {
  ensureResumeReviewTables(db);
  const refresh = ensureCurrentResumeTemplateMaterials(db, jobKey);
  if (refresh.status === "failed" || refresh.status === "unavailable") {
    throw new InputError(refresh.message ?? "Resume template refresh did not complete.");
  }
  const base = resolveBaseResumeMaterial(db, jobKey, request);
  const existing = getRow<ResumeReviewDraftRow>(
    db,
    `SELECT * FROM resume_review_drafts
     WHERE tenant_id = ?
       AND job_key = ?
       AND state = 'active'
       AND base_generation = ?
       AND base_resume_text_artifact_id IS ?
       AND base_resume_pdf_artifact_id IS ?
     ORDER BY updated_at DESC, draft_id DESC
     LIMIT 1`,
    [
      DEFAULT_TENANT,
      jobKey,
      base.generation,
      base.resumeTextArtifactId,
      base.resumePdfArtifactId,
    ],
  );
  if (existing) {
    return { ok: true, draft: draftFromRow(db, existing) };
  }

  const now = new Date().toISOString();
  const draftId = `resume_draft_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO resume_review_drafts (
       tenant_id, draft_id, job_key, base_generation,
       base_resume_text_artifact_id, base_resume_pdf_artifact_id,
       renderer_format, state, current_revision_id, latest_revision_number,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 0, ?, ?)`,
  ).run(
    DEFAULT_TENANT,
    draftId,
    jobKey,
    base.generation,
    base.resumeTextArtifactId,
    base.resumePdfArtifactId,
    base.rendererFormat,
    now,
    now,
  );

  const row = getDraftRow(db, draftId);
  if (!row) {
    throw new Error("Resume review draft was not persisted.");
  }
  return { ok: true, draft: draftFromRow(db, row) };
}

export function saveResumeReviewDraftRevision(
  db: SqliteDatabase,
  draftId: string,
  request: ResumeReviewDraftRevisionSaveRequest,
): ResumeReviewDraftRevisionResponse {
  ensureResumeReviewTables(db);
  const tx = db.transaction(() => {
    const draft = getDraftRow(db, draftId);
    if (!draft) {
      throw new InputError(`Resume review draft not found: ${draftId}`);
    }

    const now = new Date().toISOString();
    const revisionNumber = Number(draft.latest_revision_number ?? 0) + 1;
    const revisionId = `resume_revision_${crypto.randomUUID()}`;
    const previousText = latestRevisionText(db, draft) ?? readBaseResumeText(db, draft) ?? "";
    const deltas = normalizedEditDeltas(
      request.editDeltas.length ? request.editDeltas : deriveEditDeltas(previousText, request.editedText),
      revisionId,
      now,
    );

    db.prepare(
      `INSERT INTO resume_review_draft_revisions (
         tenant_id, revision_id, draft_id, job_key, revision_number,
         plate_document_json, edited_text, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      DEFAULT_TENANT,
      revisionId,
      draft.draft_id,
      draft.job_key,
      revisionNumber,
      request.plateDocument === undefined ? null : JSON.stringify(request.plateDocument),
      request.editedText,
      now,
    );

    for (const delta of deltas) {
      db.prepare(
        `INSERT INTO resume_review_edit_deltas (
           tenant_id, delta_id, revision_id, draft_id, job_key, kind, section,
           semantic_id, line_anchor_json, before_text, after_text, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        DEFAULT_TENANT,
        delta.deltaId,
        revisionId,
        draft.draft_id,
        draft.job_key,
        delta.kind,
        delta.section,
        delta.semanticId,
        delta.lineAnchor ? JSON.stringify(delta.lineAnchor) : null,
        delta.beforeText,
        delta.afterText,
        now,
      );
      insertFeedbackSignal(db, {
        jobKey: draft.job_key,
        draftId: draft.draft_id,
        draftRevisionId: revisionId,
        sourceKind: "edit_delta",
        sourceId: delta.deltaId,
        kind: signalKindForDelta(delta),
        summary: summaryForDelta(delta),
        section: delta.section,
        semanticId: delta.semanticId,
        createdAt: now,
      });
    }

    markCommentThreadsSupersededByDeltas(db, draft.draft_id, deltas, now);

    db.prepare(
      `UPDATE resume_review_drafts
          SET current_revision_id = ?,
              latest_revision_number = ?,
              state = 'active',
              updated_at = ?
        WHERE tenant_id = ? AND draft_id = ?`,
    ).run(revisionId, revisionNumber, now, DEFAULT_TENANT, draft.draft_id);

    const nextDraft = getDraftRow(db, draft.draft_id);
    const revision = getRevisionRow(db, revisionId);
    if (!nextDraft || !revision) {
      throw new Error("Resume review revision was not persisted.");
    }
    return {
      ok: true as const,
      draft: draftFromRow(db, nextDraft),
      revision: revisionFromRow(db, revision),
    };
  });
  return tx();
}

export function seedResumeReviewCommentThreads(
  db: SqliteDatabase,
  draftId: string,
  request: ResumeReviewCommentThreadSeedRequest,
): ResumeReviewCommentThreadSeedResponse {
  ensureResumeReviewTables(db);
  const tx = db.transaction(() => {
    const draft = getDraftRow(db, draftId);
    if (!draft) {
      throw new InputError(`Resume review draft not found: ${draftId}`);
    }

    const now = new Date().toISOString();
    let seededCount = 0;
    let updatedCount = 0;
    for (const input of request.threads) {
      const normalized = normalizeSeedThread(draft, input);
      if (!normalized.commentBody) continue;
      const existing = getThreadRow(db, normalized.threadId);
      if (existing) {
        db.prepare(
          `UPDATE resume_review_comment_threads
              SET base_artifact_id = ?,
                  semantic_id = ?,
                  line_anchor_json = ?,
                  source_pin_id = ?,
                  risk_label = ?,
                  comment_body = ?,
                  updated_at = ?
            WHERE tenant_id = ? AND thread_id = ?`,
        ).run(
          normalized.baseArtifactId,
          normalized.semanticId,
          normalized.lineAnchor ? JSON.stringify(normalized.lineAnchor) : null,
          normalized.sourcePinId,
          normalized.riskLabel,
          normalized.commentBody,
          now,
          DEFAULT_TENANT,
          normalized.threadId,
        );
        updatedCount += 1;
        continue;
      }
      db.prepare(
        `INSERT INTO resume_review_comment_threads (
           tenant_id, thread_id, draft_id, job_key, base_artifact_id, semantic_id,
           line_anchor_json, source_pin_id, risk_label, comment_body,
           lifecycle_state, anchor_resolved, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      ).run(
        DEFAULT_TENANT,
        normalized.threadId,
        draft.draft_id,
        draft.job_key,
        normalized.baseArtifactId,
        normalized.semanticId,
        normalized.lineAnchor ? JSON.stringify(normalized.lineAnchor) : null,
        normalized.sourcePinId,
        normalized.riskLabel,
        normalized.commentBody,
        normalized.lineAnchor ? 1 : 0,
        now,
        now,
      );
      seededCount += 1;
    }

    db.prepare(
      `UPDATE resume_review_drafts
          SET updated_at = ?
        WHERE tenant_id = ? AND draft_id = ?`,
    ).run(now, DEFAULT_TENANT, draft.draft_id);

    const nextDraft = getDraftRow(db, draft.draft_id);
    if (!nextDraft) {
      throw new Error("Resume review draft was not persisted.");
    }
    const commentThreads = commentThreadsForDraft(db, draft.draft_id);
    return {
      ok: true as const,
      draft: draftFromRow(db, nextDraft),
      commentThreads,
      seededCount,
      updatedCount,
    };
  });
  return tx();
}

export function renderResumeReviewDraft(
  db: SqliteDatabase,
  draftId: string,
  request: ResumeReviewDraftRenderRequest = {},
): ResumeReviewDraftRenderResponse {
  ensureResumeReviewTables(db);
  const tx = db.transaction(() => {
    const draft = getDraftRow(db, draftId);
    if (!draft) {
      throw new InputError(`Resume review draft not found: ${draftId}`);
    }
    const revisionId = request.draftRevisionId ?? draft.current_revision_id;
    const revision = revisionId ? getRevisionRow(db, revisionId) : undefined;
    const validation = validateDraftRevisionForRender(revision);
    if (!validation.passed || !revision) {
      return {
        ok: false as const,
        error: "resume_review_draft_invalid" as const,
        draft: draftFromRow(db, draft),
        validation,
      };
    }

    ensureMaterialStorageTables(db);
    const artifacts = persistRenderedDraftArtifacts(db, draft, revision, validation);
    const now = new Date().toISOString();
    markResidualCommentThreadsAfterAcceptance(db, draft.draft_id, now);
    db.prepare(
      `UPDATE resume_review_drafts
          SET state = 'promoted',
              updated_at = ?
        WHERE tenant_id = ? AND draft_id = ?`,
    ).run(now, DEFAULT_TENANT, draft.draft_id);

    const promotedDraft = getDraftRow(db, draft.draft_id);
    if (!promotedDraft) {
      throw new Error("Resume review draft was not promoted.");
    }
    return {
      ok: true as const,
      draft: draftFromRow(db, promotedDraft),
      validation,
      artifacts: {
        resumeText: {
          artifactId: artifacts.resumeTextArtifactId,
          artifactType: "tailored_resume" as const,
          generation: artifacts.generation,
          renderFormat: "text" as const,
        },
        resumePdf: {
          artifactId: artifacts.resumePdfArtifactId,
          artifactType: "resume_pdf" as const,
          generation: artifacts.generation,
          renderFormat: "html_pdf" as const,
        },
      },
      layoutBoxCount: artifacts.layoutBoxCount,
    };
  });
  return tx();
}

export function replyToResumeReviewComment(
  db: SqliteDatabase,
  threadId: string,
  request: ResumeCommentReplyRequest,
): ResumeCommentReplyResponse {
  ensureResumeReviewTables(db);
  const tx = db.transaction(() => {
    const thread = getThreadRow(db, threadId);
    if (!thread) {
      throw new InputError(`Resume review comment thread not found: ${threadId}`);
    }

    const now = new Date().toISOString();
    const replyId = `resume_reply_${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO resume_review_comment_replies (
         tenant_id, reply_id, thread_id, draft_revision_id, author, decision, body, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      DEFAULT_TENANT,
      replyId,
      thread.thread_id,
      request.draftRevisionId ?? null,
      request.author,
      request.decision,
      request.body,
      now,
    );

    db.prepare(
      `UPDATE resume_review_comment_threads
          SET lifecycle_state = 'user_replied',
              updated_at = ?
        WHERE tenant_id = ? AND thread_id = ?`,
    ).run(now, DEFAULT_TENANT, thread.thread_id);

    const signal = insertFeedbackSignal(db, {
      jobKey: thread.job_key,
      draftId: thread.draft_id,
      draftRevisionId: request.draftRevisionId ?? null,
      sourceKind: "comment_reply",
      sourceId: replyId,
      kind: signalKindForReply(request.decision),
      summary: boundedText(request.body, FEEDBACK_SUMMARY_LIMIT),
      section: null,
      semanticId: thread.semantic_id,
      createdAt: now,
    });

    const reply = getReplyRow(db, replyId);
    const updatedThread = getThreadRow(db, thread.thread_id);
    if (!reply || !updatedThread) {
      throw new Error("Resume review comment reply was not persisted.");
    }
    return {
      ok: true as const,
      thread: threadFromRow(db, updatedThread),
      reply: replyFromRow(reply),
      feedbackSignal: signal,
    };
  });
  return tx();
}

export function listResumeReviewFeedback(
  db: SqliteDatabase,
  jobKey: string,
): { ok: true; jobKey: string; feedbackSignals: TailoringFeedbackSignal[] } {
  ensureResumeReviewTables(db);
  return {
    ok: true,
    jobKey,
    feedbackSignals: feedbackSignalsForJob(db, jobKey),
  };
}

function normalizeSeedThread(
  draft: ResumeReviewDraftRow,
  input: ResumeReviewCommentThreadSeedInput,
): {
  threadId: string;
  baseArtifactId: string | null;
  semanticId: string | null;
  lineAnchor: ResumeLineAnchor | null;
  sourcePinId: string | null;
  riskLabel: string | null;
  commentBody: string;
} {
  const lineAnchor = normalizeLineAnchor(input.lineAnchor ?? null);
  const semanticId = emptyToNull(input.semanticId) ?? lineAnchor?.semanticId ?? null;
  const sourcePinId = emptyToNull(input.sourcePinId);
  const baseArtifactId =
    emptyToNull(input.baseArtifactId) ??
    draft.base_resume_text_artifact_id ??
    draft.base_resume_pdf_artifact_id;
  const commentBody = boundedText(input.commentBody.trim(), 4000);
  return {
    threadId:
      emptyToNull(input.threadId) ??
      stableId("resume_thread", [
        draft.draft_id,
        sourcePinId,
        semanticId,
        lineAnchor?.lineNumber ?? null,
        emptyToNull(input.riskLabel),
        commentBody,
      ]),
    baseArtifactId,
    semanticId,
    lineAnchor,
    sourcePinId,
    riskLabel: emptyToNull(input.riskLabel),
    commentBody,
  };
}

function markCommentThreadsSupersededByDeltas(
  db: SqliteDatabase,
  draftId: string,
  deltas: readonly ResumeReviewEditDelta[],
  updatedAt: string,
): void {
  if (!deltas.length) return;
  const threads = allRows<ResumeCommentThreadRow>(
    db,
    `SELECT * FROM resume_review_comment_threads
     WHERE tenant_id = ? AND draft_id = ?
       AND lifecycle_state IN ('open', 'user_replied', 'residual_after_acceptance')`,
    [DEFAULT_TENANT, draftId],
  );
  for (const thread of threads) {
    const threadAnchor = parseLineAnchor(thread.line_anchor_json);
    const matchedDelta = deltas.find((delta) => commentThreadMatchesDelta(thread, threadAnchor, delta));
    if (!matchedDelta) continue;
    db.prepare(
      `UPDATE resume_review_comment_threads
          SET lifecycle_state = 'superseded_by_edit',
              anchor_resolved = ?,
              updated_at = ?
        WHERE tenant_id = ? AND thread_id = ?`,
    ).run(matchedDelta.afterText.trim() ? 1 : 0, updatedAt, DEFAULT_TENANT, thread.thread_id);
  }
}

function commentThreadMatchesDelta(
  thread: ResumeCommentThreadRow,
  threadAnchor: ResumeLineAnchor | null,
  delta: ResumeReviewEditDelta,
): boolean {
  if (thread.semantic_id && delta.semanticId && thread.semantic_id === delta.semanticId) {
    return true;
  }
  if (
    threadAnchor?.semanticId &&
    delta.lineAnchor?.semanticId &&
    threadAnchor.semanticId === delta.lineAnchor.semanticId
  ) {
    return true;
  }
  return Boolean(
    threadAnchor?.lineNumber &&
      delta.lineAnchor?.lineNumber &&
      threadAnchor.lineNumber === delta.lineAnchor.lineNumber,
  );
}

function markResidualCommentThreadsAfterAcceptance(
  db: SqliteDatabase,
  draftId: string,
  updatedAt: string,
): void {
  db.prepare(
    `UPDATE resume_review_comment_threads
        SET lifecycle_state = 'residual_after_acceptance',
            updated_at = ?
      WHERE tenant_id = ?
        AND draft_id = ?
        AND lifecycle_state IN ('open', 'user_replied')`,
  ).run(updatedAt, DEFAULT_TENANT, draftId);
}

function validateDraftRevisionForRender(
  revision: ResumeReviewDraftRevisionRow | undefined,
): ResumeReviewDraftValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!revision) {
    errors.push("Save a draft revision before rendering replacement materials.");
    return { passed: false, errors, warnings };
  }
  const editedText = revision.edited_text.replace(/\r\n/g, "\n");
  const nonEmptyLines = editedText.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!editedText.trim()) {
    errors.push("Edited resume text is empty.");
  }
  if (nonEmptyLines.length < 3) {
    errors.push("Edited resume text needs at least three non-empty lines before rendering.");
  }
  if (editedText.length > TEXT_PREVIEW_BYTE_LIMIT) {
    errors.push("Edited resume text is too large for the local renderer.");
  }
  if (/<\s*script\b|javascript:/i.test(editedText)) {
    errors.push("Edited resume text contains unsupported executable markup.");
  }
  if (/\/Users\/|\/private\/|\.sqlite\b|\.db\b|BEGIN\s+(?:RSA\s+)?PRIVATE KEY/i.test(editedText)) {
    errors.push("Edited resume text appears to contain local paths, database names, or private key material.");
  }
  if (/\b(?:fabricated|unsupported claim|invented metric)\b/i.test(editedText)) {
    errors.push("Edited resume text still contains explicit unsupported-claim markers.");
  }
  if (!nonEmptyLines.some((line) => /^[-•*]\s+/.test(line))) {
    warnings.push("No bullet lines were detected in the edited resume.");
  }
  if (!nonEmptyLines.some((line) => /experience|education|skills|summary|profile/i.test(line))) {
    warnings.push("No recognizable resume section heading was detected.");
  }
  for (const line of nonEmptyLines) {
    if (line.length > 220) {
      warnings.push("One or more lines are long enough to risk PDF layout overflow.");
      break;
    }
  }
  for (const word of ["guru", "ninja", "rockstar"]) {
    if (new RegExp(`\\b${word}\\b`, "i").test(editedText)) {
      warnings.push(`Banned or discouraged resume wording detected: ${word}.`);
    }
  }
  return { passed: errors.length === 0, errors, warnings };
}

function persistRenderedDraftArtifacts(
  db: SqliteDatabase,
  draft: ResumeReviewDraftRow,
  revision: ResumeReviewDraftRevisionRow,
  validation: ResumeReviewDraftValidation,
): RenderedResumeArtifacts {
  const outputDir = renderOutputDirectory(db, draft);
  if (!outputDir) {
    throw new InputError("No base resume artifact path is available for rendering the edited draft.");
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const generation = nextMaterialGeneration(db, draft.job_key);
  const artifactSuffix = stableHash([draft.draft_id, revision.revision_id, generation]).slice(0, 16);
  const resumeTextArtifactId = `resume_review_text_${artifactSuffix}`;
  const resumePdfArtifactId = `resume_review_pdf_${artifactSuffix}`;
  const baseName = `resume-review-${artifactSuffix}`;
  const textPath = path.join(outputDir, `${baseName}.txt`);
  const htmlPath = path.join(outputDir, `${baseName}.html`);
  const pdfPath = path.join(outputDir, `${baseName}.pdf`);
  const editedText = revision.edited_text.replace(/\r\n/g, "\n");
  const layoutBoxes = layoutBoxesForEditedText(editedText);
  const now = new Date().toISOString();

  fs.writeFileSync(textPath, editedText, "utf8");
  fs.writeFileSync(htmlPath, htmlForEditedResume(editedText), "utf8");
  fs.writeFileSync(pdfPath, pdfBufferForEditedResume(editedText));

  insertDynamicRow(db, "job_materials", {
    job_url: draft.job_key,
    generation,
    tenant_id: DEFAULT_TENANT,
    status: "resume_approved",
    created_at: now,
    updated_at: now,
    last_validation_json: JSON.stringify(validation),
    last_verdict_json: JSON.stringify({ approved: true, source: DRAFT_RENDERER_METADATA_SOURCE }),
    metadata_json: JSON.stringify({
      source: DRAFT_RENDERER_METADATA_SOURCE,
      draft_id: draft.draft_id,
      draft_revision_id: revision.revision_id,
      base_generation: draft.base_generation,
    }),
  });
  insertDynamicRow(db, "job_materials_artifacts", {
    job_url: draft.job_key,
    generation,
    artifact_type: "tailored_resume",
    artifact_id: resumeTextArtifactId,
    status: "approved",
    path: textPath,
    render_format: "text",
    size_bytes: fs.statSync(textPath).size,
    metadata_json: JSON.stringify({
      source: DRAFT_RENDERER_METADATA_SOURCE,
      draft_id: draft.draft_id,
      draft_revision_id: revision.revision_id,
      base_resume_text_artifact_id: draft.base_resume_text_artifact_id,
    }),
    created_at: now,
    superseded_at: null,
  });
  insertDynamicRow(db, "job_materials_artifacts", {
    job_url: draft.job_key,
    generation,
    artifact_type: "resume_pdf",
    artifact_id: resumePdfArtifactId,
    status: "approved",
    path: pdfPath,
    render_format: "html_pdf",
    size_bytes: fs.statSync(pdfPath).size,
    metadata_json: JSON.stringify({
      source: DRAFT_RENDERER_METADATA_SOURCE,
      draft_id: draft.draft_id,
      draft_revision_id: revision.revision_id,
      html_path: htmlPath,
      base_resume_pdf_artifact_id: draft.base_resume_pdf_artifact_id,
      layout_box_count: layoutBoxes.length,
    }),
    created_at: now,
    superseded_at: null,
  });
  replaceLayoutBoxes(db, draft.job_key, generation, resumePdfArtifactId, layoutBoxes, now);

  return {
    generation,
    resumeTextArtifactId,
    resumePdfArtifactId,
    layoutBoxCount: layoutBoxes.length,
  };
}

function renderOutputDirectory(db: SqliteDatabase, draft: ResumeReviewDraftRow): string | null {
  const pdfPath = materialArtifactPath(db, draft.job_key, draft.base_generation, draft.base_resume_pdf_artifact_id);
  const textPath = materialArtifactPath(db, draft.job_key, draft.base_generation, draft.base_resume_text_artifact_id);
  const basePath = pdfPath ?? textPath;
  if (!basePath) return null;
  return path.dirname(basePath);
}

function materialArtifactPath(
  db: SqliteDatabase,
  jobKey: string,
  generation: number,
  artifactId: string | null,
): string | null {
  if (!artifactId || !tableExists(db, "job_materials_artifacts")) return null;
  const row = getRow<{ path: string | null }>(
    db,
    `SELECT path FROM job_materials_artifacts
     WHERE job_url = ?
       AND generation = ?
       AND artifact_id = ?
     LIMIT 1`,
    [jobKey, generation, artifactId],
  );
  return row?.path?.trim() || null;
}

function nextMaterialGeneration(db: SqliteDatabase, jobKey: string): number {
  const generations: number[] = [];
  if (tableExists(db, "job_materials")) {
    const row = getRow<{ max_generation: number | null }>(
      db,
      "SELECT MAX(generation) AS max_generation FROM job_materials WHERE job_url = ?",
      [jobKey],
    );
    if (row?.max_generation !== null && row?.max_generation !== undefined) {
      generations.push(Number(row.max_generation));
    }
  }
  if (tableExists(db, "job_materials_artifacts")) {
    const row = getRow<{ max_generation: number | null }>(
      db,
      "SELECT MAX(generation) AS max_generation FROM job_materials_artifacts WHERE job_url = ?",
      [jobKey],
    );
    if (row?.max_generation !== null && row?.max_generation !== undefined) {
      generations.push(Number(row.max_generation));
    }
  }
  return Math.max(0, ...generations.filter(Number.isFinite)) + 1;
}

function layoutBoxesForEditedText(editedText: string): ResumeLayoutBoxDraft[] {
  const lines = editedText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(0, 80).map((line, index) => ({
    semanticId: `edited:line:${index + 1}`,
    pageNumber: Math.floor(index / 42) + 1,
    lineNumber: index + 1,
    textExcerpt: boundedText(line, 240),
    leftPct: 10,
    topPct: 8 + (index % 42) * 2.1,
    widthPct: 80,
    heightPct: 1.7,
  }));
}

function replaceLayoutBoxes(
  db: SqliteDatabase,
  jobKey: string,
  generation: number,
  artifactId: string,
  boxes: readonly ResumeLayoutBoxDraft[],
  createdAt: string,
): void {
  if (!tableExists(db, "job_material_layout_boxes")) return;
  db.prepare(
    "DELETE FROM job_material_layout_boxes WHERE job_url = ? AND generation = ? AND artifact_id = ?",
  ).run(jobKey, generation, artifactId);
  for (const [index, box] of boxes.entries()) {
    insertDynamicRow(db, "job_material_layout_boxes", {
      job_url: jobKey,
      generation,
      artifact_id: artifactId,
      box_index: index,
      tenant_id: DEFAULT_TENANT,
      semantic_id: box.semanticId,
      page_number: box.pageNumber,
      line_number: box.lineNumber,
      text_excerpt: box.textExcerpt,
      left_pct: box.leftPct,
      top_pct: box.topPct,
      width_pct: box.widthPct,
      height_pct: box.heightPct,
      audit_target_json: JSON.stringify({
        source: DRAFT_RENDERER_METADATA_SOURCE,
        semanticId: box.semanticId,
        lineNumber: box.lineNumber,
      }),
      created_at: createdAt,
    });
  }
}

function ensureMaterialStorageTables(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_materials (
      job_url             TEXT NOT NULL,
      generation          INTEGER NOT NULL,
      tenant_id           TEXT NOT NULL DEFAULT 'local',
      status              TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      last_validation_json TEXT,
      last_verdict_json    TEXT,
      metadata_json       TEXT,
      PRIMARY KEY (job_url, generation)
    );
    CREATE TABLE IF NOT EXISTS job_materials_artifacts (
      job_url             TEXT NOT NULL,
      generation          INTEGER NOT NULL,
      artifact_type       TEXT NOT NULL,
      artifact_id         TEXT NOT NULL,
      status              TEXT NOT NULL,
      path                TEXT NOT NULL,
      render_format       TEXT NOT NULL,
      size_bytes          INTEGER,
      metadata_json       TEXT,
      created_at          TEXT NOT NULL,
      superseded_at       TEXT,
      PRIMARY KEY (job_url, generation, artifact_type)
    );
    CREATE TABLE IF NOT EXISTS job_material_layout_boxes (
      job_url             TEXT NOT NULL,
      generation          INTEGER NOT NULL,
      artifact_id         TEXT NOT NULL,
      box_index           INTEGER NOT NULL,
      tenant_id           TEXT NOT NULL DEFAULT 'local',
      semantic_id         TEXT NOT NULL,
      page_number         INTEGER NOT NULL,
      line_number         INTEGER,
      text_excerpt        TEXT NOT NULL,
      left_pct            REAL NOT NULL,
      top_pct             REAL NOT NULL,
      width_pct           REAL NOT NULL,
      height_pct          REAL NOT NULL,
      audit_target_json   TEXT NOT NULL DEFAULT '{}',
      created_at          TEXT NOT NULL,
      PRIMARY KEY (job_url, generation, artifact_id, box_index)
    );
  `);
}

function insertDynamicRow(
  db: SqliteDatabase,
  tableName: string,
  values: Record<string, SqliteValue>,
): void {
  const columns = tableColumnSet(db, tableName).filter((column) => Object.hasOwn(values, column));
  if (!columns.length) return;
  const placeholders = columns.map(() => "?").join(", ");
  db.prepare(
    `INSERT OR REPLACE INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`,
  ).run(...columns.map((column) => values[column] ?? null));
}

function tableColumnSet(db: SqliteDatabase, tableName: string): string[] {
  return allRows<{ name: string }>(db, `PRAGMA table_info(${tableName})`).map((row) => row.name);
}

function htmlForEditedResume(editedText: string): string {
  const paragraphs = editedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const tag = index === 0 ? "h1" : /^[-•*]\s+/.test(line) ? "li" : sectionHeadingLine(line) ? "h2" : "p";
      const clean = escapeHtml(line.replace(/^[-•*]\s+/, ""));
      return `<${tag} data-resume-line-number="${index + 1}" data-resume-page="${Math.floor(index / 42) + 1}" data-resume-layout-target="edited:line:${index + 1}">${clean}</${tag}>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Edited Resume</title>
    <style>
      body { margin: 0; font: 12px Arial, sans-serif; color: #111827; background: white; }
      .resume-document { box-sizing: border-box; width: 8.5in; min-height: 11in; padding: 0.65in; }
      h1 { font-size: 22px; margin: 0 0 10px; }
      h2 { font-size: 13px; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 0; }
      p, li { font-size: 11px; line-height: 1.35; margin: 0 0 5px; }
      li { margin-left: 18px; }
    </style>
  </head>
  <body><main class="resume-document">${paragraphs}</main></body>
</html>
`;
}

function sectionHeadingLine(line: string): boolean {
  return /^(?:summary|profile|experience|education|skills|projects|certifications|languages)$/i.test(line.trim());
}

function pdfBufferForEditedResume(editedText: string): Buffer {
  const lines = editedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 58)
    .map((line) => line.slice(0, 110));
  const content = [
    "BT",
    "/F1 10 Tf",
    "14 TL",
    "72 750 Td",
    ...lines.flatMap((line) => [`(${escapePdfText(line)}) Tj`, "T*"]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}_${stableHash(parts).slice(0, 32)}`;
}

function stableHash(parts: readonly unknown[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function resolveBaseResumeMaterial(
  db: SqliteDatabase,
  jobKey: string,
  request: ResumeReviewDraftCreateRequest,
): BaseResumeMaterial {
  if (!tableExists(db, "job_materials_artifacts")) {
    throw new InputError(`No material artifacts found for ${jobKey}.`);
  }
  const columns = tableColumnSet(db, "job_materials_artifacts");
  const renderFormatSelect = columns.includes("render_format") ? "render_format" : "NULL AS render_format";
  const createdAtSelect = columns.includes("created_at") ? "created_at" : "NULL AS created_at";
  const rows = allRows<MaterialArtifactRow>(
    db,
    `SELECT artifact_id, artifact_type, generation, path,
            ${renderFormatSelect}, ${createdAtSelect}
       FROM job_materials_artifacts
      WHERE job_url = ?
        AND COALESCE(status, 'approved') IN ('approved', 'active')
        AND artifact_type IN (
          'tailored_resume', 'tailored_resume_txt', 'resume_txt',
          'tailored_resume_pdf', 'resume_pdf'
        )
      ORDER BY COALESCE(generation, -1) DESC,
               COALESCE(created_at, '') DESC,
               artifact_id DESC`,
    [jobKey],
  );
  if (rows.length === 0) {
    throw new InputError(`No approved resume materials found for ${jobKey}.`);
  }

  const requestedGeneration = request.generation;
  const generation =
    requestedGeneration ??
    rows.find((row) => row.artifact_id === request.resumePdfArtifactId)?.generation ??
    rows.find((row) => row.artifact_id === request.resumeTextArtifactId)?.generation ??
    rows[0]?.generation;
  if (generation === undefined) {
    throw new InputError(`No approved resume materials found for ${jobKey}.`);
  }

  const generationRows = rows.filter((row) => row.generation === generation);
  const textRow = findArtifactRow(generationRows, request.resumeTextArtifactId, [
    "tailored_resume",
    "tailored_resume_txt",
    "resume_txt",
  ]);
  const pdfRow = findArtifactRow(generationRows, request.resumePdfArtifactId, [
    "tailored_resume_pdf",
    "resume_pdf",
  ]);
  if (!textRow && !pdfRow) {
    throw new InputError(`No matching resume materials found for ${jobKey}.`);
  }

  return {
    generation,
    resumeTextArtifactId: textRow?.artifact_id ?? null,
    resumePdfArtifactId: pdfRow?.artifact_id ?? null,
    rendererFormat:
      request.rendererFormat ??
      pdfRow?.render_format ??
      textRow?.render_format ??
      "unknown",
  };
}

function findArtifactRow(
  rows: readonly MaterialArtifactRow[],
  requestedArtifactId: string | undefined,
  artifactTypes: readonly string[],
): MaterialArtifactRow | null {
  if (requestedArtifactId) {
    return (
      rows.find(
        (row) => row.artifact_id === requestedArtifactId && artifactTypes.includes(row.artifact_type),
      ) ?? null
    );
  }
  return rows.find((row) => artifactTypes.includes(row.artifact_type)) ?? null;
}

function getDraftRow(db: SqliteDatabase, draftId: string): ResumeReviewDraftRow | undefined {
  return getRow<ResumeReviewDraftRow>(
    db,
    "SELECT * FROM resume_review_drafts WHERE tenant_id = ? AND draft_id = ?",
    [DEFAULT_TENANT, draftId],
  );
}

function getRevisionRow(
  db: SqliteDatabase,
  revisionId: string,
): ResumeReviewDraftRevisionRow | undefined {
  return getRow<ResumeReviewDraftRevisionRow>(
    db,
    "SELECT * FROM resume_review_draft_revisions WHERE tenant_id = ? AND revision_id = ?",
    [DEFAULT_TENANT, revisionId],
  );
}

function getThreadRow(db: SqliteDatabase, threadId: string): ResumeCommentThreadRow | undefined {
  return getRow<ResumeCommentThreadRow>(
    db,
    "SELECT * FROM resume_review_comment_threads WHERE tenant_id = ? AND thread_id = ?",
    [DEFAULT_TENANT, threadId],
  );
}

function getReplyRow(db: SqliteDatabase, replyId: string): ResumeCommentReplyRow | undefined {
  return getRow<ResumeCommentReplyRow>(
    db,
    "SELECT * FROM resume_review_comment_replies WHERE tenant_id = ? AND reply_id = ?",
    [DEFAULT_TENANT, replyId],
  );
}

function draftFromRow(db: SqliteDatabase, row: ResumeReviewDraftRow): ResumeReviewDraft {
  const latestRevision = row.current_revision_id
    ? getRevisionRow(db, row.current_revision_id)
    : undefined;
  return {
    draftId: row.draft_id,
    jobKey: row.job_key,
    baseGeneration: Number(row.base_generation),
    baseResumeTextArtifactId: row.base_resume_text_artifact_id,
    baseResumePdfArtifactId: row.base_resume_pdf_artifact_id,
    rendererFormat: row.renderer_format || "unknown",
    state: draftState(row.state),
    currentRevisionId: row.current_revision_id,
    latestRevisionNumber: Number(row.latest_revision_number ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestRevision: latestRevision ? revisionFromRow(db, latestRevision) : null,
    commentThreads: commentThreadsForDraft(db, row.draft_id),
    feedbackSignals: feedbackSignalsForJob(db, row.job_key),
  };
}

function revisionFromRow(
  db: SqliteDatabase,
  row: ResumeReviewDraftRevisionRow,
): ResumeReviewDraftRevision {
  return {
    revisionId: row.revision_id,
    draftId: row.draft_id,
    jobKey: row.job_key,
    revisionNumber: Number(row.revision_number),
    editedText: row.edited_text,
    plateDocument: parseJson(row.plate_document_json),
    editDeltas: editDeltasForRevision(db, row.revision_id),
    createdAt: row.created_at,
  };
}

function editDeltasForRevision(
  db: SqliteDatabase,
  revisionId: string,
): ResumeReviewEditDelta[] {
  return allRows<ResumeReviewEditDeltaRow>(
    db,
    `SELECT * FROM resume_review_edit_deltas
     WHERE tenant_id = ? AND revision_id = ?
     ORDER BY created_at ASC, delta_id ASC`,
    [DEFAULT_TENANT, revisionId],
  ).map(deltaFromRow);
}

function deltaFromRow(row: ResumeReviewEditDeltaRow): ResumeReviewEditDelta {
  return {
    deltaId: row.delta_id,
    revisionId: row.revision_id,
    kind: editKind(row.kind),
    section: row.section,
    semanticId: row.semantic_id,
    lineAnchor: parseLineAnchor(row.line_anchor_json),
    beforeText: row.before_text,
    afterText: row.after_text,
    createdAt: row.created_at,
  };
}

function commentThreadsForDraft(
  db: SqliteDatabase,
  draftId: string,
): ResumeCommentThread[] {
  return allRows<ResumeCommentThreadRow>(
    db,
    `SELECT * FROM resume_review_comment_threads
     WHERE tenant_id = ? AND draft_id = ?
     ORDER BY updated_at DESC, thread_id DESC`,
    [DEFAULT_TENANT, draftId],
  ).map((row) => threadFromRow(db, row));
}

function threadFromRow(db: SqliteDatabase, row: ResumeCommentThreadRow): ResumeCommentThread {
  return {
    threadId: row.thread_id,
    draftId: row.draft_id,
    jobKey: row.job_key,
    baseArtifactId: row.base_artifact_id,
    semanticId: row.semantic_id,
    lineAnchor: parseLineAnchor(row.line_anchor_json),
    sourcePinId: row.source_pin_id,
    riskLabel: row.risk_label,
    commentBody: row.comment_body,
    state: commentThreadState(row.lifecycle_state),
    anchorResolved: Boolean(row.anchor_resolved),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    replies: repliesForThread(db, row.thread_id),
  };
}

function repliesForThread(db: SqliteDatabase, threadId: string): ResumeCommentReply[] {
  return allRows<ResumeCommentReplyRow>(
    db,
    `SELECT * FROM resume_review_comment_replies
     WHERE tenant_id = ? AND thread_id = ?
     ORDER BY created_at ASC, reply_id ASC`,
    [DEFAULT_TENANT, threadId],
  ).map(replyFromRow);
}

function replyFromRow(row: ResumeCommentReplyRow): ResumeCommentReply {
  return {
    replyId: row.reply_id,
    threadId: row.thread_id,
    draftRevisionId: row.draft_revision_id,
    author: row.author,
    decision: commentReplyDecision(row.decision),
    body: row.body,
    createdAt: row.created_at,
  };
}

function feedbackSignalsForJob(db: SqliteDatabase, jobKey: string): TailoringFeedbackSignal[] {
  return allRows<TailoringFeedbackSignalRow>(
    db,
    `SELECT * FROM tailoring_feedback_signals
     WHERE tenant_id = ? AND job_key = ?
     ORDER BY created_at DESC, signal_id DESC`,
    [DEFAULT_TENANT, jobKey],
  ).map(feedbackSignalFromRow);
}

function insertFeedbackSignal(
  db: SqliteDatabase,
  input: {
    readonly jobKey: string;
    readonly draftId: string;
    readonly draftRevisionId: string | null;
    readonly sourceKind: TailoringFeedbackSourceKind;
    readonly sourceId: string;
    readonly kind: TailoringFeedbackSignalKind;
    readonly summary: string;
    readonly section: string | null;
    readonly semanticId: string | null;
    readonly createdAt: string;
  },
): TailoringFeedbackSignal {
  const signalId = `resume_feedback_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO tailoring_feedback_signals (
       tenant_id, signal_id, job_key, draft_id, draft_revision_id, source_kind,
       source_id, signal_kind, status, summary, section, semantic_id, created_at, reviewed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, NULL)`,
  ).run(
    DEFAULT_TENANT,
    signalId,
    input.jobKey,
    input.draftId,
    input.draftRevisionId,
    input.sourceKind,
    input.sourceId,
    input.kind,
    boundedText(input.summary, FEEDBACK_SUMMARY_LIMIT),
    input.section,
    input.semanticId,
    input.createdAt,
  );
  const row = getRow<TailoringFeedbackSignalRow>(
    db,
    "SELECT * FROM tailoring_feedback_signals WHERE tenant_id = ? AND signal_id = ?",
    [DEFAULT_TENANT, signalId],
  );
  if (!row) {
    throw new Error("Tailoring feedback signal was not persisted.");
  }
  return feedbackSignalFromRow(row);
}

function feedbackSignalFromRow(row: TailoringFeedbackSignalRow): TailoringFeedbackSignal {
  return {
    signalId: row.signal_id,
    jobKey: row.job_key,
    draftId: row.draft_id,
    draftRevisionId: row.draft_revision_id,
    sourceKind: feedbackSourceKind(row.source_kind),
    sourceId: row.source_id,
    kind: feedbackSignalKind(row.signal_kind),
    status: row.status === "accepted" || row.status === "rejected" ? row.status : "candidate",
    summary: row.summary,
    section: row.section,
    semanticId: row.semantic_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

function normalizedEditDeltas(
  inputs: readonly ResumeReviewEditDeltaInput[],
  revisionId: string,
  createdAt: string,
): ResumeReviewEditDelta[] {
  return inputs
    .filter((delta) => delta.beforeText !== delta.afterText)
    .map((delta) => ({
      deltaId: delta.deltaId ?? `resume_delta_${crypto.randomUUID()}`,
      revisionId,
      kind: delta.kind,
      section: emptyToNull(delta.section),
      semanticId: emptyToNull(delta.semanticId),
      lineAnchor: normalizeLineAnchor(delta.lineAnchor ?? null),
      beforeText: delta.beforeText,
      afterText: delta.afterText,
      createdAt,
    }));
}

function deriveEditDeltas(
  previousText: string,
  editedText: string,
): ResumeReviewEditDeltaInput[] {
  if (previousText === editedText) {
    return [];
  }
  return [
    {
      kind: "replace_text",
      section: "document",
      semanticId: null,
      lineAnchor: null,
      beforeText: boundedText(previousText, 6000),
      afterText: boundedText(editedText, 6000),
    },
  ];
}

function latestRevisionText(db: SqliteDatabase, draft: ResumeReviewDraftRow): string | null {
  if (!draft.current_revision_id) {
    return null;
  }
  const row = getRevisionRow(db, draft.current_revision_id);
  return row?.edited_text ?? null;
}

function readBaseResumeText(db: SqliteDatabase, draft: ResumeReviewDraftRow): string | null {
  if (!draft.base_resume_text_artifact_id || !tableExists(db, "job_materials_artifacts")) {
    return null;
  }
  const row = getRow<{ path: string | null }>(
    db,
    `SELECT path FROM job_materials_artifacts
     WHERE job_url = ?
       AND generation = ?
       AND artifact_id = ?`,
    [draft.job_key, draft.base_generation, draft.base_resume_text_artifact_id],
  );
  if (!row?.path || !fs.existsSync(row.path) || !fs.statSync(row.path).isFile()) {
    return null;
  }
  const fd = fs.openSync(row.path, "r");
  try {
    const buffer = Buffer.alloc(TEXT_PREVIEW_BYTE_LIMIT);
    const bytesRead = fs.readSync(fd, buffer, 0, TEXT_PREVIEW_BYTE_LIMIT, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function signalKindForDelta(delta: ResumeReviewEditDelta): TailoringFeedbackSignalKind {
  if (delta.kind === "structure_change" || !delta.beforeText || !delta.afterText) {
    return "style_preference";
  }
  if (numbersChanged(delta.beforeText, delta.afterText)) {
    return "factual_correction";
  }
  if (/unsupported|incorrect|fabricated|source|provenance/i.test(`${delta.beforeText}\n${delta.afterText}`)) {
    return "claim_policy_correction";
  }
  return "style_preference";
}

function signalKindForReply(decision: ResumeCommentReplyDecision): TailoringFeedbackSignalKind {
  switch (decision) {
    case "accepted":
      return "claim_policy_correction";
    case "rejected":
      return "provenance_dispute";
    case "rewrite_requested":
      return "style_preference";
    case "clarified":
      return "factual_correction";
  }
}

function summaryForDelta(delta: ResumeReviewEditDelta): string {
  return boundedText(
    `${delta.section ?? "resume"} edit: ${delta.beforeText || "[empty]"} -> ${delta.afterText || "[empty]"}`,
    FEEDBACK_SUMMARY_LIMIT,
  );
}

function numbersChanged(left: string, right: string): boolean {
  const leftNumbers = left.match(/\d+(?:[.,]\d+)?%?/g) ?? [];
  const rightNumbers = right.match(/\d+(?:[.,]\d+)?%?/g) ?? [];
  return JSON.stringify(leftNumbers) !== JSON.stringify(rightNumbers);
}

function boundedText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 3).trimEnd()}...` : value;
}

function parseJson(value: string | null): unknown | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseLineAnchor(value: string | null): ResumeLineAnchor | null {
  const parsed = parseJson(value);
  return normalizeLineAnchor(parsed);
}

function normalizeLineAnchor(value: unknown): ResumeLineAnchor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    semanticId: stringOrNull(record.semanticId),
    lineNumber: numberOrNull(record.lineNumber),
    pageNumber: numberOrNull(record.pageNumber),
    textHash: stringOrNull(record.textHash),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function emptyToNull(value: string | null | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

function draftState(value: string): ResumeReviewDraftState {
  if (value === "rendered" || value === "promoted" || value === "abandoned") {
    return value;
  }
  return "active";
}

function editKind(value: string): ResumeReviewEditKind {
  if (value === "insert_text" || value === "delete_text" || value === "structure_change") {
    return value;
  }
  return "replace_text";
}

function commentThreadState(value: string): ResumeCommentThreadState {
  if (
    value === "user_replied" ||
    value === "resolved" ||
    value === "superseded_by_edit" ||
    value === "residual_after_acceptance"
  ) {
    return value;
  }
  return "open";
}

function commentReplyDecision(value: string): ResumeCommentReplyDecision {
  if (value === "accepted" || value === "rejected" || value === "rewrite_requested") {
    return value;
  }
  return "clarified";
}

function feedbackSourceKind(value: string): TailoringFeedbackSourceKind {
  return value === "comment_reply" ? "comment_reply" : "edit_delta";
}

function feedbackSignalKind(value: string): TailoringFeedbackSignalKind {
  if (
    value === "factual_correction" ||
    value === "claim_policy_correction" ||
    value === "keyword_strategy" ||
    value === "provenance_dispute"
  ) {
    return value;
  }
  return "style_preference";
}
