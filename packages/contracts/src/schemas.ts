import { z } from "zod";

export const STAGES = ["discover", "enrich", "score", "tailor", "cover", "apply"] as const;
export type Stage = (typeof STAGES)[number];
export const PIPELINE_RUN_STAGES = ["discover", "score", "tailor", "cover", "apply"] as const;
export type PipelineRunStage = (typeof PIPELINE_RUN_STAGES)[number];
export const DEFAULT_PIPELINE_LLM_MODEL = "gemini:gemini-3.5-flash" as const;
export const PIPELINE_ACTION_JOB_KEY = "pipeline" as const;
export const MIN_TAILORING_FIT_SCORE = 6 as const;

export const MATERIAL_STAGES = ["tailor", "cover"] as const;
export type MaterialStage = (typeof MATERIAL_STAGES)[number];
export const PIPELINE_VALIDATION_MODES = ["strict", "normal", "lenient"] as const;
export type PipelineValidationMode = (typeof PIPELINE_VALIDATION_MODES)[number];

export const STAGE_STATES = [
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "skipped",
  "exhausted",
  "canceled",
  "stale",
] as const;
export type StageState = (typeof STAGE_STATES)[number];
export const ACTIVE_STATES = [
  "unknown",
  "active",
  "closed",
  "expired",
  "removed",
  "location_incompatible",
] as const;
export type ActiveState = (typeof ACTIVE_STATES)[number];
export const JOB_DELETED_FILTERS = ["active", "closed", "deleted", "hidden", "all"] as const;
export type JobDeletedFilter = (typeof JOB_DELETED_FILTERS)[number];
export const JOB_APPLY_STATUS_FILTERS = ["all", "applied"] as const;
export type JobApplyStatusFilter = (typeof JOB_APPLY_STATUS_FILTERS)[number];

export const JOB_SORT_FIELDS = [
  "discovered_at",
  "title",
  "company",
  "source",
  "compensation_min_eur",
  "compensation_max_eur",
  "compensation_posted",
  "compensation_market",
  "compensation_warnings",
  "location",
  "fit_score",
  "current_stage",
  "current_state",
  "apply_status",
] as const;
export type JobSortField = (typeof JOB_SORT_FIELDS)[number];

export const ARTIFACT_SORT_FIELDS = ["created_at", "title", "company", "type", "status", "size_bytes"] as const;
export type ArtifactSortField = (typeof ARTIFACT_SORT_FIELDS)[number];

export const ACTIVITY_SORT_FIELDS = [
  "occurred_at",
  "event_id",
  "stage",
  "level",
  "event_type",
  "message",
] as const;
export type ActivitySortField = (typeof ACTIVITY_SORT_FIELDS)[number];

export const SortDirectionSchema = z.enum(["asc", "desc"]).default("desc").catch("desc");

const optionalText = z
  .string()
  .trim()
  .optional()
  .catch("")
  .transform((value) => value ?? "");

const optionalNumber = z.coerce.number().int().optional().catch(undefined);
const IsoTimestampSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    "Expected an ISO-8601 UTC timestamp.",
  )
  .refine((value) => isCanonicalizableUtcTimestamp(value), "Expected a valid UTC timestamp.")
  .transform((value) => new Date(value).toISOString());

function isCanonicalizableUtcTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, millis: string | undefined) => {
    return `.${(millis ?? "").padEnd(3, "0")}Z`;
  });
  return new Date(timestamp).toISOString() === normalized;
}

export const RetryStageRequestSchema = z
  .object({
    stage: z.enum(STAGES),
    resetAttempts: z.boolean().default(false),
    runAfter: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  })
  .strict();
export type RetryStageRequest = z.infer<typeof RetryStageRequestSchema>;

export const RunJobStageRequestSchema = z
  .object({
    stage: z.enum(STAGES),
    dryRun: z.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(25).default(1),
    workers: z.coerce.number().int().min(1).max(16).default(1),
    minScore: z.coerce.number().int().min(0).max(10).default(7),
    validationMode: z.enum(PIPELINE_VALIDATION_MODES).default("normal"),
    llmModel: z.string().trim().min(1).max(120).default(DEFAULT_PIPELINE_LLM_MODEL),
  })
  .strict();
export type RunJobStageRequest = z.infer<typeof RunJobStageRequestSchema>;

export const ResetStaleScoresForRescoreRequestSchema = z
  .object({
    limit: z.coerce.number().int().min(0).max(500).default(0),
    jobKeys: z.array(z.string().trim().min(1)).max(5000).default([]),
  })
  .strict();
export type ResetStaleScoresForRescoreRequest = z.infer<
  typeof ResetStaleScoresForRescoreRequestSchema
>;
export interface ResetStaleScoresForRescoreResponse {
  ok: true;
  count: number;
  jobKeys: string[];
  nextAction: string;
}

