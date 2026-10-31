import { actionIdentity, actionReceiptKey, assertActionReceipt, readActionReceipt, ActionReceiptConflictError } from "./action-receipts.js";
import { ManualApplicationOutcomeRequestSchema, OutcomeSuggestionDecisionRequestSchema } from "@jobctrl/contracts";
import { selectResumeMaterial, materialArtifactCandidates, RESUME_TEXT_ARTIFACT_TYPES, RESUME_PDF_ARTIFACT_TYPES, type MaterialArtifactCandidate } from "./material-preview-selection.js";
import { safeCoverLetterAccepted, coverLetterAccepted, coverLetterSourceBytes, coverLetterTextForSource, requireCoverLetterApproval } from "./cover-letter-review.js";
import { MessageOutcomeDeterminationSchema } from "@jobctrl/contracts";
import { readArtifactLineAnchors, readDetermination } from "./semantic-determinations.js";
import crypto from "node:crypto";
import path from "node:path";
import { emailApprovalBinding, emailCandidateSha256 } from "./email-approval-binding.js";

import type {
  ApplicationOutcome,
  EmployerAnalysis,
  ApplicationOutcomeKind,
  ApplicationOutcomeListResponse,
  ApplicationOutcomeSource,
  ApplicationOutcomeWriteResponse,
  ApplyReviewDecision,
  ApplyReviewDecisionRequest,
  ApplyReviewDecisionResponse,
  ApplyReviewDecisionValue,
  ApplyReviewApprovalGateReason,
  ApplyReviewDryRunEvidence,
  ApplyReviewIdealRequirement,
  ApplyReviewProfileSourceField,
  ApplyReviewCoverageBasis,
  ApplyReviewQueueItem,
  ApplyReviewQueueResponse,
  ApplyReviewRequirementLedAudit,
  ApplyReviewRequirementLedShippedFit,
  JobCompensationSummary,
  JobApplicationOutcomeListResponse,
  ManualApplicationOutcomeRequest,
  OutcomeSuggestion,
  OutcomeSuggestionDecisionRequest,
  OutcomeSuggestionDecisionResponse,
  OutcomeSuggestionDecisionConflict,
  OutcomeSuggestionStatus,
  RequirementFitAssessment,
  RequirementFitReport,
  ResumeLayoutBox,
  ScoreBreakdown,
  ScoreTrace,
  ScoringCriteriaSnapshot,
  Stage,
  StageState,
} from "./contracts.js";
import {
  APPLICATION_OUTCOME_KINDS,
  compareOutcomeSuggestionDecision,
  EMPLOYER_ANALYSIS_PROMPT_VERSION,
  APPLY_REVIEW_DECISION_VALUES,
  OUTCOME_SUGGESTION_STATUSES,
  STAGES,
  STAGE_STATES,
} from "./contracts.js";
import { bindRequirementFitReport, requirementCoverageForArtifact, requirementIdentities, unrecordedRequirementCoverage } from "./requirement-evidence.js";
import { missingApplicationAttestationFields } from "./application-attestations.js";
import { buildApplyAudit } from "./apply-audit.js";
import { readApplyAuditControls } from "./apply-controls.js";
import { allRows, getRow, type SqliteDatabase } from "./db.js";
import { ensureJobDetailProjection, refreshProjections } from "./projections.js";
import { evaluateRepeatApplication } from "./repeat-application.js";
import { resumeTemplateStateForJob } from "./resume-templates.js";
import { InputError, resolveJobId } from "./write-model.js";

const DEFAULT_TENANT = "local";
const DEFAULT_PROFILE_ID = "default";
const CANONICAL_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLOSED_ACTIVE_STATES = ["closed", "expired", "removed", "location_incompatible"];
const POSITION_PREVIEW_CHAR_LIMIT = 6000;
const EVIDENCE_LIST_LIMIT = 12;
const EVIDENCE_TEXT_LIMIT = 180;
const IDEAL_CANDIDATE_TEXT_LIMIT = 1400;
const IDEAL_REQUIREMENT_TEXT_LIMIT = 420;
const IDEAL_REQUIREMENT_EVIDENCE_TEXT_LIMIT = 260;
const PROFILE_SOURCE_FIELD_LIMIT = 160;
const PROFILE_SOURCE_VALUE_LIMIT = 1200;

interface ReviewQueueRow extends Record<string, unknown> {
  job_id: string;
  title: string;
  employer: string;
  source: string;
  compensation_summary_json: string | null;
  application_url: string | null;
  posting_url: string | null;
  fit_score: number | null;
  description: string;
  full_description: string;
  score_breakdown_json: string | null;
  score_keywords_json: string | null;
  score_reasoning: string | null;
  score_version: number | null;
  scored_at: string | null;
  score_criteria_json: string | null;
  score_trace_json: string | null;
  current_stage: string;
  current_substage: string | null;
  current_state: string;
  current_error_code: string | null;
  current_error_message: string | null;
  has_resume: number;
  has_cover_letter: number;
  has_pdf: number;
  decision_id: string | null;
  decision: string | null;
  decided_at: string | null;
  decision_materials_generation: number | null;
  decision_profile_version: number | null;
  decision_application_url: string | null;
  partial_override_run_id: string | null;
  email_recipient: string | null;
  email_attachment_artifact_id: string | null;
  run_id: string | null;
  apply_run_status: string | null;
  result: string | null;
  dry_run: number | null;
  started_at: string | null;
  finished_at: string | null;
  employer_analysis_generation: number | null;
  employer_ideal_candidate_narrative: string | null;
  employer_requirements_json: string | null;
  requirement_fit_report_json: string | null;
}

interface OutcomeRow extends Record<string, unknown> {
  outcome_id: string;
  job_id: string;
  kind: string;
  source: string;
  note: string | null;
  occurred_at: string;
  recorded_at: string;
  suggestion_id: string | null;
  evidence_id: string | null;
  interview_prep_generation: number | null;
}

interface SuggestionRow extends Record<string, unknown> {
  suggestion_id: string;
  job_id: string;
  evidence_id: string | null;
  suggested_kind: string;
  confidence: number;
  rationale: string;
  status: string;
  decision: string | null;
  created_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  decided_outcome_id: string | null;
}

export function ensureApplicationFeedbackTables(db: SqliteDatabase): void {
  void db;
}

