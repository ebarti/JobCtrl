import { z } from "zod";

export const STAGES = ["discover", "enrich", "score", "tailor", "cover", "apply"] as const;
export type Stage = (typeof STAGES)[number];
export const PIPELINE_ACTION_JOB_KEY = "pipeline" as const;

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
export const JOB_DELETED_FILTERS = ["active", "deleted", "hidden", "all"] as const;
export type JobDeletedFilter = (typeof JOB_DELETED_FILTERS)[number];

export const JOB_SORT_FIELDS = [
  "discovered_at",
  "title",
  "company",
  "location",
  "fit_score",
  "current_stage",
  "current_state",
] as const;
export type JobSortField = (typeof JOB_SORT_FIELDS)[number];

export const ARTIFACT_SORT_FIELDS = ["created_at", "title", "company", "type", "status", "size_bytes"] as const;
export type ArtifactSortField = (typeof ARTIFACT_SORT_FIELDS)[number];

export const SortDirectionSchema = z.enum(["asc", "desc"]).default("desc").catch("desc");

const optionalText = z
  .string()
  .trim()
  .optional()
  .catch("")
  .transform((value) => value ?? "");

const optionalNumber = z.coerce.number().int().optional().catch(undefined);

export const RetryStageRequestSchema = z
  .object({
    stage: z.enum(STAGES),
    resetAttempts: z.boolean().default(false),
    runAfter: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  })
  .strict();
export type RetryStageRequest = z.infer<typeof RetryStageRequestSchema>;

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

export const RunPipelineStagesRequestSchema = z
  .object({
    stages: z.array(z.enum(STAGES)).min(1).max(STAGES.length),
    limit: z.coerce.number().int().min(1).max(1000).default(25),
    workers: z.coerce.number().int().min(1).max(16).default(1),
    minScore: z.coerce.number().int().min(0).max(10).default(7),
    validationMode: z.enum(PIPELINE_VALIDATION_MODES).default("normal"),
    dryRun: z.boolean().default(true),
    rescore: z.boolean().default(false),
    retailor: z.boolean().default(false),
    headless: z.boolean().default(false),
    model: z.string().trim().min(1).max(80).default("default"),
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
    source: optionalText,
    company: optionalText,
    minFitScore: optionalNumber,
    maxFitScore: optionalNumber,
  })
  .strict();
export type BulkJobMutationFilter = z.infer<typeof BulkJobMutationFilterSchema>;

export const BulkJobMutationRequestSchema = z
  .object({
    jobKeys: z.array(z.string().trim().min(1)).max(5000).default([]),
    allMatching: z.boolean().default(false),
    filter: BulkJobMutationFilterSchema.optional(),
    reason: z.string().trim().max(400).optional(),
  })
  .strict()
  .refine((value) => value.allMatching || value.jobKeys.length > 0, {
    message: "Provide jobKeys or set allMatching.",
  });
export type BulkJobMutationRequest = z.infer<typeof BulkJobMutationRequestSchema>;

// ---------------------------------------------------------------------------
// Profile schemas — mirror packages/domain-types/src/profile/profile.ts
//
// Wire format keeps the snake_case JSON shape from the canonical
// ``profile.json`` file (the Python aggregate's ``to_dict()`` output) so the
// API ↔ worker boundary is one schema, not two. Field names match the JSON,
// not the camelCase TS interfaces.
// ---------------------------------------------------------------------------

export const TAILORING_MODES = ["strict", "balanced", "aggressive"] as const;
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

const ProfileExperienceEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  company: z.string().min(1),
  date_range: z.string().default(""),
  location: z.string().default(""),
  bullets: z.array(z.string()).default([]),
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
  })
  .partial();

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
    tailoring_policy: ProfileTailoringPolicySchema.default({}),
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

/** Canonical profile.json shape. ``passthrough()`` preserves forward-compatible
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

export const WorkflowRunsListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).catch(1),
    pageSize: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
    page_size: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
    status: z.enum(WORKFLOW_RUN_STATUS_FILTERS).default("all").catch("all"),
  })
  .transform((value) => ({
    page: value.page,
    pageSize: value.pageSize ?? value.page_size ?? 50,
    status: value.status,
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

export interface JobSummary {
  jobKey: string;
  url: string;
  title: string;
  company: string;
  source: string;
  discoverySource: string;
  strategy: string;
  location: string;
  salary: string;
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
  currentState: StageState;
  errorCode: string | null;
  errorMessage: string | null;
  nextAction: string | null;
  artifactCount: number;
  applyStatus: string | null;
  appliedAt: string | null;
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

export interface DashboardSummary {
  ok: true;
  generatedAt: string;
  totals: {
    jobs: number;
    failures: number;
    blocked: number;
    ready: number;
    applied: number;
    dryRuns: number;
  };
  funnel: Array<{
    stage: Stage;
    total: number;
    succeeded: number;
    running: number;
    pending: number;
    blocked: number;
    failed: number;
  }>;
  activity: Array<{
    eventId: string;
    eventType: string;
    jobKey: string | null;
    title: string | null;
    company: string | null;
    stage: string;
    level: string;
    message: string;
    at: string | null;
  }>;
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
  }>;
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

export interface JobDetail {
  ok: true;
  job: JobSummary & {
    descriptionPreview: string;
    scoreReasoning: string;
  };
  stages: StageSummary[];
  artifacts: ArtifactSummary[];
}

export interface ArtifactDetail {
  ok: true;
  artifact: ArtifactSummary;
}

export interface ArtifactOpenResponse {
  ok: true;
  artifact: ArtifactSummary;
  opened: true;
  path: string;
}

export interface ProfileConfigResponse {
  ok: true;
  /** Profile JSON. Validated against ``ProfileSchema`` server-side; the wire
   * type stays ``unknown`` so the web client (which renders the raw JSON in
   * a textarea) is not forced to satisfy every required field at compile
   * time. Programmatic consumers should re-parse with ``ProfileSchema``. */
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
  limit?: number;
  workers?: number;
  minScore?: number;
  validationMode?: PipelineValidationMode;
  rescore?: boolean;
  retailor?: boolean;
  model?: string;
  headless?: boolean;
  continuous?: boolean;
  runId?: string;
  reason?: string;
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
