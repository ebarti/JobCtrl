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
  APPLY_REVIEW_DECISION_VALUES,
  OUTCOME_SUGGESTION_STATUSES,
  STAGES,
  STAGE_STATES,
} from "./contracts.js";
import { buildApplyAudit } from "./apply-audit.js";
import {
  allRows,
  getRow,
  hasCompositeJobIdForeignKey,
  jobReferenceColumn,
  jobReferenceJoinToJobs,
  jobReferencePredicateForUrl,
  stableJobIdForUrl,
  tableExists,
  type SqliteDatabase,
  type SqliteValue,
} from "./db.js";
import { refreshProjections } from "./projections.js";
import {
  ensureRepeatApplicationTables,
  evaluateRepeatApplication,
} from "./repeat-application.js";
import { resumeTemplateStateForJob } from "./resume-templates.js";
import { InputError, resolveJobUrl } from "./write-model.js";

const DEFAULT_TENANT = "local";
const DEFAULT_PROFILE_ID = "default";
const APPLICATION_REVIEW_REFERENCE_SCHEMA_VERSION = 20;
const CLOSED_ACTIVE_STATES = ["closed", "expired", "removed", "location_incompatible"];
const POSITION_PREVIEW_CHAR_LIMIT = 6000;
const MATERIAL_PREVIEW_CHAR_LIMIT = 4000;
const MATERIAL_PREVIEW_BYTE_LIMIT = 24_000;
const RESUME_AUDIT_TEXT_BYTE_LIMIT = 128_000;
const COVER_LETTER_REVIEW_TEXT_BYTE_LIMIT = 128_000;
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
  employer_ideal_candidate_narrative: string | null;
  employer_requirements_json: string | null;
  requirement_fit_report_json: string | null;
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
  interview_prep_generation: number | null;
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

type ApplicationReviewReferenceColumn = "job_id" | "job_key";

function applicationReviewReferenceColumn(
  db: SqliteDatabase,
): ApplicationReviewReferenceColumn {
  const columns = tableColumnSet(db, "application_review_decisions");
  return columns.has("job_id") ? "job_id" : "job_key";
}

function applicationReviewReferenceForUrl(
  db: SqliteDatabase,
  jobUrl: string,
): string {
  if (applicationReviewReferenceColumn(db) === "job_key") {
    return jobUrl;
  }
  const jobId = stableJobIdForUrl(db, jobUrl, DEFAULT_TENANT);
  if (!jobId) {
    throw new InputError(`No stable Job identity for ${jobUrl}.`);
  }
  return jobId;
}

export function ensureApplicationFeedbackTables(db: SqliteDatabase): void {
  const schemaVersion = db.pragma("user_version", {
    simple: true,
  }) as number;
  const stableReviewSchema =
    schemaVersion >= APPLICATION_REVIEW_REFERENCE_SCHEMA_VERSION;
  const createdReviewReference = stableReviewSchema
    ? "job_id"
    : "job_key";
  const reviewForeignKey = stableReviewSchema
    ? `,
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE`
    : "";
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_review_decisions (
      tenant_id    TEXT NOT NULL DEFAULT 'local',
      decision_id  TEXT NOT NULL,
      ${createdReviewReference} TEXT NOT NULL,
      decision     TEXT NOT NULL,
      reason       TEXT,
      decided_by   TEXT NOT NULL DEFAULT 'user',
      decided_at   TEXT NOT NULL,
      materials_generation INTEGER,
      profile_version INTEGER,
      application_url TEXT,
      partial_override_run_id TEXT,
      email_recipient TEXT,
      email_attachment_artifact_id TEXT,
      PRIMARY KEY (tenant_id, decision_id)
      ${reviewForeignKey}
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
  ensureApplicationReviewDecisionColumns(db);
  const reviewReference = applicationReviewReferenceColumn(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_application_review_decisions_job
      ON application_review_decisions(
        tenant_id,
        ${reviewReference},
        decided_at DESC
      );
  `);
  ensureApplicationOutcomeColumns(db);
  ensureRepeatApplicationTables(db);
}

function ensureApplicationReviewDecisionColumns(db: SqliteDatabase): void {
  const columns = tableColumnSet(db, "application_review_decisions");
  const additions: Record<string, string> = {
    materials_generation: "INTEGER",
    profile_version: "INTEGER",
    application_url: "TEXT",
    partial_override_run_id: "TEXT",
    email_recipient: "TEXT",
    email_attachment_artifact_id: "TEXT",
  };
  for (const [column, definition] of Object.entries(additions)) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE application_review_decisions ADD COLUMN ${column} ${definition}`);
    }
  }
}