export const RescoreJobRequestSchema = z
  .object({
    dryRun: z.boolean().default(false),
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type RescoreJobRequest = z.infer<typeof RescoreJobRequestSchema>;

export const RefreshCompensationRequestSchema = z
  .object({
    observationsJsonPath: z.string().trim().min(1).max(4000).optional(),
    includeEuroTopTech: z.boolean().optional(),
    euroTopTechMaxPages: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type RefreshCompensationRequest = z.infer<typeof RefreshCompensationRequestSchema>;

export const BulkRescoreJobsNotOnCurrentScoringPolicyRequestSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    jobKeys: z.array(z.string().trim().min(1)).max(5000).default([]),
    dryRun: z.boolean().default(false),
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type BulkRescoreJobsNotOnCurrentScoringPolicyRequest = z.infer<
  typeof BulkRescoreJobsNotOnCurrentScoringPolicyRequestSchema
>;

export const RetailorJobRequestSchema = z
  .object({
    dryRun: z.boolean().default(false),
    suppressExistingArtifacts: z.boolean().default(true),
    reason: z.string().trim().max(400).optional(),
    tailorModels: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
    tailorJudgeModel: z.string().trim().min(1).max(120).optional(),
    tailorJudgeMinScore: z.coerce.number().min(0).max(1).optional(),
  })
  .strict();
export type RetailorJobRequest = z.infer<typeof RetailorJobRequestSchema>;

export const TailorJobRequestSchema = z
  .object({
    dryRun: z.boolean().default(false),
    reason: z.string().trim().max(400).optional(),
    tailorModels: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
    tailorJudgeModel: z.string().trim().min(1).max(120).optional(),
    tailorJudgeMinScore: z.coerce.number().min(0).max(1).optional(),
  })
  .strict();
export type TailorJobRequest = z.infer<typeof TailorJobRequestSchema>;

export const BulkRetailorCurrentPolicyRequestSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    jobKeys: z.array(z.string().trim().min(1)).max(5000).default([]),
    dryRun: z.boolean().default(false),
    suppressExistingArtifacts: z.boolean().default(true),
    reason: z.string().trim().max(400).optional(),
    tailorModels: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
    tailorJudgeModel: z.string().trim().min(1).max(120).optional(),
    tailorJudgeMinScore: z.coerce.number().min(0).max(1).optional(),
  })
  .strict();
export type BulkRetailorCurrentPolicyRequest = z.infer<typeof BulkRetailorCurrentPolicyRequestSchema>;

export const GenerateMaterialsRequestSchema = z
  .object({
    stages: z.array(z.enum(MATERIAL_STAGES)).min(1).default(["tailor", "cover"]),
    dryRun: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(1),
  })
  .strict();
export type GenerateMaterialsRequest = z.infer<typeof GenerateMaterialsRequestSchema>;

export const ApplyJobRequestSchema = z
  .object({
    dryRun: z.boolean().default(true),
    headless: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(1),
    model: z.string().trim().min(1).max(80).default("default"),
  })
  .strict();
export type ApplyJobRequest = z.infer<typeof ApplyJobRequestSchema>;

export const APPLY_REVIEW_DECISION_VALUES = [
  "approve_submit",
  "approve_dry_run",
  "defer",
  "decline",
  "reset",
] as const;
export type ApplyReviewDecisionValue = (typeof APPLY_REVIEW_DECISION_VALUES)[number];

export const ApplyReviewDecisionRequestSchema = z
  .object({
    decision: z.enum(APPLY_REVIEW_DECISION_VALUES),
    reason: z.string().trim().max(400).optional(),
    decidedBy: z.string().trim().min(1).max(120).default("user"),
  })
  .strict();
export type ApplyReviewDecisionRequest = z.infer<typeof ApplyReviewDecisionRequestSchema>;

export interface ApplyReviewDecision {
  decisionId: string;
  jobKey: string;
  decision: ApplyReviewDecisionValue;
  reason: string | null;
  decidedBy: string;
  decidedAt: string;
}

export interface ApplyReviewDecisionResponse {
  ok: true;
  decision: ApplyReviewDecision;
}

export interface ApplyReviewIdealRequirement {
  id: string;
  text: string;
  tier: string | null;
  weight: number | null;
  evidence: string | null;
  fit: RequirementFitStatus | null;
  contribution: RequirementScoreContribution | null;
  tailoring: RequirementTailoringDirective | null;
  coverage: {
    state:
      | "covered"
      | "missing_from_resume"
      | "missing_from_profile"
      | "not_covered"
      | "not_recorded";
    source: "tailored_resume_bullet_provenance";
    bulletCount: number;
    examples: string[];
  };
}

export interface ApplyReviewPositionEvidence {
  descriptionPreview: string;
  idealCandidate: string | null;
  idealRequirements: ApplyReviewIdealRequirement[];
  requirements: string[];
  matched: string[];
  missing: string[];
  transferable: string[];
  keywords: string[];
}

export interface ApplyReviewProfileSourceField {
  path: string;
  label: string;
  value: string;
  section: string;
}

export interface ApplyReviewMaterialsPreview {
  resumeText: string | null;
  resumeTextArtifactId: string | null;
  resumePdfArtifactId: string | null;
  profileSourceFields: ApplyReviewProfileSourceField[];
  coverLetterText: string | null;
}

export const APPLY_AUDIT_STATES = ["ready", "preparing", "blocked", "repair"] as const;
export type ApplyAuditState = (typeof APPLY_AUDIT_STATES)[number];

export const APPLY_AUDIT_FACT_SEVERITIES = [
  "success",
  "info",
  "warning",
  "blocking",
  "unknown",
] as const;
export type ApplyAuditFactSeverity = (typeof APPLY_AUDIT_FACT_SEVERITIES)[number];

export const APPLY_AUDIT_SOURCE_STATUSES = [
  "present",
  "missing",
  "unknown",
  "not_applicable",
] as const;
export type ApplyAuditSourceStatus = (typeof APPLY_AUDIT_SOURCE_STATUSES)[number];

export interface ApplyAuditFact {
  code: string;
  label: string;
  detail: string | null;
  severity: ApplyAuditFactSeverity;
  source: string;
}

export interface ApplyAuditSource {
  kind: string;
  label: string;
  status: ApplyAuditSourceStatus;
  detail: string | null;
}

export interface ApplyAudit {
  state: ApplyAuditState;
  label: string;
  summary: string;
  reviewEvidenceAvailable: boolean;
  missingPrerequisites: ApplyAuditFact[];
  hardBlockers: ApplyAuditFact[];
  eligibilityConcerns: ApplyAuditFact[];
  sources: ApplyAuditSource[];
}

export interface ApplyReviewQueueItem {
  jobKey: string;
  title: string;
  company: string;
  source: string;
  compensationSummary: JobCompensationSummary | null;
  fitScore: number | null;
  scoreBreakdown: ScoreBreakdown | null;
  scoreKeywords: string[];
  scoreReasoning: string;
  scoreVersion: number | null;
  scoredAt: string | null;
  scoreCriteria: ScoringCriteriaSnapshot | null;
  scoreTrace: ScoreTrace | null;
  applicationUrl: string | null;
  currentStage: Stage;
  currentState: StageState;
  materials: {
    hasResume: boolean;
    hasCoverLetter: boolean;
    hasPdf: boolean;
    ready: boolean;
  };
  applyAudit: ApplyAudit;
  position: ApplyReviewPositionEvidence;
  materialsPreview: ApplyReviewMaterialsPreview;
  latestApplyRun: {
    runId: string;
    status: string;
    result: string | null;
    dryRun: boolean;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
  review: {
    state: "pending" | "approved_submit" | "approved_dry_run" | "deferred" | "declined";
    decision: ApplyReviewDecisionValue | null;
    decidedAt: string | null;
  };
  blockers: string[];
}

export interface ApplyReviewQueueResponse {
  ok: true;
  items: ApplyReviewQueueItem[];
}

export const APPLICATION_OUTCOME_KINDS = [
  "applied_confirmation",
  "recruiter_reply",
  "interview",
  "assessment",
  "rejection",
  "offer",
  "withdrawn",
  "bounced",
  "no_response",
  "unknown",
] as const;
export type ApplicationOutcomeKind = (typeof APPLICATION_OUTCOME_KINDS)[number];

export const APPLICATION_OUTCOME_SOURCES = ["manual", "email_suggestion"] as const;
export type ApplicationOutcomeSource = (typeof APPLICATION_OUTCOME_SOURCES)[number];

export const ManualApplicationOutcomeRequestSchema = z
  .object({
    kind: z.enum(APPLICATION_OUTCOME_KINDS),
    occurredAt: IsoTimestampSchema.optional(),
    note: z.string().trim().max(4000).optional(),
  })
  .strict();
export type ManualApplicationOutcomeRequest = z.infer<typeof ManualApplicationOutcomeRequestSchema>;

export interface ApplicationOutcome {
  outcomeId: string;
  jobKey: string;
  kind: ApplicationOutcomeKind;
  source: ApplicationOutcomeSource;
  note: string | null;
  occurredAt: string;
  recordedAt: string;
  suggestionId: string | null;
  evidenceId: string | null;
}

export interface ApplicationOutcomeWriteResponse {
  ok: true;
  outcome: ApplicationOutcome;
}

export const OUTCOME_SUGGESTION_STATUSES = [
  "pending",
  "accepted",
  "corrected",
  "ignored",
] as const;
export type OutcomeSuggestionStatus = (typeof OUTCOME_SUGGESTION_STATUSES)[number];

export interface ApplicationEmailEvidence {
  evidenceId: string;
  jobKey: string;
  provider: "gmail";
  providerMessageId: string;
  providerThreadId: string | null;
  fromAddress: string | null;
  toAddresses: string[];
  subject: string | null;
  snippet: string | null;
  receivedAt: string | null;
  linkedAt: string;
  linkConfidence: number;
  bodySha256: string | null;
  bodyStoredAt: string | null;
}

export interface OutcomeSuggestion {
  suggestionId: string;
  jobKey: string;
  evidenceId: string | null;
  suggestedKind: ApplicationOutcomeKind;
  confidence: number;
  rationale: string;
  status: OutcomeSuggestionStatus;
  createdAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  decidedOutcomeId: string | null;
}

export const OutcomeSuggestionDecisionRequestSchema = z
  .object({
    decision: z.enum(["accept", "correct", "ignore"]),
    outcomeKind: z.enum(APPLICATION_OUTCOME_KINDS).optional(),
    occurredAt: IsoTimestampSchema.optional(),
    note: z.string().trim().max(4000).optional(),
    reason: z.string().trim().max(400).optional(),
  })
  .strict()
  .refine((value) => value.decision !== "correct" || value.outcomeKind !== undefined, {
    message: "outcomeKind is required when correcting a suggestion.",
    path: ["outcomeKind"],
  });
export type OutcomeSuggestionDecisionRequest = z.infer<
  typeof OutcomeSuggestionDecisionRequestSchema
>;

export interface OutcomeSuggestionDecisionResponse {
  ok: true;
  suggestion: OutcomeSuggestion;
  outcome: ApplicationOutcome | null;
}

export interface ApplicationOutcomeListResponse {
  ok: true;
  outcomes: ApplicationOutcome[];
  suggestions: OutcomeSuggestion[];
}

export interface JobApplicationOutcomeListResponse extends ApplicationOutcomeListResponse {
  jobKey: string;
}

export const GmailOutcomeScanRequestSchema = z
  .object({
    recipientEmail: z.string().trim().email().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    maxResultsPerAnchor: z.coerce.number().int().min(1).max(20).default(5),
    windowDays: z.coerce.number().int().min(1).max(180).default(45),
  })
  .strict();
export type GmailOutcomeScanRequest = z.input<typeof GmailOutcomeScanRequestSchema>;

export interface GmailOutcomeScanEvidenceSummary {
  evidenceId: string;
  jobKey: string;
  providerMessageId: string;
  linkConfidence: number;
}

export interface GmailOutcomeScanSuggestionSummary {
  suggestionId: string;
  evidenceId: string;
  jobKey: string;
  kind: ApplicationOutcomeKind;
  confidence: number;
}

export interface GmailOutcomeScanResponse {
  ok: true;
  scannedAnchorCount: number;
  searchedMessageCount: number;
  linkedEvidenceCount: number;
  suggestionsCreatedCount: number;
  duplicateMessageCount: number;
  unlinkedCandidateCount: number;
  evidence: GmailOutcomeScanEvidenceSummary[];
  suggestions: GmailOutcomeScanSuggestionSummary[];
}

export const RunPipelineStagesRequestSchema = z
  .object({
    stages: z.array(z.enum(PIPELINE_RUN_STAGES)).min(1).max(PIPELINE_RUN_STAGES.length),
    limit: z.coerce.number().int().min(1).max(1000).default(25),
    workers: z.coerce.number().int().min(1).max(16).default(1),
    minScore: z.coerce.number().int().min(0).max(10).default(7),
    validationMode: z.enum(PIPELINE_VALIDATION_MODES).default("normal"),
    dryRun: z.boolean().default(true),
    rescore: z.boolean().default(false),
    retailor: z.boolean().default(false),
    headless: z.boolean().default(false),
    model: z.string().trim().min(1).max(80).default("default"),
    llmModel: z.string().trim().min(1).max(120).default(DEFAULT_PIPELINE_LLM_MODEL),
    tailorModels: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
    tailorJudgeModel: z.string().trim().min(1).max(120).optional(),
    tailorJudgeMinScore: z.coerce.number().min(0).max(1).optional(),
    continuous: z.boolean().default(false),
  })
  .strict()
  .refine((value) => new Set(value.stages).size === value.stages.length, {
    message: "stages must be unique.",
    path: ["stages"],
  });
export type RunPipelineStagesRequest = z.infer<typeof RunPipelineStagesRequestSchema>;

export const CancelJobActionRequestSchema = z
  .object({
    runId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
export type CancelJobActionRequest = z.infer<typeof CancelJobActionRequestSchema>;

export const MarkJobActionRequestSchema = z
  .object({
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type MarkJobActionRequest = z.infer<typeof MarkJobActionRequestSchema>;

export const DeleteJobRequestSchema = z
  .object({
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type DeleteJobRequest = z.infer<typeof DeleteJobRequestSchema>;

export const BulkJobMutationFilterSchema = z
  .object({
    q: optionalText,
    stage: z.enum(STAGES).optional().catch(undefined),
    state: z.enum(STAGE_STATES).optional().catch(undefined),
    deleted: z.enum(JOB_DELETED_FILTERS).default("active").catch("active"),
    applyStatus: z.enum(JOB_APPLY_STATUS_FILTERS).default("all").catch("all"),
    source: optionalText,
    company: optionalText,
    minFitScore: optionalNumber,
    maxFitScore: optionalNumber,
  })
  .strict();
export type BulkJobMutationFilter = z.infer<typeof BulkJobMutationFilterSchema>;

const BulkJobMutationRequestBaseSchema = z.object({
  jobKeys: z.array(z.string().trim().min(1)).max(5000).default([]),
  allMatching: z.boolean().default(false),
  filter: BulkJobMutationFilterSchema.optional(),
  reason: z.string().trim().max(400).optional(),
});

export const BulkJobMutationRequestSchema = BulkJobMutationRequestBaseSchema
  .strict()
  .refine((value) => value.allMatching || value.jobKeys.length > 0, {
    message: "Provide jobKeys or set allMatching.",
  });
export type BulkJobMutationRequest = z.infer<typeof BulkJobMutationRequestSchema>;

export const BulkRetryFailedRequestSchema = BulkJobMutationRequestBaseSchema
  .extend({
    runAfter: z.boolean().default(false),
    workers: z.coerce.number().int().min(1).max(16).default(1),
    minScore: z.coerce.number().int().min(0).max(10).default(7),
    validationMode: z.enum(PIPELINE_VALIDATION_MODES).default("normal"),
    dryRun: z.boolean().default(false),
    llmModel: z.string().trim().min(1).max(120).default(DEFAULT_PIPELINE_LLM_MODEL),
  })
  .strict()
  .refine((value) => value.allMatching || value.jobKeys.length > 0, {
    message: "Provide jobKeys or set allMatching.",
  });
export type BulkRetryFailedRequest = z.infer<typeof BulkRetryFailedRequestSchema>;

export const BulkRunPendingPreparationRequestSchema = BulkJobMutationRequestBaseSchema
  .extend({
    workers: z.coerce.number().int().min(1).max(16).default(1),
    minScore: z.coerce.number().int().min(0).max(10).default(7),
    validationMode: z.enum(PIPELINE_VALIDATION_MODES).default("normal"),
    dryRun: z.boolean().default(false),
    llmModel: z.string().trim().min(1).max(120).default(DEFAULT_PIPELINE_LLM_MODEL),
  })
  .strict()
  .refine((value) => value.allMatching || value.jobKeys.length > 0, {
    message: "Provide jobKeys or set allMatching.",
  });
export type BulkRunPendingPreparationRequest = z.infer<typeof BulkRunPendingPreparationRequestSchema>;

// ---------------------------------------------------------------------------
// Profile schemas — mirror packages/domain-types/src/profile/profile.ts
//
// Wire format keeps the snake_case JSON shape from the Python aggregate's
// ``to_dict()`` output so the API ↔ worker boundary is one schema, not two.
// Field names match the JSON,
// not the camelCase TS interfaces.
// ---------------------------------------------------------------------------

export const TAILORING_MODES = ["strict", "balanced", "aggressive"] as const;
export const CLAIM_MODES = ["verified_only", "evidence_reframing", "adjacent_translation", "draft_requires_confirmation"] as const;
export const AUTO_APPROVABLE_CLAIM_MODES = ["verified_only", "evidence_reframing"] as const;
export const EVIDENCE_STRENGTHS = ["verified", "supported", "inferred", "draft"] as const;
export const WRITING_TONES = ["direct", "executive", "technical", "confident", "warm"] as const;
export const BULLET_STYLES = ["balanced", "impact", "technical_depth", "leadership"] as const;
export const VERBOSITY_LEVELS = ["concise", "balanced", "detailed"] as const;
export const KEYWORD_DENSITIES = ["natural", "moderate", "high"] as const;

const ProfilePersonalSchema = z
  .object({
    full_name: z.string().default(""),
    preferred_name: z.string().default(""),
    email: z.string().default(""),
    phone: z.string().default(""),
    address: z.string().default(""),
    city: z.string().default(""),
    province_state: z.string().default(""),
    country: z.string().default(""),
    postal_code: z.string().default(""),
    linkedin_url: z.string().default(""),
    github_url: z.string().default(""),
    portfolio_url: z.string().default(""),
    website_url: z.string().default(""),
    password: z.string().default(""),
  })
  .partial();

const ProfileWorkAuthSchema = z
  .object({
    legally_authorized_to_work: z.string().default(""),
    require_sponsorship: z.string().default(""),
    work_permit_type: z.string().default(""),
  })
  .partial();

const ProfileCompensationSchema = z
  .object({
    salary_expectation: z.string().default(""),
    salary_currency: z.string().default("USD"),
    salary_range_min: z.string().default(""),
    salary_range_max: z.string().default(""),
    currency_conversion_note: z.string().default(""),
  })
  .partial();

const ProfileAvailabilitySchema = z
  .object({
    earliest_start_date: z.string().default(""),
    available_for_full_time: z.string().default(""),
    available_for_contract: z.string().default(""),
  })
  .partial();

const ProfileExperienceMetadataSchema = z
  .object({
    years_of_experience_total: z.string().default(""),
    education_level: z.string().default(""),
    current_job_title: z.string().default(""),
    current_company: z.string().default(""),
    target_role: z.string().default(""),
    target_track: z.string().default(""),
    target_seniority_floor: z.string().default(""),
    target_functions: z.string().default(""),
    target_specializations: z.string().default(""),
    target_locations: z.string().default(""),
    target_work_models: z.string().default(""),
  })
  .partial();

const ProfileEeoSchema = z
  .object({
    gender: z.string().default("Decline to self-identify"),
    race_ethnicity: z.string().default("Decline to self-identify"),
    veteran_status: z.string().default("Decline to self-identify"),
    disability_status: z.string().default("Decline to self-identify"),
  })
  .partial();

const ProfileAchievementEvidenceSchema = z.object({
  id: z.string().default(""),
  source_text: z.string().default(""),
  scope: z.string().default(""),
  action: z.string().default(""),
  tools: z.array(z.string()).default([]),
  metrics: z.array(z.string()).default([]),
  outcome: z.string().default(""),
  seniority_signal: z.string().default(""),
  evidence_strength: z.enum(EVIDENCE_STRENGTHS).default("supported"),
  claim_confidence: z.number().min(0).max(1).default(0),
  user_confirmed: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
});

const ProfileExperienceEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  company: z.string().min(1),
  date_range: z.string().default(""),
  location: z.string().default(""),
  bullets: z.array(z.string()).default([]),
  achievement_evidence: z.array(ProfileAchievementEvidenceSchema).default([]),
});

const ProfileEducationEntrySchema = z.object({
  id: z.string().min(1),
  degree: z.string().default(""),
  institution: z.string().default(""),
  location: z.string().default(""),
  date: z.string().default(""),
});

const ProfileSkillCategorySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  items: z.array(z.string()).default([]),
});

const ProfileTailoringPolicySchema = z
  .object({
    mode: z.enum(TAILORING_MODES).default("balanced"),
    allow_title_reframing: z.boolean().default(false),
    allow_achievement_rewriting: z.boolean().default(true),
    allow_skill_reordering: z.boolean().default(true),
    allow_summary_rewrite: z.boolean().default(true),
    allow_minor_inference: z.boolean().default(false),
    claim_mode: z.enum(CLAIM_MODES).default("evidence_reframing"),
    auto_approvable_claim_modes: z.array(z.enum(CLAIM_MODES)).default(["verified_only", "evidence_reframing"]),
    allow_adjacent_achievement_drafts: z.boolean().default(false),
  })
  .partial()
  .default({})
  .transform((policy) => normalizeProfileTailoringPolicy(policy));

function normalizeProfileTailoringPolicy(policy: {
  mode?: (typeof TAILORING_MODES)[number] | undefined;
  allow_title_reframing?: boolean | undefined;
  allow_achievement_rewriting?: boolean | undefined;
  allow_skill_reordering?: boolean | undefined;
  allow_summary_rewrite?: boolean | undefined;
  allow_minor_inference?: boolean | undefined;
  claim_mode?: (typeof CLAIM_MODES)[number] | undefined;
  auto_approvable_claim_modes?: Array<(typeof CLAIM_MODES)[number]> | undefined;
  allow_adjacent_achievement_drafts?: boolean | undefined;
}) {
  const mode = policy.mode ?? "balanced";
  const autoApprovable = (policy.auto_approvable_claim_modes ?? ["verified_only", "evidence_reframing"]).filter(
    (claimMode): claimMode is (typeof AUTO_APPROVABLE_CLAIM_MODES)[number] =>
      (AUTO_APPROVABLE_CLAIM_MODES as readonly string[]).includes(claimMode),
  );
  const normalized = {
    mode,
    allow_title_reframing: policy.allow_title_reframing ?? false,
    allow_achievement_rewriting: policy.allow_achievement_rewriting ?? true,
    allow_skill_reordering: policy.allow_skill_reordering ?? true,
    allow_summary_rewrite: policy.allow_summary_rewrite ?? true,
    allow_minor_inference: policy.allow_minor_inference ?? false,
    claim_mode: policy.claim_mode ?? "evidence_reframing",
    auto_approvable_claim_modes: autoApprovable.length
      ? autoApprovable
      : (["verified_only", "evidence_reframing"] as const),
    allow_adjacent_achievement_drafts:
      mode === "aggressive" && (policy.allow_adjacent_achievement_drafts ?? false),
  };
  if (mode !== "strict") {
    return normalized;
  }
  return {
    ...normalized,
    allow_title_reframing: false,
    allow_achievement_rewriting: false,
    allow_skill_reordering: false,
    allow_summary_rewrite: false,
    allow_minor_inference: false,
    claim_mode: "verified_only" as const,
    auto_approvable_claim_modes: ["verified_only"] as const,
    allow_adjacent_achievement_drafts: false,
  };
}

const ProfileWritingStyleSchema = z
  .object({
    tone: z.enum(WRITING_TONES).default("direct"),
    bullet_style: z.enum(BULLET_STYLES).default("balanced"),
    verbosity: z.enum(VERBOSITY_LEVELS).default("balanced"),
    keyword_density: z.enum(KEYWORD_DENSITIES).default("natural"),
    avoid_first_person: z.boolean().default(true),
  })
  .partial();

const ProfileTailoringRulesSchema = z
  .object({
    required_experience_entry_ids: z.array(z.string()).default([]),
    required_education_entry_ids: z.array(z.string()).default([]),
    required_skill_category_ids: z.array(z.string()).default([]),
    required_bullets_by_experience_id: z.record(z.string(), z.array(z.string())).default({}),
    required_skills_by_category_id: z.record(z.string(), z.array(z.string())).default({}),
    max_experience_bullets: z.number().int().positive().default(4),
    custom_tailoring_prompt: z.string().default(""),
    tailoring_policy: ProfileTailoringPolicySchema,
    writing_style: ProfileWritingStyleSchema.default({}),
  })
  .partial();

const ProfileResumeMasterSchema = z.object({
  executive_profile: z
    .object({ baseline_text: z.string().default("") })
    .partial()
    .default({}),
  experience_entries: z.array(ProfileExperienceEntrySchema).min(1, {
    message: "profile.resume.experience_entries must contain at least one entry.",
  }),
  education_entries: z.array(ProfileEducationEntrySchema).default([]),
  skill_categories: z.array(ProfileSkillCategorySchema).default([]),
  tailoring_rules: ProfileTailoringRulesSchema.default({}),
});

const ProfileResumeConstraintsSchema = z
  .object({
    real_metrics: z.array(z.string()).default([]),
  })
  .partial();

/** Canonical profile shape. ``passthrough()`` preserves forward-compatible
 * keys we don't yet model so a round-trip never silently drops data. */
export const ProfileSchema = z
  .object({
    personal: ProfilePersonalSchema.default({}),
    work_authorization: ProfileWorkAuthSchema.default({}),
    availability: ProfileAvailabilitySchema.default({}),
    compensation: ProfileCompensationSchema.default({}),
    experience: ProfileExperienceMetadataSchema.default({}),
    eeo_voluntary: ProfileEeoSchema.default({}),
    resume: ProfileResumeMasterSchema,
    resume_constraints: ProfileResumeConstraintsSchema.default({}),
  })
  .passthrough();

export type ProfileShape = z.infer<typeof ProfileSchema>;

export const ProfileUpdateRequestSchema = z
  .object({
    profile: z.unknown().optional(),
    profileText: z.string().optional(),
    style: z.unknown().optional(),
    styleText: z.string().optional(),
    templateText: z.string().optional(),
  })
  .strict();
export type ProfileUpdateRequest = z.infer<typeof ProfileUpdateRequestSchema>;

export const ProfileImportRequestSchema = z
  .object({
    filename: z.string().trim().min(1).max(260).default("resume.pdf"),
    pdfBase64: z.string().min(1),
    importProfile: z.boolean().default(true),
    importStyle: z.boolean().default(true),
  })
  .strict();
export type ProfileImportRequest = z.infer<typeof ProfileImportRequestSchema>;

export const SettingsUpdateRequestSchema = z
  .object({
    targetRole: z.string().trim().max(240).optional(),
    locationFilter: z.string().trim().max(240).optional(),
    minFitScore: z.coerce.number().int().min(0).max(10).optional(),
    autoApply: z.boolean().optional(),
    applyConcurrency: z.coerce.number().int().min(1).max(16).optional(),
    scoreCriteria: z.string().max(8000).optional(),
    targetCriteria: z.string().max(8000).optional(),
  })
  .strict();
export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequestSchema>;

export const CredentialKeys = ["OPENAI_API_KEY", "GEMINI_API_KEY", "LLM_URL"] as const;
export type CredentialKey = (typeof CredentialKeys)[number];

export const CredentialUpdateRequestSchema = z
  .object({
    key: z.enum(CredentialKeys),
    value: z.string().min(1).max(8000),
  })
  .strict();
export type CredentialUpdateRequest = z.infer<typeof CredentialUpdateRequestSchema>;

export const JobListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).catch(1),
    pageSize: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
    page_size: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
    sort: z.enum(JOB_SORT_FIELDS).default("discovered_at").catch("discovered_at"),
    dir: SortDirectionSchema,
    q: optionalText,
    stage: z.enum(STAGES).optional().catch(undefined),
    state: z.enum(STAGE_STATES).optional().catch(undefined),
    deleted: z.enum(JOB_DELETED_FILTERS).default("active").catch("active"),
    applyStatus: z.enum(JOB_APPLY_STATUS_FILTERS).default("all").catch("all"),
    source: optionalText,
    company: optionalText,
    minFitScore: optionalNumber,
    maxFitScore: optionalNumber,
  })
  .transform((value) => ({
    ...value,
    pageSize: value.pageSize ?? value.page_size ?? 50,
  }));

export type JobListQuery = z.infer<typeof JobListQuerySchema>;

export const ArtifactListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).catch(1),
    pageSize: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
    page_size: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
    sort: z.enum(ARTIFACT_SORT_FIELDS).default("created_at").catch("created_at"),
    dir: SortDirectionSchema,
    q: optionalText,
    status: optionalText,
    type: optionalText,
  })
  .transform((value) => ({
    ...value,
    pageSize: value.pageSize ?? value.page_size ?? 50,
  }));