export function listApplyReviewQueue(db: SqliteDatabase, appDir?: string): ApplyReviewQueueResponse {
  ensureApplicationFeedbackTables(db);
  refreshProjections(db);

  const hiddenWhere = `AND NOT EXISTS (
    SELECT 1 FROM jobctrl_hidden_jobs h
    WHERE h.tenant_id = jlp.tenant_id
      AND h.job_id = jlp.job_id
      AND h.unhidden_at IS NULL
  )`;
  const closedWhere = `AND NOT EXISTS (
    SELECT 1 FROM posting_snapshot_sets pss
    WHERE pss.tenant_id = jlp.tenant_id
      AND pss.job_id = jlp.job_id
      AND pss.latest_active_state IN (${CLOSED_ACTIVE_STATES.map(() => "?").join(", ")})
  )`;
  const employerAnalysisCte = `,
    latest_employer_analysis AS (
      SELECT tenant_id, job_id, generation, ideal_candidate_narrative, requirements_json
      FROM (
        SELECT tenant_id, job_id, generation, ideal_candidate_narrative, requirements_json,
               ROW_NUMBER() OVER (
                 PARTITION BY tenant_id, job_id
                 ORDER BY generation DESC
               ) AS row_num
        FROM job_employer_analysis
        WHERE tenant_id = ? AND prompt_version = '${EMPLOYER_ANALYSIS_PROMPT_VERSION}'
      )
      WHERE row_num = 1
    )`;
  const employerAnalysisSelect = `,
         latest_employer_analysis.generation AS employer_analysis_generation,
         latest_employer_analysis.ideal_candidate_narrative AS employer_ideal_candidate_narrative,
         latest_employer_analysis.requirements_json AS employer_requirements_json`;
  const loadRows = () => allRows<ReviewQueueRow>(
    db,
    `
    WITH latest_decision AS (
      SELECT tenant_id, decision_id, job_id, decision, decided_at,
             materials_generation, profile_version, application_url,
             partial_override_run_id, email_recipient, email_attachment_artifact_id
      FROM (
        SELECT tenant_id, decision_id, job_id, decision, decided_at,
               materials_generation, profile_version, application_url,
               partial_override_run_id, email_recipient, email_attachment_artifact_id,
               ROW_NUMBER() OVER (
                 PARTITION BY tenant_id, job_id
                 ORDER BY decided_at DESC, CASE WHEN decision = 'approve_submit' THEN 0 ELSE 1 END DESC, decision_id DESC
               ) AS row_num
        FROM application_review_decisions
        WHERE tenant_id = ?
      )
      WHERE row_num = 1
    ),
    latest_apply_run AS (
      SELECT tenant_id, run_id, job_id, status, result, dry_run, started_at, finished_at
      FROM (
        SELECT tenant_id, run_id, job_id, status, result, dry_run, started_at, finished_at,
               ROW_NUMBER() OVER (
                 PARTITION BY tenant_id, job_id
                 ORDER BY COALESCE(started_at, finished_at, '') DESC, run_id DESC
               ) AS row_num
        FROM apply_run_projections
        WHERE tenant_id = ?
      )
      WHERE row_num = 1
    ),
    apply_stage AS (
      SELECT tenant_id, job_id, state
      FROM (
        SELECT tenant_id, job_id, state,
               ROW_NUMBER() OVER (
                 PARTITION BY tenant_id, job_id
                 ORDER BY COALESCE(updated_at, '') DESC, rowid DESC
               ) AS row_num
        FROM job_stage_states
        WHERE stage = 'apply'
      )
      WHERE row_num = 1
    )
    ${employerAnalysisCte}
    SELECT jlp.job_id, jlp.title, jlp.employer, jlp.source,
           jlp.compensation_summary_json, jlp.application_url,
           jobs.url AS posting_url,
           jlp.fit_score, jlp.description, jlp.full_description,
           jlp.score_breakdown_json, jlp.score_keywords_json,
           jlp.score_reasoning, jlp.score_version, jlp.scored_at,
           jlp.score_criteria_json, jlp.score_trace_json,
           jlp.current_stage, jlp.current_substage, jlp.current_state,
           jlp.current_error_code, jlp.current_error_message,
           jlp.has_resume, jlp.has_cover_letter, jlp.has_pdf,
           latest_decision.decision_id, latest_decision.decision,
           latest_decision.decided_at,
           latest_decision.materials_generation AS decision_materials_generation,
           latest_decision.profile_version AS decision_profile_version,
           latest_decision.application_url AS decision_application_url,
           latest_decision.partial_override_run_id,
           latest_decision.email_recipient,
           latest_decision.email_attachment_artifact_id,
           latest_apply_run.run_id, latest_apply_run.status AS apply_run_status,
           latest_apply_run.result, latest_apply_run.dry_run,
           latest_apply_run.started_at, latest_apply_run.finished_at,
           jdp.requirement_fit_report_json
           ${employerAnalysisSelect}
    FROM job_list_projections jlp
    INNER JOIN jobs ON jobs.tenant_id = jlp.tenant_id AND jobs.job_id = jlp.job_id
    LEFT JOIN job_detail_projections jdp ON jdp.tenant_id = jlp.tenant_id AND jdp.job_id = jlp.job_id
    LEFT JOIN latest_decision
      ON latest_decision.tenant_id = jlp.tenant_id
     AND latest_decision.job_id = jlp.job_id
    LEFT JOIN latest_apply_run
      ON latest_apply_run.tenant_id = jlp.tenant_id
     AND latest_apply_run.job_id = jlp.job_id
    INNER JOIN apply_stage
      ON apply_stage.tenant_id = jlp.tenant_id
     AND apply_stage.job_id = jlp.job_id
    LEFT JOIN latest_employer_analysis
      ON latest_employer_analysis.tenant_id = jlp.tenant_id
     AND latest_employer_analysis.job_id = jlp.job_id
    WHERE jlp.tenant_id = ?
      AND jlp.deleted_at IS NULL
      ${hiddenWhere}
      ${closedWhere}
      AND COALESCE(jlp.apply_status, '') != 'applied'
      AND apply_stage.state IN ('pending', 'blocked', 'failed', 'stale', 'needs_verification')
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
    [
      DEFAULT_TENANT,
      DEFAULT_TENANT,
      DEFAULT_TENANT,
      DEFAULT_TENANT,
      ...CLOSED_ACTIVE_STATES,
    ],
  );

  // Keep selected list metadata and detail evidence in one SQLite snapshot,
  // including when both consumers are behind a missed Python notification.
  const rows = db.transaction(() => {
    const selected = loadRows();
    let repaired = false;
    for (const row of selected) {
      if (ensureJobDetailProjection(db, DEFAULT_TENANT, row.job_id)) repaired = true;
    }
    return repaired ? loadRows() : selected;
  }).immediate();

  const profileSourceFields = profileSourceFieldsForApplyReview(db);
  const missingProfileData = missingApplicationAttestationFields(db);
  return {
    ok: true,
    items: rows.map((row) =>
      reviewQueueItemFromRow(db, row, profileSourceFields, missingProfileData, appDir),
    ),
  };
}

export function recordApplyReviewDecision(
  db: SqliteDatabase,
  jobLocator: string,
  request: ApplyReviewDecisionRequest,
  appDir?: string,
): ApplyReviewDecisionResponse {
  return db.transaction(() => recordApplyReviewDecisionSnapshot(db, jobLocator, request, appDir)).immediate();
}
function recordApplyReviewDecisionSnapshot(db: SqliteDatabase, jobLocator: string, request: ApplyReviewDecisionRequest, appDir?: string): ApplyReviewDecisionResponse {
  ensureApplicationFeedbackTables(db);
  const jobId = resolveExternalJobId(db, jobLocator);
  const applicationUrl = currentApplicationUrl(db, jobId);
  const materialsGeneration = currentReviewMaterialsGeneration(db, jobId);
  const profileVersion = currentProfileVersion(db);
  const partialOverrideRunId =
    request.decision === "approve_submit" ? request.partialOverrideRunId ?? null : null;
  if (request.decision === "approve_submit") {
    const cover = requireCoverLetterApproval(db, jobId, appDir);
    if ((cover?.acceptedVersion ?? null) !== (request.coverLetterAcceptedVersion ?? null)) throw new InputError("approval_stale_materials");
    if (
      request.materialsGeneration === undefined ||
      request.materialsGeneration !== materialsGeneration
    ) {
      throw new InputError("approval_stale_materials");
    }
    if (request.profileVersion === undefined || request.profileVersion !== profileVersion) {
      throw new InputError("approval_stale_profile");
    }
    if (request.applicationUrl === undefined || request.applicationUrl !== applicationUrl) {
      throw new InputError("approval_stale_url");
    }
  }
  const fullDryRunEvidence =
    request.decision === "approve_submit"
      ? latestDryRunEvidence(db, {
          jobKey: jobId,
          materialsGeneration,
          profileVersion,
          applicationUrl,
          coverage: "full",
        })
      : null;
  if (partialOverrideRunId) {
    const partialEvidence = latestDryRunEvidence(db, {
      jobKey: jobId,
      materialsGeneration,
      profileVersion,
      applicationUrl,
      coverage: "partial",
    });
    if (partialEvidence?.runId !== partialOverrideRunId) {
      throw new InputError("partial_override_evidence_invalid");
    }
  } else if (request.decision === "approve_submit" && !fullDryRunEvidence) {
    throw new InputError("awaiting_dry_run");
  }
  const emailCandidate =
    request.decision === "approve_submit" ? latestEmailApplicationCandidate(db, jobId) : null;
  if (request.decision === "approve_submit" && (emailCandidate || request.reviewedEmailCandidate || request.emailRecipient || request.emailAttachmentArtifactId)) {
    if (
      !emailCandidate ||
      request.emailRecipient?.toLowerCase() !== emailCandidate.recipient.toLowerCase() ||
      request.emailAttachmentArtifactId !== emailCandidate.attachmentArtifactId ||
      !request.reviewedEmailCandidate ||
      request.reviewedEmailCandidate.candidateRunId !== emailCandidate.candidateRunId ||
      request.reviewedEmailCandidate.recordedAt !== emailCandidate.recordedAt ||
      emailCandidateSha256(request.reviewedEmailCandidate) !== emailCandidateSha256(emailCandidate)
    ) {
      throw new InputError("approval_stale_email_candidate");
    }
  }
  const emailBinding = emailCandidate ? emailApprovalBinding(db, jobId, emailCandidate) : null;
  if (emailCandidate && !emailBinding) throw new InputError("approval_stale_materials");
  const decidedAt = new Date().toISOString();
  const decision: ApplyReviewDecision = {
    decisionId: crypto.randomUUID(),
    jobKey: jobId,
    decision: request.decision,
    reason: request.reason ?? null,
    decidedBy: request.decidedBy,
    decidedAt,
    materialsGeneration,
    profileVersion,
    applicationUrl,
    partialOverrideRunId,
    emailRecipient: emailCandidate?.recipient ?? null,
    emailAttachmentArtifactId: emailCandidate?.attachmentArtifactId ?? null,
  };

  db.prepare(
    `INSERT INTO application_review_decisions (
       tenant_id, decision_id, job_id, decision, reason, decided_by, decided_at,
       materials_generation, profile_version, application_url, partial_override_run_id,
       email_recipient, email_attachment_artifact_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEFAULT_TENANT,
    decision.decisionId,
    decision.jobKey,
    decision.decision,
    decision.reason,
    decision.decidedBy,
    decision.decidedAt,
    decision.materialsGeneration,
    decision.profileVersion,
    decision.applicationUrl,
    decision.partialOverrideRunId,
    decision.emailRecipient,
    decision.emailAttachmentArtifactId,
  );

  recordEvent(db, {
    eventType: "ApplyReviewDecisionRecorded",
    jobId,
    stage: "apply",
    message: "Apply review decision recorded.",
    payload: {
      tenantId: DEFAULT_TENANT,
      jobId,
      decisionId: decision.decisionId,
      emailApprovalBinding: emailBinding,
      coverLetterBinding: safeCoverLetterAccepted(db, jobId, appDir),
      decision: decision.decision,
      reasonPresent: Boolean(decision.reason),
      materialsGeneration: decision.materialsGeneration,
      profileVersion: decision.profileVersion,
      applicationUrl: decision.applicationUrl,
      partialOverrideRunId: decision.partialOverrideRunId,
      emailRecipientPresent: Boolean(decision.emailRecipient),
      emailAttachmentArtifactId: decision.emailAttachmentArtifactId,
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
    ...readSuggestions(db),
  };
}

export function listJobApplicationOutcomes(
  db: SqliteDatabase,
  jobLocator: string,
): JobApplicationOutcomeListResponse | null {
  ensureApplicationFeedbackTables(db);
  const jobId = resolveExternalJobIdOrNull(db, jobLocator);
  if (!jobId) {
    return null;
  }
  return {
    ok: true,
    jobKey: jobId,
    outcomes: readOutcomes(db, jobId),
    ...readSuggestions(db, jobId),
  };
}

export function recordManualApplicationOutcome(
  db: SqliteDatabase,
  jobLocator: string,
  request: ManualApplicationOutcomeRequest,
): ApplicationOutcomeWriteResponse {
  request = ManualApplicationOutcomeRequestSchema.parse(request);
  return db.transaction(() => {
    ensureApplicationFeedbackTables(db);
    const jobId = resolveExternalJobId(db, jobLocator);
    const operation = request.interviewPrepGeneration === undefined ? "manual-outcome" : "interview-reflection";
    const identity = actionIdentity(DEFAULT_TENANT, operation, jobId, request.requestId, request);
    const receipt = readActionReceipt(db, DEFAULT_TENANT, identity, "ApplicationOutcomeRecorded", "job");
    if (receipt) {
      const raw = getRow<OutcomeRow & { created_by: string }>(db,
        `SELECT outcome_id, job_id, kind, source, note, occurred_at, recorded_at,
                suggestion_id, evidence_id, interview_prep_generation, created_by
         FROM application_outcomes WHERE tenant_id=? AND outcome_id=?`,
        [DEFAULT_TENANT, receipt.factId]);
      if (!raw || raw.job_id !== jobId || raw.kind !== request.kind || raw.source !== "manual" || raw.created_by !== "user") {
        throw new ActionReceiptConflictError();
      }
      const outcome = outcomeFromRow(raw);
      if (outcome.jobKey !== jobId || outcome.source !== "manual"
        || outcome.kind !== request.kind || outcome.note !== (request.note ?? null)
        || outcome.interviewPrepGeneration !== (request.interviewPrepGeneration ?? null)
        || (request.occurredAt !== undefined && outcome.occurredAt !== request.occurredAt)) {
        throw new ActionReceiptConflictError();
      }
      assertActionReceipt(identity, receipt, { ...outcome, createdBy: raw.created_by });
      return { ok: true as const, outcome };
    }
    const interviewPrepGeneration = resolveInterviewPrepGeneration(db, jobId, request.interviewPrepGeneration);
    const outcome = insertOutcome(db, {
      jobKey: jobId,
      kind: request.kind,
      source: "manual",
      note: request.note ?? null,
      occurredAt: request.occurredAt ?? new Date().toISOString(),
      suggestionId: null,
      evidenceId: null,
      interviewPrepGeneration,
    }, identity);
    return { ok: true as const, outcome };
  }).immediate();
}

const OUTCOME_SUGGESTION_OPERATION = "outcome-suggestion-decision";

interface StoredOutcome {
  readonly outcome: ApplicationOutcome;
  readonly createdBy: string;
}

function suggestionDecisionFact(suggestion: SuggestionRow, stored: StoredOutcome | null): object {
  return {
    suggestionId: suggestion.suggestion_id,
    jobId: suggestion.job_id,
    evidenceId: suggestion.evidence_id,
    suggestedKind: suggestion.suggested_kind,
    status: suggestion.status,
    decision: suggestion.decision,
    decidedAt: suggestion.decided_at,
    decisionReason: suggestion.decision_reason,
    decidedOutcomeId: suggestion.decided_outcome_id,
    outcome: stored ? { ...stored.outcome, createdBy: stored.createdBy } : null,
  };
}

export function decideOutcomeSuggestion(
  db: SqliteDatabase,
  suggestionId: string,
  request: OutcomeSuggestionDecisionRequest,
): OutcomeSuggestionDecisionResponse | OutcomeSuggestionDecisionConflict {
  request = OutcomeSuggestionDecisionRequestSchema.parse(request);
  ensureApplicationFeedbackTables(db);
  // The read and decision are under the same writer reservation. Separate API
  // connections can never both act on the same pending suggestion.
  return db.transaction((): OutcomeSuggestionDecisionResponse | OutcomeSuggestionDecisionConflict => {
    const existing = getSuggestionRow(db, suggestionId);
    if (!existing) throw new InputError("Outcome suggestion not found.");
    const previous = suggestionFromRow(db, existing);
    const stored = existing.decided_outcome_id ? readOutcome(db, existing.decided_outcome_id) : null;
    const recordedOutcome = stored?.outcome ?? null;
    const unverifiable = (): OutcomeSuggestionDecisionConflict => ({
      ok: false, error: "outcome_suggestion_replay_unverifiable", suggestion: previous, outcome: recordedOutcome,
    });
    const identity = actionIdentity(DEFAULT_TENANT, OUTCOME_SUGGESTION_OPERATION, existing.job_id, suggestionId, request);
    let receipt: ReturnType<typeof readActionReceipt>;
    try {
      receipt = readActionReceipt(db, DEFAULT_TENANT, identity, "OutcomeSuggestionDecided", "job");
    } catch (error) {
      if (error instanceof ActionReceiptConflictError) return unverifiable();
      throw error;
    }
    const decisionEvents = db.prepare(`SELECT COUNT(*) AS count FROM job_events
      WHERE tenant_id=? AND job_id=? AND event_type='OutcomeSuggestionDecided'
        AND json_valid(payload_json) AND json_extract(payload_json, '$.suggestionId')=?`)
      .get(DEFAULT_TENANT, existing.job_id, suggestionId) as { count: number };
    if (existing.status !== "pending") {
      const savedDecision = existing.status === "accepted" ? "accept"
        : existing.status === "corrected" ? "correct"
        : existing.status === "ignored" ? "ignore" : null;
      if (!receipt || decisionEvents.count !== 1 || receipt.factId !== suggestionId || !savedDecision || existing.decision !== savedDecision ||
          receipt.event.decisionRequestVersion !== 2 || typeof receipt.event.occurredAtProvided !== "boolean" ||
          (savedDecision !== "ignore" && !recordedOutcome)) return unverifiable();
      const provided = receipt.event.occurredAtProvided;
      const recordedRequest: OutcomeSuggestionDecisionRequest = {
        decision: savedDecision,
        ...(savedDecision === "correct" && recordedOutcome ? { outcomeKind: recordedOutcome.kind } : {}),
        ...(provided && recordedOutcome ? { occurredAt: recordedOutcome.occurredAt } : {}),
        ...(recordedOutcome?.note != null ? { note: recordedOutcome.note } : {}),
        ...(existing.decision_reason !== null ? { reason: existing.decision_reason } : {}),
      };
      if (compareOutcomeSuggestionDecision(recordedRequest, previous, recordedOutcome, provided) !== "replayed") return unverifiable();
      const recordedIdentity = actionIdentity(DEFAULT_TENANT, OUTCOME_SUGGESTION_OPERATION, existing.job_id, suggestionId, recordedRequest);
      try {
        assertActionReceipt(recordedIdentity, receipt, suggestionDecisionFact(existing, stored));
      } catch (error) {
        if (error instanceof ActionReceiptConflictError) return unverifiable();
        throw error;
      }
      const comparison = compareOutcomeSuggestionDecision(request, previous, recordedOutcome, provided);
      if (comparison === "replayed") return { ok: true, disposition: "replayed", suggestion: previous, outcome: recordedOutcome };
      return {
        ok: false,
        error: comparison === "conflict" ? "outcome_suggestion_conflict" : "outcome_suggestion_replay_unverifiable",
        suggestion: previous,
        outcome: recordedOutcome,
      };
    }
    if (receipt || decisionEvents.count !== 0 || existing.decision !== null || existing.decided_at !== null ||
        existing.decision_reason !== null || existing.decided_outcome_id !== null) return unverifiable();
    if (!previous.determination) throw new InputError("outcome_determination_unavailable");
    const decidedAt = new Date().toISOString();
    let outcome: ApplicationOutcome | null = null;
    if (request.decision === "accept" || request.decision === "correct") {
      const kind = request.decision === "correct"
        ? (request.outcomeKind as ApplicationOutcomeKind)
        : outcomeKind(existing.suggested_kind);
      outcome = insertOutcome(db, {
        jobKey: canonicalJobId(existing.job_id),
        kind,
        source: "email_suggestion",
        note: request.note ?? null,
        occurredAt: request.occurredAt ?? decidedAt,
        suggestionId: existing.suggestion_id,
        evidenceId: existing.evidence_id,
        interviewPrepGeneration: null,
      });
    }
    db.prepare(
      `UPDATE application_outcome_suggestions
       SET status = ?, decision = ?, decided_at = ?, decision_reason = ?, decided_outcome_id = ?
       WHERE tenant_id = ? AND suggestion_id = ?`,
    ).run(
      suggestionStatusForDecision(request.decision), request.decision, decidedAt,
      request.reason ?? null, outcome?.outcomeId ?? null, DEFAULT_TENANT, existing.suggestion_id,
    );
    const suggestion = getSuggestionRow(db, suggestionId);
    if (!suggestion) throw new InputError("Outcome suggestion not found.");
    const event = {
      tenantId: DEFAULT_TENANT, jobId: existing.job_id, suggestionId: existing.suggestion_id,
      evidenceId: existing.evidence_id, decision: request.decision,
      outcomeId: outcome?.outcomeId ?? null, outcomeKind: outcome?.kind ?? null,
      notePresent: Boolean(request.note), reasonPresent: Boolean(request.reason),
      decisionRequestVersion: 2, occurredAtProvided: request.occurredAt !== undefined,
    };
    recordEvent(db, {
      eventType: "OutcomeSuggestionDecided",
      jobId: canonicalJobId(existing.job_id),
      stage: "apply",
      message: "Application outcome suggestion decision recorded.",
      idempotencyKey: actionReceiptKey(identity, suggestionDecisionFact(suggestion, outcome ? { outcome, createdBy: "user" } : null), event),
      payload: { ...event, receipt: { ...identity.binding, factId: suggestionId } },
    });
    return { ok: true, disposition: "applied", suggestion: suggestionFromRow(db, suggestion), outcome };
  }).immediate();
}

function insertOutcome(
  db: SqliteDatabase,
  input: {
    jobKey: JobId;
    kind: ApplicationOutcomeKind;
    source: ApplicationOutcomeSource;
    note: string | null;
    occurredAt: string;
    suggestionId: string | null;
    evidenceId: string | null;
    interviewPrepGeneration: number | null;
  },
  identity?: ReturnType<typeof actionIdentity>,
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
    interviewPrepGeneration: input.interviewPrepGeneration,
  };

  db.prepare(
    `INSERT INTO application_outcomes (
       tenant_id, outcome_id, job_id, kind, source, note, occurred_at,
       recorded_at, suggestion_id, evidence_id, interview_prep_generation, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    outcome.interviewPrepGeneration,
    "user",
  );

  const event = {
    tenantId: DEFAULT_TENANT,
    jobId: outcome.jobKey,
    outcomeId: outcome.outcomeId,
    kind: outcome.kind,
    source: outcome.source,
    occurredAt: outcome.occurredAt,
    suggestionId: outcome.suggestionId,
    evidenceId: outcome.evidenceId,
    interviewPrepGeneration: outcome.interviewPrepGeneration,
    notePresent: Boolean(outcome.note),
  };
  recordEvent(db, {
    ...(identity ? { idempotencyKey: actionReceiptKey(identity, { ...outcome, createdBy: "user" }, event) } : {}),
    eventType: "ApplicationOutcomeRecorded",
    jobId: canonicalJobId(outcome.jobKey),
    stage: "apply",
    message: "Application outcome recorded.",
    payload: { ...event, ...(identity ? { receipt: { ...identity.binding, factId: outcome.outcomeId } } : {}) },
  });

  return outcome;
}

function readOutcomes(db: SqliteDatabase, jobId?: JobId): ApplicationOutcome[] {
  const where = jobId ? "WHERE tenant_id = ? AND job_id = ?" : "WHERE tenant_id = ?";
  const params = jobId ? [DEFAULT_TENANT, jobId] : [DEFAULT_TENANT];
  return allRows<OutcomeRow>(
    db,
    `SELECT outcome_id, job_id, kind, source, note, occurred_at,
            recorded_at, suggestion_id, evidence_id, interview_prep_generation
     FROM application_outcomes
     ${where}
     ORDER BY occurred_at DESC, recorded_at DESC, outcome_id DESC`,
    params,
  ).map(outcomeFromRow);
}

function readOutcome(db: SqliteDatabase, outcomeId: string): StoredOutcome | null {
  const row = getRow<OutcomeRow & { created_by: string }>(
    db,
    `SELECT outcome_id, job_id, kind, source, note, occurred_at,
            recorded_at, suggestion_id, evidence_id, interview_prep_generation, created_by
     FROM application_outcomes
     WHERE tenant_id = ? AND outcome_id = ?`,
    [DEFAULT_TENANT, outcomeId],
  );
  // The general read model normalizes unknown raw kinds for display. A replay
  // receipt must never treat an invalid stored value as the valid "unknown" kind.
  if (!row || !APPLICATION_OUTCOME_KINDS.includes(row.kind as ApplicationOutcomeKind)) return null;
  return { outcome: outcomeFromRow(row), createdBy: row.created_by };
}

function resolveInterviewPrepGeneration(
  db: SqliteDatabase,
  jobId: JobId,
  generation: number | undefined,
): number | null {
  if (generation === undefined) {
    return null;
  }
  const row = getRow<{ generation: number }>(
    db,
    `SELECT generation
       FROM job_interview_prep
      WHERE tenant_id = ?
        AND job_id = ?
        AND generation = ?
        AND status IN ('accepted', 'superseded')
      LIMIT 1`,
    [DEFAULT_TENANT, jobId, generation],
  );
  if (!row) {
    throw new InputError("Interview prep generation not found.");
  }
  return generation;
}

function readSuggestions(db: SqliteDatabase, jobId?: JobId): Pick<ApplicationOutcomeListResponse,"suggestions"|"interpretationStatus"> {
  const where = jobId ? "WHERE tenant_id = ? AND job_id = ?" : "WHERE tenant_id = ?";
  const params = jobId ? [DEFAULT_TENANT, jobId] : [DEFAULT_TENANT];
  const rows = allRows<SuggestionRow>(
    db,
    `SELECT suggestion_id, job_id, evidence_id, suggested_kind, confidence,
            rationale, status, decision, created_at, decided_at, decision_reason,
            decided_outcome_id
     FROM application_outcome_suggestions
     ${where}
     ORDER BY created_at DESC, suggestion_id DESC`,
    params,
  );
  const suggestions:OutcomeSuggestion[]=[];
  let failureCode:string|null=null;
  for(const row of rows){
    try {
      const suggestion=suggestionFromRow(db,row);
      if(suggestion.determination) suggestions.push(suggestion);
      else failureCode="outcome_determination_unavailable";
    }catch(error){
      if(error instanceof InputError || error instanceof Error && error.message.startsWith("determination_")) failureCode="outcome_determination_binding_invalid";
      else throw error;
    }
  }
  const blocked = db.prepare(`SELECT s.failure_code FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY tenant_id,entity_id,kind ORDER BY updated_at DESC,input_fingerprint DESC) AS revision FROM semantic_stage_states) s WHERE s.revision=1 AND s.kind IN ('message_link','message_outcome') AND s.state='blocked' AND s.tenant_id=? ${jobId?"AND EXISTS (SELECT 1 FROM application_email_evidence e WHERE e.tenant_id=s.tenant_id AND e.provider_message_id=s.entity_id AND e.job_id=?)":""} ORDER BY s.updated_at DESC LIMIT 1`).get(...(jobId?[DEFAULT_TENANT,jobId]:[DEFAULT_TENANT])) as {failure_code:string}|undefined;
  failureCode ??= blocked?.failure_code??null;
  return {suggestions,interpretationStatus:{status:failureCode?"unavailable":suggestions.length?"available":"not_requested",failureCode}};
}

function getSuggestionRow(db: SqliteDatabase, suggestionId: string): SuggestionRow | undefined {
  return getRow<SuggestionRow>(
    db,
    `SELECT suggestion_id, job_id, evidence_id, suggested_kind, confidence,
            rationale, status, decision, created_at, decided_at, decision_reason,
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
  missingProfileData: readonly string[],
  appDir?: string,
): ApplyReviewQueueItem {
  const jobId = canonicalJobId(row.job_id);
  const currentState = stageState(row.current_state);
  const currentSubstage = stage(row.current_substage ?? row.current_stage);
  const blockers = queueBlockers(row, currentState);
  const scoreBreakdown = parseQueueScoreBreakdown(row.score_breakdown_json);
  const scoreKeywords = boundedEvidenceList(parseStringListJson(row.score_keywords_json));
  const applicationUrl = applyTargetUrl(row);
  const materialsPreview = materialPreviewsForJob(db, jobId, profileSourceFields, appDir);
  const emailApplication = latestEmailApplicationCandidate(db, jobId);
  const materialsGeneration = materialsPreview.materialsGeneration;
  const profileVersion = currentProfileVersion(db);
  const dryRunEvidence = latestDryRunEvidence(db, {
    jobKey: jobId,
    materialsGeneration,
    profileVersion,
    applicationUrl,
    coverage: "full",
  });
  const partialDryRunEvidence = latestDryRunEvidence(db, {
    jobKey: jobId,
    materialsGeneration,
    profileVersion,
    applicationUrl,
    coverage: "partial",
  });
  const approvalReasons = approvalGateReasons(row, {
    materialsGeneration,
    profileVersion,
    applicationUrl,
    dryRunEvidence,
    partialDryRunEvidence,
  });
  if (row.decision === "approve_submit") {
    const event = getRow<{ payload_json: string }>(db, `SELECT payload_json FROM job_events
      WHERE tenant_id=? AND job_id=? AND event_type='ApplyReviewDecisionRecorded'
        AND json_extract(payload_json, '$.decisionId')=? ORDER BY event_id DESC LIMIT 1`, [DEFAULT_TENANT, jobId, row.decision_id]);
    const payload = event ? parseJsonRecord(event.payload_json) : null;
    const emailBinding = payload?.["emailApprovalBinding"] as {
      version?: number; candidateSha256?: string; postingUrlSha256?: string;
      postingInputsSha256?: string; materialsSha256?: string;
    } | null;
    if ((emailApplication || row.email_recipient || row.email_attachment_artifact_id) && !approvalReasons.length) {
      if (!emailApplication || emailBinding?.version !== 1) {
        approvalReasons.push("approval_stale_email_candidate");
      } else {
        // A changed candidate can refer to a different attachment; compare the
        // existing source fingerprints before reporting the candidate mismatch.
        const current = emailApprovalBinding(db, jobId, emailApplication, { allowUnmatchedAttachment: true });
        if (!current) approvalReasons.push("approval_stale_materials");
        else if (emailBinding.postingUrlSha256 !== current.postingUrlSha256) approvalReasons.push("approval_stale_url");
        else if (emailBinding.materialsSha256 !== current.materialsSha256) approvalReasons.push("approval_stale_materials");
        else if (emailBinding.candidateSha256 !== current.candidateSha256 ||
          emailBinding.postingInputsSha256 !== current.postingInputsSha256 ||
          row.email_recipient?.toLowerCase() !== emailApplication.recipient.toLowerCase() ||
          row.email_attachment_artifact_id !== emailApplication.attachmentArtifactId) {
          approvalReasons.push("approval_stale_email_candidate");
        }
      }
    }
    const bound = payload?.["coverLetterBinding"] ?? null;
    const boundVersion = (bound as { acceptedVersion?: string } | null)?.acceptedVersion ?? null;
    if (boundVersion !== (materialsPreview.coverLetter?.acceptedVersion ?? null)
      || materialsPreview.coverLetterPdfError || (materialsPreview.coverLetter && !materialsPreview.coverLetter.pdfSourceCurrent)) {
      approvalReasons.splice(0, approvalReasons.length, "approval_stale_materials");
    }
  }
  const idealCandidate = cleanLimitedText(
    row.employer_ideal_candidate_narrative,
    IDEAL_CANDIDATE_TEXT_LIMIT,
  );
  const sourceRequirements = requirementIdentities(row.employer_requirements_json);
  const projectedFitReport = parseRequirementFitReport(row.requirement_fit_report_json);
  const requirementFitReport = bindRequirementFitReport(
    projectedFitReport?.scoreVersion === nullableNumber(row.score_version) ? projectedFitReport : null,
    row.employer_analysis_generation, sourceRequirements,
  );
  const rawIdealRequirements = parseIdealRequirementsJson(row.employer_requirements_json);
  const idealRequirements = requirementsWithTailoredResumeCoverage(
    db,
    jobId,
    rawIdealRequirements,
    materialsPreview.resumeTextArtifactId,
    requirementFitReport,
    sourceRequirements,
  );
  const scoreEvidenceRequirements = boundedEvidenceList([
    ...(scoreBreakdown?.matchedSignals ?? []),
    ...(scoreBreakdown?.missingSignals ?? []),
    ...(scoreBreakdown?.transferableSignals ?? []),
  ]);
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
    ...readApplyAuditControls(db, DEFAULT_TENANT, jobId),
    applicationUrl,
    hasResume: Boolean(row.has_resume),
    hasCoverLetter: Boolean(row.has_cover_letter),
    hasPdf: Boolean(row.has_pdf),
    currentStage: currentSubstage,
    currentState,
    currentErrorCode: row.current_error_code,
    currentErrorMessage: row.current_error_message,
    latestApplyRun,
    scoreBreakdown,
    missingProfileData,
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
    jobKey: jobId,
    title: row.title || "Untitled",
    company: row.employer || "Unknown company",
    source: row.source || "unknown",
    compensationSummary: parseQueueCompensationSummary(row.compensation_summary_json),
    fitScore: nullableNumber(row.fit_score),
    scoreBreakdown,
    scoreKeywords,
    scoreReasoning: cleanLimitedText(row.score_reasoning, IDEAL_CANDIDATE_TEXT_LIMIT),
    scoreVersion: nullableNumber(row.score_version),
    scoredAt: row.scored_at,
    scoreCriteria: parseQueueScoreCriteria(row.score_criteria_json),
    scoreTrace: parseQueueScoreTrace(row.score_trace_json),
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
    repeatApplication: evaluateRepeatApplication(db, jobId),
    position: {
      descriptionPreview: previewText(
        row.full_description || row.description,
        POSITION_PREVIEW_CHAR_LIMIT,
      ),
      idealCandidate: idealCandidate || null,
      idealRequirements,
      requirements: idealRequirements.length
        ? idealRequirements.map((requirement) => requirement.text)
        : scoreEvidenceRequirements,
      matched: boundedEvidenceList(scoreBreakdown?.matchedSignals ?? []),
      missing: boundedEvidenceList(scoreBreakdown?.missingSignals ?? []),
      transferable: boundedEvidenceList(scoreBreakdown?.transferableSignals ?? []),
      keywords: scoreKeywords,
    },
    materialsPreview,
    latestApplyRun,
    emailApplication,
    review: {
      state: reviewState(row.decision),
      decision: reviewDecision(row.decision),
      decidedAt: row.decided_at,
      materialsGeneration: nullableNumber(row.decision_materials_generation),
      profileVersion: nullableNumber(row.decision_profile_version),
      applicationUrl: row.decision_application_url,
      partialOverrideRunId: row.partial_override_run_id,
      emailRecipient: row.email_recipient,
      emailAttachmentArtifactId: row.email_attachment_artifact_id,
    },
    approvalGate: {
      materialsGeneration,
      profileVersion,
      applicationUrl,
      dryRunEvidence,
      partialDryRunEvidence,
      reasons: approvalReasons,
    },
    blockers,
  };
}

