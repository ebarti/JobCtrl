import crypto from "node:crypto";
import fs from "node:fs";

import type {
  ApplicationOutcome,
  ApplicationOutcomeKind,
  ApplicationOutcomeListResponse,
  ApplicationOutcomeSource,
  ApplicationOutcomeWriteResponse,
  ApplyReviewDecision,
  ApplyReviewDecisionRequest,
  ApplyReviewDecisionResponse,
  ApplyReviewDecisionValue,
  ApplyReviewProfileSourceField,
  ApplyReviewQueueItem,
  ApplyReviewQueueResponse,
  JobApplicationOutcomeListResponse,
  ManualApplicationOutcomeRequest,
  OutcomeSuggestion,
  OutcomeSuggestionDecisionRequest,
  OutcomeSuggestionDecisionResponse,
  OutcomeSuggestionStatus,
  ScoreBreakdown,
  Stage,
  StageState,
} from "./contracts.js";
import {
  APPLICATION_OUTCOME_KINDS,
  APPLY_REVIEW_DECISION_VALUES,
  OUTCOME_SUGGESTION_STATUSES,
  STAGES,
  STAGE_STATES,
} from "./contracts.js";
import { buildApplyAudit } from "./apply-audit.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { refreshProjections } from "./projections.js";
import { InputError, resolveJobUrl } from "./write-model.js";

const DEFAULT_TENANT = "local";
const DEFAULT_PROFILE_ID = "default";
const CLOSED_ACTIVE_STATES = ["closed", "expired", "removed", "location_incompatible"];
const POSITION_PREVIEW_CHAR_LIMIT = 6000;
const MATERIAL_PREVIEW_CHAR_LIMIT = 4000;
const MATERIAL_PREVIEW_BYTE_LIMIT = 24_000;
const RESUME_AUDIT_TEXT_BYTE_LIMIT = 128_000;
const COVER_LETTER_REVIEW_TEXT_BYTE_LIMIT = 128_000;
const EVIDENCE_LIST_LIMIT = 12;
const EVIDENCE_TEXT_LIMIT = 180;
const PROFILE_SOURCE_FIELD_LIMIT = 160;
const PROFILE_SOURCE_VALUE_LIMIT = 1200;

interface ReviewQueueRow extends Record<string, unknown> {
  job_id: string;
  title: string;
  employer: string;
  source: string;
  application_url: string | null;
  fit_score: number | null;
  description: string;
  full_description: string;
  score_breakdown_json: string | null;
  score_keywords_json: string | null;
  current_stage: string;
  current_state: string;
  current_error_code: string | null;
  current_error_message: string | null;
  has_resume: number;
  has_cover_letter: number;
  has_pdf: number;
  decision_id: string | null;
  decision: string | null;
  decided_at: string | null;
  run_id: string | null;
  apply_run_status: string | null;
  result: string | null;
  dry_run: number | null;
  started_at: string | null;
  finished_at: string | null;
}

interface OutcomeRow extends Record<string, unknown> {
  outcome_id: string;
  job_key: string;
  kind: string;
  source: string;
  note: string | null;
  occurred_at: string;
  recorded_at: string;
  suggestion_id: string | null;
  evidence_id: string | null;
}

interface SuggestionRow extends Record<string, unknown> {
  suggestion_id: string;
  job_key: string;
  evidence_id: string | null;
  suggested_kind: string;
  confidence: number;
  rationale: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  decided_outcome_id: string | null;
}