export type ArtifactListQuery = z.infer<typeof ArtifactListQuerySchema>;

export const ActivityListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).catch(1),
    pageSize: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
    page_size: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
    sort: z.enum(ACTIVITY_SORT_FIELDS).default("occurred_at").catch("occurred_at"),
    dir: SortDirectionSchema,
    q: optionalText,
    level: optionalText,
    stage: optionalText,
    eventType: optionalText,
    event_type: optionalText,
  })
  .transform((value) => ({
    page: value.page,
    pageSize: value.pageSize ?? value.page_size ?? 50,
    sort: value.sort,
    dir: value.dir,
    q: value.q,
    level: value.level,
    stage: value.stage,
    eventType: value.eventType || value.event_type,
  }));

export type ActivityListQuery = z.infer<typeof ActivityListQuerySchema>;

// ---------------------------------------------------------------------------
// Workflow runs (PR 5 of the Temporal stack)
//
// `apply_run_projections` is the unified workflow-run row after PR 4. The
// run id is the Temporal workflow id (see `ApplyWorkflow.run` —
// `run_id=info.workflow_id`), so the deep-link uses it verbatim.
// `WorkflowRunStatusSchema` widens beyond `ApplyRunStatus` so future non-
// apply workflows can land here without another migration.
// ---------------------------------------------------------------------------