function ensureApplicationOutcomeColumns(db: SqliteDatabase): void {
  const columns = tableColumnSet(db, "application_outcomes");
  const additions: Record<string, string> = {
    interview_prep_generation: "INTEGER",
  };
  for (const [column, definition] of Object.entries(additions)) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE application_outcomes ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function listApplyReviewQueue(db: SqliteDatabase): ApplyReviewQueueResponse {
  ensureApplicationFeedbackTables(db);
  refreshProjections(db);

  const hiddenWhere = tableExists(db, "jobctrl_hidden_jobs")
    ? `AND NOT EXISTS (
         SELECT 1 FROM jobctrl_hidden_jobs h
         WHERE h.job_url = jlp.job_id AND h.unhidden_at IS NULL
       )`
    : "";
  const stableSnapshotReference = hasCompositeJobIdForeignKey(
    db,
    "posting_snapshot_sets",
  );
  const closedWhere = tableExists(db, "posting_snapshot_sets")
    ? `AND NOT EXISTS (
         SELECT 1 FROM posting_snapshot_sets pss
         WHERE pss.tenant_id = jlp.tenant_id
           AND pss.${stableSnapshotReference ? "job_id" : "job_url"} = ${
             stableSnapshotReference
               ? `(SELECT j.job_id
                     FROM jobs j
                    WHERE j.tenant_id = jlp.tenant_id
                      AND j.url = jlp.job_id
                    LIMIT 1)`
               : "jlp.job_id"
           }
           AND pss.latest_active_state IN (${CLOSED_ACTIVE_STATES.map(() => "?").join(", ")})
       )`
    : "";
  const closedParams = tableExists(db, "posting_snapshot_sets") ? CLOSED_ACTIVE_STATES : [];
  const hasEmployerAnalysis = tableExists(db, "job_employer_analysis");
  const employerAnalysisReference = hasEmployerAnalysis
    ? jobReferenceColumn(db, "job_employer_analysis")
    : "job_url";
  const employerAnalysisCte = hasEmployerAnalysis
    ? `,
    latest_employer_analysis AS (
      SELECT job_reference, ideal_candidate_narrative, requirements_json
      FROM (
        SELECT ${employerAnalysisReference} AS job_reference,
               ideal_candidate_narrative, requirements_json,
               ROW_NUMBER() OVER (
                 PARTITION BY tenant_id, ${employerAnalysisReference}
                 ORDER BY generation DESC
               ) AS row_num
        FROM job_employer_analysis
        WHERE tenant_id = ?
      )
      WHERE row_num = 1
    )`
    : "";
  const employerAnalysisSelect = hasEmployerAnalysis
    ? `,
           latest_employer_analysis.ideal_candidate_narrative AS employer_ideal_candidate_narrative,
           latest_employer_analysis.requirements_json AS employer_requirements_json`
    : `,
           NULL AS employer_ideal_candidate_narrative,
           NULL AS employer_requirements_json`;
  const employerAnalysisJoin = hasEmployerAnalysis
    ? employerAnalysisReference === "job_id"
      ? `LEFT JOIN jobs employer_analysis_job
           ON employer_analysis_job.tenant_id = jlp.tenant_id
          AND employer_analysis_job.url = jlp.job_id
         LEFT JOIN latest_employer_analysis
           ON latest_employer_analysis.job_reference =
              employer_analysis_job.job_id`
      : "LEFT JOIN latest_employer_analysis ON latest_employer_analysis.job_reference = jlp.job_id"
    : "";
  const stableStageReferences = jobReferenceColumn(
    db,
    "job_stage_states",
  ) === "job_id";
  const reviewReference = applicationReviewReferenceColumn(db);
  const stableReviewReferences = reviewReference === "job_id";
  const reviewJobKeySelect = stableReviewReferences
    ? "review_jobs.url"
    : "review_decisions.job_key";
  const reviewJobsJoin = stableReviewReferences
    ? `JOIN jobs review_jobs
         ON review_jobs.tenant_id = review_decisions.tenant_id
        AND review_jobs.job_id = review_decisions.job_id`
    : "";
  const rows = allRows<ReviewQueueRow>(
    db,
    `
    WITH latest_decision AS (
      SELECT decision_id, job_key, decision, decided_at,
             materials_generation, profile_version, application_url,
             partial_override_run_id, email_recipient, email_attachment_artifact_id
      FROM (
        SELECT review_decisions.decision_id,
               ${reviewJobKeySelect} AS job_key,
               review_decisions.decision,
               review_decisions.decided_at,
               review_decisions.materials_generation,
               review_decisions.profile_version,
               review_decisions.application_url,
               review_decisions.partial_override_run_id,
               review_decisions.email_recipient,
               review_decisions.email_attachment_artifact_id,
               ROW_NUMBER() OVER (
                 PARTITION BY review_decisions.tenant_id,
                              review_decisions.${reviewReference}
                 ORDER BY review_decisions.decided_at DESC,
                          review_decisions.decision_id DESC
               ) AS row_num
        FROM application_review_decisions review_decisions
        ${reviewJobsJoin}
        WHERE review_decisions.tenant_id = ?
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
    ),
    apply_stage AS (
      SELECT tenant_id, job_url, state
      FROM (
        SELECT ${stableStageReferences ? "stage_jobs.tenant_id" : `'${DEFAULT_TENANT}'`} AS tenant_id,
               ${stableStageReferences ? "stage_jobs.url" : "stage_state.job_url"} AS job_url,
               stage_state.state,
               ROW_NUMBER() OVER (
                 PARTITION BY ${
                   stableStageReferences
                     ? "stage_state.tenant_id, stage_state.job_id"
                     : "stage_state.job_url"
                 }
                 ORDER BY COALESCE(stage_state.updated_at, '') DESC,
                          stage_state.rowid DESC
               ) AS row_num
        FROM job_stage_states stage_state
        ${stableStageReferences
          ? `JOIN jobs stage_jobs
               ON ${jobReferenceJoinToJobs(
                 db,
                 "job_stage_states",
                 "stage_state",
                 "stage_jobs",
               )}`
          : ""}
        WHERE stage_state.stage = 'apply'
      )
      WHERE row_num = 1
    )
    ${employerAnalysisCte}
    SELECT jlp.job_id, jlp.title, jlp.employer, jlp.source,
           jlp.compensation_summary_json, jlp.application_url,
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
    LEFT JOIN job_detail_projections jdp ON jdp.tenant_id = jlp.tenant_id AND jdp.job_id = jlp.job_id
    LEFT JOIN latest_decision ON latest_decision.job_key = jlp.job_id
    LEFT JOIN latest_apply_run ON latest_apply_run.job_id = jlp.job_id
    INNER JOIN apply_stage
      ON apply_stage.tenant_id = jlp.tenant_id
     AND apply_stage.job_url = jlp.job_id
    ${employerAnalysisJoin}
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
      ...(hasEmployerAnalysis ? [DEFAULT_TENANT] : []),
      DEFAULT_TENANT,
      ...closedParams,
    ],
  );

  const profileSourceFields = profileSourceFieldsForApplyReview(db);
  const missingProfileData = missingApplicationAttestationFields(db);
  return {
    ok: true,
    items: rows.map((row) =>
      reviewQueueItemFromRow(db, row, profileSourceFields, missingProfileData),
    ),
  };
}

export function recordApplyReviewDecision(
  db: SqliteDatabase,
  jobKey: string,
  request: ApplyReviewDecisionRequest,
): ApplyReviewDecisionResponse {
  ensureApplicationFeedbackTables(db);
  const jobUrl = existingJobUrl(db, jobKey);
  const applicationUrl = currentApplicationUrl(db, jobUrl);
  const materialsGeneration = currentReviewMaterialsGeneration(db, jobUrl);
  const profileVersion = currentProfileVersion(db);
  const partialOverrideRunId =
    request.decision === "approve_submit" ? request.partialOverrideRunId ?? null : null;
  if (request.decision === "approve_submit") {
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
          jobKey: jobUrl,
          materialsGeneration,
          profileVersion,
          applicationUrl,
          coverage: "full",
        })
      : null;
  if (partialOverrideRunId) {
    const partialEvidence = latestDryRunEvidence(db, {
      jobKey: jobUrl,
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
    request.decision === "approve_submit" ? latestEmailApplicationCandidate(db, jobUrl) : null;
  if (emailCandidate) {
    if (
      request.emailRecipient?.toLowerCase() !== emailCandidate.recipient.toLowerCase() ||
      request.emailAttachmentArtifactId !== emailCandidate.attachmentArtifactId
    ) {
      throw new InputError("approval_stale_email_candidate");
    }
  }
  const decidedAt = new Date().toISOString();
  const decision: ApplyReviewDecision = {
    decisionId: crypto.randomUUID(),
    jobKey: jobUrl,
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
  const reviewReference = applicationReviewReferenceColumn(db);
  const storedJobReference = applicationReviewReferenceForUrl(
    db,
    jobUrl,
  );

  db.prepare(
    `INSERT INTO application_review_decisions (
       tenant_id, decision_id, ${reviewReference}, decision, reason, decided_by, decided_at,
       materials_generation, profile_version, application_url, partial_override_run_id,
       email_recipient, email_attachment_artifact_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEFAULT_TENANT,
    decision.decisionId,
    storedJobReference,
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
    jobUrl,
    stage: "apply",
    message: "Apply review decision recorded.",
    payload: {
      tenantId: DEFAULT_TENANT,
      jobKey: jobUrl,
      decisionId: decision.decisionId,
      decision: decision.decision,
      reasonPresent: Boolean(decision.reason),
      materialsGeneration: decision.materialsGeneration,
      profileVersion: decision.profileVersion,
      applicationUrl: decision.applicationUrl,
      partialOverrideRunId: decision.partialOverrideRunId,
      emailRecipient: decision.emailRecipient,
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
  const interviewPrepGeneration = resolveInterviewPrepGeneration(
    db,
    jobUrl,
    request.interviewPrepGeneration,
  );
  const outcome = insertOutcome(db, {
    jobKey: jobUrl,
    kind: request.kind,
    source: "manual",
    note: request.note ?? null,
    occurredAt: request.occurredAt ?? new Date().toISOString(),
    suggestionId: null,
    evidenceId: null,
    interviewPrepGeneration,
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
        interviewPrepGeneration: null,
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
    interviewPrepGeneration: number | null;
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
    interviewPrepGeneration: input.interviewPrepGeneration,
  };

  db.prepare(
    `INSERT INTO application_outcomes (
       tenant_id, outcome_id, job_key, kind, source, note, occurred_at,
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
      interviewPrepGeneration: outcome.interviewPrepGeneration,
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
            recorded_at, suggestion_id, evidence_id, interview_prep_generation
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
            recorded_at, suggestion_id, evidence_id, interview_prep_generation
     FROM application_outcomes
     WHERE tenant_id = ? AND outcome_id = ?`,
    [DEFAULT_TENANT, outcomeId],
  );
  return row ? outcomeFromRow(row) : null;
}

function resolveInterviewPrepGeneration(
  db: SqliteDatabase,
  jobUrl: string,
  generation: number | undefined,
): number | null {
  if (generation === undefined) {
    return null;
  }
  if (!tableExists(db, "job_interview_prep")) {
    throw new InputError("Interview prep generation not found.");
  }
  const reference = jobReferencePredicateForUrl(
    db,
    "job_interview_prep",
    jobUrl,
    DEFAULT_TENANT,
  );
  const row = getRow<{ generation: number }>(
    db,
    `SELECT generation
       FROM job_interview_prep
      WHERE tenant_id = ?
        AND ${reference.sql}
        AND generation = ?
        AND status IN ('accepted', 'superseded')
      LIMIT 1`,
    [DEFAULT_TENANT, ...reference.params, generation],
  );
  if (!row) {
    throw new InputError("Interview prep generation not found.");
  }
  return generation;
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
  missingProfileData: readonly string[],
): ApplyReviewQueueItem {
  const currentState = stageState(row.current_state);
  const currentSubstage = stage(row.current_substage ?? row.current_stage);
  const blockers = queueBlockers(row, currentState);
  const scoreBreakdown = parseQueueScoreBreakdown(row.score_breakdown_json);
  const scoreKeywords = boundedEvidenceList(parseStringListJson(row.score_keywords_json));
  const applicationUrl = applyTargetUrl(row);
  const materialsPreview = materialPreviewsForJob(db, row.job_id, profileSourceFields);
  const emailApplication = latestEmailApplicationCandidate(db, row.job_id);
  const materialsGeneration = materialsPreview.materialsGeneration;
  const profileVersion = currentProfileVersion(db);
  const dryRunEvidence = latestDryRunEvidence(db, {
    jobKey: row.job_id,
    materialsGeneration,
    profileVersion,
    applicationUrl,
    coverage: "full",
  });
  const partialDryRunEvidence = latestDryRunEvidence(db, {
    jobKey: row.job_id,
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
  const idealCandidate = cleanLimitedText(
    row.employer_ideal_candidate_narrative,
    IDEAL_CANDIDATE_TEXT_LIMIT,
  );
  const requirementFitReport = parseRequirementFitReport(row.requirement_fit_report_json);
  const rawIdealRequirements = parseIdealRequirementsJson(row.employer_requirements_json);
  const idealRequirements = requirementsWithTailoredResumeCoverage(
    db,
    row.job_id,
    rawIdealRequirements,
    materialsPreview.resumeTextArtifactId,
    requirementFitReport,
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
    jobKey: row.job_id,
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
    repeatApplication: evaluateRepeatApplication(db, row.job_id),
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
  const postingUrl = cleanBlockerText(row.job_id);
  return postingUrl || null;
}

function currentApplicationUrl(db: SqliteDatabase, jobKey: string): string | null {
  if (tableExists(db, "job_list_projections")) {
    const row = getRow<{ application_url: string | null; job_id: string }>(
      db,
      `SELECT application_url, job_id
       FROM job_list_projections
       WHERE tenant_id = ? AND job_id = ?`,
      [DEFAULT_TENANT, jobKey],
    );
    if (row) {
      return cleanBlockerText(row.application_url) || cleanBlockerText(row.job_id) || null;
    }
  }
  if (tableExists(db, "jobs")) {
    const row = getRow<{ application_url: string | null; url: string }>(
      db,
      "SELECT application_url, url FROM jobs WHERE url = ?",
      [jobKey],
    );
    if (row) {
      return cleanBlockerText(row.application_url) || cleanBlockerText(row.url) || null;
    }
  }
  return jobKey || null;
}

function latestMaterialsGeneration(db: SqliteDatabase, jobKey: string): number | null {
  if (!tableExists(db, "job_materials")) return null;
  const reference = jobReferencePredicateForUrl(
    db,
    "job_materials",
    jobKey,
  );
  const row = getRow<{ generation: number | null }>(
    db,
    `SELECT MAX(generation) AS generation
       FROM job_materials
      WHERE ${reference.sql}`,
    reference.params,
  );
  return nullableNumber(row?.generation);
}

function currentReviewMaterialsGeneration(db: SqliteDatabase, jobKey: string): number | null {
  return resumeMaterialPreviewForJob(db, jobKey).materialsGeneration ?? latestMaterialsGeneration(db, jobKey);
}

function currentProfileVersion(db: SqliteDatabase): number | null {
  if (!tableExists(db, "candidate_profiles")) return null;
  const columns = tableColumnSet(db, "candidate_profiles");
  if (!columns.has("version")) return null;
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
    readonly jobKey: string;
    readonly materialsGeneration: number | null;
    readonly profileVersion: number | null;
    readonly applicationUrl: string | null;
    readonly coverage: "full" | "partial";
  },
): ApplyReviewDryRunEvidence | null {
  if (
    expected.materialsGeneration === null ||
    expected.profileVersion === null ||
    !expected.applicationUrl ||
    !tableExists(db, "job_events")
  ) {
    return null;
  }
  const rows = allRows<{ payload_json: string | null; occurred_at: string | null }>(
    db,
    `SELECT payload_json, occurred_at
     FROM job_events
     WHERE job_url = ? AND stage = 'apply' AND event_type = 'DryRunCompleted'
     ORDER BY event_id DESC
     LIMIT 24`,
    [expected.jobKey],
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
  jobKey: string,
): ApplyReviewQueueItem["emailApplication"] {
  if (!tableExists(db, "job_events")) {
    return null;
  }
  const row = getRow<{ payload_json: string | null; occurred_at: string | null }>(
    db,
    `SELECT payload_json, occurred_at
     FROM job_events
     WHERE job_url = ? AND stage = 'apply' AND event_type = 'EmailApplicationCandidateRecorded'
     ORDER BY occurred_at DESC, event_id DESC
     LIMIT 1`,
    [jobKey],
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
    readonly jobKey: string;
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
     WHERE job_url = ?
       AND stage = 'apply'
       AND event_type = 'ApplyRunStarted'
       AND payload_json LIKE ?
     ORDER BY event_id DESC
     LIMIT 1`,
    [expected.jobKey, `%${runId}%`],
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

function isReviewRequiredMaterialMetadata(value: string | null): boolean {
  const metadata = parseJsonRecord(value);
  if (!metadata) return false;
  if (Boolean(recordValue(metadata, "reviewRequired", "review_required"))) return true;
  const fit = asRecord(recordValue(metadata, "postGenerationFit", "post_generation_fit"));
  const decision = asRecord(recordValue(fit, "revisionDecision", "revision_decision"));
  if (Boolean(recordValue(decision, "reviewBlocked", "review_blocked"))) return true;
  const fitScore = asRecord(recordValue(fit, "fitScore", "fit_score"));
  return parseStringList(recordValue(fitScore, "reviewBlockers", "review_blockers")).length > 0;
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
  return {
    state: "not_recorded",
    source: "tailored_resume_bullet_provenance",
    bulletCount: 0,
    examples: [],
  };
}

function requirementsWithTailoredResumeCoverage(
  db: SqliteDatabase,
  jobKey: string,
  requirements: readonly ApplyReviewIdealRequirement[],
  resumeTextArtifactId: string | null,
  requirementFitReport: RequirementFitReport | null,
): ApplyReviewIdealRequirement[] {
  if (!requirements.length) {
    return [];
  }
  const fitByRequirement = requirementFitByRequirementId(requirementFitReport);
  if (!resumeTextArtifactId || !tableExists(db, "job_bullet_provenance")) {
    return requirements.map((requirement) =>
      requirementWithFitAssessment(requirement, fitByRequirement.get(requirement.id), emptyRequirementCoverage()),
    );
  }
  const provenanceReference = jobReferencePredicateForUrl(
    db,
    "job_bullet_provenance",
    jobKey,
  );
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  const rows = allRows<{
    generated_text: string;
    requirement_ids_json: string;
  }>(
    db,
    `SELECT generated_text, requirement_ids_json
       FROM job_bullet_provenance
      WHERE ${provenanceReference.sql}
        AND artifact_id = ?
      ORDER BY position, bullet_id`,
    [...provenanceReference.params, resumeTextArtifactId],
  );
  if (!rows.length) {
    return requirements.map((requirement) =>
      requirementWithFitAssessment(requirement, fitByRequirement.get(requirement.id), emptyRequirementCoverage()),
    );
  }

  const covered = new Map<string, { bulletCount: number; examples: string[] }>();
  for (const row of rows) {
    const ids = parseStringListJson(row.requirement_ids_json).filter((id) => requirementIds.has(id));
    if (!ids.length) continue;
    const example = cleanText(row.generated_text);
    for (const id of ids) {
      const current = covered.get(id) ?? { bulletCount: 0, examples: [] };
      current.bulletCount += 1;
      if (example && current.examples.length < 3) {
        current.examples.push(example);
      }
      covered.set(id, current);
    }
  }

  return requirements.map((requirement) => {
    const hit = covered.get(requirement.id);
    const assessment = fitByRequirement.get(requirement.id);
    return requirementWithFitAssessment(
      requirement,
      assessment,
      hit
        ? {
            state: "covered",
            source: "tailored_resume_bullet_provenance",
            bulletCount: hit.bulletCount,
            examples: hit.examples,
          }
        : uncoveredRequirementCoverage(assessment),
    );
  });
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

function uncoveredRequirementCoverage(
  assessment: RequirementFitAssessment | undefined,
): ApplyReviewIdealRequirement["coverage"] {
  if (assessment?.fit.kind === "missing" || assessment?.fit.kind === "blocked") {
    return {
      state: "missing_from_profile",
      source: "tailored_resume_bullet_provenance",
      bulletCount: 0,
      examples: [],
    };
  }
  if (assessment?.fit.kind === "matched" || assessment?.fit.kind === "transferable") {
    return {
      state: "missing_from_resume",
      source: "tailored_resume_bullet_provenance",
      bulletCount: 0,
      examples: [],
    };
  }
  return emptyRequirementCoverage();
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

const APPLICATION_ATTESTATION_PROFILE_COLUMNS = [
  ["age_18_plus", "application_attestation_age_18_plus"],
  ["background_check_consent", "application_attestation_background_check_consent"],
  ["felony_conviction", "application_attestation_felony_conviction"],
  ["previously_worked_at_employer", "application_attestation_previously_worked_at_employer"],
] as const;

function missingApplicationAttestationFields(db: SqliteDatabase): string[] {
  if (!tableExists(db, "candidate_profiles")) return [];
  const columns = tableColumnSet(db, "candidate_profiles");
  if (!APPLICATION_ATTESTATION_PROFILE_COLUMNS.every(([, column]) => columns.has(column))) {
    return [];
  }
  const row = getRow<Record<string, unknown>>(
    db,
    `SELECT ${APPLICATION_ATTESTATION_PROFILE_COLUMNS.map(([, column]) => column).join(", ")}
       FROM candidate_profiles
      WHERE tenant_id = ? AND profile_id = ?`,
    [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
  );
  if (!row) return [];
  return APPLICATION_ATTESTATION_PROFILE_COLUMNS
    .filter(([, column]) => row[column] === undefined || row[column] === null || row[column] === "")
    .map(([field]) => field);
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
  | "materialsGeneration"
  | "resumeText"
  | "resumeTextArtifactId"
  | "resumePdfArtifactId"
  | "resumePdfLayoutBoxes"
  | "requirementLedAudit"
  | "resumeTemplate"
>;

interface MaterialArtifactCandidate {
  readonly artifactId: string | null;
  readonly createdAt: string;
  readonly generation: number | null;
  readonly metadataJson: string | null;
  readonly path: string;
  readonly reviewRequired: boolean;
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
  const reviewRequiredText = textCandidates.find((candidate) => candidate.reviewRequired);
  if (reviewRequiredText) {
    const text = firstReadableTextCandidate([reviewRequiredText], {
      byteLimit: RESUME_AUDIT_TEXT_BYTE_LIMIT,
      charLimit: null,
    });
    if (text) {
      return {
        materialsGeneration: text.candidate.generation,
        resumeText: text.preview,
        resumeTextArtifactId: text.candidate.artifactId,
        resumePdfArtifactId: null,
        resumePdfLayoutBoxes: [],
        requirementLedAudit: requirementLedAuditForCandidates(db, jobKey, text.candidate),
        resumeTemplate: resumeTemplateStateForJob(db, jobKey),
      };
    }
  }

  for (const pdf of pdfCandidates) {
    const text = firstReadableTextCandidate(
      textCandidates.filter((candidate) => sameMaterialGeneration(candidate, pdf)),
      { byteLimit: RESUME_AUDIT_TEXT_BYTE_LIMIT, charLimit: null },
    );
    if (text) {
      return {
        materialsGeneration: text.candidate.generation,
        resumeText: text.preview,
        resumeTextArtifactId: text.candidate.artifactId,
        resumePdfArtifactId: pdf.artifactId,
        resumePdfLayoutBoxes: resumeLayoutBoxesForArtifact(db, pdf.artifactId),
        requirementLedAudit: requirementLedAuditForCandidates(db, jobKey, text.candidate, pdf),
        resumeTemplate: resumeTemplateStateForJob(db, jobKey),
      };
    }
  }

  const pdfOnly = pdfCandidates[0];
  if (pdfOnly) {
    return {
      materialsGeneration: pdfOnly.generation,
      resumeText: null,
      resumeTextArtifactId: null,
      resumePdfArtifactId: pdfOnly.artifactId,
      resumePdfLayoutBoxes: resumeLayoutBoxesForArtifact(db, pdfOnly.artifactId),
      requirementLedAudit: requirementLedAuditForCandidates(db, jobKey, pdfOnly),
      resumeTemplate: resumeTemplateStateForJob(db, jobKey),
    };
  }

  const text = firstReadableTextCandidate(textCandidates, { byteLimit: RESUME_AUDIT_TEXT_BYTE_LIMIT, charLimit: null });
  if (text) {
    return {
      materialsGeneration: text.candidate.generation,
      resumeText: text.preview,
      resumeTextArtifactId: text.candidate.artifactId,
      resumePdfArtifactId: null,
      resumePdfLayoutBoxes: [],
      requirementLedAudit: requirementLedAuditForCandidates(db, jobKey, text.candidate),
      resumeTemplate: resumeTemplateStateForJob(db, jobKey),
    };
  }

  const failedAudit = failedRequirementLedAuditForJob(db, jobKey);
  return {
    materialsGeneration: failedAudit?.generation ?? pdfCandidates[0]?.generation ?? null,
    resumeText: null,
    resumeTextArtifactId: null,
    resumePdfArtifactId: pdfCandidates[0]?.artifactId ?? null,
    resumePdfLayoutBoxes: pdfCandidates[0]?.artifactId
      ? resumeLayoutBoxesForArtifact(db, pdfCandidates[0].artifactId)
      : [],
    requirementLedAudit: failedAudit?.audit ?? (pdfCandidates[0] ? requirementLedAuditForCandidates(db, jobKey, pdfCandidates[0]) : null),
    resumeTemplate: resumeTemplateStateForJob(db, jobKey),
  };
}

function failedRequirementLedAuditForJob(
  db: SqliteDatabase,
  jobKey: string,
): { generation: number | null; audit: ApplyReviewRequirementLedAudit } | null {
  if (!tableExists(db, "job_materials_artifacts")) {
    return null;
  }
  const artifactTypes = [...RESUME_TEXT_ARTIFACT_TYPES, ...RESUME_PDF_ARTIFACT_TYPES];
  const placeholders = artifactTypes.map(() => "?").join(", ");
  const columns = tableColumnSet(db, "job_materials_artifacts");
  const metadataSelect = columns.has("metadata_json") ? "metadata_json" : "NULL AS metadata_json";
  const artifactReference = jobReferencePredicateForUrl(
    db,
    "job_materials_artifacts",
    jobKey,
  );
  const rows = allRows<{
    artifact_id: string | null;
    created_at: string | null;
    generation: number | null;
    metadata_json: string | null;
    path: string | null;
  }>(
    db,
    `SELECT artifact_id, path, generation, created_at, ${metadataSelect}
       FROM job_materials_artifacts
      WHERE ${artifactReference.sql}
        AND artifact_type IN (${placeholders})
        AND status = 'rejected'
        AND metadata_json IS NOT NULL
        AND metadata_json != ''
      ORDER BY COALESCE(generation, -1) DESC, COALESCE(created_at, '') DESC, rowid DESC
      LIMIT 8`,
    [...artifactReference.params, ...artifactTypes],
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
      audit: reconcileRequirementLedAuditWithProvenance(db, jobKey, candidate, audit),
    };
  }
  return null;
}

function requirementLedAuditForCandidates(
  db: SqliteDatabase,
  jobKey: string,
  ...candidates: readonly MaterialArtifactCandidate[]
): ApplyReviewRequirementLedAudit | null {
  for (const candidate of candidates) {
    const audit = parseRequirementLedAuditMetadata(candidate.metadataJson);
    if (audit) {
      return reconcileRequirementLedAuditWithProvenance(db, jobKey, candidate, audit);
    }
  }
  return null;
}

function reconcileRequirementLedAuditWithProvenance(
  db: SqliteDatabase,
  jobKey: string,
  candidate: MaterialArtifactCandidate,
  audit: ApplyReviewRequirementLedAudit,
): ApplyReviewRequirementLedAudit {
  const requirementById = requirementSummariesFromAudit(audit);
  if (!requirementById.size || !tableExists(db, "job_bullet_provenance")) {
    return audit;
  }

  const rows = provenanceRowsForCandidate(db, jobKey, candidate);
  if (!rows.length) {
    return audit;
  }

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
  jobKey: string,
  candidate: MaterialArtifactCandidate,
): Array<{ requirement_ids_json: string }> {
  const provenanceReference = jobReferencePredicateForUrl(
    db,
    "job_bullet_provenance",
    jobKey,
  );
  const rowsByArtifact = candidate.artifactId
    ? allRows<{ requirement_ids_json: string }>(
        db,
        `SELECT requirement_ids_json
           FROM job_bullet_provenance
          WHERE ${provenanceReference.sql}
            AND artifact_id = ?`,
        [...provenanceReference.params, candidate.artifactId],
      )
    : [];
  if (rowsByArtifact.length || candidate.generation === null) {
    return rowsByArtifact;
  }
  return allRows<{ requirement_ids_json: string }>(
    db,
    `SELECT requirement_ids_json
       FROM job_bullet_provenance
      WHERE ${provenanceReference.sql}
        AND generation = ?`,
    [...provenanceReference.params, candidate.generation],
  );
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
  if (!artifactId || !tableExists(db, "artifact_list_projections")) return [];
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
    const columns = tableColumnSet(db, "artifact_list_projections");
    const metadataSelect = columns.has("metadata_json") ? "metadata_json" : "NULL AS metadata_json";
    const rows = allRows<{
      artifact_id: string | null;
      created_at: string | null;
      generation: number | null;
      local_path: string | null;
      metadata_json: string | null;
      status: string | null;
    }>(
      db,
      `SELECT artifact_id, local_path, generation, created_at, status, ${metadataSelect}
       FROM artifact_list_projections
       WHERE job_id = ?
         AND artifact_type IN (${placeholders})
         AND COALESCE(status, 'active') IN ('approved', 'active', 'candidate')
         AND local_path IS NOT NULL
         AND local_path != ''
       ORDER BY COALESCE(generation, -1) DESC, COALESCE(created_at, '') DESC, artifact_id DESC
       LIMIT 16`,
      [jobKey, ...artifactTypes],
    );
    for (const [index, row] of rows.entries()) {
      const reviewRequired = row.status === "candidate" && isReviewRequiredMaterialMetadata(row.metadata_json);
      if (row.status === "candidate" && !reviewRequired) continue;
      pushMaterialCandidate(candidates, {
        artifactId: row.artifact_id,
        binary,
        createdAt: row.created_at,
        generation: row.generation,
        metadataJson: row.metadata_json,
        path: row.local_path,
        reviewRequired,
        rowRank: index,
        sourceRank: 0,
      });
    }
  }

  if (tableExists(db, "job_materials_artifacts")) {
    const columns = tableColumnSet(db, "job_materials_artifacts");
    const metadataSelect = columns.has("metadata_json") ? "metadata_json" : "NULL AS metadata_json";
    const materialReference = jobReferencePredicateForUrl(
      db,
      "job_materials_artifacts",
      jobKey,
    );
    const rows = allRows<{
      artifact_id: string | null;
      created_at: string | null;
      generation: number | null;
      metadata_json: string | null;
      path: string | null;
      status: string | null;
    }>(
      db,
      `SELECT artifact_id, path, generation, created_at, status, ${metadataSelect}
       FROM job_materials_artifacts
       WHERE ${materialReference.sql}
         AND artifact_type IN (${placeholders})
         AND COALESCE(status, 'approved') IN ('approved', 'active', 'candidate')
         AND path IS NOT NULL
         AND path != ''
       ORDER BY COALESCE(generation, -1) DESC, COALESCE(created_at, '') DESC, rowid DESC
       LIMIT 16`,
      [...materialReference.params, ...artifactTypes],
    );
    for (const [index, row] of rows.entries()) {
      const reviewRequired = row.status === "candidate" && isReviewRequiredMaterialMetadata(row.metadata_json);
      if (row.status === "candidate" && !reviewRequired) continue;
      pushMaterialCandidate(candidates, {
        artifactId: row.artifact_id,
        binary,
        createdAt: row.created_at,
        generation: row.generation,
        metadataJson: row.metadata_json,
        path: row.path,
        reviewRequired,
        rowRank: index,
        sourceRank: 1,
      });
    }
  }

  if (tableExists(db, "job_artifacts")) {
    const artifactReference = jobReferencePredicateForUrl(
      db,
      "job_artifacts",
      jobKey,
    );
    const rows = allRows<{
      created_at: string | null;
      path: string | null;
      row_id: string | number | null;
    }>(
      db,
      `SELECT rowid AS row_id, path, created_at
       FROM job_artifacts
       WHERE ${artifactReference.sql}
         AND artifact_type IN (${placeholders})
         AND COALESCE(status, 'active') NOT IN ('missing', 'failed', 'superseded', 'suppressed')
         AND path IS NOT NULL
         AND path != ''
       ORDER BY COALESCE(created_at, '') DESC, rowid DESC
       LIMIT 16`,
      [...artifactReference.params, ...artifactTypes],
    );
    for (const [index, row] of rows.entries()) {
      pushMaterialCandidate(candidates, {
        artifactId: row.row_id === null || row.row_id === undefined ? null : String(row.row_id),
        binary,
        createdAt: row.created_at,
        generation: null,
        metadataJson: null,
        path: row.path,
        reviewRequired: false,
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
      metadataJson: null,
      path: legacyRow?.path ?? null,
      reviewRequired: false,
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
    readonly metadataJson: string | null | undefined;
    readonly path: string | null | undefined;
    readonly reviewRequired?: boolean;
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
    metadataJson: input.metadataJson ? String(input.metadataJson) : null,
    path,
    reviewRequired: Boolean(input.reviewRequired),
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
    interviewPrepGeneration: row.interview_prep_generation ?? null,
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