function approvalGateReasons(
  row: ReviewQueueRow,
  current: {
    readonly materialsGeneration: number | null;
    readonly profileVersion: number | null;
    readonly applicationUrl: string | null;
    readonly dryRunEvidence: ApplyReviewDryRunEvidence | null;
    readonly partialDryRunEvidence: ApplyReviewDryRunEvidence | null;
  },
): ApplyReviewApprovalGateReason[] {
  if (row.decision !== "approve_submit") {
    return ["awaiting_approval"];
  }
  if (
    row.decision_materials_generation === null ||
    current.materialsGeneration === null ||
    Number(row.decision_materials_generation) !== current.materialsGeneration
  ) {
    return ["approval_stale_materials"];
  }
  if (
    row.decision_profile_version === null ||
    current.profileVersion === null ||
    Number(row.decision_profile_version) !== current.profileVersion
  ) {
    return ["approval_stale_profile"];
  }
  if (!row.decision_application_url || row.decision_application_url !== current.applicationUrl) {
    return ["approval_stale_url"];
  }
  if (current.dryRunEvidence) {
    return [];
  }
  if (row.partial_override_run_id) {
    return current.partialDryRunEvidence?.runId === row.partial_override_run_id
      ? []
      : ["override_evidence_invalid"];
  }
  return ["awaiting_dry_run"];
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
  const postingUrl = cleanBlockerText(row.posting_url);
  return postingUrl || null;
}