export const WORKFLOW_RUN_STATUSES = [
  "starting",
  "in_progress",
  "succeeded",
  "failed",
  "canceled",
  "terminated",
  "timed_out",
  "dry_run_complete",
  "captcha",
  "login_issue",
  "expired",
  "manual",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKFLOW_RUN_STATUS_FILTERS = ["all", ...WORKFLOW_RUN_STATUSES] as const;
export type WorkflowRunStatusFilter = (typeof WORKFLOW_RUN_STATUS_FILTERS)[number];

export const WORKFLOW_RUN_SORT_FIELDS = [
  "started_at",
  "finished_at",
  "duration_ms",
  "title",
  "company",
  "status",
  "model",
  "dry_run",
] as const;
export type WorkflowRunSortField = (typeof WORKFLOW_RUN_SORT_FIELDS)[number];

export const WorkflowRunsListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).catch(1),
    pageSize: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
    page_size: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
    status: z.enum(WORKFLOW_RUN_STATUS_FILTERS).default("all").catch("all"),
    sort: z.enum(WORKFLOW_RUN_SORT_FIELDS).default("started_at").catch("started_at"),
    dir: SortDirectionSchema,
  })
  .transform((value) => ({
    page: value.page,
    pageSize: value.pageSize ?? value.page_size ?? 50,
    status: value.status,
    sort: value.sort,
    dir: value.dir,
  }));
export type WorkflowRunsListQuery = z.infer<typeof WorkflowRunsListQuerySchema>;

export interface WorkflowRunSummary {
  /** Temporal workflow id — drives the deep-link to the Temporal Web UI. */
  readonly workflowId: string;
  /**
   * Logical run id surfaced by the read-model. Equal to `workflowId` for
   * apply runs (the Python `ApplyWorkflow` sets `run_id = info.workflow_id`);
   * preserved as a distinct field so future non-apply workflows that key
   * timeline events on a different id keep working.
   */
  readonly runId: string;
  readonly jobKey: string;
  readonly title: string;
  readonly company: string;
  readonly status: WorkflowRunStatus;
  readonly result: string | null;
  readonly dryRun: boolean;
  readonly model: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
}

export interface StageSummary {
  stage: Stage;
  state: StageState;
  attemptCount: number;
  maxAttempts: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  blockedBy: string[];
  nextAction: string | null;
}

export interface ScoreBreakdown {
  technicalFit: number;
  experienceFit: number;
  roleFit: number;
  reasoning: string;
  fitBand: "excellent" | "strong" | "plausible" | "stretch" | "poor";
  confidence: "high" | "medium" | "low";
  eligibility: ScoreEligibility;
  matchedSignals: string[];
  missingSignals: string[];
  transferableSignals: string[];
}

export interface ScoreEligibility {
  status: "eligible" | "warning" | "blocked" | "unknown";
  hardBlockers: string[];
  warnings: string[];
}

export type RequirementFitStatus =
  | {
      kind: "matched";
      evidenceIds: string[];
      strength: "direct" | "strong";
    }
  | {
      kind: "transferable";
      evidenceIds: string[];
      gap: string;
      bridge: string;
    }
  | {
      kind: "missing";
      reason: string;
    }
  | {
      kind: "blocked";
      blocker: string;
    }
  | {
      kind: "not_assessed";
      reason: string;
    };

export interface RequirementScoreContribution {
  maxPoints: number;
  awardedPoints: number;
  weightedImpact: number;
  rationale: string;
}

export interface RequirementTailoringDirective {
  action: "double_down" | "bridge_gap" | "avoid_claim" | "low_priority";
  priority: number;
  allowedEvidenceIds: string[];
  targetKeywords: string[];
  prohibitedClaims: string[];
  instruction: string;
}

export interface RequirementArtifactCoverage {
  state:
    | "covered"
    | "missing_from_resume"
    | "missing_from_profile"
    | "not_covered"
    | "not_recorded";
  source: "tailored_resume_bullet_provenance";
  bulletCount: number;
  examples: string[];
}

export interface RequirementFitAssessment {
  requirementId: string;
  requirementText: string;
  tier: "must_have" | "nice_to_have";
  weight: number;
  jobEvidenceSpan: string;
  fit: RequirementFitStatus;
  contribution: RequirementScoreContribution;
  tailoring: RequirementTailoringDirective;
  artifactCoverage: RequirementArtifactCoverage | null;
}

export interface RequirementFitSummary {
  weightedFit: number;
  mustHaveCoverage: number;
  blockerCount: number;
  missingHighWeightCount: number;
}

export interface RequirementFitReport {
  jobKey: string;
  scoreVersion: number;
  employerAnalysisGeneration: number;
  profileSnapshotVersion: number;
  scoringPolicyVersion: number;
  formulaVersion: string;
  resolvedFitScore: number | null;
  fitBand: "excellent" | "strong" | "plausible" | "stretch" | "poor";
  confidence: "high" | "medium" | "low";
  summary: RequirementFitSummary;
  assessments: RequirementFitAssessment[];
}

export interface ScoringCriteriaSnapshot {
  minFitScore: number;
  criteriaText: string;
  targetCriteria: string;
  criteriaVersion: string;
}

export interface ScoreTrace {
  promptVersion: string;
  schemaVersion: string;
  model: string;
  criteriaVersion: string;
  profileSnapshotVersion: number;
  scoringPolicyId: string;
  scoringPolicyVersion: number;
  rubricVersion: string;
  rawWeightedScore: number | null;
  calibrationAdjustment: number;
  policyAnchorCount: number;
  resolvedFitBand: string;
  resolutionReason: string;
  parserWarnings: string[];
  correctionHistory: ScoreCorrection[];
}

export interface ScoreCorrection {
  originalScore?: number;
  correctedScore: number;
  rationale: string;
  correctedBy: string;
  correctedAt: string;
}

export interface ScoreStaleness {
  isStale: boolean;
  staleReason: string | null;
  currentPolicyVersion: number | null;
  targetPolicyVersion: number | null;
  markedAt: string | null;
  pendingExplicitRescore: boolean;
}

export interface JobCompensationRangeSummary {
  currency: string | null;
  period: string;
  component: string;
  minimumAmount: number | null;
  maximumAmount: number | null;
  annualizedMinimumAmount?: number | null;
  annualizedMaximumAmount?: number | null;
  annualizedMinimumEur?: number | null;
  annualizedMaximumEur?: number | null;
  displayRange: string | null;
}

export interface JobPostedCompensationSummary {
  sourceKind: "posted";
  recordStatus: "recorded" | "not_recorded";
  parseState: PostedCompensationParseState | null;
  confidence: PostedCompensationConfidence;
  warningCount: number;
  range: JobCompensationRangeSummary | null;
  displayRange: string | null;
}

export interface JobMarketCompensationSummary {
  sourceKind: "reported_company_role_market";
  recordStatus: "recorded" | "not_requested";
  estimateState: MarketCompensationEstimateState;
  confidenceBand: MarketCompensationConfidenceBand;
  confidenceScore: number | null;
  sourceCount: number;
  sampleCount: number | null;
  warningCount: number;
  range: JobCompensationRangeSummary | null;
  displayRange: string | null;
  confidenceInterval: JobCompensationRangeSummary | null;
  displayConfidenceInterval: string | null;
}

export interface JobCompensationSummary {
  projectionVersion: number;
  legacyRawSalary: string | null;
  warningCount: number;
  posted: JobPostedCompensationSummary;
  market: JobMarketCompensationSummary;
}

export interface JobCompensationAudit {
  projectionVersion: number;
  posted: PostedCompensationFactResponse;
  market: MarketCompensationEstimateResponse;
}