export function ensureApplicationFeedbackTables(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_review_decisions (
      tenant_id    TEXT NOT NULL DEFAULT 'local',
      decision_id  TEXT NOT NULL,
      job_key      TEXT NOT NULL,
      decision     TEXT NOT NULL,
      reason       TEXT,
      decided_by   TEXT NOT NULL DEFAULT 'user',
      decided_at   TEXT NOT NULL,
      PRIMARY KEY (tenant_id, decision_id)
    );
    CREATE INDEX IF NOT EXISTS idx_application_review_decisions_job
      ON application_review_decisions(tenant_id, job_key, decided_at DESC);

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
      created_by    TEXT NOT NULL DEFAULT 'user',
      PRIMARY KEY (tenant_id, outcome_id)
    );
    CREATE INDEX IF NOT EXISTS idx_application_outcomes_job
      ON application_outcomes(tenant_id, job_key, occurred_at DESC, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS application_email_evidence (
      tenant_id            TEXT NOT NULL DEFAULT 'local',
      evidence_id          TEXT NOT NULL,
      job_key              TEXT NOT NULL,
      provider             TEXT NOT NULL DEFAULT 'gmail',
      provider_message_id  TEXT NOT NULL,
      provider_thread_id   TEXT,
      from_address         TEXT,
      to_addresses_json    TEXT NOT NULL DEFAULT '[]',
      subject              TEXT,
      snippet              TEXT,
      received_at          TEXT,
      linked_at            TEXT NOT NULL,
      link_confidence      REAL NOT NULL DEFAULT 0,
      link_signals_json    TEXT NOT NULL DEFAULT '[]',
      body_text            TEXT,
      body_sha256          TEXT,
      body_stored_at       TEXT,
      PRIMARY KEY (tenant_id, evidence_id),
      UNIQUE (tenant_id, provider, provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_application_email_evidence_job
      ON application_email_evidence(tenant_id, job_key, received_at DESC);

    CREATE TABLE IF NOT EXISTS application_outcome_suggestions (
      tenant_id          TEXT NOT NULL DEFAULT 'local',
      suggestion_id      TEXT NOT NULL,
      job_key            TEXT NOT NULL,
      evidence_id        TEXT,
      suggested_kind     TEXT NOT NULL,
      confidence         REAL NOT NULL DEFAULT 0,
      rationale          TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT 'pending',
      created_at         TEXT NOT NULL,
      decided_at         TEXT,
      decision           TEXT,
      decision_reason    TEXT,
      decided_outcome_id TEXT,
      PRIMARY KEY (tenant_id, suggestion_id)
    );
    CREATE INDEX IF NOT EXISTS idx_application_outcome_suggestions_job
      ON application_outcome_suggestions(tenant_id, job_key, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_application_outcome_suggestions_status
      ON application_outcome_suggestions(tenant_id, status, created_at DESC);
  `);
}

export function listApplyReviewQueue(db: SqliteDatabase): ApplyReviewQueueResponse {
  ensureApplicationFeedbackTables(db);
  refreshProjections(db);

  const hiddenWhere = tableExists(db, "jobhunter_hidden_jobs")
    ? `AND NOT EXISTS (
         SELECT 1 FROM jobhunter_hidden_jobs h
         WHERE h.job_url = jlp.job_id AND h.unhidden_at IS NULL
       )`
    : "";
  const closedWhere = tableExists(db, "posting_snapshot_sets")
    ? `AND NOT EXISTS (
         SELECT 1 FROM posting_snapshot_sets pss
         WHERE pss.job_url = jlp.job_id
           AND pss.latest_active_state IN (${CLOSED_ACTIVE_STATES.map(() => "?").join(", ")})
       )`
    : "";
  const closedParams = tableExists(db, "posting_snapshot_sets") ? CLOSED_ACTIVE_STATES : [];
  const rows = allRows<ReviewQueueRow>(
    db,
    `
    WITH latest_decision AS (
      SELECT decision_id, job_key, decision, decided_at
      FROM (
        SELECT decision_id, job_key, decision, decided_at,
               ROW_NUMBER() OVER (
                 PARTITION BY tenant_id, job_key
                 ORDER BY decided_at DESC, decision_id DESC
               ) AS row_num
        FROM application_review_decisions
        WHERE tenant_id = ?
      )
      WHERE row_num = 1
    ),
    latest_apply_run AS (
      SELECT run_id, job_id, status, result, dry_run, started_at, finished_at
      FROM (
        SELECT run_id, job_id, status, result, dry_run, started_at, finished_at,
               ROW_NUMBER() OVER (
                 PARTITION BY tenant_id, job_id
                 ORDER BY COALESCE(started_at, finished_at, '') DESC, run_id DESC
               ) AS row_num
        FROM apply_run_projections
        WHERE tenant_id = ?
      )
      WHERE row_num = 1
    )
    SELECT jlp.job_id, jlp.title, jlp.employer, jlp.source, jlp.application_url,
           jlp.fit_score, jlp.description, jlp.full_description,
           jlp.score_breakdown_json, jlp.score_keywords_json,
           jlp.current_stage, jlp.current_state,
           jlp.current_error_code, jlp.current_error_message,
           jlp.has_resume, jlp.has_cover_letter, jlp.has_pdf,
           latest_decision.decision_id, latest_decision.decision,
           latest_decision.decided_at,
           latest_apply_run.run_id, latest_apply_run.status AS apply_run_status,
           latest_apply_run.result, latest_apply_run.dry_run,
           latest_apply_run.started_at, latest_apply_run.finished_at
    FROM job_list_projections jlp
    LEFT JOIN latest_decision ON latest_decision.job_key = jlp.job_id
    LEFT JOIN latest_apply_run ON latest_apply_run.job_id = jlp.job_id
    WHERE jlp.tenant_id = ?
      AND jlp.deleted_at IS NULL
      ${hiddenWhere}
      ${closedWhere}
      AND COALESCE(jlp.apply_status, '') != 'applied'
      AND jlp.current_stage = 'apply'
      AND jlp.current_state IN ('pending', 'blocked', 'failed', 'stale')
      AND (
        jlp.has_resume = 1
        OR jlp.application_url IS NOT NULL
        OR jlp.fit_score IS NOT NULL
      )
      AND COALESCE(latest_decision.decision, '') NOT IN ('defer', 'decline')
    ORDER BY
      CASE COALESCE(latest_decision.decision, '')
        WHEN 'approve_submit' THEN 0
        WHEN 'approve_dry_run' THEN 1
        ELSE 2
      END,
      jlp.fit_score DESC,
      jlp.title ASC
    `,
    [DEFAULT_TENANT, DEFAULT_TENANT, DEFAULT_TENANT, ...closedParams],
  );

  const profileSourceFields = profileSourceFieldsForApplyReview(db);
  return {
    ok: true,
    items: rows.map((row) => reviewQueueItemFromRow(db, row, profileSourceFields)),
  };
}

export function recordApplyReviewDecision(
  db: SqliteDatabase,
  jobKey: string,
  request: ApplyReviewDecisionRequest,
): ApplyReviewDecisionResponse {
  ensureApplicationFeedbackTables(db);
  const jobUrl = existingJobUrl(db, jobKey);
  const decidedAt = new Date().toISOString();
  const decision: ApplyReviewDecision = {
    decisionId: crypto.randomUUID(),
    jobKey: jobUrl,
    decision: request.decision,
    reason: request.reason ?? null,
    decidedBy: request.decidedBy,
    decidedAt,
  };

  db.prepare(
    `INSERT INTO application_review_decisions (
       tenant_id, decision_id, job_key, decision, reason, decided_by, decided_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEFAULT_TENANT,
    decision.decisionId,
    decision.jobKey,
    decision.decision,
    decision.reason,
    decision.decidedBy,
    decision.decidedAt,
  );

  recordEvent(db, {
    eventType: "ApplyReviewDecisionRecorded",
    jobUrl,
    stage: "apply",
    message: "Apply review decision recorded.",
    payload: {
      tenantId: DEFAULT_TENANT,
      jobKey: jobUrl,
      decisionId: decision.decisionId,
      decision: decision.decision,
      reasonPresent: Boolean(decision.reason),
    },
  });

  return { ok: true, decision };
}

export function listApplicationOutcomes(
  db: SqliteDatabase,
): ApplicationOutcomeListResponse {
  ensureApplicationFeedbackTables(db);
  return {
    ok: true,
    outcomes: readOutcomes(db),
    suggestions: readSuggestions(db),
  };
}

export function listJobApplicationOutcomes(
  db: SqliteDatabase,
  jobKey: string,
): JobApplicationOutcomeListResponse | null {
  ensureApplicationFeedbackTables(db);
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    return null;
  }
  return {
    ok: true,
    jobKey: jobUrl,
    outcomes: readOutcomes(db, jobUrl),
    suggestions: readSuggestions(db, jobUrl),
  };
}

export function recordManualApplicationOutcome(
  db: SqliteDatabase,
  jobKey: string,
  request: ManualApplicationOutcomeRequest,
): ApplicationOutcomeWriteResponse {
  ensureApplicationFeedbackTables(db);
  const jobUrl = existingJobUrl(db, jobKey);
  const outcome = insertOutcome(db, {
    jobKey: jobUrl,
    kind: request.kind,
    source: "manual",
    note: request.note ?? null,
    occurredAt: request.occurredAt ?? new Date().toISOString(),
    suggestionId: null,
    evidenceId: null,
  });
  return { ok: true, outcome };
}

export function decideOutcomeSuggestion(
  db: SqliteDatabase,
  suggestionId: string,
  request: OutcomeSuggestionDecisionRequest,
): OutcomeSuggestionDecisionResponse {
  ensureApplicationFeedbackTables(db);
  const existing = getSuggestionRow(db, suggestionId);
  if (!existing) {
    throw new InputError("Outcome suggestion not found.");
  }
  if (existing.status !== "pending") {
    return {
      ok: true,
      suggestion: suggestionFromRow(existing),
      outcome: existing.decided_outcome_id ? readOutcome(db, existing.decided_outcome_id) : null,
    };
  }
  const decidedAt = new Date().toISOString();
  let outcome: ApplicationOutcome | null = null;

  const write = db.transaction(() => {
    if (request.decision === "accept" || request.decision === "correct") {
      const kind =
        request.decision === "correct"
          ? (request.outcomeKind as ApplicationOutcomeKind)
          : outcomeKind(existing.suggested_kind);
      outcome = insertOutcome(db, {
        jobKey: existing.job_key,
        kind,
        source: "email_suggestion",
        note: request.note ?? null,
        occurredAt: request.occurredAt ?? decidedAt,
        suggestionId: existing.suggestion_id,
        evidenceId: existing.evidence_id,
      });
    }

    db.prepare(
      `UPDATE application_outcome_suggestions
       SET status = ?,
           decision = ?,
           decided_at = ?,
           decision_reason = ?,
           decided_outcome_id = ?
       WHERE tenant_id = ? AND suggestion_id = ?`,
    ).run(
      suggestionStatusForDecision(request.decision),
      request.decision,
      decidedAt,
      request.reason ?? null,
      outcome?.outcomeId ?? null,
      DEFAULT_TENANT,
      existing.suggestion_id,
    );

    recordEvent(db, {
      eventType: "OutcomeSuggestionDecided",
      jobUrl: existing.job_key,
      stage: "apply",
      message: "Application outcome suggestion decision recorded.",
      payload: {
        tenantId: DEFAULT_TENANT,
        jobKey: existing.job_key,
        suggestionId: existing.suggestion_id,
        evidenceId: existing.evidence_id,
        decision: request.decision,
        outcomeId: outcome?.outcomeId ?? null,
        outcomeKind: outcome?.kind ?? null,
        notePresent: Boolean(request.note),
        reasonPresent: Boolean(request.reason),
      },
    });
  });
  write();

  const suggestion = getSuggestionRow(db, suggestionId);
  if (!suggestion) {
    throw new InputError("Outcome suggestion not found.");
  }
  return {
    ok: true,
    suggestion: suggestionFromRow(suggestion),
    outcome,
  };
}

function insertOutcome(
  db: SqliteDatabase,
  input: {
    jobKey: string;
    kind: ApplicationOutcomeKind;
    source: ApplicationOutcomeSource;
    note: string | null;
    occurredAt: string;
    suggestionId: string | null;
    evidenceId: string | null;
  },
): ApplicationOutcome {
  const recordedAt = new Date().toISOString();
  const outcome: ApplicationOutcome = {
    outcomeId: crypto.randomUUID(),
    jobKey: input.jobKey,
    kind: input.kind,
    source: input.source,
    note: input.note,
    occurredAt: input.occurredAt,
    recordedAt,
    suggestionId: input.suggestionId,
    evidenceId: input.evidenceId,
  };

  db.prepare(
    `INSERT INTO application_outcomes (
       tenant_id, outcome_id, job_key, kind, source, note, occurred_at,
       recorded_at, suggestion_id, evidence_id, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEFAULT_TENANT,
    outcome.outcomeId,
    outcome.jobKey,
    outcome.kind,
    outcome.source,
    outcome.note,
    outcome.occurredAt,
    outcome.recordedAt,
    outcome.suggestionId,
    outcome.evidenceId,
    "user",
  );

  recordEvent(db, {
    eventType: "ApplicationOutcomeRecorded",
    jobUrl: outcome.jobKey,
    stage: "apply",
    message: "Application outcome recorded.",
    payload: {
      tenantId: DEFAULT_TENANT,
      jobKey: outcome.jobKey,
      outcomeId: outcome.outcomeId,
      kind: outcome.kind,
      source: outcome.source,
      occurredAt: outcome.occurredAt,
      suggestionId: outcome.suggestionId,
      evidenceId: outcome.evidenceId,
      notePresent: Boolean(outcome.note),
    },
  });

  return outcome;
}

function readOutcomes(db: SqliteDatabase, jobKey?: string): ApplicationOutcome[] {
  const where = jobKey ? "WHERE tenant_id = ? AND job_key = ?" : "WHERE tenant_id = ?";
  const params = jobKey ? [DEFAULT_TENANT, jobKey] : [DEFAULT_TENANT];
  return allRows<OutcomeRow>(
    db,
    `SELECT outcome_id, job_key, kind, source, note, occurred_at,
            recorded_at, suggestion_id, evidence_id
     FROM application_outcomes
     ${where}
     ORDER BY occurred_at DESC, recorded_at DESC, outcome_id DESC`,
    params,
  ).map(outcomeFromRow);
}

function readOutcome(db: SqliteDatabase, outcomeId: string): ApplicationOutcome | null {
  const row = getRow<OutcomeRow>(
    db,
    `SELECT outcome_id, job_key, kind, source, note, occurred_at,
            recorded_at, suggestion_id, evidence_id
     FROM application_outcomes
     WHERE tenant_id = ? AND outcome_id = ?`,
    [DEFAULT_TENANT, outcomeId],
  );
  return row ? outcomeFromRow(row) : null;
}

function readSuggestions(db: SqliteDatabase, jobKey?: string): OutcomeSuggestion[] {
  const where = jobKey ? "WHERE tenant_id = ? AND job_key = ?" : "WHERE tenant_id = ?";
  const params = jobKey ? [DEFAULT_TENANT, jobKey] : [DEFAULT_TENANT];
  return allRows<SuggestionRow>(
    db,
    `SELECT suggestion_id, job_key, evidence_id, suggested_kind, confidence,
            rationale, status, created_at, decided_at, decision_reason,
            decided_outcome_id
     FROM application_outcome_suggestions
     ${where}
     ORDER BY created_at DESC, suggestion_id DESC`,
    params,
  ).map(suggestionFromRow);
}

function getSuggestionRow(db: SqliteDatabase, suggestionId: string): SuggestionRow | undefined {
  return getRow<SuggestionRow>(
    db,
    `SELECT suggestion_id, job_key, evidence_id, suggested_kind, confidence,
            rationale, status, created_at, decided_at, decision_reason,
            decided_outcome_id
     FROM application_outcome_suggestions
     WHERE tenant_id = ? AND suggestion_id = ?`,
    [DEFAULT_TENANT, suggestionId],
  );
}

function reviewQueueItemFromRow(
  db: SqliteDatabase,
  row: ReviewQueueRow,
  profileSourceFields: readonly ApplyReviewProfileSourceField[],
): ApplyReviewQueueItem {
  const currentState = stageState(row.current_state);
  const blockers = queueBlockers(row, currentState);
  const scoreBreakdown = parseQueueScoreBreakdown(row.score_breakdown_json);
  const applicationUrl = applyTargetUrl(row);
  const materialsPreview = materialPreviewsForJob(db, row.job_id, profileSourceFields);
  const latestApplyRun = row.run_id
    ? {
        runId: row.run_id,
        status: row.apply_run_status ?? "",
        result: row.result,
        dryRun: Boolean(row.dry_run),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      }
    : null;
  const applyAudit = buildApplyAudit({
    applicationUrl,
    hasResume: Boolean(row.has_resume),
    hasCoverLetter: Boolean(row.has_cover_letter),
    hasPdf: Boolean(row.has_pdf),
    currentStage: stage(row.current_stage),
    currentState,
    currentErrorCode: row.current_error_code,
    currentErrorMessage: row.current_error_message,
    latestApplyRun,
    scoreBreakdown,
    reviewEvidenceAvailable: Boolean(
      scoreBreakdown ||
        materialsPreview.resumeText ||
        materialsPreview.resumePdfArtifactId ||
        materialsPreview.coverLetterText ||
        row.full_description ||
        row.description,
    ),
  });
  return {
    jobKey: row.job_id,
    title: row.title || "Untitled",
    company: row.employer || "Unknown company",
    source: row.source || "unknown",
    fitScore: nullableNumber(row.fit_score),
    applicationUrl,
    currentStage: stage(row.current_stage),
    currentState,
    materials: {
      hasResume: Boolean(row.has_resume),
      hasCoverLetter: Boolean(row.has_cover_letter),
      hasPdf: Boolean(row.has_pdf),
      ready: applyAudit.state === "ready",
    },
    applyAudit,
    position: {
      descriptionPreview: previewText(
        row.full_description || row.description,
        POSITION_PREVIEW_CHAR_LIMIT,
      ),
      requirements: boundedEvidenceList([
        ...(scoreBreakdown?.matchedSignals ?? []),
        ...(scoreBreakdown?.missingSignals ?? []),
        ...(scoreBreakdown?.transferableSignals ?? []),
      ]),
      matched: boundedEvidenceList(scoreBreakdown?.matchedSignals ?? []),
      missing: boundedEvidenceList(scoreBreakdown?.missingSignals ?? []),
      transferable: boundedEvidenceList(scoreBreakdown?.transferableSignals ?? []),
      keywords: boundedEvidenceList(parseStringListJson(row.score_keywords_json)),
    },
    materialsPreview,
    latestApplyRun,
    review: {
      state: reviewState(row.decision),
      decision: reviewDecision(row.decision),
      decidedAt: row.decided_at,
    },
    blockers,
  };
}

function queueBlockers(row: ReviewQueueRow, currentState: StageState): string[] {
  const blockers: string[] = [];
  if (!row.has_resume) blockers.push("missing_resume");
  if (!applyTargetUrl(row)) blockers.push("missing_application_url");
  if (currentState !== "pending") {
    blockers.push(stageBlockerReason(row, currentState));
  }
  return blockers;
}

function applyTargetUrl(row: ReviewQueueRow): string | null {
  const directApplyUrl = cleanBlockerText(row.application_url);
  if (directApplyUrl) {
    return directApplyUrl;
  }
  const postingUrl = cleanBlockerText(row.job_id);
  return postingUrl || null;
}

function stageBlockerReason(row: ReviewQueueRow, currentState: StageState): string {
  const message = cleanBlockerText(row.current_error_message);
  if (message) {
    return message;
  }
  const code = cleanBlockerText(row.current_error_code);
  if (code && !isGenericStageCode(code)) {
    return code;
  }
  return `${stage(row.current_stage)}_${currentState}`;
}

function cleanBlockerText(value: string | null): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isGenericStageCode(value: string): boolean {
  return ["BLOCKED", "FAILED", "STALE", "ERROR"].includes(value.trim().toUpperCase());
}

function parseQueueScoreBreakdown(value: string | null): ScoreBreakdown | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<ScoreBreakdown> | null;
    if (!parsed || typeof parsed !== "object" || (parsed as Record<string, unknown>).legacy === true) {
      return null;
    }
    const eligibility = parsed.eligibility as (Partial<ScoreBreakdown["eligibility"]> & Record<string, unknown>) | undefined;
    const hardBlockers = Array.isArray(eligibility?.hardBlockers)
      ? eligibility.hardBlockers
      : Array.isArray(eligibility?.hard_blockers)
        ? eligibility.hard_blockers
        : [];
    return {
      technicalFit: scoreDimension(parsed.technicalFit),
      experienceFit: scoreDimension(parsed.experienceFit),
      roleFit: scoreDimension(parsed.roleFit),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      fitBand: parsed.fitBand ?? "plausible",
      confidence: parsed.confidence ?? "medium",
      eligibility: {
        status: eligibility?.status ?? "unknown",
        hardBlockers: boundedEvidenceList(hardBlockers),
        warnings: boundedEvidenceList(eligibility?.warnings ?? []),
      },
      matchedSignals: boundedEvidenceList(parsed.matchedSignals ?? []),
      missingSignals: boundedEvidenceList(parsed.missingSignals ?? []),
      transferableSignals: boundedEvidenceList(parsed.transferableSignals ?? []),
    };
  } catch {
    return null;
  }
}

function scoreDimension(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(10, numeric)) : 0;
}

function parseStringListJson(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    return parseStringList(JSON.parse(value));
  } catch {
    return [];
  }
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return boundedEvidenceList(value);
}

function boundedEvidenceList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const bounded = text.length > EVIDENCE_TEXT_LIMIT ? `${text.slice(0, EVIDENCE_TEXT_LIMIT).trim()}...` : text;
    const key = bounded.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bounded);
    if (out.length >= EVIDENCE_LIST_LIMIT) break;
  }
  return out;
}

function previewText(value: string | null | undefined, limit: number): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit).trim()}...` : text;
}

function materialPreviewsForJob(
  db: SqliteDatabase,
  jobKey: string,
  profileSourceFields: readonly ApplyReviewProfileSourceField[],
): ApplyReviewQueueItem["materialsPreview"] {
  const resumePreview = resumeMaterialPreviewForJob(db, jobKey);
  return {
    ...resumePreview,
    profileSourceFields: [...profileSourceFields],
    coverLetterText: coverLetterMaterialPreviewForJob(db, jobKey),
  };
}

const PROFILE_ROOT_SOURCE_FIELDS: Array<{
  readonly column: string;
  readonly label: string;
  readonly path: string;
  readonly section: string;
}> = [
  { column: "personal_full_name", label: "Profile > Personal information > Full name", path: "personal.full_name", section: "profile_personal" },
  { column: "personal_preferred_name", label: "Profile > Personal information > Preferred name", path: "personal.preferred_name", section: "profile_personal" },
  { column: "personal_email", label: "Profile > Personal information > Email", path: "personal.email", section: "profile_personal" },
  { column: "personal_phone", label: "Profile > Personal information > Phone", path: "personal.phone", section: "profile_personal" },
  { column: "personal_address", label: "Profile > Personal information > Address", path: "personal.address", section: "profile_personal" },
  { column: "personal_city", label: "Profile > Personal information > City", path: "personal.city", section: "profile_personal" },
  { column: "personal_province_state", label: "Profile > Personal information > State / province", path: "personal.province_state", section: "profile_personal" },
  { column: "personal_country", label: "Profile > Personal information > Country", path: "personal.country", section: "profile_personal" },
  { column: "personal_postal_code", label: "Profile > Personal information > Postal code", path: "personal.postal_code", section: "profile_personal" },
  { column: "personal_linkedin_url", label: "Profile > Personal information > LinkedIn URL", path: "personal.linkedin_url", section: "profile_personal" },
  { column: "personal_github_url", label: "Profile > Personal information > GitHub URL", path: "personal.github_url", section: "profile_personal" },
  { column: "personal_portfolio_url", label: "Profile > Personal information > Portfolio URL", path: "personal.portfolio_url", section: "profile_personal" },
  { column: "personal_website_url", label: "Profile > Personal information > Website URL", path: "personal.website_url", section: "profile_personal" },
  { column: "resume_baseline_text", label: "Profile > Resume baseline > Executive profile baseline", path: "resume.executive_profile.baseline_text", section: "profile_summary" },
];

function profileSourceFieldsForApplyReview(db: SqliteDatabase): ApplyReviewProfileSourceField[] {
  const fields: ApplyReviewProfileSourceField[] = [];
  appendProfileRootSourceFields(db, fields);
  appendProfileExperienceSourceFields(db, fields);
  appendProfileEducationSourceFields(db, fields);
  appendProfileSkillSourceFields(db, fields);
  return uniqueProfileSourceFields(fields).slice(0, PROFILE_SOURCE_FIELD_LIMIT);
}

function appendProfileRootSourceFields(db: SqliteDatabase, fields: ApplyReviewProfileSourceField[]): void {
  if (!tableExists(db, "candidate_profiles")) return;
  const columns = tableColumnSet(db, "candidate_profiles");
  const available = PROFILE_ROOT_SOURCE_FIELDS.filter((field) => columns.has(field.column));
  if (!available.length) return;
  const row = getRow<Record<string, unknown>>(
    db,
    `SELECT ${available.map((field) => field.column).join(", ")}
       FROM candidate_profiles
      WHERE tenant_id = ? AND profile_id = ?`,
    [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
  );
  if (!row) return;
  for (const field of available) {
    addProfileSourceField(fields, field, row[field.column]);
  }
}

function appendProfileExperienceSourceFields(db: SqliteDatabase, fields: ApplyReviewProfileSourceField[]): void {
  if (!tableExists(db, "candidate_profile_experience_entries")) return;
  const entries = allRows<{
    entry_id: string;
    position_index: number;
    date_range: string;
    title: string;
    company: string;
    location: string;
  }>(
    db,
    `SELECT entry_id, position_index, date_range, title, company, location
       FROM candidate_profile_experience_entries
      WHERE tenant_id = ? AND profile_id = ?
      ORDER BY position_index`,
    [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
  );
  for (const entry of entries) {
    const index = Number(entry.position_index ?? 0);
    const heading = profileEntryHeading(entry.title, entry.company, `Experience ${index + 1}`);
    addProfileSourceField(fields, profileField(`Profile > Experience entries > ${heading} > Title`, `resume.experience_entries.${index}.title`, "profile_experience"), entry.title);
    addProfileSourceField(fields, profileField(`Profile > Experience entries > ${heading} > Company`, `resume.experience_entries.${index}.company`, "profile_experience"), entry.company);
    addProfileSourceField(fields, profileField(`Profile > Experience entries > ${heading} > Location`, `resume.experience_entries.${index}.location`, "profile_experience"), entry.location);
    addProfileSourceField(fields, profileField(`Profile > Experience entries > ${heading} > Date range`, `resume.experience_entries.${index}.date_range`, "profile_experience"), entry.date_range);
  }
  if (!tableExists(db, "candidate_profile_experience_bullets")) return;
  const bullets = allRows<{
    position_index: number;
    title: string;
    company: string;
    bullet_index: number;
    bullet_text: string;
  }>(
    db,
    `SELECT entries.position_index,
            entries.title,
            entries.company,
            bullets.bullet_index,
            bullets.bullet_text
       FROM candidate_profile_experience_entries AS entries
       JOIN candidate_profile_experience_bullets AS bullets
         ON bullets.tenant_id = entries.tenant_id
        AND bullets.profile_id = entries.profile_id
        AND bullets.entry_id = entries.entry_id
      WHERE entries.tenant_id = ? AND entries.profile_id = ?
      ORDER BY entries.position_index, bullets.bullet_index`,
    [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
  );
  for (const bullet of bullets) {
    const entryIndex = Number(bullet.position_index ?? 0);
    const bulletIndex = Number(bullet.bullet_index ?? 0);
    const heading = profileEntryHeading(bullet.title, bullet.company, `Experience ${entryIndex + 1}`);
    addProfileSourceField(
      fields,
      profileField(
        `Profile > Experience entries > ${heading} > Bullet ${bulletIndex + 1}`,
        `resume.experience_entries.${entryIndex}.bullets.${bulletIndex}`,
        "profile_experience",
      ),
      bullet.bullet_text,
    );
  }
}

function appendProfileEducationSourceFields(db: SqliteDatabase, fields: ApplyReviewProfileSourceField[]): void {
  if (!tableExists(db, "candidate_profile_education_entries")) return;
  const rows = allRows<{
    position_index: number;
    date: string;
    degree: string;
    institution: string;
    location: string;
  }>(
    db,
    `SELECT position_index, date, degree, institution, location
       FROM candidate_profile_education_entries
      WHERE tenant_id = ? AND profile_id = ?
      ORDER BY position_index`,
    [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
  );
  for (const row of rows) {
    const index = Number(row.position_index ?? 0);
    const heading = profileEntryHeading(row.degree, row.institution, `Education ${index + 1}`);
    addProfileSourceField(fields, profileField(`Profile > Education > ${heading} > Degree`, `resume.education_entries.${index}.degree`, "profile_education"), row.degree);
    addProfileSourceField(fields, profileField(`Profile > Education > ${heading} > Institution`, `resume.education_entries.${index}.institution`, "profile_education"), row.institution);
    addProfileSourceField(fields, profileField(`Profile > Education > ${heading} > Location`, `resume.education_entries.${index}.location`, "profile_education"), row.location);
    addProfileSourceField(fields, profileField(`Profile > Education > ${heading} > Completion month`, `resume.education_entries.${index}.date`, "profile_education"), row.date);
  }
}

function appendProfileSkillSourceFields(db: SqliteDatabase, fields: ApplyReviewProfileSourceField[]): void {
  if (!tableExists(db, "candidate_profile_skill_categories")) return;
  const categories = allRows<{
    category_id: string;
    position_index: number;
    label: string;
  }>(
    db,
    `SELECT category_id, position_index, label
       FROM candidate_profile_skill_categories
      WHERE tenant_id = ? AND profile_id = ?
      ORDER BY position_index`,
    [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
  );
  for (const category of categories) {
    const index = Number(category.position_index ?? 0);
    const label = profileEntryHeading(category.label, category.category_id, `Skill category ${index + 1}`);
    addProfileSourceField(fields, profileField(`Profile > Skills > ${label} > Label`, `resume.skill_categories.${index}.label`, "profile_skills"), category.label);
  }
  if (!tableExists(db, "candidate_profile_skill_items")) return;
  const skills = allRows<{
    position_index: number;
    label: string;
    category_id: string;
    item_index: number;
    item_text: string;
  }>(
    db,
    `SELECT categories.position_index,
            categories.label,
            skills.category_id,
            skills.item_index,
            skills.item_text
       FROM candidate_profile_skill_items AS skills
       LEFT JOIN candidate_profile_skill_categories AS categories
         ON categories.tenant_id = skills.tenant_id
        AND categories.profile_id = skills.profile_id
        AND categories.category_id = skills.category_id
      WHERE skills.tenant_id = ? AND skills.profile_id = ?
      ORDER BY categories.position_index, skills.item_index`,
    [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
  );
  for (const skill of skills) {
    const categoryIndex = Number(skill.position_index ?? 0);
    const skillIndex = Number(skill.item_index ?? 0);
    const label = profileEntryHeading(skill.label, skill.category_id, `Skill category ${categoryIndex + 1}`);
    addProfileSourceField(
      fields,
      profileField(
        `Profile > Skills > ${label} > Skill ${skillIndex + 1}`,
        `resume.skill_categories.${categoryIndex}.items.${skillIndex}`,
        "profile_skills",
      ),
      skill.item_text,
    );
  }
}

function tableColumnSet(db: SqliteDatabase, table: string): Set<string> {
  return new Set(allRows<{ name: string }>(db, `PRAGMA table_info(${table})`).map((row) => row.name));
}

function profileField(label: string, path: string, section: string): Omit<ApplyReviewProfileSourceField, "value"> {
  return { label, path, section };
}

function addProfileSourceField(
  fields: ApplyReviewProfileSourceField[],
  field: Omit<ApplyReviewProfileSourceField, "value">,
  value: unknown,
): void {
  const text = safeProfileSourceText(value);
  if (!text) return;
  fields.push({ label: field.label, path: field.path, section: field.section, value: text });
}

function safeProfileSourceText(value: unknown, maxLength = PROFILE_SOURCE_VALUE_LIMIT): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

function profileEntryHeading(primary: unknown, secondary: unknown, fallback: string): string {
  const primaryText = safeProfileSourceText(primary, 80);
  const secondaryText = safeProfileSourceText(secondary, 80);
  if (primaryText && secondaryText && primaryText !== secondaryText) return `${primaryText} at ${secondaryText}`;
  return primaryText || secondaryText || fallback;
}

function uniqueProfileSourceFields(fields: readonly ApplyReviewProfileSourceField[]): ApplyReviewProfileSourceField[] {
  const seen = new Set<string>();
  const out: ApplyReviewProfileSourceField[] = [];
  for (const field of fields) {
    const key = `${field.path}:${field.value}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(field);
  }
  return out;
}

type ResumeMaterialPreview = Pick<
  ApplyReviewQueueItem["materialsPreview"],
  "resumeText" | "resumeTextArtifactId" | "resumePdfArtifactId"
>;

interface MaterialArtifactCandidate {
  readonly artifactId: string | null;
  readonly createdAt: string;
  readonly generation: number | null;
  readonly path: string;
  readonly rowRank: number;
  readonly sourceRank: number;
}

const RESUME_TEXT_ARTIFACT_TYPES = ["tailored_resume", "tailored_resume_txt", "resume_txt"] as const;
const RESUME_PDF_ARTIFACT_TYPES = ["tailored_resume_pdf", "resume_pdf"] as const;
const COVER_LETTER_TEXT_ARTIFACT_TYPES = ["cover_letter", "cover_letter_txt"] as const;

function coverLetterMaterialPreviewForJob(db: SqliteDatabase, jobKey: string): string | null {
  const text = firstReadableTextCandidate(
    materialArtifactCandidates(db, {
      artifactTypes: COVER_LETTER_TEXT_ARTIFACT_TYPES,
      binary: false,
      includeLegacyJobColumn: "cover_letter_path",
      jobKey,
    }),
    { byteLimit: COVER_LETTER_REVIEW_TEXT_BYTE_LIMIT, charLimit: null },
  );
  return text?.preview ?? null;
}

function resumeMaterialPreviewForJob(db: SqliteDatabase, jobKey: string): ResumeMaterialPreview {
  const textCandidates = materialArtifactCandidates(db, {
    artifactTypes: RESUME_TEXT_ARTIFACT_TYPES,
    binary: false,
    includeLegacyJobColumn: "tailored_resume_path",
    jobKey,
  });
  const pdfCandidates = materialArtifactCandidates(db, {
    artifactTypes: RESUME_PDF_ARTIFACT_TYPES,
    binary: true,
    jobKey,
  }).filter((candidate) => candidate.artifactId);

  for (const pdf of pdfCandidates) {
    const text = firstReadableTextCandidate(
      textCandidates.filter((candidate) => sameMaterialGeneration(candidate, pdf)),
      { byteLimit: RESUME_AUDIT_TEXT_BYTE_LIMIT, charLimit: null },
    );
    if (text) {
      return {
        resumeText: text.preview,
        resumeTextArtifactId: text.candidate.artifactId,
        resumePdfArtifactId: pdf.artifactId,
      };
    }
  }

  const pdfOnly = pdfCandidates[0];
  if (pdfOnly) {
    return {
      resumeText: null,
      resumeTextArtifactId: null,
      resumePdfArtifactId: pdfOnly.artifactId,
    };
  }

  const text = firstReadableTextCandidate(textCandidates, { byteLimit: RESUME_AUDIT_TEXT_BYTE_LIMIT, charLimit: null });
  if (text) {
    return {
      resumeText: text.preview,
      resumeTextArtifactId: text.candidate.artifactId,
      resumePdfArtifactId: null,
    };
  }

  return {
    resumeText: null,
    resumeTextArtifactId: null,
    resumePdfArtifactId: pdfCandidates[0]?.artifactId ?? null,
  };
}

function firstReadableTextCandidate(
  candidates: readonly MaterialArtifactCandidate[],
  options: ReadTextOptions = {},
): { candidate: MaterialArtifactCandidate; preview: string } | null {
  for (const candidate of candidates) {
    const preview = readTextPreview(candidate.path, options);
    if (preview) {
      return { candidate, preview };
    }
  }
  return null;
}

function materialArtifactCandidates(
  db: SqliteDatabase,
  {
    artifactTypes,
    binary,
    includeLegacyJobColumn,
    jobKey,
  }: {
    readonly artifactTypes: readonly string[];
    readonly binary: boolean;
    readonly includeLegacyJobColumn?: "tailored_resume_path" | "cover_letter_path";
    readonly jobKey: string;
  },
): MaterialArtifactCandidate[] {
  const candidates: MaterialArtifactCandidate[] = [];
  const placeholders = artifactTypes.map(() => "?").join(", ");

  if (tableExists(db, "artifact_list_projections")) {
    const rows = allRows<{
      artifact_id: string | null;
      created_at: string | null;
      generation: number | null;
      local_path: string | null;
    }>(
      db,
      `SELECT artifact_id, local_path, generation, created_at
       FROM artifact_list_projections
       WHERE job_id = ?
         AND artifact_type IN (${placeholders})
         AND COALESCE(status, 'active') IN ('approved', 'active')
         AND local_path IS NOT NULL
         AND local_path != ''
       ORDER BY COALESCE(generation, -1) DESC, COALESCE(created_at, '') DESC, artifact_id DESC
       LIMIT 16`,
      [jobKey, ...artifactTypes],
    );
    for (const [index, row] of rows.entries()) {
      pushMaterialCandidate(candidates, {
        artifactId: row.artifact_id,
        binary,
        createdAt: row.created_at,
        generation: row.generation,
        path: row.local_path,
        rowRank: index,
        sourceRank: 0,
      });
    }
  }

  if (tableExists(db, "job_materials_artifacts")) {
    const rows = allRows<{
      artifact_id: string | null;
      created_at: string | null;
      generation: number | null;
      path: string | null;
    }>(
      db,
      `SELECT artifact_id, path, generation, created_at
       FROM job_materials_artifacts
       WHERE job_url = ?
         AND artifact_type IN (${placeholders})
         AND COALESCE(status, 'approved') IN ('approved', 'active')
         AND path IS NOT NULL
         AND path != ''
       ORDER BY COALESCE(generation, -1) DESC, COALESCE(created_at, '') DESC, rowid DESC
       LIMIT 16`,
      [jobKey, ...artifactTypes],
    );
    for (const [index, row] of rows.entries()) {
      pushMaterialCandidate(candidates, {
        artifactId: row.artifact_id,
        binary,
        createdAt: row.created_at,
        generation: row.generation,
        path: row.path,
        rowRank: index,
        sourceRank: 1,
      });
    }
  }

  if (tableExists(db, "job_artifacts")) {
    const rows = allRows<{
      created_at: string | null;
      path: string | null;
      row_id: string | number | null;
    }>(
      db,
      `SELECT rowid AS row_id, path, created_at
       FROM job_artifacts
       WHERE job_url = ?
         AND artifact_type IN (${placeholders})
         AND COALESCE(status, 'active') NOT IN ('missing', 'failed', 'superseded', 'suppressed')
         AND path IS NOT NULL
         AND path != ''
       ORDER BY COALESCE(created_at, '') DESC, rowid DESC
       LIMIT 16`,
      [jobKey, ...artifactTypes],
    );
    for (const [index, row] of rows.entries()) {
      pushMaterialCandidate(candidates, {
        artifactId: row.row_id === null || row.row_id === undefined ? null : String(row.row_id),
        binary,
        createdAt: row.created_at,
        generation: null,
        path: row.path,
        rowRank: index,
        sourceRank: 2,
      });
    }
  }

  if (includeLegacyJobColumn && tableExists(db, "jobs")) {
    const legacyRow = getRow<{ path: string | null }>(
      db,
      `SELECT ${includeLegacyJobColumn} AS path FROM jobs WHERE url = ?`,
      [jobKey],
    );
    pushMaterialCandidate(candidates, {
      artifactId: null,
      binary,
      createdAt: "",
      generation: null,
      path: legacyRow?.path ?? null,
      rowRank: 0,
      sourceRank: 3,
    });
  }

  return candidates.sort(compareMaterialCandidates);
}

function pushMaterialCandidate(
  candidates: MaterialArtifactCandidate[],
  input: {
    readonly artifactId: string | null | undefined;
    readonly binary: boolean;
    readonly createdAt: string | null | undefined;
    readonly generation: number | null | undefined;
    readonly path: string | null | undefined;
    readonly rowRank: number;
    readonly sourceRank: number;
  },
): void {
  const path = String(input.path ?? "").trim();
  if (!path || !artifactPathExists(path, { binary: input.binary })) {
    return;
  }
  candidates.push({
    artifactId: input.artifactId ? String(input.artifactId) : null,
    createdAt: String(input.createdAt ?? ""),
    generation: nullableNumber(input.generation),
    path,
    rowRank: input.rowRank,
    sourceRank: input.sourceRank,
  });
}

function compareMaterialCandidates(a: MaterialArtifactCandidate, b: MaterialArtifactCandidate): number {
  const generation = (b.generation ?? -1) - (a.generation ?? -1);
  if (generation !== 0) return generation;
  const createdAt = b.createdAt.localeCompare(a.createdAt);
  if (createdAt !== 0) return createdAt;
  const source = a.sourceRank - b.sourceRank;
  if (source !== 0) return source;
  return a.rowRank - b.rowRank;
}

function sameMaterialGeneration(a: MaterialArtifactCandidate, b: MaterialArtifactCandidate): boolean {
  return a.generation === b.generation;
}

function artifactPathExists(artifactPath: string, { binary }: { readonly binary: boolean }): boolean {
  try {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      return false;
    }
    return binary || !isBinaryPreviewPath(artifactPath);
  } catch {
    // Artifact files can disappear while the local projection still exists.
    // In that case the review UI should fall back to the next available source.
    return false;
  }
}

function isBinaryPreviewPath(artifactPath: string): boolean {
  return /\.(pdf|docx?|png|jpe?g|webp|gif|zip)$/i.test(artifactPath);
}

interface ReadTextOptions {
  readonly byteLimit?: number;
  readonly charLimit?: number | null;
}

function readTextPreview(artifactPath: string, options: ReadTextOptions = {}): string | null {
  let fd: number | null = null;
  try {
    const stats = fs.statSync(artifactPath);
    if (!stats.isFile()) {
      return null;
    }
    const byteCount = Math.min(stats.size, options.byteLimit ?? MATERIAL_PREVIEW_BYTE_LIMIT);
    if (byteCount <= 0) {
      return null;
    }
    const buffer = Buffer.alloc(byteCount);
    fd = fs.openSync(artifactPath, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, byteCount, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (!text.trim() || text.includes("\u0000")) {
      return null;
    }
    return options.charLimit === null ? previewText(text, text.length) : previewText(text, options.charLimit ?? MATERIAL_PREVIEW_CHAR_LIMIT);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function outcomeFromRow(row: OutcomeRow): ApplicationOutcome {
  return {
    outcomeId: row.outcome_id,
    jobKey: row.job_key,
    kind: outcomeKind(row.kind),
    source: row.source === "email_suggestion" ? "email_suggestion" : "manual",
    note: row.note,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    suggestionId: row.suggestion_id,
    evidenceId: row.evidence_id,
  };
}

function suggestionFromRow(row: SuggestionRow): OutcomeSuggestion {
  return {
    suggestionId: row.suggestion_id,
    jobKey: row.job_key,
    evidenceId: row.evidence_id,
    suggestedKind: outcomeKind(row.suggested_kind),
    confidence: Number(row.confidence ?? 0),
    rationale: row.rationale ?? "",
    status: suggestionStatus(row.status),
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    decidedOutcomeId: row.decided_outcome_id,
  };
}

function existingJobUrl(db: SqliteDatabase, jobKey: string): string {
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    throw new InputError("Job not found.");
  }
  return jobUrl;
}

function recordEvent(
  db: SqliteDatabase,
  event: {
    eventType: string;
    payload: Record<string, unknown>;
    message: string;
    jobUrl: string;
    stage: Stage;
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
    stage: event.stage,
    event_type: event.eventType,
    level: "info",
    message: event.message,
    occurred_at: new Date().toISOString(),
    payload_json: JSON.stringify(event.payload),
  };
  const entries = Object.entries(values).filter(([name]) => columns.has(name));
  if (!entries.length) {
    return;
  }
  db.prepare(
    `INSERT INTO job_events (${entries.map(([name]) => name).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`,
  ).run(...entries.map(([, value]) => value));
}

function reviewState(
  value: string | null,
): ApplyReviewQueueItem["review"]["state"] {
  switch (value) {
    case "approve_submit":
      return "approved_submit";
    case "approve_dry_run":
      return "approved_dry_run";
    case "defer":
      return "deferred";
    case "decline":
      return "declined";
    default:
      return "pending";
  }
}

function reviewDecision(value: string | null): ApplyReviewDecisionValue | null {
  return APPLY_REVIEW_DECISION_VALUES.includes(value as ApplyReviewDecisionValue)
    ? (value as ApplyReviewDecisionValue)
    : null;
}

function outcomeKind(value: string): ApplicationOutcomeKind {
  return APPLICATION_OUTCOME_KINDS.includes(value as ApplicationOutcomeKind)
    ? (value as ApplicationOutcomeKind)
    : "unknown";
}

function suggestionStatus(value: string): OutcomeSuggestionStatus {
  return OUTCOME_SUGGESTION_STATUSES.includes(value as OutcomeSuggestionStatus)
    ? (value as OutcomeSuggestionStatus)
    : "pending";
}

function suggestionStatusForDecision(
  decision: OutcomeSuggestionDecisionRequest["decision"],
): OutcomeSuggestionStatus {
  if (decision === "accept") return "accepted";
  if (decision === "correct") return "corrected";
  return "ignored";
}

function stage(value: string): Stage {
  return STAGES.includes(value as Stage) ? (value as Stage) : "apply";
}

function stageState(value: string): StageState {
  return STAGE_STATES.includes(value as StageState) ? (value as StageState) : "pending";
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