function currentApplicationUrl(db: SqliteDatabase, jobId: JobId): string | null {
  const row = getRow<{ application_url: string | null; url: string }>(
    db,
    `SELECT e.application_url, j.url
       FROM jobs j LEFT JOIN job_enrichments e
         ON e.tenant_id = j.tenant_id AND e.job_id = j.job_id
      WHERE j.tenant_id = ? AND j.job_id = ?`,
    [DEFAULT_TENANT, jobId],
  );
  return cleanBlockerText(row?.application_url ?? null) || cleanBlockerText(row?.url ?? null) || null;
}

function latestMaterialsGeneration(db: SqliteDatabase, jobId: JobId): number | null {
  const row = getRow<{ generation: number | null }>(
    db,
    "SELECT MAX(generation) AS generation FROM job_materials WHERE tenant_id = ? AND job_id = ?",
    [DEFAULT_TENANT, jobId],
  );
  return nullableNumber(row?.generation);
}

function currentReviewMaterialsGeneration(db: SqliteDatabase, jobId: JobId): number | null {
  return resumeMaterialPreviewForJob(db, jobId).materialsGeneration ?? latestMaterialsGeneration(db, jobId);
}

function currentProfileVersion(db: SqliteDatabase): number | null {
  const row = getRow<{ version: number | null }>(
    db,
    "SELECT version FROM candidate_profiles WHERE tenant_id = ? AND profile_id = ?",
    [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
  );
  return nullableNumber(row?.version);
}

function latestDryRunEvidence(
  db: SqliteDatabase,
  expected: {
    readonly jobKey: JobId;
    readonly materialsGeneration: number | null;
    readonly profileVersion: number | null;
    readonly applicationUrl: string | null;
    readonly coverage: "full" | "partial";
  },
): ApplyReviewDryRunEvidence | null {
  if (
    expected.materialsGeneration === null ||
    expected.profileVersion === null ||
    !expected.applicationUrl
  ) {
    return null;
  }
  const rows = allRows<{ payload_json: string | null; occurred_at: string | null }>(
    db,
    `SELECT payload_json, occurred_at
     FROM job_events
     WHERE tenant_id = ? AND job_id = ? AND stage = 'apply' AND event_type = 'DryRunCompleted'
     ORDER BY event_id DESC
     LIMIT 24`,
    [DEFAULT_TENANT, expected.jobKey],
  );
  for (const row of rows) {
    const payload = parseJsonRecord(row.payload_json);
    const runId = stringValue(recordValue(payload, "runId", "run_id"));
    if (!runId) continue;
    const coverage = stringValue(recordValue(payload, "coverage", "dry_run_coverage"));
    if (coverage !== expected.coverage) continue;
    if (
      !dryRunCompletionMatches(
        db,
        {
          jobKey: expected.jobKey,
          materialsGeneration: expected.materialsGeneration,
          profileVersion: expected.profileVersion,
          applicationUrl: expected.applicationUrl,
        },
        runId,
        payload,
      )
    ) {
      continue;
    }
    return {
      runId,
      coverage,
      finishedAt: stringValue(recordValue(payload, "finishedAt", "finished_at")) || row.occurred_at,
      blockedChannels: parseStringList(recordValue(payload, "blockedChannels", "blocked_channels")),
    };
  }
  return null;
}

function latestEmailApplicationCandidate(
  db: SqliteDatabase,
  jobId: JobId,
): ApplyReviewQueueItem["emailApplication"] {
  const row = getRow<{ payload_json: string | null; occurred_at: string | null }>(
    db,
    `SELECT payload_json, occurred_at
     FROM job_events
     WHERE tenant_id = ? AND job_id = ? AND stage = 'apply' AND event_type = 'EmailApplicationCandidateRecorded'
     ORDER BY occurred_at DESC, event_id DESC
     LIMIT 1`,
    [DEFAULT_TENANT, jobId],
  );
  const payload = parseJsonRecord(row?.payload_json ?? null);
  if (!payload) return null;
  const recipient = stringValue(recordValue(payload, "recipient", "recipient"));
  const subject = stringValue(recordValue(payload, "subject", "subject"));
  const body = stringValue(recordValue(payload, "body", "body"));
  const attachmentArtifactId = stringValue(recordValue(payload, "attachmentArtifactId", "attachment_artifact_id"));
  const attachmentName = stringValue(recordValue(payload, "attachmentName", "attachment_name"));
  const candidateRunId = stringValue(recordValue(payload, "runId", "run_id"));
  if (!recipient || !subject || !body || !attachmentArtifactId || !attachmentName || !candidateRunId) {
    return null;
  }
  return {
    recipient,
    subject,
    body,
    attachmentArtifactId,
    attachmentName,
    candidateRunId,
    recordedAt: row?.occurred_at ?? null,
  };
}

function dryRunCompletionMatches(
  db: SqliteDatabase,
  expected: {
    readonly jobKey: JobId;
    readonly materialsGeneration: number;
    readonly profileVersion: number;
    readonly applicationUrl: string;
  },
  runId: string,
  completionPayload: Record<string, unknown> | null,
): boolean {
  const completionGeneration = nullableNumber(
    recordValue(completionPayload, "materialsGeneration", "materials_generation"),
  );
  const completionProfileVersion = nullableNumber(
    recordValue(completionPayload, "profileVersion", "profile_version"),
  );
  const completionUrl = stringValue(recordValue(completionPayload, "applicationUrl", "application_url"));
  const started = getRow<{ payload_json: string | null }>(
    db,
    `SELECT payload_json
     FROM job_events
     WHERE tenant_id = ?
       AND job_id = ?
       AND stage = 'apply'
       AND event_type = 'ApplyRunStarted'
       AND payload_json LIKE ?
     ORDER BY event_id DESC
     LIMIT 1`,
    [DEFAULT_TENANT, expected.jobKey, `%${runId}%`],
  );
  const startedPayload = parseJsonRecord(started?.payload_json ?? null);
  const matchedGeneration =
    completionGeneration ?? nullableNumber(recordValue(startedPayload, "materialsGeneration", "materials_generation"));
  const matchedProfileVersion =
    completionProfileVersion ?? nullableNumber(recordValue(startedPayload, "profileVersion", "profile_version"));
  const matchedUrl =
    completionUrl || stringValue(recordValue(startedPayload, "applicationUrl", "application_url"));
  return (
    matchedGeneration === expected.materialsGeneration &&
    matchedProfileVersion === expected.profileVersion &&
    matchedUrl === expected.applicationUrl &&
    hasRunBoundInitialNavigation(completionPayload, expected.applicationUrl)
  );
}

function hasRunBoundInitialNavigation(
  completionPayload: Record<string, unknown> | null,
  applicationUrl: string,
): boolean {
  const allowed = recordValue(completionPayload, "allowedNavigations", "allowed_navigations");
  if (!Array.isArray(allowed) || allowed.length !== 1) {
    return false;
  }
  const navigation = asRecord(allowed[0]);
  if (!navigation) {
    return false;
  }
  const expectedFingerprint = canonicalApplicationUrlFingerprint(applicationUrl);
  return (
    expectedFingerprint !== null &&
    stringValue(navigation.decision) === "run_bound_initial_url" &&
    stringValue(recordValue(navigation, "grantId", "grant_id")) === "initial_application_url" &&
    stringValue(navigation.method).toUpperCase() === "GET" &&
    stringValue(recordValue(navigation, "urlFingerprint", "url_fingerprint")) === expectedFingerprint
  );
}

function canonicalApplicationUrlFingerprint(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw !== value || /[\\\s]/u.test(raw)) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    parsed.hash = "";
    const canonical = `${parsed.protocol}//${parsed.host}${parsed.pathname || "/"}${parsed.search}`;
    return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  } catch {
    return null;
  }
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
  return `${stage(row.current_substage ?? row.current_stage)}_${currentState}`;
}