export interface JobSummary {
  jobKey: string;
  url: string;
  title: string;
  company: string;
  source: string;
  discoverySource: string;
  postingSource: string;
  postingSourceUrl: string | null;
  strategy: string;
  location: string;
  salary: string;
  compensationSummary: JobCompensationSummary | null;
  discoveredAt: string | null;
  applicationUrl: string | null;
  fitScore: number | null;
  scoreBreakdown: ScoreBreakdown | null;
  scoreKeywords: string[];
  scoreReasoning: string;
  scoreVersion: number | null;
  scoredAt: string | null;
  scoreCriteria: ScoringCriteriaSnapshot | null;
  scoreTrace: ScoreTrace | null;
  scoreCorrection: ScoreCorrection | null;
  scoreStaleness: ScoreStaleness;
  currentStage: Stage;
  currentSubstage: Stage;
  currentState: StageState;
  errorCode: string | null;
  errorMessage: string | null;
  nextAction: string | null;
  artifactCount: number;
  applyStatus: string | null;
  appliedAt: string | null;
  activeState: ActiveState;
  deletedAt: string | null;
  hiddenAt: string | null;
}

export interface ArtifactSummary {
  artifactId: string;
  jobKey: string;
  title: string;
  company: string;
  type: string;
  status: string;
  localPath: string;
  createdAt: string | null;
  sizeBytes: number | null;
  size: string;
}

export interface PaginatedResponse<T> {
  ok: true;
  items: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pages: number;
  };
  sort: {
    field: string;
    dir: "asc" | "desc";
  };
  filter: Record<string, unknown>;
}

export interface ActivityEventSummary {
  eventId: string;
  eventType: string;
  jobKey: string | null;
  title: string | null;
  company: string | null;
  stage: string;
  level: string;
  message: string;
  at: string | null;
}

export const JOB_AUDIT_CATEGORIES = [
  "discovery",
  "enrichment",
  "scoring",
  "materials",
  "apply",
  "outcome",
  "pipeline",
  "job",
] as const;
export type JobAuditCategory = (typeof JOB_AUDIT_CATEGORIES)[number];

export const JOB_AUDIT_TONES = ["info", "success", "warning", "danger", "muted"] as const;
export type JobAuditTone = (typeof JOB_AUDIT_TONES)[number];

export interface JobAuditDetail {
  label: string;
  value: string;
}

export interface JobAuditEntry {
  id: string;
  category: JobAuditCategory;
  tone: JobAuditTone;
  title: string;
  description: string | null;
  occurredAt: string | null;
  actor: string | null;
  details: JobAuditDetail[];
}

export interface ActivityEventResponse {
  ok: true;
  event: ActivityEventSummary;
}

export interface PipelineProgressSummary {
  stage: Stage;
  status: "running" | "succeeded" | "failed" | "partial";
  runId?: string;
  workflowId?: string;
  percent: number | null;
  completed: number;
  total: number;
  currentStep: string | null;
  message: string;
  sourceProgress?: {
    completed: number;
    total: number;
    unit: string | null;
    currentQuery: string | null;
    currentLocation: string | null;
    newJobs: number | null;
    existingJobs: number | null;
    filteredJobs: number | null;
    errorCount: number | null;
    rawTotal: number | null;
  };
  updatedAt: string | null;
}

export interface ApplyRunTimelineEventSummary {
  at: string | null;
  type: string;
  level: string;
  message: string | null;
}

export interface DashboardSummary {
  ok: true;
  generatedAt: string;
  totals: {
    jobs: number;
    jobsToday: number;
    failures: number;
    blocked: number;
    ready: number;
    applied: number;
    appliedToday: number;
    dryRuns: number;
  };
  preparation?: PreparationSummary;
  funnel: Array<{
    stage: Stage;
    total: number;
    succeeded: number;
    running: number;
    pending: number;
    blocked: number;
    failed: number;
  }>;
  activity: ActivityEventSummary[];
  progress: PipelineProgressSummary[];
  sourceHealth: SourceHealthSummary[];
  operationalMetrics: OperationalMetricsSummary;
  applyRuns: Array<{
    runId: string;
    jobKey: string;
    title: string;
    company: string;
    status: string;
    dryRun: boolean;
    startedAt: string | null;
    events: ApplyRunTimelineEventSummary[];
  }>;
}

export interface PreparationSummary {
  currentScoringPolicyVersion: number | null;
  currentTailoringPolicyVersion: number | null;
  outdatedScoreCount: number;
  outdatedTailoredArtifactCount: number;
  workItems: {
    queued: number;
    running: number;
    failed: number;
  };
}

export interface SourceHealthSummary {
  sourceId: string;
  recommendedState: string;
  runCount: number;
  failedRunCount: number;
  consecutiveFailures: number;
  observedJobs: number;
  newJobs: number;
  existingJobs: number;
  duplicateRate: number | null;
  activeVerificationRate: number | null;
  fullDescriptionSuccessRate: number | null;
  applyUrlSuccessRate: number | null;
  operationalFailureCount: number;
  scrapeFailureCount: number;
  retryableFailureCount: number;
  lastFailureCategory: string | null;
  lastRunId: string | null;
  lastErrorClass: string | null;
  updatedAt: string | null;
}

export interface OperationalMetricsSummary {
  attempts: number;
  failures: number;
  operationalFailures: number;
  scrapeFailures: number;
  retryableFailures: number;
  byStage: OperationalStageMetricSummary[];
  bySource: OperationalSourceMetricSummary[];
}

export interface OperationalStageMetricSummary {
  stage: string;
  attempts: number;
  failures: number;
  operationalFailures: number;
  scrapeFailures: number;
  retryableFailures: number;
  avgDurationMs: number | null;
  lastOutcome: string | null;
  lastFailureCategory: string | null;
  lastErrorClass: string | null;
}

export interface OperationalSourceMetricSummary extends OperationalStageMetricSummary {
  sourceId: string;
  adapter: string | null;
  sourceKind: string | null;
  sourcePriority: string | null;
  sourceRole: string | null;
  lastRunId: string | null;
}

/**
 * Phase 1 — the canonical employer-analysis read DTO served on JobDetail.
 *
 * Mirrors the Python ``EmployerAnalysis.to_read_model()`` projection: the
 * reconciled "ideal candidate" analysis plus the full ensemble audit trail
 * (per-model sub-analyses, per-leg failures, agreement signal, and the
 * degraded-ensemble completeness). Snake_case keys match the projection JSON.
 */
export interface EmployerAnalysisRequirement {
  id: string;
  text: string;
  tier: "must_have" | "nice_to_have";
  weight: number;
  evidence_span: string;
}

export interface EmployerAnalysisKeyword {
  keyword: string;
  evidence_span: string;
  requirement_ref: string | null;
  rationale: string;
  is_orphan: boolean;
}

export interface EmployerAnalysisAgreement {
  score: number;
  flagged_requirements: string[];
  flagged_keywords: string[];
}

export interface EmployerAnalysisSubAnalysis {
  model_id: string;
  role_framing: string;
  inferred_seniority: string;
  ideal_candidate_narrative: string;
  requirements: EmployerAnalysisRequirement[];
  keywords: EmployerAnalysisKeyword[];
}

export interface EmployerAnalysisFailure {
  model_id: string;
  error: string;
  raw_output: string | null;
}

export interface EmployerAnalysis {
  generation: number;
  snapshot_hash: string;
  prompt_version: string;
  sdk_set_version: string;
  cache_key: string;
  created_at: string;
  ensemble_completeness: string;
  legs_attempted: number;
  legs_succeeded: number;
  is_degraded: boolean;
  agreement: EmployerAnalysisAgreement;
  role_framing: string;
  inferred_seniority: string;
  ideal_candidate_narrative: string;
  requirements: EmployerAnalysisRequirement[];
  keywords: EmployerAnalysisKeyword[];
  sub_analyses: EmployerAnalysisSubAnalysis[];
  failures: EmployerAnalysisFailure[];
}

export interface JobDetail {
  ok: true;
  job: JobSummary & {
    descriptionPreview: string;
    scoreReasoning: string;
  };
  applyAudit: ApplyAudit;
  stages: StageSummary[];
  artifacts: ArtifactSummary[];
  auditHistory: JobAuditEntry[];
  // Phase 1: the canonical employer analysis served from projection rows, or
  // null when no analysis has been produced for this job yet.
  employerAnalysis: EmployerAnalysis | null;
  // Requirement-led fit audit served from projection rows, or null when this
  // job has not been scored with requirement-level assessments yet.
  requirementFitReport: RequirementFitReport | null;
  // Projection-backed compensation facts from canonical posted-fact and
  // reported company-role estimate rows. Null only when the projection row is
  // absent or contains invalid JSON.
  compensationAudit: JobCompensationAudit | null;
}

export interface ArtifactDetail {
  ok: true;
  artifact: ArtifactSummary;
  tailoringExplanation: ArtifactTailoringExplanation | null;
}

/**
 * Phase 2 — one canonical per-bullet provenance record served on the artifact's
 * tailoring explanation.
 *
 * Mirrors the Python ``BulletProvenance.to_dict()`` projection: the profile
 * evidence the bullet derives from (``evidenceIds``), the job requirement it
 * serves (``requirementIds``, FK into the employer analysis), the transform that
 * produced it (``transformType``), the granular control that governed it
 * (``control``), a human rationale, and the actual rendered bullet text
 * (``generatedText``) — the coverage anchor. Served exclusively from canonical
 * ``job_bullet_provenance`` projection rows, never derived from ``metadata_json``.
 */
export interface BulletProvenanceEntry {
  bulletId: string;
  section: string;
  sourceId: string | null;
  evidenceIds: string[];
  sourceText: string[];
  requirementIds: string[];
  matchedKeywords: string[];
  transformType: string;
  control: string;
  rationale: string;
  generatedText: string;
}

/**
 * Phase 3 — honest generation-time keyword coverage (GROUND-06 / success
 * criterion 4).
 *
 * Mirrors the Python ``KeywordCoverage.to_read_model()`` projection: covered +
 * missing computed against the actual rendered (voiced) resume text both renderers
 * consume, where a keyword counts as covered ONLY when it appears in a
 * provenance-backed grounded bullet. ``coveredBy`` maps each covered keyword to the
 * ``bulletId`` that demonstrates it (per-keyword, per-bullet inspectability).
 * ``computedAgainst`` records that coverage was computed against rendered text, not
 * the job description. Served exclusively from the canonical ``coverage_audit_json``
 * projection column.
 */
export interface BulletCoverageAudit {
  computedAgainst: string;
  planned: string[];
  covered: string[];
  missing: string[];
  coveredBy: Record<string, string>;
  counts: {
    planned: number;
    covered: number;
    missing: number;
  };
}

/**
 * Phase 3 — the voice-pass audit (VOICE-02): the de-buzzword/vary-structure pass
 * is inspectable, not a hidden prompt tweak.
 *
 * Mirrors the Python ``VoicePassRecord.to_dict()``: whether the pass ``ran``, was
 * ``accepted`` (kept over the pre-voice candidate because the deterministic proxies
 * improved AND grounding re-validated), the ``model`` that produced it, the prompt
 * version, the deterministic ``proxyDelta`` (buzzword density + structural variety
 * before/after), and a ``reason`` when it was not accepted (e.g. a voice edit that
 * introduced an unsourced metric was rejected — VOICE-03).
 */
export interface VoicePassAudit {
  ran: boolean;
  accepted: boolean;
  model: string;
  promptVersion: string;
  proxyDelta: Record<string, unknown>;
  reason: string;
}

export interface ArtifactTailoringExplanation {
  targetSeniority: string | null;
  claimMode: string | null;
  validationMode: string | null;
  safety: {
    autoApprovableClaimModes: string[];
    allowAdjacentAchievementDrafts: boolean | null;
    qualityPassed: boolean | null;
  };
  keywords: {
    coverageRecorded: boolean;
    planned: string[];
    covered: string[];
    missing: string[];
    filtered: {
      planned: string[];
      covered: string[];
      missing: string[];
    };
    counts: {
      planned: number;
      covered: number;
      missing: number;
      displayedPlanned: number;
      displayedCovered: number;
      displayedMissing: number;
      filteredPlanned: number;
      filteredCovered: number;
      filteredMissing: number;
    };
  };
  evidence: {
    requiredIds: string[];
    seniorityIds: string[];
    representedIds: string[];
    missingIds: string[];
    verifiedMetricCount: number | null;
  };
  quality: {
    passed: boolean | null;
    errors: string[];
    warnings: string[];
    notes: string[];
    metricClaims: string[];
    repeatedKeywords: string[];
  };
  judge: {
    passed: boolean | null;
    verdict: string | null;
    score: number | null;
    minScore: number | null;
    issues: string[];
    unsupportedClaims: string[];
    fabrications: string[];
    missingRequiredEvidence: string[];
    repairInstructions: string[];
  };
  adversarialReview: {
    ran: boolean;
    passed: boolean | null;
    score: number | null;
    scoreRationale: string | null;
    threshold: number | null;
    blockers: string[];
    warnings: string[];
    repairInstructions: string[];
    personas: Array<{
      persona: string;
      verdict: string | null;
      score: number | null;
      scoreRationale: string | null;
      promptRubric: string | null;
      blockers: string[];
      warnings: string[];
      repairInstructions: string[];
      scoreBasis: string[];
      response: {
        verdict: string | null;
        score: number | null;
        scoreRationale: string | null;
        blockers: string[];
        warnings: string[];
        repairInstructions: string[];
      } | null;
    }>;
    audit: {
      model: string | null;
      schemaVersion: string | null;
      promptMessages: Array<{ role: string; content: string }>;
      response: {
        verdict: string | null;
        score: number | null;
        scoreRationale: string | null;
        blockers: string[];
        warnings: string[];
        repairInstructions: string[];
        personas: Array<{
          verdict: string | null;
          score: number | null;
          scoreRationale: string | null;
          blockers: string[];
          warnings: string[];
          repairInstructions: string[];
        }>;
      } | null;
    } | null;
    skippedReason: string | null;
  } | null;
  reviewFeedback: {
    warningRepairAttempted: boolean | null;
    acceptedWithResidualWarnings: boolean | null;
    acceptedWarnings: string[];
  };
  annotatedChanges: Array<{
    section: string;
    label: string;
    changeType: string;
    sourceId: string | null;
    sourceText: string[];
    tailoredText: string[];
    rationale: string | null;
    jobSignals: string[];
    controls: string[];
    evidenceIds: string[];
    evidenceNotes: string[];
  }>;
  // Phase 2: canonical per-bullet provenance served from ``job_bullet_provenance``
  // projection rows (evidence × requirement × transform × control × rationale),
  // or [] when no provenance was recorded for this artifact's generation.
  bulletProvenance: BulletProvenanceEntry[];
  // Phase 3: honest generation-time keyword coverage computed against the actual
  // rendered (voiced) resume text both renderers consume — covered counts only
  // when a keyword appears in a provenance-backed grounded bullet (GROUND-06 /
  // success criterion 4). ``null`` when no Phase-3 coverage was recorded for this
  // artifact's generation. Served from the canonical ``coverage_audit_json``
  // projection column — never recomputed from the JD at read time.
  coverageAudit: BulletCoverageAudit | null;
  // Phase 3: the voice-pass audit (VOICE-02) — whether the de-buzzword/vary pass
  // ran, was accepted, the model that produced it, and the deterministic proxy
  // delta that justified it. ``null`` when no voice pass was recorded.
  voicePass: VoicePassAudit | null;
  models: {
    candidateModels: string[];
    selectedModel: string | null;
    selectedCandidate: string | null;
    judgeModel: string | null;
    attempts: number | null;
  };
}

export interface ArtifactOpenResponse {
  ok: true;
  artifact: ArtifactSummary;
  opened: true;
  path: string;
}

export interface ProfileConfigResponse {
  ok: true;
  /** Profile data. Validated against ``ProfileSchema`` server-side; the wire
   * type stays ``unknown`` so partial drafts can flow through explicit review
   * and import paths. Programmatic consumers should re-parse with
   * ``ProfileSchema``. */
  profile: unknown;
  style: unknown;
  templateText: string;
}

export interface ProfileImportResponse {
  ok: true;
  /** Draft profile dict — nullable shape so partial imports don't lose data. */
  profile?: unknown;
  style?: unknown;
  templateText?: string;
  source?: unknown;
  action?: ActionRunResponse;
}

export interface ActionCommandPayload {
  action:
    | "run_stage"
    | "retry_stage"
    | "rescore_job"
    | "rescore_jobs_not_on_current_scoring_policy"
    | "tailor_job"
    | "retailor_job"
    | "retailor_current_policy"
    | "analyze_job"
    | "refresh_compensation"
    | "generate_materials"
    | "apply"
    | "cancel"
    | "mark_applied"
    | "mark_skipped"
    | "profile_import";
  jobKey: string;
  stage?: Stage;
  stages?: Stage[];
  resetAttempts?: boolean;
  runAfter?: boolean;
  dryRun?: boolean;
  jobKeys?: string[];
  limit?: number;
  workers?: number;
  minScore?: number;
  validationMode?: PipelineValidationMode;
  rescore?: boolean;
  retailor?: boolean;
  model?: string;
  llmModel?: string;
  tailorModels?: string[];
  tailorJudgeModel?: string;
  tailorJudgeMinScore?: number;
  suppressExistingArtifacts?: boolean;
  headless?: boolean;
  continuous?: boolean;
  runId?: string;
  reason?: string;
  observationsJsonPath?: string;
  includeEuroTopTech?: boolean;
  euroTopTechMaxPages?: number;
}

export interface ActionRunResponse {
  ok: true;
  runId: string;
  workflowId?: string;
  firstExecutionRunId?: string;
  actionId: string;
  action: ActionCommandPayload["action"];
  status: string;
  jobKey: string;
  command: ActionCommandPayload;
  stage?: StageSummary;
  result?: unknown;
  eventCursor?: string | null;
  message?: string;
}

export interface PipelineStageRunResponse {
  ok: true;
  action: "run_stage";
  status: string;
  jobKey: typeof PIPELINE_ACTION_JOB_KEY;
  count: number;
  command: RunPipelineStagesRequest;
  actions: ActionRunResponse[];
  eventCursor?: string | null;
  message?: string;
}

export interface JobMutationResponse {
  ok: true;
  count: number;
  jobKeys: string[];
}

export interface BulkRetryFailedResponse extends JobMutationResponse {
  status: string;
  runAfter: boolean;
  stageCounts: Partial<Record<Stage, number>>;
  actions: ActionRunResponse[];
  eventCursor?: string | null;
  message?: string;
}

export interface BulkRunPendingPreparationResponse extends JobMutationResponse {
  status: string;
  stageCounts: Partial<Record<Stage, number>>;
  actions: ActionRunResponse[];
  eventCursor?: string | null;
  message?: string;
}

export interface RescoreJobResponse extends JobMutationResponse {
  currentPolicyVersion: number | null;
}

export interface BulkRescoreJobsNotOnCurrentScoringPolicyResponse extends JobMutationResponse {
  currentPolicyVersion: number | null;
}

export interface RetailorJobResponse extends JobMutationResponse {
  currentPolicyVersion: number | null;
}

export interface BulkRetailorCurrentPolicyResponse extends JobMutationResponse {
  currentPolicyVersion: number | null;
}