function cleanBlockerText(value: string | null): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isGenericStageCode(value: string): boolean {
  return ["BLOCKED", "FAILED", "STALE", "ERROR"].includes(value.trim().toUpperCase());
}

function parseQueueScoreBreakdown(value: string | null): ScoreBreakdown | null {
  const parsed = parseJsonRecord(value);
  if (!parsed || parsed.legacy === true) {
    return null;
  }
  const eligibility = asRecord(parsed.eligibility);
  return {
    technicalFit: scoreDimension(recordValue(parsed, "technicalFit", "technical_fit")),
    experienceFit: scoreDimension(recordValue(parsed, "experienceFit", "experience_fit")),
    roleFit: scoreDimension(recordValue(parsed, "roleFit", "role_fit")),
    reasoning: stringValue(parsed.reasoning),
    fitBand: parseChoice(recordValue(parsed, "fitBand", "fit_band"), "plausible", [
      "excellent",
      "strong",
      "plausible",
      "stretch",
      "poor",
    ]),
    confidence: parseChoice(parsed.confidence, "medium", ["high", "medium", "low"]),
    eligibility: {
      status: parseChoice(eligibility?.status, "unknown", ["eligible", "warning", "blocked", "unknown"]),
      hardBlockers: parseStringList(recordValue(eligibility, "hardBlockers", "hard_blockers")),
      warnings: parseStringList(eligibility?.warnings),
    },
    matchedSignals: parseStringList(recordValue(parsed, "matchedSignals", "matched_signals")),
    missingSignals: parseStringList(recordValue(parsed, "missingSignals", "missing_signals")),
    transferableSignals: parseStringList(recordValue(parsed, "transferableSignals", "transferable_signals")),
  };
}