export const CorrectScoreRequestSchema = z
  .object({
    correctedScore: z.coerce.number().int().min(1).max(10),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type CorrectScoreRequest = z.infer<typeof CorrectScoreRequestSchema>;
export type CorrectScoreResponse = JobDetail;

export interface DashboardSettings {
  targetRole: string;
  locationFilter: string;
  minFitScore: number;
  autoApply: boolean;
  applyConcurrency: number;
  scoreCriteria: string;
  targetCriteria: string;
}

export interface SettingsResponse {
  ok: true;
  settings: DashboardSettings;
  paths: {
    settingsPath: string;
  };
}

export const COMPENSATION_SOURCE_TYPES = [
  "posted_salary",
  "public_wage_baseline",
  "occupation_taxonomy",
  "licensed_market_benchmark",
  "reported_compensation",
] as const;
export type CompensationSourceType = (typeof COMPENSATION_SOURCE_TYPES)[number];

export const COMPENSATION_SOURCE_ACCESS_MODES = [
  "local_posting_text",
  "public_dataset",
  "public_taxonomy",
  "licensed_api",
  "licensed_data_feed",
  "enterprise_mcp",
  "partner_api",
  "written_permission",
  "manual_import",
  "unavailable_until_permitted",
] as const;
export type CompensationSourceAccessMode = (typeof COMPENSATION_SOURCE_ACCESS_MODES)[number];

export const COMPENSATION_SOURCE_AVAILABILITY = ["available", "unavailable"] as const;
export type CompensationSourceAvailability = (typeof COMPENSATION_SOURCE_AVAILABILITY)[number];

export const COMPENSATION_SOURCE_LICENSE_STATUSES = [
  "not_required",
  "requires_license",
  "requires_permission",
  "permitted",
] as const;
export type CompensationSourceLicenseStatus =
  (typeof COMPENSATION_SOURCE_LICENSE_STATUSES)[number];

export const COMPENSATION_SUPPORTED_FIELDS = [
  "posted_range",
  "base_salary",
  "gross_annual_salary",
  "gross_monthly_salary",
  "wage_percentiles",
  "occupation_mapping",
  "market_range",
  "total_compensation",
  "sample_count",
  "freshness",
  "attribution",
] as const;
export type CompensationSupportedField = (typeof COMPENSATION_SUPPORTED_FIELDS)[number];

export interface CompensationSourceCoverage {
  geography: string;
  regions: string[];
  notes: string;
}

export interface CompensationSourcePolicySummary {
  sourceId: string;
  displayName: string;
  sourceType: CompensationSourceType;
  accessMode: CompensationSourceAccessMode;
  availability: CompensationSourceAvailability;
  licenseStatus: CompensationSourceLicenseStatus;
  termsUrl: string | null;
  sourceUrl: string | null;
  freshnessPolicy: string;
  attributionRequirement: string;
  supportedFields: CompensationSupportedField[];
  disabledReason: string | null;
  configured: boolean;
  coverage: CompensationSourceCoverage;
  notes: string[];
}

export interface CompensationSourceRegistryResponse {
  ok: true;
  sources: CompensationSourcePolicySummary[];
}

export const DiscoverySettingsUpdateRequestSchema = z
  .object({
    boards: z.array(z.enum(["indeed", "linkedin", "zip_recruiter", "glassdoor"])).min(1).optional(),
    resultsPerSite: z.coerce.number().int().min(1).max(1000).optional(),
    hoursOld: z.coerce.number().int().min(1).max(8760).optional(),
  })
  .strict();
export type DiscoverySettingsUpdateRequest = z.infer<typeof DiscoverySettingsUpdateRequestSchema>;

export interface DiscoverySettings {
  boards: Array<"indeed" | "linkedin" | "zip_recruiter" | "glassdoor">;
  resultsPerSite: number;
  hoursOld: number;
  source: "database";
}

export interface DiscoverySettingsResponse {
  ok: true;
  settings: DiscoverySettings;
}

export interface CredentialsResponse {
  ok: true;
  credentials: Array<{
    key: CredentialKey;
    label: string;
    configured: boolean;
    storage: "keychain";
  }>;
}

// ---------------------------------------------------------------------------
// PR6 Discovery Product Controls — source registry, locator candidates,
// quarantine queue, manual-capture queue, and discovery feedback.
//
// These read-model rows are surfaced through ``GET /v1/discovery/...``
// endpoints. The schemas live alongside the existing dashboard payloads so
// the web app and the JSON-RPC contract tests share one source of truth.
// ---------------------------------------------------------------------------

export const SOURCE_KIND_VALUES = [
  "ats_api",
  "employer_careers_page",
  "official_api",
  "licensed_feed",
  "niche_board",
  "broad_board",
  "smart_extract",
  "user_mediated_capture",
] as const;
export type SourceKindValue = (typeof SOURCE_KIND_VALUES)[number];

export const SOURCE_STATE_VALUES = ["active", "experimental", "quarantined", "disabled"] as const;
export type SourceStateValue = (typeof SOURCE_STATE_VALUES)[number];

export const SOURCE_PRIORITY_VALUES = [
  "canonical",
  "preferred",
  "standard",
  "fallback",
  "lead_generator",
] as const;
export type SourcePriorityValue = (typeof SOURCE_PRIORITY_VALUES)[number];

export const RECOMMENDED_SOURCE_STATES = [
  "trusted",
  "normal",
  "experimental",
  "quarantined",
  "disabled",
] as const;
export type RecommendedSourceState = (typeof RECOMMENDED_SOURCE_STATES)[number];

export interface SourceRegistryEntrySummary {
  sourceId: string;
  kind: SourceKindValue;
  displayName: string;
  owner: "system" | "user";
  priority: SourcePriorityValue;
  state: SourceStateValue;
  policyId: string;
  recommendedState: RecommendedSourceState;
  lastRunId: string | null;
  lastRunCompletedAt: string | null;
  lastErrorClass: string | null;
  consecutiveFailures: number;
  observedJobs: number;
  newJobs: number;
  duplicateRate: number | null;
  activeVerificationRate: number | null;
  fullDescriptionSuccessRate: number | null;
  applyUrlSuccessRate: number | null;
  qualityTrend: "up" | "flat" | "down" | "unknown";
}

export interface SourceRegistryListResponse {
  ok: true;
  sources: SourceRegistryEntrySummary[];
}

export interface SourceRegistryMutationResponse {
  ok: true;
  source: SourceRegistryEntrySummary;
}

export const MANUAL_ACTION_REASON_VALUES = [
  "captcha",
  "login_required",
  "paywall",
  "bot_detection",
  "rate_limit",
  "protected_internal_site",
  "ambiguous_career_system",
] as const;
export type ManualActionReasonValue = (typeof MANUAL_ACTION_REASON_VALUES)[number];

export const MANUAL_CAPTURE_MODE_VALUES = [
  "current_page",
  "saved_html",
  "copied_url",
  "pasted_text",
  "email_import",
] as const;
export type ManualCaptureModeValue = (typeof MANUAL_CAPTURE_MODE_VALUES)[number];

export interface SourceLocatorCandidateSummary {
  candidateId: string;
  candidateUrl: string;
  sourceKind: SourceKindValue;
  confidence: number;
  detectedAtsKind: string | null;
  employerDomainMatched: boolean;
  manualActionReason: ManualActionReasonValue | null;
  discoveredAt: string;
}

export interface SourceLocatorListResponse {
  ok: true;
  candidates: SourceLocatorCandidateSummary[];
}

export const SourceLocatorDecisionSchema = z
  .object({
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type SourceLocatorDecisionRequest = z.infer<typeof SourceLocatorDecisionSchema>;

export interface SourceLocatorDecisionResponse {
  ok: true;
  candidateId: string;
  decision: "promote" | "reject";
  source: SourceRegistryEntrySummary | null;
  decidedAt: string;
}

export const QUARANTINE_REASONS = [
  "low_confidence_extraction",
  "policy_overridden",
  "broad_board_only",
  "unknown_active_state",
  "user_review_requested",
] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

export interface QuarantineEntrySummary {
  jobId: string;
  jobKey: string;
  title: string;
  company: string;
  sourceId: string;
  postingUrl: string | null;
  reason: QuarantineReason;
  confidence: number | null;
  snapshotVersion: number | null;
  capturedAt: string | null;
  noticeText: string | null;
}

export interface QuarantineListResponse {
  ok: true;
  entries: QuarantineEntrySummary[];
}

export interface ManualCaptureQueueItemSummary {
  itemId: string;
  originatingUrl: string;
  sourceId: string | null;
  reason: ManualActionReasonValue;
  retryContext: Record<string, unknown>;
  requiredAt: string;
  status: "pending" | "imported" | "dismissed";
}

export interface ManualCaptureListResponse {
  ok: true;
  items: ManualCaptureQueueItemSummary[];
}

export const DISCOVERY_FEEDBACK_KINDS = [
  "saved",
  "applied",
  "dismissed",
  "stale",
  "duplicate",
  "wrong_company",
  "wrong_location",
  "bad_source",
  "useful",
  "irrelevant",
] as const;
export type DiscoveryFeedbackKind = (typeof DISCOVERY_FEEDBACK_KINDS)[number];

export const DiscoveryFeedbackRequestSchema = z
  .object({
    jobKey: z.string().trim().min(1).max(2048),
    sourceId: z.string().trim().min(1).max(160).optional(),
    kind: z.enum(DISCOVERY_FEEDBACK_KINDS),
    note: z.string().trim().max(400).optional(),
  })
  .strict();
export type DiscoveryFeedbackRequest = z.infer<typeof DiscoveryFeedbackRequestSchema>;

export interface DiscoveryFeedbackResponse {
  ok: true;
  feedbackId: string;
  jobKey: string;
  sourceId: string | null;
  kind: DiscoveryFeedbackKind;
  recordedAt: string;
}

export const ROLE_MATCH_FEEDBACK_STATUSES = ["pending", "approved", "declined"] as const;
export type RoleMatchFeedbackStatus = (typeof ROLE_MATCH_FEEDBACK_STATUSES)[number];

export const ROLE_MATCH_FEEDBACK_RULE_KINDS = ["exact_title_exclusion"] as const;
export type RoleMatchFeedbackRuleKind = (typeof ROLE_MATCH_FEEDBACK_RULE_KINDS)[number];

export const ROLE_MATCH_FEEDBACK_REASON_CODES = [
  "low_role_fit",
  "role_mismatch_evidence",
  "very_low_score",
] as const;
export type RoleMatchFeedbackReasonCode = (typeof ROLE_MATCH_FEEDBACK_REASON_CODES)[number];

export interface RoleMatchFeedbackEvidence {
  jobKey: string;
  title: string;
  company: string;
  sourceId: string | null;
  fitScore: number;
  roleFit: number | null;
  reason: string;
  scoredAt: string | null;
}

export interface RoleMatchFeedbackSuggestion {
  suggestionId: string;
  status: RoleMatchFeedbackStatus;
  ruleKind: RoleMatchFeedbackRuleKind;
  titlePattern: string;
  titleDisplay: string;
  reasonCode: RoleMatchFeedbackReasonCode;
  reason: string;
  sampleCount: number;
  sourceIds: string[];
  evidence: RoleMatchFeedbackEvidence[];
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
}

export interface RoleMatchFeedbackListResponse {
  ok: true;
  suggestions: RoleMatchFeedbackSuggestion[];
}

export const RoleMatchFeedbackDecisionSchema = z
  .object({
    decision: z.enum(["approve", "decline"]),
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type RoleMatchFeedbackDecisionRequest = z.infer<typeof RoleMatchFeedbackDecisionSchema>;

export interface RoleMatchFeedbackDecisionResponse {
  ok: true;
  suggestion: RoleMatchFeedbackSuggestion;
}

export const SourceUpsertRequestSchema = z
  .object({
    sourceId: z.string().trim().min(1).max(160),
    kind: z.enum(SOURCE_KIND_VALUES),
    displayName: z.string().trim().min(1).max(160),
    priority: z.enum(SOURCE_PRIORITY_VALUES).default("standard"),
    state: z.enum(SOURCE_STATE_VALUES).default("experimental"),
    seedUrl: z
      .string()
      .trim()
      .max(2048)
      .regex(/^https?:\/\/[^\s]+$/i, "seedUrl must be a valid http(s) URL")
      .optional(),
  })
  .strict();
export type SourceUpsertRequest = z.infer<typeof SourceUpsertRequestSchema>;

export const SourceStatePatchSchema = z
  .object({
    state: z.enum(SOURCE_STATE_VALUES),
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type SourceStatePatch = z.infer<typeof SourceStatePatchSchema>;

export interface DiscoveryPreviewLead {
  candidateUrl: string;
  title: string;
  company: string;
  location: string;
  estimatedConfidence: number;
}

export interface DiscoveryPreviewResponse {
  ok: true;
  sourceId: string;
  leads: DiscoveryPreviewLead[];
  generatedAt: string;
}

export const POSTED_COMPENSATION_PARSE_STATES = [
  "missing",
  "unparseable",
  "ambiguous",
  "parsed_range",
] as const;
export type PostedCompensationParseState = (typeof POSTED_COMPENSATION_PARSE_STATES)[number];

export const POSTED_COMPENSATION_COMPONENTS = [
  "base_salary",
  "ote",
  "bonus",
  "commission",
  "equity",
  "unknown",
] as const;
export type PostedCompensationComponent = (typeof POSTED_COMPENSATION_COMPONENTS)[number];

export const POSTED_COMPENSATION_PERIODS = ["hour", "month", "year", "unknown"] as const;
export type PostedCompensationPeriod = (typeof POSTED_COMPENSATION_PERIODS)[number];

export const POSTED_COMPENSATION_CONFIDENCE = ["none", "low", "medium", "high"] as const;
export type PostedCompensationConfidence = (typeof POSTED_COMPENSATION_CONFIDENCE)[number];

export const POSTED_COMPENSATION_WARNING_CODES = [
  "ambiguous_multiple_amounts",
  "bonus_component",
  "broad_range",
  "commission_component",
  "equity_component",
  "hourly_period",
  "missing_currency",
  "missing_period",
  "monthly_period",
  "no_amount_found",
  "one_sided_range",
  "ote_component",
  "source_text_truncated",
] as const;
export type PostedCompensationWarningCode = (typeof POSTED_COMPENSATION_WARNING_CODES)[number];

export interface PostedCompensationWarning {
  code: PostedCompensationWarningCode;
  message: string;
}

interface PostedCompensationFactBase {
  tenantId: string;
  jobKey: string;
  sourceField: string;
  legacyRawSalary: string | null;
  parserVersion: string;
  sourceHash: string;
  parsedAt: string;
  warnings: PostedCompensationWarning[];
}

export interface PostedCompensationMissingFact extends PostedCompensationFactBase {
  parseState: "missing";
  sourceText: null;
  confidence: "none";
}

export interface PostedCompensationUnparseableFact extends PostedCompensationFactBase {
  parseState: "unparseable";
  sourceText: string;
  confidence: "low";
}

export interface PostedCompensationAmbiguousFact extends PostedCompensationFactBase {
  parseState: "ambiguous";
  sourceText: string;
  confidence: "low" | "medium";
}

export interface PostedCompensationParsedRangeFact extends PostedCompensationFactBase {
  parseState: "parsed_range";
  sourceText: string;
  currency: string | null;
  period: PostedCompensationPeriod;
  component: PostedCompensationComponent;
  minimumAmount: number | null;
  maximumAmount: number | null;
  annualizedMinimumAmount: number | null;
  annualizedMaximumAmount: number | null;
  annualizationAssumption: string | null;
  confidence: "low" | "medium" | "high";
}

export type PostedCompensationFact =
  | PostedCompensationMissingFact
  | PostedCompensationUnparseableFact
  | PostedCompensationAmbiguousFact
  | PostedCompensationParsedRangeFact;

export interface PostedCompensationFactRecordedResponse {
  ok: true;
  recordStatus: "recorded";
  fact: PostedCompensationFact;
}

export interface PostedCompensationFactNotRecordedResponse {
  ok: true;
  recordStatus: "not_recorded";
  jobKey: string;
  legacyRawSalary: string | null;
}

export type PostedCompensationFactResponse =
  | PostedCompensationFactRecordedResponse
  | PostedCompensationFactNotRecordedResponse;

export const MARKET_COMPENSATION_ESTIMATE_STATES = [
  "not_requested",
  "unsupported",
  "source_unavailable",
  "insufficient_evidence",
  "estimated_range",
] as const;
export type MarketCompensationEstimateState = (typeof MARKET_COMPENSATION_ESTIMATE_STATES)[number];

export const MARKET_COMPENSATION_SOURCE_IDS = [
  "levels_fyi",
  "glassdoor",
  "manual_reported_compensation",
  "euro_top_tech",
  "posted_salary_text",
] as const;
export type MarketCompensationSourceId = (typeof MARKET_COMPENSATION_SOURCE_IDS)[number];

export const MARKET_COMPENSATION_CONFIDENCE_BANDS = ["none", "low", "medium", "high"] as const;
export type MarketCompensationConfidenceBand = (typeof MARKET_COMPENSATION_CONFIDENCE_BANDS)[number];

export const MARKET_COMPENSATION_COMPONENTS = [
  "base_salary",
  "total_compensation",
] as const;
export type MarketCompensationComponent = (typeof MARKET_COMPENSATION_COMPONENTS)[number];

export const MARKET_COMPENSATION_PERIODS = ["year", "month"] as const;
export type MarketCompensationPeriod = (typeof MARKET_COMPENSATION_PERIODS)[number];

export const MARKET_COMPENSATION_FACTOR_NAMES = [
  "company",
  "role",
  "level",
  "location",
  "component",
  "freshness",
  "sample",
  "agreement",
  "trimodal_tier",
] as const;
export type MarketCompensationFactorName = (typeof MARKET_COMPENSATION_FACTOR_NAMES)[number];

export const MARKET_COMPENSATION_WARNING_CODES = [
  "reported_compensation_sample",
  "posted_salary_sample",
  "source_conflict_with_posted_salary",
  "stale_source_snapshot",
  "low_sample_count",
  "company_role_fallback",
  "trimodal_tier_inferred",
  "location_mismatch",
] as const;
export type MarketCompensationWarningCode = (typeof MARKET_COMPENSATION_WARNING_CODES)[number];

export const MARKET_COMPENSATION_REASON_CODES = [
  "unsupported_source",
  "unsupported_component",
  "missing_company",
  "missing_role",
  "missing_reported_observation",
  "stale_source_snapshot",
  "weak_company_match",
  "weak_role_match",
  "weak_level_match",
  "weak_location_match",
  "low_sample_count",
  "source_dispersion_too_high",
] as const;
export type MarketCompensationReasonCode = (typeof MARKET_COMPENSATION_REASON_CODES)[number];

export interface MarketCompensationWarning {
  code: MarketCompensationWarningCode;
  message: string;
}

export interface MarketCompensationReason {
  code: MarketCompensationReasonCode;
  message: string;
}

export interface MarketCompensationFactor {
  name: MarketCompensationFactorName;
  score: number;
  band: MarketCompensationConfidenceBand;
  reason: string;
}

export interface MarketCompensationSourceSnapshot {
  sourceId: MarketCompensationSourceId;
  displayName: string;
  sourceType: "reported_compensation" | "posted_salary";
  releaseYear: number | null;
  snapshotVersion: string;
  geographyScope: string;
  aggregateBucket: string;
  attribution: string;
  sampleCount: number | null;
}

interface MarketCompensationEstimateBase {
  tenantId: string;
  jobKey: string;
  estimateState: MarketCompensationEstimateState;
  confidenceBand: MarketCompensationConfidenceBand;
  confidenceScore: number;
  sourceCount: number;
  sampleCount: number | null;
  aggregateBucket: string | null;
  geographyScope: string | null;
  occupationCode: string | null;
  occupationLabel: string | null;
  seniorityLabel: string | null;
  companyName: string | null;
  normalizedCompany: string | null;
  roleTitle: string | null;
  normalizedRole: string | null;
  companyTier: "tier_1_local" | "tier_2_ambitious" | "tier_3_top_of_market" | "unknown";
  matchScope:
    | "exact_company_role"
    | "same_location_role_fallback"
    | "company_adjacent_role"
    | "tier_role_fallback"
    | "market_baseline_fallback"
    | "none";
  sources: MarketCompensationSourceSnapshot[];
  factors: MarketCompensationFactor[];
  warnings: MarketCompensationWarning[];
  estimatorVersion: string;
  estimatedAt: string;
}

export interface MarketCompensationUnsupportedEstimate extends MarketCompensationEstimateBase {
  estimateState: "unsupported";
  unsupportedReasons: MarketCompensationReason[];
}

export interface MarketCompensationSourceUnavailableEstimate extends MarketCompensationEstimateBase {
  estimateState: "source_unavailable";
  sourceUnavailableReasons: MarketCompensationReason[];
}

export interface MarketCompensationInsufficientEvidenceEstimate extends MarketCompensationEstimateBase {
  estimateState: "insufficient_evidence";
  insufficientReasons: MarketCompensationReason[];
}

export interface MarketCompensationEstimatedRangeEstimate extends MarketCompensationEstimateBase {
  estimateState: "estimated_range";
  currency: string;
  period: MarketCompensationPeriod;
  component: MarketCompensationComponent;
  minimumAmount: number;
  maximumAmount: number;
  confidenceInterval: {
    minimumAmount: number;
    maximumAmount: number;
  };
}

export type MarketCompensationEstimate =
  | MarketCompensationUnsupportedEstimate
  | MarketCompensationSourceUnavailableEstimate
  | MarketCompensationInsufficientEvidenceEstimate
  | MarketCompensationEstimatedRangeEstimate;

export interface MarketCompensationEstimateRecordedResponse {
  ok: true;
  recordStatus: "recorded";
  estimate: MarketCompensationEstimate;
}

export interface MarketCompensationEstimateNotRequestedResponse {
  ok: true;
  recordStatus: "not_requested";
  jobKey: string;
}

export type MarketCompensationEstimateResponse =
  | MarketCompensationEstimateRecordedResponse
  | MarketCompensationEstimateNotRequestedResponse;

export const QuarantineDecisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type QuarantineDecision = z.infer<typeof QuarantineDecisionSchema>;

export interface QuarantineDecisionResponse {
  ok: true;
  jobKey: string;
  decision: "approve" | "reject";
  recordedAt: string;
}

export const ManualCaptureImportSchema = z
  .object({
    captureMode: z.enum(MANUAL_CAPTURE_MODE_VALUES),
    capturedUrl: z
      .string()
      .trim()
      .max(2048)
      .regex(/^https?:\/\/[^\s]+$/i, "capturedUrl must be a valid http(s) URL")
      .optional(),
    contentText: z.string().trim().max(200_000).optional(),
    contentHtmlBase64: z.string().trim().max(8_000_000).optional(),
    note: z.string().trim().max(400).optional(),
    futureManualActionRequired: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) =>
      value.capturedUrl !== undefined ||
      value.contentText !== undefined ||
      value.contentHtmlBase64 !== undefined,
    { message: "One of capturedUrl, contentText, or contentHtmlBase64 must be provided." },
  );
export type ManualCaptureImportRequest = z.infer<typeof ManualCaptureImportSchema>;

export interface ManualCaptureImportResponse {
  ok: true;
  itemId: string;
  jobKey: string | null;
  importedAt: string;
  provenance: {
    sourceKind: "user_mediated_capture";
    originatingUrl: string;
    captureMode: ManualCaptureModeValue;
    futureManualActionRequired: boolean;
  };
}

export const ManualCaptureDismissSchema = z
  .object({
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type ManualCaptureDismissRequest = z.infer<typeof ManualCaptureDismissSchema>;

export interface ManualCaptureDismissResponse {
  ok: true;
  itemId: string;
  status: "dismissed";
  dismissedAt: string;
}