function parseQueueScoreCriteria(value: string | null): ScoringCriteriaSnapshot | null {
  const parsed = parseJsonRecord(value);
  if (!parsed) {
    return null;
  }
  return {
    minFitScore: scoreDimension(recordValue(parsed, "minFitScore", "min_fit_score")),
    criteriaText: cleanLimitedText(recordValue(parsed, "criteriaText", "criteria_text"), IDEAL_CANDIDATE_TEXT_LIMIT),
    targetCriteria: cleanLimitedText(recordValue(parsed, "targetCriteria", "target_criteria"), IDEAL_CANDIDATE_TEXT_LIMIT),
    criteriaVersion: stringValue(recordValue(parsed, "criteriaVersion", "criteria_version")),
  };
}

function parseQueueScoreTrace(value: string | null): ScoreTrace | null {
  const parsed = parseJsonRecord(value);
  if (!parsed) {
    return null;
  }
  return {
    promptVersion: stringValue(recordValue(parsed, "promptVersion", "prompt_version")),
    schemaVersion: stringValue(recordValue(parsed, "schemaVersion", "schema_version")),
    model: stringValue(parsed.model),
    criteriaVersion: stringValue(recordValue(parsed, "criteriaVersion", "criteria_version")),
    profileSnapshotVersion: numberValue(recordValue(parsed, "profileSnapshotVersion", "profile_snapshot_version")),
    scoringPolicyId: stringValue(recordValue(parsed, "scoringPolicyId", "scoring_policy_id")),
    scoringPolicyVersion: numberValue(recordValue(parsed, "scoringPolicyVersion", "scoring_policy_version")),
    rubricVersion: stringValue(recordValue(parsed, "rubricVersion", "rubric_version")),
    rawWeightedScore: nullableNumber(recordValue(parsed, "rawWeightedScore", "raw_weighted_score")),
    calibrationAdjustment: numberValue(recordValue(parsed, "calibrationAdjustment", "calibration_adjustment")),
    policyAnchorCount: parseStringList(recordValue(parsed, "anchorIds", "anchor_ids")).length,
    resolvedFitBand: stringValue(recordValue(parsed, "resolvedFitBand", "resolved_fit_band")),
    resolutionReason: stringValue(recordValue(parsed, "resolutionReason", "resolution_reason")),
    parserWarnings: parseStringList(recordValue(parsed, "parserWarnings", "parser_warnings")),
    correctionHistory: [],
  };
}

function parseRequirementFitReport(value: string | null): RequirementFitReport | null {
  const parsed = parseJsonRecord(value);
  if (!parsed || !Array.isArray(parsed.assessments)) {
    return null;
  }
  return parsed as unknown as RequirementFitReport;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}


function parseQueueCompensationSummary(value: string | null): JobCompensationSummary | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as JobCompensationSummary;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(
  record: Record<string, unknown> | null | undefined,
  camelKey: string,
  snakeKey: string,
): unknown {
  if (!record) {
    return undefined;
  }
  return record[camelKey] ?? record[snakeKey];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseChoice<const T extends readonly string[]>(
  value: unknown,
  fallback: T[number],
  choices: T,
): T[number] {
  return typeof value === "string" && choices.includes(value) ? value : fallback;
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

function parseIdealRequirementsJson(value: string | null): ApplyReviewIdealRequirement[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item, index) => idealRequirementFromValue(item, index))
      .filter((requirement): requirement is ApplyReviewIdealRequirement => requirement !== null)
      .slice(0, EVIDENCE_LIST_LIMIT);
  } catch {
    return [];
  }
}

function idealRequirementFromValue(value: unknown, index: number): ApplyReviewIdealRequirement | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as Record<string, unknown>;
  const text = cleanLimitedText(data.text, IDEAL_REQUIREMENT_TEXT_LIMIT);
  if (!text) {
    return null;
  }
  const id = cleanLimitedText(data.id, 80) || `requirement-${index + 1}`;
  return {
    id,
    text,
    tier: cleanLimitedText(data.tier, 80) || null,
    weight: cleanRequirementWeight(data.weight),
    evidence:
      cleanLimitedText(data.evidence_span, IDEAL_REQUIREMENT_EVIDENCE_TEXT_LIMIT) ||
      cleanLimitedText(data.evidenceSpan, IDEAL_REQUIREMENT_EVIDENCE_TEXT_LIMIT) ||
      null,
    fit: null,
    contribution: null,
    tailoring: null,
    coverage: emptyRequirementCoverage(),
  };
}

function emptyRequirementCoverage(): ApplyReviewIdealRequirement["coverage"] {
  return unrecordedRequirementCoverage();
}

function requirementsWithTailoredResumeCoverage(
  db: SqliteDatabase,
  jobId: JobId,
  requirements: readonly ApplyReviewIdealRequirement[],
  resumeTextArtifactId: string | null,
  requirementFitReport: RequirementFitReport | null,
  sourceRequirements: readonly { id: string; text: string }[],
): ApplyReviewIdealRequirement[] {
  const fitByRequirement = requirementFitByRequirementId(requirementFitReport);
  const coverage = requirementCoverageForArtifact(db, jobId, resumeTextArtifactId, sourceRequirements, requirementFitReport);
  return requirements.map((requirement) => requirementWithFitAssessment(
    requirement, fitByRequirement.get(requirement.id), coverage.get(requirement.id) ?? emptyRequirementCoverage(),
  ));
}

/** Job Detail uses the same selected resume and source bindings as Apply Review. */
export function requirementFitForCurrentAnalysis(
  db: SqliteDatabase,
  jobId: string,
  analysis: EmployerAnalysis | null,
  report: RequirementFitReport | null,
): RequirementFitReport | null {
  const current = bindRequirementFitReport(report, analysis?.generation, analysis?.requirements ?? []);
  if (!current || !analysis) return null;
  const selected = resumeMaterialPreviewForJob(db, canonicalJobId(jobId));
  const coverage = requirementCoverageForArtifact(db, jobId, selected.resumeTextArtifactId, analysis.requirements, current);
  return { ...current, assessments: current.assessments.map((assessment) => ({
    ...assessment, artifactCoverage: coverage.get(assessment.requirementId) ?? emptyRequirementCoverage(),
  })) };
}

function requirementFitByRequirementId(
  report: RequirementFitReport | null,
): Map<string, RequirementFitAssessment> {
  const result = new Map<string, RequirementFitAssessment>();
  if (!report) {
    return result;
  }
  for (const assessment of report.assessments) {
    if (assessment.requirementId) {
      result.set(assessment.requirementId, assessment);
    }
  }
  return result;
}

function requirementWithFitAssessment(
  requirement: ApplyReviewIdealRequirement,
  assessment: RequirementFitAssessment | undefined,
  coverage: ApplyReviewIdealRequirement["coverage"],
): ApplyReviewIdealRequirement {
  return {
    ...requirement,
    fit: assessment?.fit ?? null,
    contribution: assessment?.contribution ?? null,
    tailoring: assessment?.tailoring ?? null,
    coverage,
  };
}

function cleanRequirementWeight(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(0, numeric);
}

function cleanLimitedText(value: unknown, limit: number): string {
  const text = cleanText(value);
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit).trim()}...` : text;
}

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function boundedEvidenceList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = cleanLimitedText(value, EVIDENCE_TEXT_LIMIT);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
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
  jobId: JobId,
  profileSourceFields: readonly ApplyReviewProfileSourceField[],
  appDir?: string,
): ApplyReviewQueueItem["materialsPreview"] {
  const resumePreview = resumeMaterialPreviewForJob(db, jobId);
  let coverLetter: ReturnType<typeof coverLetterAccepted> = null;
  let coverLetterText: string | null = null;
  let coverLetterPdfError: string | null = null;
  try {
    coverLetter = coverLetterAccepted(db, jobId, appDir);
    coverLetterText = coverLetter ? coverLetterTextForSource(db, appDir ?? path.dirname(path.resolve(db.name)), coverLetter.source)
      : coverLetterMaterialPreviewForJob(db, jobId, appDir);
  }
  catch { coverLetterPdfError = "The accepted cover-letter source cannot be read or exceeds the supported size. Restore or regenerate the letter before previewing or approving."; }
  return {
    ...resumePreview,
    profileSourceFields: [...profileSourceFields],
    coverLetterText,
    coverLetter,
    coverLetterPdfError,
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
  const row = getRow<Record<string, unknown>>(
    db,
    `SELECT ${PROFILE_ROOT_SOURCE_FIELDS.map((field) => field.column).join(", ")}
       FROM candidate_profiles
      WHERE tenant_id = ? AND profile_id = ?`,
    [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
  );
  if (!row) return;
  for (const field of PROFILE_ROOT_SOURCE_FIELDS) {
    addProfileSourceField(fields, field, row[field.column]);
  }
}

function appendProfileExperienceSourceFields(db: SqliteDatabase, fields: ApplyReviewProfileSourceField[]): void {
  const entries = allRows<{
    entry_id: string;
    position_index: number;
    date_range: string;
    title: string;
    company: string;
    location: string;
    summary: string;
  }>(
    db,
    `SELECT entry_id, position_index, date_range, title, company, location, summary
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
    addProfileSourceField(fields, profileField(`Profile > Experience entries > ${heading} > Position summary`, `resume.experience_entries.${index}.summary`, "profile_experience"), entry.summary);
  }
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
  | "materialsGeneration"
  | "resumeText"
  | "resumeTextArtifactId"
  | "resumePdfArtifactId"
  | "resumePdfLayoutBoxes"
  | "requirementLedAudit"
  | "resumeTemplate"
>;

const COVER_LETTER_TEXT_ARTIFACT_TYPES = ["cover_letter", "cover_letter_txt"] as const;

function coverLetterMaterialPreviewForJob(db: SqliteDatabase, jobId: JobId, appDir = path.dirname(path.resolve(db.name))): string | null {
  for (const candidate of materialArtifactCandidates(db, {
      artifactTypes: COVER_LETTER_TEXT_ARTIFACT_TYPES,
      binary: false,
      includeLegacyJobColumn: "cover_letter_path",
      jobId,
    })) {
    try { return coverLetterSourceBytes(appDir, candidate.path).toString("utf8"); }
    catch { /* An unreadable or unowned candidate is never displayed. */ }
  }
  return null;
}

function resumeMaterialPreviewForJob(db: SqliteDatabase, jobId: JobId): ResumeMaterialPreview {
  const { text, pdf } = selectResumeMaterial(db, jobId);
  if (text || pdf) {
    const candidates = [text?.candidate, pdf].filter((candidate): candidate is MaterialArtifactCandidate => Boolean(candidate));
    return {
      materialsGeneration: text?.candidate.generation ?? pdf?.generation ?? null,
      resumeText: text?.preview ?? null,
      resumeTextArtifactId: text?.candidate.artifactId ?? null,
      resumePdfArtifactId: pdf?.artifactId ?? null,
      resumePdfLayoutBoxes: pdf?.artifactId ? resumeLayoutBoxesForArtifact(db, pdf.artifactId) : [],
      requirementLedAudit: requirementLedAuditForCandidates(db, jobId, ...candidates),
      resumeTemplate: resumeTemplateStateForJob(db, jobId),
    };
  }
  const failedAudit = failedRequirementLedAuditForJob(db, jobId);
  return {
    materialsGeneration: failedAudit?.generation ?? null,
    resumeText: null, resumeTextArtifactId: null, resumePdfArtifactId: null,
    resumePdfLayoutBoxes: [], requirementLedAudit: failedAudit?.audit ?? null,
    resumeTemplate: resumeTemplateStateForJob(db, jobId),
  };
}

function failedRequirementLedAuditForJob(
  db: SqliteDatabase,
  jobId: JobId,
): { generation: number | null; audit: ApplyReviewRequirementLedAudit } | null {
  const artifactTypes = [...RESUME_TEXT_ARTIFACT_TYPES, ...RESUME_PDF_ARTIFACT_TYPES];
  const placeholders = artifactTypes.map(() => "?").join(", ");
  const rows = allRows<{
    artifact_id: string | null;
    created_at: string | null;
    generation: number | null;
    metadata_json: string | null;
    path: string | null;
  }>(
    db,
    `SELECT artifact_id, path, generation, created_at, metadata_json
       FROM job_materials_artifacts
      WHERE tenant_id = ?
        AND job_id = ?
        AND artifact_type IN (${placeholders})
        AND status = 'rejected'
        AND metadata_json IS NOT NULL
        AND metadata_json != ''
      ORDER BY COALESCE(generation, -1) DESC, COALESCE(created_at, '') DESC, rowid DESC
      LIMIT 8`,
    [DEFAULT_TENANT, jobId, ...artifactTypes],
  );
  for (const [index, row] of rows.entries()) {
    const audit = parseRequirementLedAuditMetadata(row.metadata_json);
    if (!audit) continue;
    const candidate: MaterialArtifactCandidate = {
      artifactId: row.artifact_id ? String(row.artifact_id) : null,
      createdAt: String(row.created_at ?? ""),
      generation: nullableNumber(row.generation),
      metadataJson: row.metadata_json,
      path: String(row.path ?? ""),
      reviewRequired: false,
      rowRank: index,
      sourceRank: 1,
    };
    return {
      generation: candidate.generation,
      audit: reconcileRequirementLedAuditWithProvenance(db, jobId, candidate, audit),
    };
  }
  return null;
}

function requirementLedAuditForCandidates(
  db: SqliteDatabase,
  jobId: JobId,
  ...candidates: readonly MaterialArtifactCandidate[]
): ApplyReviewRequirementLedAudit | null {
  for (const candidate of candidates) {
    const audit = parseRequirementLedAuditMetadata(candidate.metadataJson);
    if (audit) {
      return reconcileRequirementLedAuditWithProvenance(db, jobId, candidate, audit);
    }
  }
  return null;
}

function reconcileRequirementLedAuditWithProvenance(
  db: SqliteDatabase,
  jobId: JobId,
  candidate: MaterialArtifactCandidate,
  audit: ApplyReviewRequirementLedAudit,
): ApplyReviewRequirementLedAudit {
  const requirementById = requirementSummariesFromAudit(audit);
  if (!requirementById.size) {
    return audit;
  }

  const rows = provenanceRowsForCandidate(db, jobId, candidate);

  const coveredIds = new Set<string>();
  for (const row of rows) {
    for (const id of parseStringListJson(row.requirement_ids_json)) {
      if (requirementById.has(id)) {
        coveredIds.add(id);
      }
    }
  }

  const priorUncoveredReason = new Map(audit.uncoveredRequirements.map((requirement) => [requirement.id, requirement.reason]));
  const coveredRequirements: ApplyReviewRequirementLedAudit["coveredRequirements"] = [];
  const uncoveredRequirements: ApplyReviewRequirementLedAudit["uncoveredRequirements"] = [];
  for (const id of requirementById.keys()) {
    if (coveredIds.has(id)) {
      coveredRequirements.push(requirementAuditRequirement(id, requirementById, null));
    } else {
      uncoveredRequirements.push(
        requirementAuditRequirement(
          id,
          requirementById,
          priorUncoveredReason.get(id) ?? "No provenance-linked bullet in the selected tailored resume.",
        ),
      );
    }
  }

  return {
    ...audit,
    coveredRequirements,
    uncoveredRequirements,
  };
}

function requirementSummariesFromAudit(
  audit: ApplyReviewRequirementLedAudit,
): Map<string, { textExcerpt: string; tier: string | null }> {
  const result = new Map<string, { textExcerpt: string; tier: string | null }>();
  for (const requirement of [...audit.coveredRequirements, ...audit.uncoveredRequirements]) {
    if (requirement.id && !result.has(requirement.id)) {
      result.set(requirement.id, {
        textExcerpt: requirement.textExcerpt,
        tier: requirement.tier,
      });
    }
  }
  return result;
}

function provenanceRowsForCandidate(
  db: SqliteDatabase,
  jobId: JobId,
  candidate: MaterialArtifactCandidate,
): Array<{ requirement_ids_json: string }> {
  if(!candidate.artifactId || candidate.generation===null)return [];
  const artifact=db.prepare("SELECT artifact_type FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND artifact_id=? AND generation=?").get(DEFAULT_TENANT,jobId,candidate.artifactId,candidate.generation) as {artifact_type:string}|undefined;
  if(!artifact)return [];
  const anchors=readArtifactLineAnchors(db,DEFAULT_TENANT,artifact.artifact_type,candidate.artifactId,candidate.generation,jobId);
  return Array.from(anchors.values()).map(anchor=>({requirement_ids_json:JSON.stringify(anchor.requirementIds)}));
}

function parseRequirementLedAuditMetadata(value: string | null): ApplyReviewRequirementLedAudit | null {
  const metadata = parseJsonRecord(value);
  const qualityPlan = asRecord(recordValue(metadata, "qualityPlan", "quality_plan"));
  const coverageGraph = asRecord(recordValue(qualityPlan, "coverageGraph", "coverage_graph"));
  if (!coverageGraph) {
    return null;
  }
  const targetProfile = asRecord(recordValue(qualityPlan, "targetProfile", "target_profile"));
  const requirementById = requirementAuditSummaries(targetProfile);
  const coveredRequirementIds = parseStringList(recordValue(coverageGraph, "coveredRequirementIds", "covered_requirement_ids"));
  const claims = parseAuditClaims(recordValue(metadata, "changeAnnotations", "change_annotations"));
  const revision = parseAuditRevision(recordValue(metadata, "postGenerationFit", "post_generation_fit"));
  const shippedFit = parseAuditShippedFit(
    recordValue(metadata, "postGenerationFitFinal", "post_generation_fit_final"),
  );
  const reviewBlockers = boundedEvidenceList([
    ...(revision?.reviewBlockers ?? []),
    ...claims
      .filter((claim) => claim.reviewRequired)
      .map((claim) => `${claim.label}: ${claim.claimLabels.join(", ") || "review required"}`),
  ]);
  return {
    requirementCount: nonNegativeInteger(recordValue(coverageGraph, "requirementCount", "requirement_count")),
    achievementCount: nonNegativeInteger(recordValue(coverageGraph, "achievementCount", "achievement_count")),
    coverageEdgeCount: nonNegativeInteger(recordValue(coverageGraph, "coverageEdgeCount", "coverage_edge_count")),
    coveredRequirements: coveredRequirementIds.map((id) => requirementAuditRequirement(id, requirementById, null)),
    uncoveredRequirements: parseUncoveredAuditRequirements(
      recordValue(coverageGraph, "uncoveredRequirements", "uncovered_requirements"),
      requirementById,
    ),
    unusedAchievementIds: parseStringList(recordValue(coverageGraph, "unusedAchievementIds", "unused_achievement_ids")),
    evidenceBackedClaims: claims.filter(
      (claim) => claim.requirementIds.length > 0 || claim.evidenceIds.length > 0 || claim.coverageEdgeIds.length > 0,
    ),
    pinnedClaims: claims.filter(
      (claim) => claim.claimLabels.includes("pinned") || claim.positioningReasons.includes("pinned"),
    ),
    adjacentOrDraftClaims: claims.filter(
      (claim) =>
        claim.reviewRequired ||
        claim.claimLabels.includes("adjacent_translation") ||
        claim.claimLabels.includes("draft_requires_confirmation"),
    ),
    bulletLimitOverflows: parseAuditOverflows(recordValue(metadata, "bulletLimitOverflows", "bullet_limit_overflows")),
    revision,
    shippedFit,
    reviewBlockers,
  };
}

function requirementAuditSummaries(
  targetProfile: Record<string, unknown> | null,
): Map<string, { textExcerpt: string; tier: string | null }> {
  const result = new Map<string, { textExcerpt: string; tier: string | null }>();
  for (const item of arrayValue(targetProfile?.requirements)) {
    const record = asRecord(item);
    if (!record) continue;
    const id = cleanLimitedText(recordValue(record, "requirementId", "requirement_id"), 80);
    if (!id) continue;
    result.set(id, {
      textExcerpt: cleanLimitedText(recordValue(record, "textExcerpt", "text_excerpt"), IDEAL_REQUIREMENT_TEXT_LIMIT),
      tier: cleanLimitedText(record.tier, 80) || null,
    });
  }
  return result;
}

function requirementAuditRequirement(
  id: string,
  requirementById: Map<string, { textExcerpt: string; tier: string | null }>,
  reason: string | null,
): ApplyReviewRequirementLedAudit["coveredRequirements"][number] {
  const summary = requirementById.get(id);
  return {
    id,
    textExcerpt: summary?.textExcerpt || id,
    tier: summary?.tier ?? null,
    reason,
  };
}

function parseUncoveredAuditRequirements(
  value: unknown,
  requirementById: Map<string, { textExcerpt: string; tier: string | null }>,
): ApplyReviewRequirementLedAudit["uncoveredRequirements"] {
  return arrayValue(value)
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      const id = cleanLimitedText(recordValue(record, "requirementId", "requirement_id"), 80);
      if (!id) return null;
      return requirementAuditRequirement(
        id,
        requirementById,
        cleanLimitedText(record.reason, EVIDENCE_TEXT_LIMIT) || null,
      );
    })
    .filter((item): item is ApplyReviewRequirementLedAudit["uncoveredRequirements"][number] => item !== null)
    .slice(0, EVIDENCE_LIST_LIMIT);
}

function parseAuditClaims(value: unknown): ApplyReviewRequirementLedAudit["evidenceBackedClaims"] {
  return arrayValue(value)
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      const section = cleanLimitedText(record.section, 80);
      const label = cleanLimitedText(record.label, 160);
      if (!section || !label) return null;
      return {
        section,
        label,
        textExcerpts: parseStringList(recordValue(record, "tailoredText", "tailored_text")).slice(0, 3),
        requirementIds: parseStringList(recordValue(record, "requirementIds", "requirement_ids")),
        evidenceIds: parseStringList(recordValue(record, "evidenceIds", "evidence_ids")),
        coverageEdgeIds: parseStringList(recordValue(record, "coverageEdgeIds", "coverage_edge_ids")),
        claimLabels: parseStringList(recordValue(record, "claimLabels", "claim_labels")),
        positioningReasons: parseStringList(recordValue(record, "positioningReasons", "positioning_reasons")),
        reviewRequired: Boolean(recordValue(record, "reviewRequired", "review_required")),
      };
    })
    .filter((item): item is ApplyReviewRequirementLedAudit["evidenceBackedClaims"][number] => item !== null)
    .slice(0, EVIDENCE_LIST_LIMIT);
}

function parseAuditOverflows(value: unknown): ApplyReviewRequirementLedAudit["bulletLimitOverflows"] {
  return arrayValue(value)
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      const experienceEntryId = cleanLimitedText(recordValue(record, "experienceEntryId", "experience_entry_id"), 120);
      const reason = cleanLimitedText(record.reason, 120);
      const maxBullets = nonNegativeInteger(recordValue(record, "maxBullets", "max_bullets"));
      const actualBullets = nonNegativeInteger(recordValue(record, "actualBullets", "actual_bullets"));
      if (!experienceEntryId || !reason || actualBullets <= maxBullets) return null;
      return {
        experienceEntryId,
        maxBullets,
        actualBullets,
        reason,
        evidenceIds: parseStringList(recordValue(record, "evidenceIds", "evidence_ids")),
      };
    })
    .filter((item): item is ApplyReviewRequirementLedAudit["bulletLimitOverflows"][number] => item !== null)
    .slice(0, EVIDENCE_LIST_LIMIT);
}

const GROUNDED_COVERAGE_BASIS = "grounded_shipped_text_v1";

function coverageBasisLabel(value: unknown): ApplyReviewCoverageBasis {
  return value === GROUNDED_COVERAGE_BASIS ? "grounded_shipped_text_v1" : "judge_claimed_legacy";
}

function parseAuditRevision(value: unknown): ApplyReviewRequirementLedAudit["revision"] {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const fitScore = asRecord(recordValue(record, "fitScore", "fit_score"));
  const decision = asRecord(recordValue(record, "revisionDecision", "revision_decision"));
  if (!fitScore && !decision) {
    return null;
  }
  const attempt = nullableInteger(decision?.attempt);
  return {
    score: nullableNumber(fitScore?.score),
    mustHaveCoverage: nullableNumber(recordValue(fitScore, "mustHaveCoverage", "must_have_coverage")),
    thresholdFailed: Boolean(recordValue(decision, "thresholdFailed", "threshold_failed")),
    shouldRevise: Boolean(recordValue(decision, "shouldRevise", "should_revise")),
    reviewBlocked: Boolean(recordValue(decision, "reviewBlocked", "review_blocked")),
    enhancementAllowed: Boolean(recordValue(decision, "enhancementAllowed", "enhancement_allowed")),
    reason: cleanLimitedText(decision?.reason, EVIDENCE_TEXT_LIMIT) || null,
    attempt,
    maxRevisionAttempts: nullableInteger(recordValue(decision, "maxRevisionAttempts", "max_revision_attempts")),
    revisionsUsed: attempt === null ? null : Math.max(0, attempt - 1),
    coverageBasis: coverageBasisLabel(recordValue(fitScore, "coverageBasis", "coverage_basis")),
    claimedOnlyRequirementIds: parseStringList(
      recordValue(fitScore, "claimedOnlyRequirementIds", "claimed_only_requirement_ids"),
    ),
    prioritizedFixes: parseStringList(recordValue(decision, "prioritizedFixes", "prioritized_fixes")),
    reviewBlockers: parseStringList(recordValue(decision, "reviewBlockers", "review_blockers")),
  };
}

function parseAuditShippedFit(value: unknown): ApplyReviewRequirementLedShippedFit | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const fitScore = asRecord(recordValue(record, "fitScore", "fit_score"));
  const lifecycle = cleanLimitedText(record.lifecycle, 80) || null;
  if (!fitScore && !lifecycle) {
    return null;
  }
  return {
    lifecycle,
    score: nullableNumber(fitScore?.score),
    mustHaveCoverage: nullableNumber(recordValue(fitScore, "mustHaveCoverage", "must_have_coverage")),
    claimedOnlyRequirementIds: parseStringList(
      recordValue(fitScore, "claimedOnlyRequirementIds", "claimed_only_requirement_ids"),
    ),
    passed: Boolean(record.passed),
    warnings: parseStringList(record.warnings),
    coverageBasis: coverageBasisLabel(recordValue(fitScore, "coverageBasis", "coverage_basis")),
  };
}

function resumeLayoutBoxesForArtifact(db: SqliteDatabase, artifactId: string | null): ResumeLayoutBox[] {
  if (!artifactId) return [];
  const row = getRow<{ layout_boxes_json?: string | null }>(
    db,
    "SELECT layout_boxes_json FROM artifact_list_projections WHERE artifact_id = ?",
    [artifactId],
  );
  return parseResumeLayoutBoxes(row?.layout_boxes_json ?? null);
}

function parseResumeLayoutBoxes(value: string | null): ResumeLayoutBox[] {
  let parsed: unknown = null;
  try {
    parsed = value ? JSON.parse(value) : null;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const boxes: ResumeLayoutBox[] = [];
  for (const raw of parsed) {
    if (!isRecord(raw)) continue;
    const semanticId = cleanLimitedText(raw.semanticId, 160);
    const textExcerpt = cleanLimitedText(raw.textExcerpt, 500);
    const pageNumber = positiveInteger(raw.pageNumber);
    const leftPct = boundedPercent(raw.leftPct);
    const topPct = boundedPercent(raw.topPct);
    const widthPct = boundedPercent(raw.widthPct);
    const heightPct = boundedPercent(raw.heightPct);
    if (
      !semanticId ||
      !textExcerpt ||
      pageNumber === null ||
      leftPct === null ||
      topPct === null ||
      widthPct === null ||
      heightPct === null
    ) {
      continue;
    }
    boxes.push({
      semanticId,
      pageNumber,
      lineNumber: nullableInteger(raw.lineNumber),
      textExcerpt,
      leftPct,
      topPct,
      widthPct,
      heightPct,
    });
  }
  return boxes;
}

function outcomeFromRow(row: OutcomeRow): ApplicationOutcome {
  return {
    outcomeId: row.outcome_id,
    jobKey: canonicalJobId(row.job_id),
    kind: outcomeKind(row.kind),
    source: row.source === "email_suggestion" ? "email_suggestion" : "manual",
    note: row.note,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    suggestionId: row.suggestion_id,
    evidenceId: row.evidence_id,
    interviewPrepGeneration: row.interview_prep_generation ?? null,
  };
}

function suggestionFromRow(db: SqliteDatabase, row: SuggestionRow): OutcomeSuggestion {
  const binding = db.prepare("SELECT determination_id FROM semantic_entity_bindings WHERE tenant_id=? AND entity_kind='outcome_suggestion' AND entity_id=? AND determination_kind='message_outcome'").get(DEFAULT_TENANT, row.suggestion_id) as {determination_id:string} | undefined;
  const determination = binding ? readDetermination(db, DEFAULT_TENANT, binding.determination_id) : null;
  if (determination && determination.kind !== "message_outcome") throw new InputError("outcome_determination_binding_invalid");
  const result = determination ? MessageOutcomeDeterminationSchema.parse(determination.result) : null;
  if (result) {
    const source = db.prepare("SELECT job_id,provider_message_id,subject,snippet,body_text FROM application_email_evidence WHERE tenant_id=? AND evidence_id=?").get(DEFAULT_TENANT,row.evidence_id) as {job_id:string;provider_message_id:string;subject:string|null;snippet:string|null;body_text:string|null}|undefined;
    const text = source ? [source.subject,source.snippet,source.body_text].map(value=>(value??"").trim()).join("\n") : "";
    if (!source || source.job_id !== row.job_id || determination!.entity_id !== source.provider_message_id || result.kind !== row.suggested_kind || result.confidence !== Number(row.confidence) || result.citations.some(cite => cite.source_id !== "message" || !text.includes(cite.quote))) throw new InputError("outcome_determination_binding_invalid");
  }
  return {
    determination,
    citations: result?.citations ?? [],
    suggestionId: row.suggestion_id,
    jobKey: canonicalJobId(row.job_id),
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

type JobId = string & { readonly __brand: "JobId" };

function canonicalJobId(value: string): JobId {
  if (!CANONICAL_JOB_ID.test(value)) {
    throw new InputError("jobId must be a canonical lowercase UUID.");
  }
  return value as JobId;
}

function resolveExternalJobIdOrNull(db: SqliteDatabase, jobLocator: string): JobId | null {
  const resolved = resolveJobId(db, DEFAULT_TENANT, jobLocator);
  return resolved ? canonicalJobId(resolved) : null;
}

function resolveExternalJobId(db: SqliteDatabase, jobLocator: string): JobId {
  const jobId = resolveExternalJobIdOrNull(db, jobLocator);
  if (!jobId) {
    throw new InputError("Job not found.");
  }
  return jobId;
}

function recordEvent(
  db: SqliteDatabase,
  event: {
    eventType: string;
    idempotencyKey?: string;
    payload: Record<string, unknown>;
    message: string;
    jobId: JobId;
    stage: Stage;
  },
): void {
  db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level, message,
       occurred_at, payload_json, entity_kind, entity_ref, idempotency_key
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEFAULT_TENANT,
    event.jobId,
    7,
    event.stage,
    event.eventType,
    "info",
    event.message,
    new Date().toISOString(),
    JSON.stringify(event.payload),
    "job",
    event.jobId,
    event.idempotencyKey ?? null,
  );
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

function nullableInteger(value: unknown): number | null {
  const parsed = nullableNumber(value);
  if (parsed === null) return null;
  return Number.isInteger(parsed) ? parsed : Math.trunc(parsed);
}

function nonNegativeInteger(value: unknown): number {
  const parsed = nullableInteger(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

function positiveInteger(value: unknown): number | null {
  const parsed = nullableInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function boundedPercent(value: unknown): number | null {
  const parsed = nullableNumber(value);
  if (parsed === null || parsed < 0) return null;
  return Math.min(100, parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
