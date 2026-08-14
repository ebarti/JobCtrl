import { z } from "zod";
import { CONTACT_ROLES, CONTACT_SOURCE_KINDS } from "@jobctrl/domain-types";

export const STAGES = ["discover", "enrich", "score", "tailor", "cover", "apply"] as const;
export type Stage = (typeof STAGES)[number];
export const PIPELINE_RUN_STAGES = ["discover", "score", "tailor", "cover", "apply"] as const;
export type PipelineRunStage = (typeof PIPELINE_RUN_STAGES)[number];
export const DEFAULT_PIPELINE_LLM_MODEL = "default" as const;
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
  "needs_verification",
  "canceled",
  "stale",
] as const;
export type StageState = (typeof STAGE_STATES)[number];
export const USER_FACING_STAGE_STATES = [
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "skipped",
  "needs_verification",
  "canceled",
  "stale",
] as const satisfies readonly StageState[];
export const STAGE_FAILURE_REASONS = ["attempt_budget_exhausted"] as const;
export type StageFailureReason = (typeof STAGE_FAILURE_REASONS)[number];
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
const STAGE_OR_ALL = [...STAGES, "all"] as const;
const STATE_OR_ALL = [...STAGE_STATES, "all"] as const;

export const JOB_SORT_FIELDS = [
  "discovered_at",
  "title",
  "company",
  "source",
  "compensation_min_eur",
  "compensation_max_eur",
  "compensation_posted",
  "compensation_market",
  "compensation_confidence",
  "compensation_warnings",
  "location",
  "fit_score",
  "current_stage",
  "current_state",
  "apply_status",
] as const;
export type JobSortField = (typeof JOB_SORT_FIELDS)[number];

export const DAILY_DIGEST_ITEM_KEYS = [
  "newMatches",
  "blockedSources",
  "reviewNeededMaterials",
  "staleScores",
  "pendingApprovals",
  "followUpsDue",
  "budget",
] as const;
export type DailyDigestItemKey = (typeof DAILY_DIGEST_ITEM_KEYS)[number];
export const DIGEST_FOLLOW_UP_THRESHOLD_DAYS = 7 as const;
export const DIGEST_DAY_BOUNDARY = "UTC" as const;

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
export const TableIdSchema = z.enum(["jobs", "discovery-sources"]);
export type TableId = z.infer<typeof TableIdSchema>;

export const SavedTableViewDensitySchema = z.enum(["compact", "regular", "comfy"]);
export type SavedTableViewDensity = z.infer<typeof SavedTableViewDensitySchema>;

export const SavedTableViewTextFilterSchema = z
  .object({
    operator: z.enum(["contains", "does_not_contain"]).default("contains").catch("contains"),
    text: z.string().default("").catch(""),
    selectedValues: z.array(z.string()).default([]).catch([]),
  })
  .strict();
export type SavedTableViewTextFilter = z.infer<typeof SavedTableViewTextFilterSchema>;

export const SavedTableViewGridFiltersSchema = z.record(
  z.string(),
  SavedTableViewTextFilterSchema.optional(),
);
export type SavedTableViewGridFilters = z.infer<typeof SavedTableViewGridFiltersSchema>;

export const SavedTableViewUrlFiltersSchema = z
  .object({
    q: z.string().optional().catch(undefined),
    stage: z.enum(STAGE_OR_ALL).optional().catch(undefined),
    state: z.enum(STATE_OR_ALL).optional().catch(undefined),
    applyStatus: z.enum(JOB_APPLY_STATUS_FILTERS).optional().catch(undefined),
    deleted: z.enum(["active", "closed", "deleted", "hidden"]).optional().catch(undefined),
    pageSize: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
    minFitScore: z.coerce.number().int().min(1).max(10).optional().catch(undefined),
    maxFitScore: z.coerce.number().int().min(1).max(10).optional().catch(undefined),
    discoveredSince: z.string().trim().min(1).optional().catch(undefined),
    scoredSince: z.string().trim().min(1).optional().catch(undefined),
  })
  .strict();
export type SavedTableViewUrlFilters = z.infer<typeof SavedTableViewUrlFiltersSchema>;

export const SavedTableViewSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    tableId: TableIdSchema,
    name: z.string().trim().min(1).max(80),
    builtIn: z.boolean(),
    columns: z
      .object({
        order: z.array(z.string()).default([]).catch([]),
        hidden: z.array(z.string()).default([]).catch([]),
        widths: z.record(z.string(), z.coerce.number().int().min(24).max(2000)).default({}).catch({}),
      })
      .strict(),
    density: SavedTableViewDensitySchema.nullable(),
    sort: z
      .object({
        columnId: z.string(),
        direction: z.enum(["asc", "desc"]),
      })
      .strict(),
    urlFilters: SavedTableViewUrlFiltersSchema.default({}),
    gridFilters: SavedTableViewGridFiltersSchema.default({}),
    grouping: z
      .object({
        columnId: z.string(),
      })
      .strict()
      .nullable(),
    colorRules: z
      .array(
        z
          .object({
            columnId: z.string(),
            predicate: z
              .object({
                op: z.enum(["eq", "neq", "gte", "lte", "contains"]),
                value: z.union([z.string(), z.number()]),
              })
              .strict(),
            tone: z.enum(["success", "warning", "danger", "info"]),
          })
          .strict(),
      )
      .default([]),
    schemaVersion: z.number().int().min(1),
  })
  .strict();
export type SavedTableView = z.infer<typeof SavedTableViewSchema>;

const optionalText = z
  .string()
  .trim()
  .optional()
  .catch("")
  .transform((value) => value ?? "");

const optionalNumber = z.coerce.number().int().optional().catch(undefined);
export const IsoTimestampSchema = z
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

export const GenerateInterviewPrepRequestSchema = z
  .object({
    llmModel: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type GenerateInterviewPrepRequest = z.infer<typeof GenerateInterviewPrepRequestSchema>;

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
    materialsGeneration: z.number().int().nonnegative().nullable().optional(),
    profileVersion: z.number().int().positive().nullable().optional(),
    applicationUrl: z.string().trim().min(1).max(2048).nullable().optional(),
    partialOverrideRunId: z.string().trim().min(1).max(120).optional(),
    emailRecipient: z.string().trim().email().optional(),
    emailAttachmentArtifactId: z.string().trim().min(1).max(160).optional(),
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
  materialsGeneration?: number | null;
  profileVersion?: number | null;
  applicationUrl?: string | null;
  partialOverrideRunId?: string | null;
  emailRecipient?: string | null;
  emailAttachmentArtifactId?: string | null;
}

export interface ApplyReviewDecisionResponse {
  ok: true;
  decision: ApplyReviewDecision;
}

export const RepeatApplicationOverrideRequestSchema = z
  .object({
    evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    priorJobId: z.string().uuid(),
    reason: z.string().trim().min(10).max(400),
    confirmedBy: z.string().trim().min(1).max(120).default("user"),
  })
  .strict();
export type RepeatApplicationOverrideRequest = z.infer<
  typeof RepeatApplicationOverrideRequestSchema
>;

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

export interface ApplyReviewRequirementLedAuditRequirement {
  id: string;
  textExcerpt: string;
  tier: string | null;
  reason: string | null;
}

export interface ApplyReviewRequirementLedAuditClaim {
  section: string;
  label: string;
  textExcerpts: string[];
  requirementIds: string[];
  evidenceIds: string[];
  coverageEdgeIds: string[];
  claimLabels: string[];
  positioningReasons: string[];
  reviewRequired: boolean;
}

export interface ApplyReviewRequirementLedAuditOverflow {
  experienceEntryId: string;
  maxBullets: number;
  actualBullets: number;
  reason: string;
  evidenceIds: string[];
}

export type ApplyReviewCoverageBasis = "grounded_shipped_text_v1" | "judge_claimed_legacy";

export interface ApplyReviewRequirementLedAuditRevision {
  score: number | null;
  mustHaveCoverage: number | null;
  thresholdFailed: boolean;
  shouldRevise: boolean;
  reviewBlocked: boolean;
  enhancementAllowed: boolean;
  reason: string | null;
  attempt: number | null;
  maxRevisionAttempts: number | null;
  revisionsUsed: number | null;
  coverageBasis: ApplyReviewCoverageBasis;
  claimedOnlyRequirementIds: string[];
  prioritizedFixes: string[];
  reviewBlockers: string[];
}

export interface ApplyReviewRequirementLedShippedFit {
  lifecycle: string | null;
  score: number | null;
  mustHaveCoverage: number | null;
  claimedOnlyRequirementIds: string[];
  passed: boolean;
  warnings: string[];
  coverageBasis: ApplyReviewCoverageBasis;
}

export interface ApplyReviewRequirementLedAudit {
  requirementCount: number;
  achievementCount: number;
  coverageEdgeCount: number;
  coveredRequirements: ApplyReviewRequirementLedAuditRequirement[];
  uncoveredRequirements: ApplyReviewRequirementLedAuditRequirement[];
  unusedAchievementIds: string[];
  evidenceBackedClaims: ApplyReviewRequirementLedAuditClaim[];
  pinnedClaims: ApplyReviewRequirementLedAuditClaim[];
  adjacentOrDraftClaims: ApplyReviewRequirementLedAuditClaim[];
  bulletLimitOverflows: ApplyReviewRequirementLedAuditOverflow[];
  revision: ApplyReviewRequirementLedAuditRevision | null;
  shippedFit?: ApplyReviewRequirementLedShippedFit | null;
  reviewBlockers: string[];
}

export interface ApplyReviewMaterialsPreview {
  materialsGeneration: number | null;
  resumeText: string | null;
  resumeTextArtifactId: string | null;
  resumePdfArtifactId: string | null;
  resumePdfLayoutBoxes: ResumeLayoutBox[];
  profileSourceFields: ApplyReviewProfileSourceField[];
  coverLetterText: string | null;
  requirementLedAudit?: ApplyReviewRequirementLedAudit | null;
  resumeTemplate?: ResumeTemplateState | null;
}

export const RESUME_TEMPLATE_STATUSES = ["active", "archived"] as const;
export type ResumeTemplateStatus = (typeof RESUME_TEMPLATE_STATUSES)[number];

export const RESUME_TEMPLATE_ASSIGNMENT_SOURCES = [
  "job_override",
  "profile_default",
  "built_in",
] as const;
export type ResumeTemplateAssignmentSource =
  (typeof RESUME_TEMPLATE_ASSIGNMENT_SOURCES)[number];

export const RESUME_TEMPLATE_STALE_STATES = [
  "template_current",
  "template_stale",
  "refresh_queued",
  "refresh_failed",
  "refresh_unavailable",
] as const;
export type ResumeTemplateStaleState = (typeof RESUME_TEMPLATE_STALE_STATES)[number];

export const RESUME_TEMPLATE_REFRESH_STATUSES = [
  "not_required",
  "queued",
  "completed",
  "failed",
  "unavailable",
] as const;
export type ResumeTemplateRefreshStatus = (typeof RESUME_TEMPLATE_REFRESH_STATUSES)[number];

export const RESUME_TEMPLATE_SECTIONS = [
  "summary",
  "experience",
  "education",
  "skills",
] as const;
export type ResumeTemplateSection = (typeof RESUME_TEMPLATE_SECTIONS)[number];

export const RESUME_TEMPLATE_FONT_FAMILIES = [
  "sans",
  "serif",
  "system",
  "aptos",
  "avenir",
  "helvetica",
  "inter",
  "source_sans",
  "calibri",
  "georgia",
  "garamond",
  "charter",
  "source_serif",
  "times",
  "cambria",
] as const;
export type ResumeTemplateFontFamily = (typeof RESUME_TEMPLATE_FONT_FAMILIES)[number];

export const ResumeTemplateThemeSchema = z
  .object({
    pageSize: z.enum(["a4", "letter"]).default("a4"),
    fontFamily: z.enum(RESUME_TEMPLATE_FONT_FAMILIES).default("sans"),
    fontScale: z.coerce.number().min(0.85).max(1.2).default(1),
    density: z.enum(["compact", "balanced", "spacious"]).default("balanced"),
    marginMm: z
      .object({
        top: z.coerce.number().min(8).max(28).default(16.5),
        right: z.coerce.number().min(8).max(28).default(17.5),
        bottom: z.coerce.number().min(8).max(28).default(18),
        left: z.coerce.number().min(8).max(28).default(17.5),
      })
      .strict()
      .default({ top: 16.5, right: 17.5, bottom: 18, left: 17.5 }),
    headerLayout: z.enum(["centered", "left", "split"]).default("centered"),
    sectionHeadingStyle: z.enum(["rule", "plain", "boxed"]).default("rule"),
    alignment: z.enum(["left", "justified"]).default("justified"),
    bulletSpacing: z.enum(["tight", "normal", "loose"]).default("normal"),
    accentColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#111111"),
    sectionOrder: z
      .array(z.enum(RESUME_TEMPLATE_SECTIONS))
      .min(1)
      .max(RESUME_TEMPLATE_SECTIONS.length)
      .default(["summary", "experience", "education", "skills"]),
    hiddenSections: z.array(z.enum(RESUME_TEMPLATE_SECTIONS)).max(RESUME_TEMPLATE_SECTIONS.length).default([]),
  })
  .strict();
export type ResumeTemplateTheme = z.infer<typeof ResumeTemplateThemeSchema>;

export const ResumeTemplateLayoutSchema = z
  .object({
    plateDocument: z.unknown().optional(),
    sectionOrder: z.array(z.enum(RESUME_TEMPLATE_SECTIONS)).max(RESUME_TEMPLATE_SECTIONS.length).optional(),
  })
  .strict()
  .default({});
export type ResumeTemplateLayout = z.infer<typeof ResumeTemplateLayoutSchema>;

export interface ResumeTemplateVersionSummary {
  templateId: string;
  versionId: string;
  versionNumber: number;
  displayName: string;
  status: ResumeTemplateStatus;
  theme: ResumeTemplateTheme;
  layout: ResumeTemplateLayout;
  contentHash: string;
  createdAt: string;
}

export interface ResumeTemplateSummary {
  templateId: string;
  displayName: string;
  status: ResumeTemplateStatus;
  builtIn: boolean;
  activeVersion: ResumeTemplateVersionSummary;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeTemplateMetadata {
  templateId: string;
  templateVersionId: string;
  templateVersionNumber: number;
  templateName: string;
  templateHash: string;
  assignmentSource: ResumeTemplateAssignmentSource;
}

export interface ResumeTemplateRefreshAttempt {
  attemptId: string;
  jobKey: string;
  status: ResumeTemplateRefreshStatus;
  fromGeneration: number | null;
  toGeneration: number | null;
  templateId: string | null;
  templateVersionId: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ResumeTemplateState {
  effective: ResumeTemplateMetadata;
  snapshot: ResumeTemplateMetadata | null;
  state: ResumeTemplateStaleState;
  reason: string | null;
  lastRefreshAttempt: ResumeTemplateRefreshAttempt | null;
}

export interface ResumeTemplateListResponse {
  ok: true;
  templates: ResumeTemplateSummary[];
  defaultTemplate: ResumeTemplateMetadata | null;
  builtInDefault: ResumeTemplateMetadata;
  effectiveDefaultVersion: ResumeTemplateVersionSummary;
}

export interface ResumeTemplateDetailResponse {
  ok: true;
  template: ResumeTemplateSummary;
}

export const ResumeTemplateVersionSaveRequestSchema = z
  .object({
    templateId: z.string().trim().min(1).max(120).optional(),
    displayName: z.string().trim().min(1).max(120),
    theme: ResumeTemplateThemeSchema,
    layout: ResumeTemplateLayoutSchema.optional().default({}),
  })
  .strict();
export type ResumeTemplateVersionSaveRequest = z.infer<
  typeof ResumeTemplateVersionSaveRequestSchema
>;

export interface ResumeTemplateVersionSaveResponse {
  ok: true;
  template: ResumeTemplateSummary;
}

export const ResumeTemplateDefaultSelectionRequestSchema = z
  .object({
    templateId: z.string().trim().min(1).max(120),
    versionId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
export type ResumeTemplateDefaultSelectionRequest = z.infer<
  typeof ResumeTemplateDefaultSelectionRequestSchema
>;

export interface ResumeTemplateDefaultSelectionResponse {
  ok: true;
  defaultTemplate: ResumeTemplateMetadata;
}

export const JobResumeTemplateAssignmentRequestSchema = z
  .object({
    templateId: z.string().trim().min(1).max(120).nullable().optional(),
    versionId: z.string().trim().min(1).max(160).nullable().optional(),
  })
  .strict();
export type JobResumeTemplateAssignmentRequest = z.infer<
  typeof JobResumeTemplateAssignmentRequestSchema
>;

export interface JobResumeTemplateAssignmentResponse {
  ok: true;
  jobKey: string;
  effectiveTemplate: ResumeTemplateMetadata;
  overrideTemplate: ResumeTemplateMetadata | null;
  templateState: ResumeTemplateState | null;
}

export const EnsureCurrentResumeMaterialsRequestSchema = z
  .object({
    force: z.boolean().default(false),
  })
  .strict();
export type EnsureCurrentResumeMaterialsRequest = z.infer<
  typeof EnsureCurrentResumeMaterialsRequestSchema
>;

export interface EnsureCurrentResumeMaterialsResponse {
  ok: true;
  jobKey: string;
  status: ResumeTemplateRefreshStatus;
  templateState: ResumeTemplateState | null;
  attempt: ResumeTemplateRefreshAttempt | null;
  generation: number | null;
  message: string | null;
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

export type RepeatApplicationRelationship =
  | "canonical_job"
  | "canonical_identity"
  | "accepted_duplicate"
  | "same_employer_equivalent_role";

export type RepeatApplicationFactKind =
  | "application_submitted"
  | "application_manually_marked"
  | "applied_confirmation"
  | "legacy_applied_status";

export type RepeatApplicationStatus =
  | "clear"
  | "blocked"
  | "confirmation_required"
  | "override_ready"
  | "override_consumed";

export interface RepeatApplicationMatch {
  relationship: RepeatApplicationRelationship;
  reason: string;
  priorApplication: {
    jobId: string;
    title: string;
    company: string;
    applicationUrl: string | null;
    factKind: RepeatApplicationFactKind;
    factId: string;
    confirmedAt: string;
  };
  identityEvidence: string[];
}

export interface RepeatApplicationOverride {
  overrideId: string;
  targetJobId: string;
  priorJobId: string;
  evidenceFingerprint: string;
  reason: string;
  confirmedBy: string;
  confirmedAt: string;
  consumedAt: string | null;
  consumedRunId: string | null;
}

export interface RepeatApplicationAuditEntry {
  auditId: string;
  targetJobId: string;
  action: "blocked" | "confirmation_required" | "override_recorded" | "override_consumed";
  evidenceFingerprint: string;
  evidence: RepeatApplicationMatch[];
  overrideId: string | null;
  priorJobId: string | null;
  actor: string;
  reason: string | null;
  occurredAt: string;
}

export interface RepeatApplicationAssessment {
  status: RepeatApplicationStatus;
  summary: string;
  evidenceFingerprint: string | null;
  evaluatedAt: string;
  matches: RepeatApplicationMatch[];
  override: RepeatApplicationOverride | null;
  auditTrail: RepeatApplicationAuditEntry[];
}

export interface RepeatApplicationOverrideResponse {
  ok: true;
  assessment: RepeatApplicationAssessment;
}

export type ApplyReviewDryRunCoverage = "full" | "partial";
/**
 * The apply-review approval-gate vocabulary. This constant is the single
 * TypeScript source for the gate reasons; the Python launcher's refusal
 * reasons are pinned to the same fixture
 * (packages/domain-types/test/fixtures/apply_approval_gate_reasons.json).
 */
export const APPLY_REVIEW_APPROVAL_GATE_REASONS = [
  "awaiting_approval",
  "awaiting_dry_run",
  "approval_stale_materials",
  "approval_stale_profile",
  "approval_stale_url",
  "approval_stale_email_candidate",
  "override_evidence_invalid",
] as const;
export type ApplyReviewApprovalGateReason = (typeof APPLY_REVIEW_APPROVAL_GATE_REASONS)[number];

export interface ApplyReviewDryRunEvidence {
  runId: string;
  coverage: ApplyReviewDryRunCoverage;
  finishedAt: string | null;
  blockedChannels: string[];
}

export interface ApplyReviewApprovalGate {
  materialsGeneration: number | null;
  profileVersion: number | null;
  applicationUrl: string | null;
  dryRunEvidence: ApplyReviewDryRunEvidence | null;
  partialDryRunEvidence: ApplyReviewDryRunEvidence | null;
  reasons: ApplyReviewApprovalGateReason[];
}

export interface ApplyReviewEmailApplicationPreview {
  recipient: string;
  subject: string;
  body: string;
  attachmentArtifactId: string;
  attachmentName: string;
  candidateRunId: string;
  recordedAt: string | null;
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
  repeatApplication: RepeatApplicationAssessment;
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
  emailApplication: ApplyReviewEmailApplicationPreview | null;
  review: {
    state: "pending" | "approved_submit" | "approved_dry_run" | "deferred" | "declined";
    decision: ApplyReviewDecisionValue | null;
    decidedAt: string | null;
    materialsGeneration?: number | null;
    profileVersion?: number | null;
    applicationUrl?: string | null;
    partialOverrideRunId?: string | null;
    emailRecipient?: string | null;
    emailAttachmentArtifactId?: string | null;
  };
  approvalGate: ApplyReviewApprovalGate;
  blockers: string[];
}

export interface ApplyReviewQueueResponse {
  ok: true;
  items: ApplyReviewQueueItem[];
}

export const RESUME_REVIEW_DRAFT_STATES = [
  "active",
  "rendered",
  "promoted",
  "abandoned",
] as const;
export type ResumeReviewDraftState = (typeof RESUME_REVIEW_DRAFT_STATES)[number];

export const RESUME_REVIEW_EDIT_KINDS = [
  "replace_text",
  "insert_text",
  "delete_text",
  "structure_change",
] as const;
export type ResumeReviewEditKind = (typeof RESUME_REVIEW_EDIT_KINDS)[number];

export const RESUME_COMMENT_THREAD_STATES = [
  "open",
  "user_replied",
  "resolved",
  "superseded_by_edit",
  "residual_after_acceptance",
] as const;
export type ResumeCommentThreadState = (typeof RESUME_COMMENT_THREAD_STATES)[number];

export const RESUME_COMMENT_REPLY_DECISIONS = [
  "accepted",
  "rejected",
  "clarified",
  "rewrite_requested",
] as const;
export type ResumeCommentReplyDecision = (typeof RESUME_COMMENT_REPLY_DECISIONS)[number];

export const TAILORING_FEEDBACK_SIGNAL_KINDS = [
  "style_preference",
  "factual_correction",
  "claim_policy_correction",
  "keyword_strategy",
  "provenance_dispute",
] as const;
export type TailoringFeedbackSignalKind = (typeof TAILORING_FEEDBACK_SIGNAL_KINDS)[number];

export const TAILORING_FEEDBACK_RULE_ALLOWLIST_VERSION = 1 as const;
export const TAILORING_FEEDBACK_RULE_KEYS = [
  "style_guidance",
  "fact_handling",
  "claim_policy",
  "keyword_strategy",
  "provenance_policy",
] as const;
export type TailoringFeedbackRuleKey = (typeof TAILORING_FEEDBACK_RULE_KEYS)[number];
export const TAILORING_FEEDBACK_RULE_VALUES = [
  "preserve_user_edit_pattern",
  "require_source_match",
  "omit_unsupported_claims",
  "use_supported_terms_only",
  "require_direct_evidence",
] as const;
export type TailoringFeedbackRuleValue = (typeof TAILORING_FEEDBACK_RULE_VALUES)[number];

export const TAILORING_FEEDBACK_RULE_ALLOWLIST = {
  style_preference: {
    ruleKey: "style_guidance",
    ruleValue: "preserve_user_edit_pattern",
  },
  factual_correction: {
    ruleKey: "fact_handling",
    ruleValue: "require_source_match",
  },
  claim_policy_correction: {
    ruleKey: "claim_policy",
    ruleValue: "omit_unsupported_claims",
  },
  keyword_strategy: {
    ruleKey: "keyword_strategy",
    ruleValue: "use_supported_terms_only",
  },
  provenance_dispute: {
    ruleKey: "provenance_policy",
    ruleValue: "require_direct_evidence",
  },
} as const satisfies Record<
  TailoringFeedbackSignalKind,
  { readonly ruleKey: TailoringFeedbackRuleKey; readonly ruleValue: TailoringFeedbackRuleValue }
>;

export const TAILORING_FEEDBACK_SIGNAL_STATUSES = [
  "candidate",
  "accepted",
  "rejected",
] as const;
export type TailoringFeedbackSignalStatus = (typeof TAILORING_FEEDBACK_SIGNAL_STATUSES)[number];

export const TAILORING_FEEDBACK_SOURCE_KINDS = ["edit_delta", "comment_reply"] as const;
export type TailoringFeedbackSourceKind = (typeof TAILORING_FEEDBACK_SOURCE_KINDS)[number];

export interface ResumeLineAnchor {
  semanticId: string | null;
  lineNumber: number | null;
  pageNumber: number | null;
  textHash: string | null;
}

export interface ResumeReviewEditDelta {
  deltaId: string;
  revisionId: string;
  kind: ResumeReviewEditKind;
  section: string | null;
  semanticId: string | null;
  lineAnchor: ResumeLineAnchor | null;
  beforeText: string;
  afterText: string;
  createdAt: string;
}

export interface ResumeReviewDraftRevision {
  revisionId: string;
  draftId: string;
  jobKey: string;
  revisionNumber: number;
  editedText: string;
  plateDocument: unknown | null;
  editDeltas: ResumeReviewEditDelta[];
  createdAt: string;
}

export interface ResumeCommentReply {
  replyId: string;
  threadId: string;
  draftRevisionId: string | null;
  author: string;
  decision: ResumeCommentReplyDecision;
  body: string;
  createdAt: string;
}

export interface ResumeCommentThread {
  threadId: string;
  draftId: string;
  jobKey: string;
  baseArtifactId: string | null;
  semanticId: string | null;
  lineAnchor: ResumeLineAnchor | null;
  sourcePinId: string | null;
  riskLabel: string | null;
  commentBody: string;
  state: ResumeCommentThreadState;
  anchorResolved: boolean;
  createdAt: string;
  updatedAt: string;
  replies: ResumeCommentReply[];
}

export interface TailoringFeedbackSignal {
  signalId: string;
  jobKey: string;
  draftId: string;
  draftRevisionId: string | null;
  sourceKind: TailoringFeedbackSourceKind;
  sourceId: string;
  kind: TailoringFeedbackSignalKind;
  status: TailoringFeedbackSignalStatus;
  summary: string;
  section: string | null;
  semanticId: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export type TailoringFeedbackReviewDecision = "accepted" | "rejected";

export interface TailoringFeedbackSignalReview {
  reviewId: string;
  signalId: string;
  revision: number;
  decision: TailoringFeedbackReviewDecision;
  signalKind: TailoringFeedbackSignalKind;
  ruleKey: TailoringFeedbackRuleKey | null;
  ruleValue: TailoringFeedbackRuleValue | null;
  allowlistVersion: typeof TAILORING_FEEDBACK_RULE_ALLOWLIST_VERSION;
  contradictsSignalIds: string[];
  reviewedAt: string;
}

export interface ResumeReviewDraft {
  draftId: string;
  jobKey: string;
  baseGeneration: number;
  baseResumeTextArtifactId: string | null;
  baseResumePdfArtifactId: string | null;
  rendererFormat: string;
  state: ResumeReviewDraftState;
  currentRevisionId: string | null;
  latestRevisionNumber: number;
  createdAt: string;
  updatedAt: string;
  latestRevision: ResumeReviewDraftRevision | null;
  commentThreads: ResumeCommentThread[];
  feedbackSignals: TailoringFeedbackSignal[];
}

export const ResumeReviewDraftCreateRequestSchema = z
  .object({
    generation: z.coerce.number().int().min(0).optional(),
    resumeTextArtifactId: z.string().trim().min(1).max(240).optional(),
    resumePdfArtifactId: z.string().trim().min(1).max(240).optional(),
    rendererFormat: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type ResumeReviewDraftCreateRequest = z.infer<
  typeof ResumeReviewDraftCreateRequestSchema
>;

const ResumeLineAnchorSchema = z
  .object({
    semanticId: z.string().trim().max(240).nullable().optional(),
    lineNumber: z.coerce.number().int().min(1).max(500).nullable().optional(),
    pageNumber: z.coerce.number().int().min(1).max(50).nullable().optional(),
    textHash: z.string().trim().max(128).nullable().optional(),
  })
  .strict();

export const ResumeReviewEditDeltaInputSchema = z
  .object({
    deltaId: z.string().trim().min(1).max(160).optional(),
    kind: z.enum(RESUME_REVIEW_EDIT_KINDS).default("replace_text"),
    section: z.string().trim().max(160).nullable().optional(),
    semanticId: z.string().trim().max(240).nullable().optional(),
    lineAnchor: ResumeLineAnchorSchema.nullable().optional(),
    beforeText: z.string().max(6000).default(""),
    afterText: z.string().max(6000).default(""),
  })
  .strict();
export type ResumeReviewEditDeltaInput = z.infer<
  typeof ResumeReviewEditDeltaInputSchema
>;

export const ResumeReviewDraftRevisionSaveRequestSchema = z
  .object({
    editedText: z.string().max(128_000),
    plateDocument: z.unknown().optional(),
    editDeltas: z.array(ResumeReviewEditDeltaInputSchema).max(200).default([]),
  })
  .strict();
export type ResumeReviewDraftRevisionSaveRequest = z.infer<
  typeof ResumeReviewDraftRevisionSaveRequestSchema
>;

export const ResumeReviewCommentThreadSeedInputSchema = z
  .object({
    threadId: z.string().trim().min(1).max(160).optional(),
    baseArtifactId: z.string().trim().max(240).nullable().optional(),
    semanticId: z.string().trim().max(240).nullable().optional(),
    lineAnchor: ResumeLineAnchorSchema.nullable().optional(),
    sourcePinId: z.string().trim().max(240).nullable().optional(),
    riskLabel: z.string().trim().max(160).nullable().optional(),
    commentBody: z.string().trim().min(1).max(4000),
  })
  .strict();
export type ResumeReviewCommentThreadSeedInput = z.infer<
  typeof ResumeReviewCommentThreadSeedInputSchema
>;

export const ResumeReviewCommentThreadSeedRequestSchema = z
  .object({
    threads: z.array(ResumeReviewCommentThreadSeedInputSchema).max(100).default([]),
  })
  .strict();
export type ResumeReviewCommentThreadSeedRequest = z.infer<
  typeof ResumeReviewCommentThreadSeedRequestSchema
>;

export const ResumeCommentReplyRequestSchema = z
  .object({
    draftRevisionId: z.string().trim().min(1).max(160).optional(),
    author: z.string().trim().min(1).max(120).default("user"),
    decision: z.enum(RESUME_COMMENT_REPLY_DECISIONS),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
export type ResumeCommentReplyRequest = z.infer<typeof ResumeCommentReplyRequestSchema>;

export interface ResumeReviewDraftResponse {
  ok: true;
  draft: ResumeReviewDraft;
}

export interface ResumeReviewDraftRevisionResponse {
  ok: true;
  draft: ResumeReviewDraft;
  revision: ResumeReviewDraftRevision;
}

export interface ResumeReviewCommentThreadSeedResponse {
  ok: true;
  draft: ResumeReviewDraft;
  commentThreads: ResumeCommentThread[];
  seededCount: number;
  updatedCount: number;
}

export interface ResumeCommentReplyResponse {
  ok: true;
  thread: ResumeCommentThread;
  reply: ResumeCommentReply;
  feedbackSignal: TailoringFeedbackSignal;
}

export interface ResumeReviewFeedbackListResponse {
  ok: true;
  jobKey: string;
  feedbackSignals: TailoringFeedbackSignal[];
}

const TailoringLearningSignalIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^tailoring-feedback:[A-Za-z0-9_.:-]+:[1-9][0-9]*$/);

export const TailoringFeedbackSignalReviewRequestSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("accepted"),
      ruleKey: z.enum(TAILORING_FEEDBACK_RULE_KEYS),
      ruleValue: z.enum(TAILORING_FEEDBACK_RULE_VALUES),
      contradictsSignalIds: z
        .array(TailoringLearningSignalIdSchema)
        .max(100)
        .default([])
        .transform((values) => [...new Set(values)].sort()),
    })
    .strict(),
  z.object({ decision: z.literal("rejected") }).strict(),
]);
export type TailoringFeedbackSignalReviewRequest = z.infer<
  typeof TailoringFeedbackSignalReviewRequestSchema
>;

export interface TailoringFeedbackSignalReviewResponse {
  ok: true;
  review: TailoringFeedbackSignalReview;
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
    interviewPrepGeneration: z.number().int().positive().optional(),
  })
  .refine((value) => value.interviewPrepGeneration === undefined || value.kind === "interview", {
    message: "interviewPrepGeneration is only valid for interview outcomes.",
    path: ["interviewPrepGeneration"],
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
  interviewPrepGeneration: number | null;
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
    sourceIds: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
  })
  .strict()
  .refine((value) => new Set(value.stages).size === value.stages.length, {
    message: "stages must be unique.",
    path: ["stages"],
  })
  .refine((value) => !value.sourceIds || new Set(value.sourceIds).size === value.sourceIds.length, {
    message: "sourceIds must be unique.",
    path: ["sourceIds"],
  })
  .refine((value) => !value.sourceIds?.length || value.stages.includes("discover"), {
    message: "sourceIds can only be used when running discover.",
    path: ["sourceIds"],
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
export const AUTO_APPROVABLE_CLAIM_MODES = ["verified_only", "evidence_reframing", "adjacent_translation"] as const;
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
  const hasExplicitClaimMode = policy.claim_mode !== undefined;
  let claimMode: (typeof CLAIM_MODES)[number] = policy.claim_mode ?? "evidence_reframing";
  if (!hasExplicitClaimMode && mode === "strict") {
    claimMode = "verified_only";
  } else if (!hasExplicitClaimMode && policy.allow_adjacent_achievement_drafts === true) {
    claimMode = "draft_requires_confirmation";
  } else if (!hasExplicitClaimMode && policy.allow_minor_inference === true) {
    claimMode = "adjacent_translation";
  }
  const autoApprovable = (policy.auto_approvable_claim_modes ?? ["verified_only", "evidence_reframing"]).filter(
    (claimMode): claimMode is (typeof AUTO_APPROVABLE_CLAIM_MODES)[number] =>
      (AUTO_APPROVABLE_CLAIM_MODES as readonly string[]).includes(claimMode),
  );
  const normalized = {
    mode,
    allow_title_reframing: false,
    allow_achievement_rewriting: policy.allow_achievement_rewriting ?? mode !== "strict",
    allow_skill_reordering: policy.allow_skill_reordering ?? mode !== "strict",
    allow_summary_rewrite: policy.allow_summary_rewrite ?? mode !== "strict",
    allow_minor_inference: policy.allow_minor_inference ?? false,
    claim_mode: claimMode,
    auto_approvable_claim_modes: autoApprovable.length
      ? autoApprovable
      : mode === "strict" && policy.auto_approvable_claim_modes === undefined
        ? (["verified_only"] as const)
        : (["verified_only", "evidence_reframing"] as const),
    allow_adjacent_achievement_drafts: claimMode === "draft_requires_confirmation",
  };
  return normalized;
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

const ProfileRevisionGatesSchema = z
  .object({
    min_fit_score: z.number().int().min(1).max(10).default(8),
    must_have_coverage: z.number().min(0).max(1).default(0.85),
    max_revision_attempts: z.number().int().min(0).default(1),
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
    revision_gates: ProfileRevisionGatesSchema.default({}),
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

const NullableAttestationSchema = z.boolean().nullable().default(null);

const DEFAULT_APPLICATION_ATTESTATIONS = {
  age_18_plus: null,
  background_check_consent: null,
  felony_conviction: null,
  previously_worked_at_employer: null,
  additional: {},
} as const;

const ProfileApplicationAttestationsSchema = z
  .object({
    age_18_plus: NullableAttestationSchema,
    background_check_consent: NullableAttestationSchema,
    felony_conviction: NullableAttestationSchema,
    previously_worked_at_employer: NullableAttestationSchema,
    additional: z
      .record(z.string(), z.union([z.boolean(), z.string(), z.null()]))
      .default({}),
  })
  .default(DEFAULT_APPLICATION_ATTESTATIONS);

const ProfileApplicationPreferencesSchema = z
  .object({
    how_heard: z.string().default(""),
  })
  .default({ how_heard: "" });

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
    application_attestations: ProfileApplicationAttestationsSchema,
    application_preferences: ProfileApplicationPreferencesSchema,
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
    applyConcurrency: z.coerce.number().int().min(1).max(16).optional(),
    workerActivitySlots: z.coerce.number().int().min(1).max(64).optional(),
    dailyBudgetUsd: z.coerce.number().min(0).optional(),
    analysisLegs: z.array(z.enum(["codex", "claude", "google"])).min(1).optional(),
    tailoringGeneratorModels: z.array(z.string().trim().min(1).max(160)).min(1).nullable().optional(),
    tailoringJudgeModel: z.string().trim().min(1).max(160).nullable().optional(),
    tailoringJudgeMinScore: z.coerce.number().min(0).max(1).optional(),
    applyMaxBudgetUsd: z.coerce.number().min(0).optional(),
    applyTimeoutSeconds: z.coerce.number().int().min(60).max(3600).optional(),
    scoreCriteria: z.string().max(8000).optional(),
    targetCriteria: z.string().max(8000).optional(),
    preferredModels: z
      .object({
        codex: z.string().trim().min(1).max(160).nullable().optional(),
        claude: z.string().trim().min(1).max(160).nullable().optional(),
        google: z.string().trim().min(1).max(160).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequestSchema>;

export const CredentialKeys = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "AWS_PROFILE",
  "AWS_REGION",
  "GEMINI_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CAPSOLVER_API_KEY",
] as const;
export type CredentialKey = (typeof CredentialKeys)[number];

export const SecretCredentialKeys = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "CAPSOLVER_API_KEY",
] as const satisfies readonly CredentialKey[];
export type SecretCredentialKey = (typeof SecretCredentialKeys)[number];

export const ProviderConfigurationKeys = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "AWS_PROFILE",
  "AWS_REGION",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const satisfies readonly CredentialKey[];
export type ProviderConfigurationKey = (typeof ProviderConfigurationKeys)[number];

export const CREDENTIAL_VALUE_MAX_LENGTH = 8_000;
const CREDENTIAL_VALUE_UNSAFE_CHARACTERS = /[\r\n\u0000]/u;

export const CredentialUpdateRequestSchema = z
  .object({
    key: z.enum(CredentialKeys),
    value: z
      .string()
      .min(1, "Credential value is required.")
      .max(
        CREDENTIAL_VALUE_MAX_LENGTH,
        "Credential value exceeds the supported length.",
      )
      .refine((value) => !CREDENTIAL_VALUE_UNSAFE_CHARACTERS.test(value), {
        message:
          "Credential value must not contain carriage returns, line feeds, or NUL characters.",
      }),
  })
  .strict();
export type CredentialUpdateRequest = z.infer<typeof CredentialUpdateRequestSchema>;

export const CredentialBatchOperationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("set"),
      key: z.enum(CredentialKeys),
      value: CredentialUpdateRequestSchema.shape.value,
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      key: z.enum(CredentialKeys),
    })
    .strict(),
]);
export type CredentialBatchOperation = z.infer<typeof CredentialBatchOperationSchema>;

export const CredentialBatchUpdateRequestSchema = z
  .object({
    operations: z
      .array(CredentialBatchOperationSchema)
      .min(1, "At least one credential operation is required.")
      .max(CredentialKeys.length),
  })
  .strict()
  .superRefine(({ operations }, context) => {
    const seen = new Set<CredentialKey>();
    for (const operation of operations) {
      if (seen.has(operation.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each credential key may appear only once per batch.",
          path: ["operations"],
        });
      }
      seen.add(operation.key);
    }
  });
export type CredentialBatchUpdateRequest = z.infer<
  typeof CredentialBatchUpdateRequestSchema
>;

export const ProviderIds = ["codex", "claude", "google"] as const;
export type ProviderId = (typeof ProviderIds)[number];

export const ProviderModelCatalogSourceSchema = z.literal("live");
export type ProviderModelCatalogSource = z.infer<typeof ProviderModelCatalogSourceSchema>;

export const ProviderModelSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    displayName: z.string().trim().min(1).max(160),
    isDefault: z.boolean().optional(),
  })
  .strict();
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

export const ProviderModelCatalogItemSchema = z
  .object({
    provider: z.enum(ProviderIds),
    configured: z.boolean(),
    ready: z.boolean(),
    source: ProviderModelCatalogSourceSchema,
    models: z.array(ProviderModelSchema).max(512),
    message: z.string().trim().min(1).max(240).optional(),
  })
  .strict();
export type ProviderModelCatalogItem = z.infer<typeof ProviderModelCatalogItemSchema>;

export const ProviderModelCatalogResultSchema = z
  .object({
    providers: z.array(ProviderModelCatalogItemSchema).length(ProviderIds.length),
  })
  .strict()
  .superRefine(({ providers }, context) => {
    for (const [index, provider] of providers.entries()) {
      if (provider.provider !== ProviderIds[index]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `providers must use stable ${ProviderIds.join(", ")} order`,
          path: ["providers", index, "provider"],
        });
      }
      if (provider.source !== "live") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${provider.provider} catalog source must be live`,
          path: ["providers", index, "source"],
        });
      }
      if (!provider.ready && provider.models.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unready providers must not return models",
          path: ["providers", index, "models"],
        });
      }
    }
  });

export const ProviderStatusModeSchema = z.string().trim().min(1).max(80).nullable();

export const ProviderStatusItemSchema = z
  .object({
    provider: z.enum(ProviderIds),
    configured: z.boolean(),
    ready: z.boolean(),
    mode: ProviderStatusModeSchema,
    message: z.string().trim().max(240).optional(),
  })
  .strict();
export type ProviderStatusItem = z.infer<typeof ProviderStatusItemSchema>;

export const ProviderStatusResultSchema = z
  .object({
    providers: z.array(ProviderStatusItemSchema).max(ProviderIds.length),
  })
  .strict();

export const CodexVerifyResultSchema = z
  .object({
    provider: z.literal("codex"),
    ok: z.boolean(),
    status: z.enum(["connected", "not_configured", "failed"]),
    message: z.string().trim().min(1).max(240),
  })
  .strict();

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
    normalizedScoreKeyword: z.string().min(1).optional(),
    minFitScore: optionalNumber,
    maxFitScore: optionalNumber,
    discoveredSince: IsoTimestampSchema.optional().catch(undefined),
    discovered_since: IsoTimestampSchema.optional().catch(undefined),
    scoredSince: IsoTimestampSchema.optional().catch(undefined),
    scored_since: IsoTimestampSchema.optional().catch(undefined),
  })
  .transform((value) => ({
    ...value,
    pageSize: value.pageSize ?? value.page_size ?? 50,
    discoveredSince: value.discoveredSince ?? value.discovered_since,
    scoredSince: value.scoredSince ?? value.scored_since,
  }));

export type JobListQuery = z.infer<typeof JobListQuerySchema>;

export const ScoringKeywordAggregationItemSchema = z
  .object({
    normalizedKeyword: z.string().min(1),
    displayKeyword: z.string().min(1),
    scoreVersion: z.number().int().positive(),
    jobCount: z.number().int().positive(),
  })
  .strict();
export type ScoringKeywordAggregationItem = z.infer<typeof ScoringKeywordAggregationItemSchema>;

export const ScoringKeywordAggregationResponseSchema = z
  .object({
    ok: z.literal(true),
    keywords: z.array(ScoringKeywordAggregationItemSchema),
  })
  .strict();
export type ScoringKeywordAggregationResponse = z.infer<typeof ScoringKeywordAggregationResponseSchema>;

export const LearningRecommendationIdSchema = z
  .string()
  .regex(/^learning-recommendation:[a-f0-9]{64}$/);

export const LearningRecommendationReviewIdSchema = z
  .string()
  .regex(/^learning-recommendation-review:[a-f0-9]{64}$/);

const LearningEvidenceIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);

const LearningEvidenceJobIdSchema = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  );

export const LearningPaginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).catch(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().catch(undefined),
    page_size: z.coerce.number().int().min(1).max(100).optional().catch(undefined),
  })
  .transform((value) => ({
    page: value.page,
    pageSize: value.pageSize ?? value.page_size ?? 50,
  }));
export type LearningPaginationQuery = z.infer<typeof LearningPaginationQuerySchema>;

export const TailoringPolicyRevisionListQuerySchema = LearningPaginationQuerySchema;
export type TailoringPolicyRevisionListQuery = z.infer<
  typeof TailoringPolicyRevisionListQuerySchema
>;

export const TailoringPolicyLearnedRuleSchema = z.discriminatedUnion("ruleKey", [
  z
    .object({
      ruleKey: z.literal("style_guidance"),
      ruleValue: z.literal("preserve_user_edit_pattern"),
    })
    .strict(),
  z
    .object({
      ruleKey: z.literal("fact_handling"),
      ruleValue: z.literal("require_source_match"),
    })
    .strict(),
  z
    .object({
      ruleKey: z.literal("claim_policy"),
      ruleValue: z.literal("omit_unsupported_claims"),
    })
    .strict(),
  z
    .object({
      ruleKey: z.literal("keyword_strategy"),
      ruleValue: z.literal("use_supported_terms_only"),
    })
    .strict(),
  z
    .object({
      ruleKey: z.literal("provenance_policy"),
      ruleValue: z.literal("require_direct_evidence"),
    })
    .strict(),
]);
export type TailoringPolicyLearnedRule = z.infer<typeof TailoringPolicyLearnedRuleSchema>;

export const TailoringPolicyRevisionSummarySchema = z
  .object({
    context: z.literal("materials"),
    policyKind: z.literal("tailoring_rule"),
    version: z.number().int().positive(),
    status: z.enum(["current", "superseded"]),
    learnedRules: z.array(TailoringPolicyLearnedRuleSchema).max(5),
    sourceReviewId: LearningRecommendationReviewIdSchema.nullable(),
    sourceRecommendationId: LearningRecommendationIdSchema.nullable(),
    rollbackOfVersion: z.number().int().positive().nullable(),
    rollbackReasonCode: z.enum(["user_requested", "historical_or_unspecified"]).nullable(),
    createdAt: IsoTimestampSchema,
  })
  .strict()
  .refine(
    (value) => (value.sourceReviewId === null) === (value.sourceRecommendationId === null),
    "Policy recommendation and review provenance must be present together.",
  )
  .refine(
    (value) => (value.rollbackOfVersion === null) === (value.rollbackReasonCode === null),
    "Policy rollback version and reason must be present together.",
  );
export type TailoringPolicyRevisionSummary = z.infer<
  typeof TailoringPolicyRevisionSummarySchema
>;

export const TailoringPolicyRevisionListResponseSchema = z
  .object({
    ok: z.literal(true),
    revisions: z.array(TailoringPolicyRevisionSummarySchema).max(100),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) => value.revisions.length <= value.pageSize,
    "Policy revision page exceeds its declared page size.",
  )
  .refine(
    (value) => value.revisions.filter((revision) => revision.status === "current").length <= 1,
    "Policy revision page contains multiple current revisions.",
  );
export type TailoringPolicyRevisionListResponse = z.infer<
  typeof TailoringPolicyRevisionListResponseSchema
>;

export const LearningRecommendationSummarySchema = z
  .object({
    recommendationId: LearningRecommendationIdSchema,
    derivationVersion: z.number().int().positive(),
    evaluationFixtureVersion: z.number().int().positive(),
    context: z.literal("materials"),
    policyKind: z.literal("tailoring_rule"),
    signalKind: z.enum([
      "style_preference",
      "factual_correction",
      "claim_policy_correction",
      "keyword_strategy",
      "provenance_dispute",
    ]),
    ruleKey: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/),
    ruleValue: z.string().min(1).max(160).regex(/^[a-z0-9_]+$/),
    allowlistVersion: z.number().int().positive(),
    status: z.literal("pending"),
    active: z.boolean(),
    observedSignalCount: z.number().int().min(3),
    observedJobCount: z.number().int().min(2),
    minimumSignalCount: z.number().int().min(3),
    minimumJobCount: z.number().int().min(2),
    confidenceLimit: z.literal("sample_gated_no_population_inference"),
    supportingEvidenceCount: z.number().int().min(3),
    contradictingEvidenceCount: z.number().int().nonnegative(),
    tombstoneCount: z.number().int().nonnegative(),
    derivedAt: IsoTimestampSchema,
  })
  .strict();
export type LearningRecommendationSummary = z.infer<
  typeof LearningRecommendationSummarySchema
>;

export const LearningRecommendationEvidenceListQuerySchema =
  LearningPaginationQuerySchema;
export type LearningRecommendationEvidenceListQuery = z.infer<
  typeof LearningRecommendationEvidenceListQuerySchema
>;

export const LearningRecommendationEvidenceLinkSchema = z
  .object({
    signalId: LearningEvidenceIdentifierSchema,
    evidenceRole: z.enum(["supporting", "contradicting"]),
    sourceKind: z.literal("tailoring_feedback_signal"),
    sourceRevision: z.number().int().positive(),
    jobId: LearningEvidenceJobIdSchema,
    recordedAt: IsoTimestampSchema,
  })
  .strict();
export type LearningRecommendationEvidenceLink = z.infer<
  typeof LearningRecommendationEvidenceLinkSchema
>;

export const LearningRecommendationEvidenceListResponseSchema = z
  .object({
    ok: z.literal(true),
    recommendationId: LearningRecommendationIdSchema,
    evidence: z.array(LearningRecommendationEvidenceLinkSchema).max(100),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) => value.evidence.length <= value.pageSize,
    "Recommendation evidence page exceeds its declared page size.",
  );
export type LearningRecommendationEvidenceListResponse = z.infer<
  typeof LearningRecommendationEvidenceListResponseSchema
>;

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
// `workflow_run_projections` is the unified workflow-run source (Python-sole-
// writer, folded from the `Workflow*` lifecycle events) covering every
// workflow type. Apply rows are enriched with job context via a LEFT JOIN to
// `apply_run_projections`, the apply-specific detail projection. The run id is
// the Temporal workflow id, so the deep-link uses it verbatim.
// `WorkflowRunStatusSchema` widens beyond `ApplyRunStatus` so non-apply
// workflows land here without another migration.
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
    workflowType: z.string().trim().min(1).optional().catch(undefined),
    startedSince: IsoTimestampSchema.optional().catch(undefined),
    startedBefore: IsoTimestampSchema.optional().catch(undefined),
    sort: z.enum(WORKFLOW_RUN_SORT_FIELDS).default("started_at").catch("started_at"),
    dir: SortDirectionSchema,
  })
  .transform((value) => ({
    page: value.page,
    pageSize: value.pageSize ?? value.page_size ?? 50,
    status: value.status,
    workflowType: value.workflowType,
    startedSince: value.startedSince,
    startedBefore: value.startedBefore,
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
  /**
   * Temporal workflow type (e.g. `JobPipelineWorkflow`, `ApplyWorkflow`).
   * Empty string for legacy apply rows that predate the Workflow* events.
   */
  readonly workflowType: string;
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

export interface WorkflowRunTimelineEvent {
  readonly eventType: string;
  readonly occurredAt: string | null;
  readonly status: string | null;
  readonly message: string | null;
}

export interface WorkflowRunDetail {
  readonly workflowId: string;
  readonly runId: string;
  readonly workflowType: string;
  readonly status: WorkflowRunStatus;
  readonly jobKey: string;
  readonly title: string;
  readonly company: string;
  readonly dryRun: boolean;
  readonly model: string | null;
  readonly result: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean;
  readonly inputSummary: Record<string, unknown>;
  readonly temporalRunId: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly events: readonly WorkflowRunTimelineEvent[];
}

export const APPLY_URL_OUTCOME_CODES = [
  "APPLY_URL_EXTERNAL_RECOVERED",
  "APPLY_URL_LINKEDIN_ONSITE",
  "APPLY_URL_CONTROL_MISSING",
  "APPLY_URL_EXTERNAL_TARGET_MISSING",
  "APPLY_URL_NAVIGATION_FAILED",
  "APPLY_URL_UNSAFE_TARGET",
] as const;
export type ApplyUrlOutcomeCode = (typeof APPLY_URL_OUTCOME_CODES)[number];

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
  failureReason?: StageFailureReason | null;
  retryable: boolean;
  blockedBy: string[];
  nextAction: string | null;
  /**
   * Allow-listed application-target readiness fact captured by Enrichment.
   * This stays separate from stage failure state because LinkedIn on-site
   * apply is a successful terminal discovery, not an Enrich failure.
  */
  applyUrlOutcome?: {
    code: ApplyUrlOutcomeCode;
    message: string;
    retryable: boolean;
    method: string | null;
  } | null;
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
  jobId: string;
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

export const EVIDENCE_MAP_ENTRY_KINDS = ["achievement_evidence", "skill"] as const;
export type EvidenceMapEntryKind = (typeof EVIDENCE_MAP_ENTRY_KINDS)[number];

export const EVIDENCE_USAGE_REF_KINDS = [
  "resume_bullet",
  "requirement_fit",
  "skill_coverage",
] as const;
export type EvidenceUsageRefKind = (typeof EVIDENCE_USAGE_REF_KINDS)[number];

export const EVIDENCE_GAP_KINDS = [
  "missing_requirement",
  "blocked_requirement",
  "transferable_requirement",
  "missing_skill",
] as const;
export type EvidenceGapKind = (typeof EVIDENCE_GAP_KINDS)[number];

/**
 * One recorded use of a profile proof point or skill.
 *
 * This is a read-model reference, not a new fact. Resume usages come from
 * bullet provenance rows; requirement usages come from requirement-fit items;
 * skill coverage comes from the generation-time coverage audit. Optional fields
 * are scoped by ``kind`` so callers can deep-link without guessing.
 */
export interface EvidenceUsageRef {
  kind: EvidenceUsageRefKind;
  jobKey: string;
  jobTitle: string | null;
  employer: string | null;
  artifactId: string | null;
  bulletId: string | null;
  generation: number | null;
  generatedTextPreview: string | null;
  scoreVersion: number | null;
  requirementId: string | null;
  requirementText: string | null;
  requirementFitKind: RequirementFitStatus["kind"] | null;
  artifactCoverageState: RequirementArtifactCoverage["state"] | null;
  keyword: string | null;
  coverageState: "covered" | "declared" | "missing" | null;
  occurredAt: string | null;
}

export interface EvidenceFreshness {
  evidenceDateRange: string | null;
  evidenceStrength: "verified" | "supported" | "inferred" | "draft" | string | null;
  userConfirmed: boolean;
  claimConfidence: number | null;
  lastUsedAt: string | null;
}

export interface EvidenceReusableStory {
  scope: string;
  action: string;
  outcome: string;
  metrics: string[];
}

export interface EvidenceGap {
  gapId: string;
  kind: EvidenceGapKind;
  requirementId: string | null;
  requirementText: string;
  demandedSkill: string | null;
  tier: "must_have" | "nice_to_have" | string | null;
  weight: number | null;
  fitKind: RequirementFitStatus["kind"] | null;
  reason: string;
  jobRefs: EvidenceUsageRef[];
}

export interface EvidenceMapEntry {
  entryId: string;
  kind: EvidenceMapEntryKind;
  evidenceId: string | null;
  skillId: string | null;
  title: string;
  story: EvidenceReusableStory | null;
  skills: string[];
  tags: string[];
  freshness: EvidenceFreshness;
  resumeUsages: EvidenceUsageRef[];
  requirementUsages: EvidenceUsageRef[];
  coverageUsages: EvidenceUsageRef[];
  gaps: EvidenceGap[];
}

export interface EvidenceMapResponse {
  ok: true;
  entries: EvidenceMapEntry[];
  gaps: EvidenceGap[];
  generatedAt: string;
}

export const INTERVIEW_PREP_ITEM_KINDS = [
  "theme",
  "star_draft",
  "gap_drill",
  "company_note",
] as const;
export type InterviewPrepItemKind = (typeof INTERVIEW_PREP_ITEM_KINDS)[number];

export const INTERVIEW_PREP_STATUSES = ["accepted", "failed", "superseded"] as const;
export type InterviewPrepStatus = (typeof INTERVIEW_PREP_STATUSES)[number];

export interface InterviewPrepGateAudit {
  status: "passed" | "failed";
  fabricationFindings: string[];
  groundingFindings: string[];
  judgeVerdict: string | null;
  warnings: string[];
}

export interface InterviewPrepItem {
  itemId: string;
  kind: InterviewPrepItemKind;
  title: string;
  generatedText: string;
  evidenceIds: string[];
  requirementIds: string[];
  sourceText: string[];
  transformType: string;
  control: string;
  groundingAudit: string[];
  warnings: string[];
  position: number;
}

export interface InterviewPrep {
  jobId: string;
  generation: number;
  status: InterviewPrepStatus;
  generatedAt: string;
  model: string | null;
  gateAudit: InterviewPrepGateAudit;
  items: InterviewPrepItem[];
}

export interface InterviewPrepResponse {
  ok: true;
  prep: InterviewPrep | null;
}

export interface GenerateInterviewPrepResponse {
  ok: true;
  runId: string | null;
  workflowId: string | null;
  firstExecutionRunId: string | null;
  prep: InterviewPrep | null;
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
  benchmarkKind: "direct" | "extrapolated" | null;
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
  posted: JobCompensationAuditPostedResponse;
  market: JobCompensationAuditMarketResponse;
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
  failureReason?: StageFailureReason | null;
  nextAction: string | null;
  artifactCount: number;
  applyStatus: string | null;
  appliedAt: string | null;
  activeState: ActiveState;
  deletedAt: string | null;
  hiddenAt: string | null;
  resumeTemplate?: ResumeTemplateState | null;
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
  resumeTemplate?: ResumeTemplateState | null;
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
  /** Canonical workflow id when the event payload carries run ownership. */
  workflowId: string | null;
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

export const DiscoveryProviderProgressSchema = z
  .object({
    site: z.string().min(1),
    phase: z.string().min(1),
    unit: z.string().min(1),
    completedUnits: z.number().int().nonnegative(),
    totalUnits: z.number().int().nonnegative().nullable(),
    rawItemsSeen: z.number().int().nonnegative().nullable(),
    jobsEmitted: z.number().int().nonnegative(),
    hasMore: z.boolean().nullable(),
  })
  .strict();
export type DiscoveryProviderProgress = z.infer<
  typeof DiscoveryProviderProgressSchema
>;

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
    recoveredUnits?: number | null;
  };
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Pipeline operations read model
//
// This is deliberately separate from PipelineProgressSummary. The legacy
// progress payload describes a stage's current progress line; this snapshot
// describes an execution-scoped operational view, including the capacity and
// external backlog that make an overall completion percentage misleading.
// ---------------------------------------------------------------------------

export const PIPELINE_OPERATIONS_PHASES = [
  "discovering",
  "draining",
  "completed",
  "completed_with_issues",
  "failed",
  "canceled",
] as const;
export const PipelineOperationsPhaseSchema = z.enum(PIPELINE_OPERATIONS_PHASES);
export type PipelineOperationsPhase = z.infer<typeof PipelineOperationsPhaseSchema>;

export const PIPELINE_OPERATIONS_STAGE_SCOPES = [
  "current_execution",
  "execution_sweep",
  "global_outside_execution",
] as const;
export const PipelineOperationalStageScopeSchema = z.enum(PIPELINE_OPERATIONS_STAGE_SCOPES);
export type PipelineOperationalStageScope = z.infer<typeof PipelineOperationalStageScopeSchema>;

export const PipelineStageCountsSchema = z
  .object({
    /** The number of items the owning source has determined are in scope. */
    eligible: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    exhausted: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
    needsVerification: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  })
  .strict();
export type PipelineStageCounts = z.infer<typeof PipelineStageCountsSchema>;

export const PipelineOperationsFreshnessSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("fresh"),
      asOf: z.string(),
      staleAfterSeconds: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      asOf: z.string(),
      staleAfterSeconds: z.number().int().positive(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("unsupported"),
      asOf: z.string(),
      staleAfterSeconds: z.number().int().positive(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      asOf: z.string(),
      staleAfterSeconds: z.number().int().positive(),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type PipelineOperationsFreshness = z.infer<typeof PipelineOperationsFreshnessSchema>;

export const PipelineTaskQueueStatsSchema = z
  .object({
    pollerCount: z.number().int().nonnegative(),
    approximateBacklogCount: z.number().int().nonnegative(),
    approximateBacklogAgeSeconds: z.number().nonnegative(),
    tasksAddRate: z.number().nonnegative(),
    tasksDispatchRate: z.number().nonnegative(),
  })
  .strict();
export type PipelineTaskQueueStats = z.infer<typeof PipelineTaskQueueStatsSchema>;

export const PipelineApproximateTaskQueueSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      observedAt: z.string(),
      workflow: PipelineTaskQueueStatsSchema,
      activity: PipelineTaskQueueStatsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      observedAt: z.string(),
      lastKnownStatus: z.enum(["available", "unsupported", "unavailable"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("unsupported"),
      observedAt: z.string(),
      reasonCode: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      observedAt: z.string(),
      reasonCode: z.string().min(1),
    })
    .strict(),
]);
export type PipelineApproximateTaskQueue = z.infer<typeof PipelineApproximateTaskQueueSchema>;

const PipelineAvailableCapacityBaseSchema = z.object({
  status: z.literal("available"),
  asOf: z.string(),
  staleAfterSeconds: z.number().int().positive(),
  taskQueue: z.string().nullable(),
  freshWorkerCount: z.number().int().nonnegative(),
  staleWorkerCount: z.number().int().nonnegative(),
  invalidWorkerCount: z.number().int().nonnegative(),
  configuredSlots: z.number().int().nonnegative(),
  activeSlots: z.number().int().nonnegative(),
  availableSlots: z.number().int().nonnegative(),
  executorThreads: z.number().int().nonnegative(),
  slotSaturation: z.number().min(0).max(1).nullable(),
  approximateTaskQueue: PipelineApproximateTaskQueueSchema,
});

const PipelineAvailableCapacitySchema = z.discriminatedUnion("kind", [
  PipelineAvailableCapacityBaseSchema.extend({
    kind: z.literal("shared_activity_pool"),
  }).strict(),
  PipelineAvailableCapacityBaseSchema.extend({
    kind: z.literal("shared_activity_pool_with_internal_parallelism"),
    internalParallelism: z.number().int().positive(),
  }).strict(),
]);

export const PipelineCapacitySchema = z.union([
  PipelineAvailableCapacitySchema,
  z
    .object({
      status: z.literal("stale"),
      asOf: z.string(),
      staleAfterSeconds: z.number().int().positive(),
      taskQueue: z.string().nullable(),
      reason: z.string().min(1),
      approximateTaskQueue: PipelineApproximateTaskQueueSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      asOf: z.string(),
      staleAfterSeconds: z.number().int().positive(),
      taskQueue: z.string().nullable(),
      reason: z.string().min(1),
      approximateTaskQueue: PipelineApproximateTaskQueueSchema,
    })
    .strict(),
]);
export type PipelineCapacity = z.infer<typeof PipelineCapacitySchema>;

export const PipelineEtaSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      lowSeconds: z.number().nonnegative(),
      highSeconds: z.number().nonnegative(),
      confidence: z.enum(["low", "medium", "high"]),
      basis: z.enum(["source_rate", "stage_throughput", "cohort_throughput"]),
      sampleSize: z.number().int().nonnegative(),
      asOf: z.string(),
      caveat: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("calibrating"),
      completedSamples: z.number().int().nonnegative(),
      minimumSamples: z.number().int().positive(),
      asOf: z.string(),
      reason: z.enum(["insufficient_samples", "membership_open"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("paused"),
      reason: z.enum(["worker_unavailable", "budget_exceeded", "blocked", "no_dispatch"]),
      asOf: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      reason: z.enum(["telemetry_stale", "observation_stale", "unknown_scope"]),
      asOf: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.enum([
        "no_work",
        "telemetry_stale",
        "unsupported",
        "unknown_scope",
        "contention_unbounded",
      ]),
      asOf: z.string(),
    })
    .strict(),
]);
export type PipelineEta = z.infer<typeof PipelineEtaSchema>;

export const PipelineExecutionCohortSummarySchema = z
  .object({
    members: z.number().int().nonnegative(),
    planned: z.number().int().nonnegative(),
    notEligible: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failedPlan: z.number().int().nonnegative(),
    terminal: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  })
  .strict();
export type PipelineExecutionCohortSummary = z.infer<typeof PipelineExecutionCohortSummarySchema>;

export const DiscoveryExecutionSummarySchema = z
  .object({
    discoverWorkflowId: z.string().min(1),
    discoverRunId: z.string().min(1),
    selectedAs: z.enum(["active_or_draining", "latest_terminal"]),
    workflowStatus: z.enum(WORKFLOW_RUN_STATUSES),
    phase: PipelineOperationsPhaseSchema,
    membershipClosed: z.boolean(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    errorCode: z.string().nullable(),
    currentExecution: PipelineExecutionCohortSummarySchema,
    sweptExistingBacklog: PipelineExecutionCohortSummarySchema,
  })
  .strict();
export type DiscoveryExecutionSummary = z.infer<typeof DiscoveryExecutionSummarySchema>;

export const PipelineStageBacklogSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("domain_jobs"),
      counts: PipelineStageCountsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("not_separate"),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type PipelineStageBacklog = z.infer<typeof PipelineStageBacklogSchema>;

export const PipelineOperationalStageSchema = z
  .object({
    stage: z.string().min(1),
    label: z.string().min(1),
    scope: PipelineOperationalStageScopeSchema,
    currentExecution: PipelineStageCountsSchema,
    existingBacklog: PipelineStageBacklogSchema,
    capacity: PipelineCapacitySchema,
    eta: PipelineEtaSchema,
    asOf: z.string(),
  })
  .strict();
export type PipelineOperationalStage = z.infer<typeof PipelineOperationalStageSchema>;

export const SourceFamilyProgressSchema = z
  .object({
    planned: z.number().int().nonnegative(),
    counts: PipelineStageCountsSchema,
    eta: PipelineEtaSchema,
    asOf: z.string(),
    providerProgress: DiscoveryProviderProgressSchema.nullable().optional(),
  })
  .strict();
export type SourceFamilyProgress = z.infer<typeof SourceFamilyProgressSchema>;

export const DiscoveryReconciliationProgressSchema = z
  .object({
    enrichment: PipelineStageCountsSchema,
    preparationFanout: PipelineStageCountsSchema,
    asOf: z.string(),
  })
  .strict();
export type DiscoveryReconciliationProgress = z.infer<typeof DiscoveryReconciliationProgressSchema>;

export const PipelineProjectionCoverageSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      mode: z.enum(["native", "reconstructed"]),
      decoderVersion: z.number().int().positive(),
      historyEventId: z.number().int().nonnegative(),
      membershipCount: z.number().int().nonnegative(),
      stepCount: z.number().int().nonnegative(),
      updatedAt: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("recovering"),
      mode: z.enum(["native", "reconstructed"]).nullable(),
      decoderVersion: z.number().int().positive().nullable(),
      historyEventId: z.number().int().nonnegative().nullable(),
      expectedMembershipCount: z.number().int().nonnegative().nullable(),
      persistedMembershipCount: z.number().int().nonnegative(),
      expectedStepCount: z.number().int().nonnegative().nullable(),
      persistedStepCount: z.number().int().nonnegative(),
      updatedAt: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("retrying"),
      mode: z.enum(["native", "reconstructed"]).nullable(),
      decoderVersion: z.number().int().positive().nullable(),
      historyEventId: z.number().int().nonnegative().nullable(),
      expectedMembershipCount: z.number().int().nonnegative().nullable(),
      persistedMembershipCount: z.number().int().nonnegative(),
      expectedStepCount: z.number().int().nonnegative().nullable(),
      persistedStepCount: z.number().int().nonnegative(),
      errorCode: z.string().min(1),
      updatedAt: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("incomplete"),
      mode: z.enum(["native", "reconstructed"]).nullable(),
      decoderVersion: z.number().int().positive().nullable(),
      historyEventId: z.number().int().nonnegative().nullable(),
      expectedMembershipCount: z.number().int().nonnegative().nullable(),
      persistedMembershipCount: z.number().int().nonnegative(),
      expectedStepCount: z.number().int().nonnegative().nullable(),
      persistedStepCount: z.number().int().nonnegative(),
      errorCode: z.string().min(1),
      updatedAt: z.string().nullable(),
    })
    .strict(),
]);
export type PipelineProjectionCoverage = z.infer<typeof PipelineProjectionCoverageSchema>;

export const PipelineActiveStageCountSchema = z
  .object({
    stage: z.string().min(1),
    count: z.number().int().positive(),
  })
  .strict();
export type PipelineActiveStageCount = z.infer<typeof PipelineActiveStageCountSchema>;

const PipelineActiveItemBaseSchema = z.object({
  activityType: z.string().min(1),
  workflowId: z.string().nullable(),
  executionId: z.string().nullable(),
  attempt: z.number().int().positive(),
  startedAt: z.string(),
});

export const PipelineActiveItemSchema = z.discriminatedUnion("kind", [
  PipelineActiveItemBaseSchema.extend({
    kind: z.literal("resolved_job"),
    jobKey: z.string().min(1),
    title: z.string().nullable(),
    company: z.string().nullable(),
    stage: z.string().min(1),
  }).strict(),
  PipelineActiveItemBaseSchema.extend({
    kind: z.literal("source_family"),
    sourceFamily: z.string().min(1),
  }).strict(),
  PipelineActiveItemBaseSchema.extend({
    kind: z.literal("orchestration"),
    operation: z.string().min(1),
  }).strict(),
  PipelineActiveItemBaseSchema.extend({
    kind: z.literal("unresolved_runtime_activity"),
    opaqueId: z.string().min(1),
    /** Known from the allowlisted activity type even when workflow ownership is unresolved. */
    stage: z.string().min(1).nullable(),
  }).strict(),
]);
export type PipelineActiveItem = z.infer<typeof PipelineActiveItemSchema>;

export const PipelineOperationsSnapshotSchema = z
  .object({
    generatedAt: z.string(),
    etaEstimatorVersion: z.literal("pipeline-eta-v1"),
    freshness: PipelineOperationsFreshnessSchema,
    execution: DiscoveryExecutionSummarySchema.nullable(),
    capacity: PipelineCapacitySchema,
    sourceFamilies: SourceFamilyProgressSchema.nullable(),
    reconciliation: DiscoveryReconciliationProgressSchema.nullable(),
    projectionCoverage: PipelineProjectionCoverageSchema.nullable(),
    stages: z.array(PipelineOperationalStageSchema),
    /** Exact fresh runtime activity totals grouped by known operational stage. */
    activeStageCounts: z.array(PipelineActiveStageCountSchema).nullable(),
    activeItems: z.array(PipelineActiveItemSchema).max(20),
    /** Null when worker runtime inventory cannot make an exact statement. */
    activeItemsTotal: z.number().int().nonnegative().nullable(),
    /** Null when the inventory itself is unavailable or stale. */
    activeItemsTruncated: z.boolean().nullable(),
    overallEta: PipelineEtaSchema,
  })
  .strict();
export type PipelineOperationsSnapshot = z.infer<typeof PipelineOperationsSnapshotSchema>;

export interface ApplyRunTimelineEventSummary {
  at: string | null;
  type: string;
  level: string;
  message: string | null;
}

export interface DashboardConversionFunnel {
  applied: number;
  reply: number;
  interview: number;
  offer: number;
  rejection: number;
  replyRate: number | null;
  interviewRate: number | null;
  offerRate: number | null;
  rejectionRate: number | null;
  costPerInterview: number | null;
}

export interface DashboardConversionSummary {
  totals: DashboardConversionFunnel;
  bySource: Array<{ source: string } & DashboardConversionFunnel>;
  byBand: Array<{ band: string } & DashboardConversionFunnel>;
}

export type OutcomeAnalyticsScoreBand =
  | "perfect"
  | "strong"
  | "moderate"
  | "weak"
  | "poor"
  | "unscored";

export type OutcomeAnalyticsFitBand =
  | "excellent"
  | "strong"
  | "plausible"
  | "stretch"
  | "poor"
  | "unreported";

export type OutcomeAnalyticsApplyMode = "automated_live" | "manual_marked" | "external_confirmed";

export interface OutcomeAnalyticsFunnel {
  n: number;
  applied: number;
  reply: number;
  interview: number;
  offer: number;
  rejection: number;
  replyRate: number | null;
  interviewRate: number | null;
  offerRate: number | null;
  rejectionRate: number | null;
}

export interface OutcomeAnalyticsTimeToResponse {
  n: number;
  medianMinutes: number | null;
}

export interface OutcomeAnalyticsSuggestionAccuracy {
  n: number;
  decided: number;
  accepted: number;
  corrected: number;
  ignored: number;
  acceptanceRate: number | null;
}

export interface OutcomeAnalyticsSummary {
  ok: true;
  generatedAt: string;
  minSample: number;
  totals: OutcomeAnalyticsFunnel;
  bySource: Array<{ source: string } & OutcomeAnalyticsFunnel>;
  byScoreBand: Array<{ scoreBand: OutcomeAnalyticsScoreBand } & OutcomeAnalyticsFunnel>;
  byFitBand: Array<{ fitBand: OutcomeAnalyticsFitBand } & OutcomeAnalyticsFunnel>;
  byApplyMode: Array<{ applyMode: OutcomeAnalyticsApplyMode } & OutcomeAnalyticsFunnel>;
  byTemplate: Array<{ templateId: string; templateName: string | null } & OutcomeAnalyticsFunnel>;
  byPolicy: Array<{ tailoringPolicyVersion: number | null; policyLabel: string } & OutcomeAnalyticsFunnel>;
  timeToResponse: OutcomeAnalyticsTimeToResponse;
  suggestionAccuracy: OutcomeAnalyticsSuggestionAccuracy;
}

export interface DashboardStuckWorkItem {
  jobKey: string;
  title: string;
  company: string;
  stage: Stage;
  updatedAt: string | null;
}

export interface DashboardWorkSummary {
  /** Queued work plus running work that is not classified as stuck. */
  active: number;
  /** Running work past `stuckAfterSeconds` while the worker is unavailable. */
  stuck: number;
  stuckAfterSeconds: number;
  /** Oldest stuck items first; bounded for the dashboard surface. */
  stuckItems: DashboardStuckWorkItem[];
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
  work: DashboardWorkSummary;
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
  conversion: DashboardConversionSummary;
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

export const POLITENESS_OUTCOME_REASONS = [
  "robots_disallowed",
  "rate_limited",
  "budget_exhausted",
] as const;
export type PolitenessOutcomeReason = (typeof POLITENESS_OUTCOME_REASONS)[number];

/**
 * Per-source crawl-politeness outcomes recorded by the R10 politeness gateway.
 *
 * These are first-class NON-error outcomes — a robots.txt disallow, a rate-limit
 * deferral/refusal, or a per-run request-budget exhaustion — sourced from
 * `operational_attempt_metrics` rows written with `outcome = "blocked"` and
 * `is_scrape_failure = 0`. They explain why a source produced nothing without
 * being counted as a scrape failure. Counts of `0` with a `null` last reason
 * mean no politeness outcome was recorded for the source (nothing implied).
 */
export interface SourcePolitenessOutcomes {
  robotsDisallowedCount: number;
  /**
   * Recorded rate-limited outcomes. The gateway currently enforces rate limits
   * by waiting rather than by emitting a rate-limited verdict, so this counter
   * legitimately reads 0 in production until the later R10 Retry-After-clamp
   * work records RATE_LIMITED outcomes. Rendered uniformly with the other two
   * reasons regardless — the read path and UI are already correct for it.
   */
  rateLimitedCount: number;
  budgetExhaustedCount: number;
  /** Most-recent block reason for the source, or null when none recorded. */
  lastBlockedReason: PolitenessOutcomeReason | null;
  /** ISO timestamp of the most-recent block, or null when none recorded. */
  lastBlockedAt: string | null;
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
  politeness: SourcePolitenessOutcomes;
  updatedAt: string | null;
}

export interface DigestState {
  lastAcknowledgedAt: string | null;
  updatedAt: string | null;
}

export interface DailyDigestBudget {
  status: "ok" | "over_budget";
  estimatedUsd: number;
  dailyBudgetUsd: number;
  remainingUsd: number | null;
  unlimited: boolean;
}

export interface DailyDigest {
  ok: true;
  generatedAt: string;
  since: string | null;
  highFitThreshold: number;
  newMatches: {
    count: number;
    highFitCount: number;
  };
  blockedSources: {
    count: number;
    sources: Array<{
      sourceId: string;
      recommendedState: string;
      consecutiveFailures: number;
    }>;
  };
  reviewNeededMaterials: {
    count: number;
  };
  staleScores: {
    count: number;
  };
  pendingApprovals: {
    count: number;
  };
  followUpsDue: {
    count: number;
    derived: true;
    thresholdDays: typeof DIGEST_FOLLOW_UP_THRESHOLD_DAYS;
    dayBoundary: typeof DIGEST_DAY_BOUNDARY;
  };
  budget: DailyDigestBudget;
  deepLinks: Record<DailyDigestItemKey, string>;
}

export const DigestAcknowledgeRequestSchema = z
  .object({
    acknowledgedAt: IsoTimestampSchema.optional().catch(undefined),
  })
  .transform((value): { acknowledgedAt?: string } =>
    value.acknowledgedAt ? { acknowledgedAt: value.acknowledgedAt } : {},
  );

export interface DigestAcknowledgeRequest {
  acknowledgedAt?: string;
}

export interface DigestAcknowledgeResponse {
  ok: true;
  state: DigestState;
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
  coverage_scope: "resume" | "eligibility" | "logistics" | "employer_condition" | null;
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
  repeatApplication: RepeatApplicationAssessment;
  /**
   * The newest non-terminal apply run for this job, resolved from the
   * job-scoped apply-run projection rather than the bounded dashboard feed.
   * It gives the job detail action panel an exact cancellation target.
   */
  activeApplyRun?: {
    runId: string;
    status: string;
    result: string | null;
    dryRun: boolean;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
  stages: StageSummary[];
  artifacts: ArtifactSummary[];
  auditHistory: JobAuditEntry[];
  // Phase 1: the canonical employer analysis served from projection rows, or
  // null when no analysis has been produced for this job yet.
  employerAnalysis: EmployerAnalysis | null;
  // Requirement-led fit audit served from projection rows, or null when this
  // job has not been scored with requirement-level assessments yet.
  requirementFitReport: RequirementFitReport | null;
  // Accepted interview-prep artifact served from projection rows, or null when
  // the user has not explicitly generated prep for this job yet.
  interviewPrep: InterviewPrep | null;
  // Projection-backed compensation facts from canonical posted-fact and
  // reported company-role estimate rows. Null only when the projection row is
  // absent or contains invalid JSON.
  compensationAudit: JobCompensationAudit | null;
}

export interface ArtifactDetail {
  ok: true;
  artifact: ArtifactSummary;
  layoutBoxes: ResumeLayoutBox[];
  tailoringExplanation: ArtifactTailoringExplanation | null;
}

export type ArtifactComparisonCoverageState =
  | "recorded"
  | "left_not_recorded"
  | "right_not_recorded"
  | "not_recorded";

export interface CoverageDelta {
  coverageRecorded: boolean;
  state: ArtifactComparisonCoverageState;
  computedAgainst: string | null;
  newlyCovered: string[];
  coverageLost: string[];
  newlyDeclared: string[];
  declaredLost: string[];
  stillDeclared: string[];
  stillMissing: string[];
}

export interface ArtifactComparisonSide {
  artifactId: string;
  label: string;
  title: string;
  status: string;
  templateId: string | null;
  templateName: string | null;
  coverageRecorded: boolean;
  coverageCounts: BulletCoverageAudit["counts"] | null;
  riskLabels: string[];
  validation: {
    passed: boolean | null;
    errorCount: number;
    warningCount: number;
  };
  judge: {
    passed: boolean | null;
    verdict: string | null;
    score: number | null;
    minScore: number | null;
    issueCount: number;
  };
}

export interface ArtifactComparison {
  left: ArtifactComparisonSide;
  right: ArtifactComparisonSide;
  coverageDelta: CoverageDelta;
}

export interface ResumeLayoutBox {
  semanticId: string;
  pageNumber: number;
  lineNumber: number | null;
  textExcerpt: string;
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
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
 * Mirrors the Python ``KeywordCoverage.to_read_model()`` projection. Planned
 * keywords partition into three honestly-labeled buckets computed against the actual
 * rendered (voiced) resume text the HTML renderer consumes: ``covered`` (demonstrated —
 * appears in an evidence-backed bullet), ``declared`` (rendered in a skills-section
 * line, which is the canonical profile declaration, but not demonstrated in
 * experience/evidence), and ``missing`` (rendered in no shipped line). ``coveredBy``
 * maps each covered keyword to the ``bulletId`` that demonstrates it; ``declaredBy``
 * maps each declared keyword to the skills ``bulletId`` that declares it (per-keyword,
 * per-bullet inspectability). ``computedAgainst`` records that coverage was computed
 * against rendered text, not the job description. Served exclusively from the
 * canonical ``coverage_audit_json`` projection column. ``declared`` / ``declaredBy``
 * are absent on pre-A6b persisted rows and default to empty on read.
 */
export interface BulletCoverageAudit {
  computedAgainst: string;
  planned: string[];
  covered: string[];
  declared: string[];
  missing: string[];
  coveredBy: Record<string, string>;
  declaredBy: Record<string, string>;
  counts: {
    planned: number;
    covered: number;
    declared: number;
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
    declared: string[];
    missing: string[];
    filtered: {
      planned: string[];
      covered: string[];
      missing: string[];
    };
    counts: {
      planned: number;
      covered: number;
      declared: number;
      missing: number;
      displayedPlanned: number;
      displayedCovered: number;
      displayedDeclared: number;
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
  // rendered (voiced) resume text the HTML renderer consumes — three buckets: covered
  // (demonstrated in an evidence-backed bullet), declared (rendered in the profile's
  // skills line but not demonstrated), missing (rendered nowhere) (GROUND-06 /
  // success criterion 4 / A6b). ``null`` when no Phase-3 coverage was recorded for
  // this artifact's generation. Served from the canonical ``coverage_audit_json``
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
    | "generate_interview_prep"
    | "apply"
    | "cancel"
    | "rederive_learning_recommendations"
    | "mark_applied"
    | "mark_skipped"
    | "profile_import";
  jobKey: string;
  jobId?: string;
  stage?: Stage;
  stages?: Stage[];
  resetAttempts?: boolean;
  runAfter?: boolean;
  dryRun?: boolean;
  jobIds?: string[];
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
  sourceIds?: string[];
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

export interface JobCtrlSettings {
  applyConcurrency: number;
  workerActivitySlots: number;
  dailyBudgetUsd: number;
  analysisLegs: ProviderId[];
  tailoringGeneratorModels: string[] | null;
  tailoringJudgeModel: string | null;
  tailoringJudgeMinScore: number;
  applyMaxBudgetUsd: number;
  applyTimeoutSeconds: number;
  scoreCriteria: string;
  targetCriteria: string;
  preferredModels: Partial<Record<ProviderId, string>>;
}

export const SETTING_ACTIVATIONS = [
  "live",
  "next_poll",
  "next_source_family",
  "next_run",
  "next_analysis",
  "next_workflow",
  "next_apply_job",
  "restart",
] as const;
export type SettingActivation = (typeof SETTING_ACTIVATIONS)[number];

const effectiveSettingSchema = <T extends z.ZodType>(value: T) =>
  z
    .object({
      value,
      source: z.enum(["persisted", "default"]),
      activation: z.enum(SETTING_ACTIVATIONS),
      editable: z.literal(true),
    })
    .strict();

export type EffectiveSetting<T> = {
  value: T;
  source: "persisted" | "default";
  activation: SettingActivation;
  editable: true;
};

export interface EffectiveJobCtrlSettings {
  dailyBudgetUsd: EffectiveSetting<number>;
  applyConcurrency: EffectiveSetting<number>;
  workerActivitySlots: EffectiveSetting<number>;
  analysisLegs: EffectiveSetting<ProviderId[]>;
  tailoringGeneratorModels: EffectiveSetting<string[] | null>;
  tailoringJudgeModel: EffectiveSetting<string | null>;
  tailoringJudgeMinScore: EffectiveSetting<number>;
  applyMaxBudgetUsd: EffectiveSetting<number>;
  applyTimeoutSeconds: EffectiveSetting<number>;
  scoreCriteria: EffectiveSetting<string>;
  targetCriteria: EffectiveSetting<string>;
}

export const SettingsResponseSchema = z
  .object({
    ok: z.literal(true),
    settings: z
      .object({
        applyConcurrency: z.number(),
        workerActivitySlots: z.number(),
        dailyBudgetUsd: z.number(),
        analysisLegs: z.array(z.enum(ProviderIds)),
        tailoringGeneratorModels: z.array(z.string()).nullable(),
        tailoringJudgeModel: z.string().nullable(),
        tailoringJudgeMinScore: z.number(),
        applyMaxBudgetUsd: z.number(),
        applyTimeoutSeconds: z.number(),
        scoreCriteria: z.string(),
        targetCriteria: z.string(),
        preferredModels: z
          .object({
            codex: z.string().optional(),
            claude: z.string().optional(),
            google: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
    effectiveSettings: z
      .object({
        dailyBudgetUsd: effectiveSettingSchema(z.number()),
        applyConcurrency: effectiveSettingSchema(z.number()),
        workerActivitySlots: effectiveSettingSchema(z.number()),
        analysisLegs: effectiveSettingSchema(z.array(z.enum(ProviderIds))),
        tailoringGeneratorModels: effectiveSettingSchema(z.array(z.string()).nullable()),
        tailoringJudgeModel: effectiveSettingSchema(z.string().nullable()),
        tailoringJudgeMinScore: effectiveSettingSchema(z.number()),
        applyMaxBudgetUsd: effectiveSettingSchema(z.number()),
        applyTimeoutSeconds: effectiveSettingSchema(z.number()),
        scoreCriteria: effectiveSettingSchema(z.string()),
        targetCriteria: effectiveSettingSchema(z.string()),
      })
      .strict(),
    paths: z.object({ configPath: z.string() }).strict(),
  })
  .strict();

export interface SettingsResponse {
  ok: true;
  settings: JobCtrlSettings;
  effectiveSettings: EffectiveJobCtrlSettings;
  paths: {
    configPath: string;
  };
}

export const EXTENSION_CAPABILITY_VALUES = ["capture", "autofill_read"] as const;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITY_VALUES)[number];

export const ExtensionCapabilityTokenResponseSchema = z
  .object({
    ok: z.literal(true),
    token: z.string().trim().min(32),
    tokenPath: z.string().trim().min(1),
    created: z.boolean(),
  })
  .strict();
export type ExtensionCapabilityTokenResponse = z.infer<
  typeof ExtensionCapabilityTokenResponseSchema
>;

export const ExtensionAuthStatusResponseSchema = z
  .object({
    ok: z.literal(true),
    authenticated: z.literal(true),
    capabilities: z.array(z.enum(EXTENSION_CAPABILITY_VALUES)),
  })
  .strict();
export type ExtensionAuthStatusResponse = z.infer<typeof ExtensionAuthStatusResponseSchema>;

export interface ExtensionAutofillProfileField {
  path: string;
  label: string;
  value: string;
  source: {
    kind: "profile";
    path: string;
    label: string;
  };
}

export interface ExtensionAutofillProfileResponse {
  ok: true;
  profileVersion: number | null;
  fields: ExtensionAutofillProfileField[];
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
  "public_markdown",
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

export const LEVELS_FYI_COMPENSATION_ACCESS_MODES = [
  "public_markdown",
  "licensed_api",
  "licensed_data_feed",
  "enterprise_mcp",
] as const satisfies readonly CompensationSourceAccessMode[];
export type LevelsFyiCompensationAccessMode =
  (typeof LEVELS_FYI_COMPENSATION_ACCESS_MODES)[number];

export const GLASSDOOR_COMPENSATION_ACCESS_MODES = [
  "partner_api",
  "written_permission",
] as const satisfies readonly CompensationSourceAccessMode[];
export type GlassdoorCompensationAccessMode =
  (typeof GLASSDOOR_COMPENSATION_ACCESS_MODES)[number];

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

export interface FixedCompensationSourceControl {
  kind: "fixed";
  enabled: true;
}

export interface UserCompensationSourceControl {
  kind: "user_preference";
  enabled: boolean;
  accessMode: CompensationSourceAccessMode | null;
  allowedAccessModes: CompensationSourceAccessMode[];
  europeCoverageRequired: boolean;
  europeCoverageConfirmed: boolean;
}

export type CompensationSourceControl =
  | FixedCompensationSourceControl
  | UserCompensationSourceControl;

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
  control: CompensationSourceControl;
  coverage: CompensationSourceCoverage;
  notes: string[];
}

export interface CompensationSourceRegistryResponse {
  ok: true;
  sources: CompensationSourcePolicySummary[];
}

export const CompensationSourcePolicyUpdateRequestSchema = z
  .discriminatedUnion("sourceId", [
    z
      .object({
        sourceId: z.literal("levels_fyi"),
        enabled: z.boolean(),
        accessMode: z.enum(LEVELS_FYI_COMPENSATION_ACCESS_MODES).nullable(),
        europeCoverageConfirmed: z.boolean(),
      })
      .strict(),
    z
      .object({
        sourceId: z.literal("glassdoor"),
        enabled: z.boolean(),
        accessMode: z.enum(GLASSDOOR_COMPENSATION_ACCESS_MODES).nullable(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.enabled && value.accessMode === null) {
      context.addIssue({
        code: "custom",
        message: "Choose the permitted access mode before enabling this source.",
        path: ["accessMode"],
      });
    }
    if (
      value.sourceId === "levels_fyi" &&
      value.enabled &&
      value.accessMode !== "public_markdown" &&
      !value.europeCoverageConfirmed
    ) {
      context.addIssue({
        code: "custom",
        message: "Confirm Europe coverage before enabling Levels.fyi.",
        path: ["europeCoverageConfirmed"],
      });
    }
  });
export type CompensationSourcePolicyUpdateRequest = z.infer<
  typeof CompensationSourcePolicyUpdateRequestSchema
>;

export const DiscoverySettingsUpdateRequestSchema = z
  .object({
    minFitScore: z.coerce.number().int().min(0).max(10).optional(),
    autoApply: z.boolean().optional(),
    applyApprovalRequired: z.boolean().optional(),
    boards: z.array(z.enum(["indeed", "linkedin", "zip_recruiter", "glassdoor"])).min(1).optional(),
    resultsPerSite: z.coerce.number().int().min(1).max(1000).optional(),
    hoursOld: z.coerce.number().int().min(1).max(8760).optional(),
    schedulingEnabled: z.boolean().optional(),
    scheduleCron: z.string().min(1).optional(),
    roleFilterMode: z.enum(["auto", "deterministic", "llm"]).optional(),
    roleFilterModel: z.string().trim().max(160).nullable().optional(),
    maxParallelFamilies: z.coerce.number().int().min(1).max(4).optional(),
    crawlUserAgentProduct: z.string().trim().min(1).max(80).optional(),
    crawlUserAgentContact: z.string().trim().max(240).optional(),
  })
  .strict();
export type DiscoverySettingsUpdateRequest = z.infer<typeof DiscoverySettingsUpdateRequestSchema>;

export interface DiscoverySettings {
  minFitScore: number;
  autoApply: boolean;
  applyApprovalRequired: boolean;
  boards: Array<"indeed" | "linkedin" | "zip_recruiter" | "glassdoor">;
  resultsPerSite: number;
  hoursOld: number;
  schedulingEnabled: boolean;
  scheduleCron: string;
  roleFilterMode: "auto" | "deterministic" | "llm";
  roleFilterModel: string | null;
  maxParallelFamilies: number;
  crawlUserAgentProduct: string;
  crawlUserAgentContact: string;
  source: "database";
}

export interface EffectiveDiscoverySettings {
  minFitScore: EffectiveSetting<number>;
  autoApply: EffectiveSetting<boolean>;
  applyApprovalRequired: EffectiveSetting<boolean>;
  boards: EffectiveSetting<DiscoverySettings["boards"]>;
  resultsPerSite: EffectiveSetting<number>;
  hoursOld: EffectiveSetting<number>;
  schedulingEnabled: EffectiveSetting<boolean>;
  scheduleCron: EffectiveSetting<string>;
  roleFilterMode: EffectiveSetting<DiscoverySettings["roleFilterMode"]>;
  roleFilterModel: EffectiveSetting<string | null>;
  maxParallelFamilies: EffectiveSetting<number>;
  crawlUserAgentProduct: EffectiveSetting<string>;
  crawlUserAgentContact: EffectiveSetting<string>;
}

export const DiscoverySettingsResponseSchema = z
  .object({
    ok: z.literal(true),
    settings: z
      .object({
        minFitScore: z.number(),
        autoApply: z.boolean(),
        applyApprovalRequired: z.boolean(),
        boards: z.array(z.enum(["indeed", "linkedin", "zip_recruiter", "glassdoor"])),
        resultsPerSite: z.number(),
        hoursOld: z.number(),
        schedulingEnabled: z.boolean(),
        scheduleCron: z.string(),
        roleFilterMode: z.enum(["auto", "deterministic", "llm"]),
        roleFilterModel: z.string().nullable(),
        maxParallelFamilies: z.number(),
        crawlUserAgentProduct: z.string(),
        crawlUserAgentContact: z.string(),
        source: z.literal("database"),
      })
      .strict(),
    effectiveSettings: z
      .object({
        minFitScore: effectiveSettingSchema(z.number()),
        autoApply: effectiveSettingSchema(z.boolean()),
        applyApprovalRequired: effectiveSettingSchema(z.boolean()),
        boards: effectiveSettingSchema(
          z.array(z.enum(["indeed", "linkedin", "zip_recruiter", "glassdoor"])),
        ),
        resultsPerSite: effectiveSettingSchema(z.number()),
        hoursOld: effectiveSettingSchema(z.number()),
        schedulingEnabled: effectiveSettingSchema(z.boolean()),
        scheduleCron: effectiveSettingSchema(z.string()),
        roleFilterMode: effectiveSettingSchema(z.enum(["auto", "deterministic", "llm"])),
        roleFilterModel: effectiveSettingSchema(z.string().nullable()),
        maxParallelFamilies: effectiveSettingSchema(z.number()),
        crawlUserAgentProduct: effectiveSettingSchema(z.string()),
        crawlUserAgentContact: effectiveSettingSchema(z.string()),
      })
      .strict(),
  })
  .strict();

export interface DiscoverySettingsResponse {
  ok: true;
  settings: DiscoverySettings;
  effectiveSettings: EffectiveDiscoverySettings;
}

export interface CredentialsResponse {
  ok: true;
  store: {
    kind: "config_and_macos_keychain";
    available: boolean;
    unavailableReason: "inspection_failed" | "unsupported_platform" | null;
    requiresWorkerRestart: true;
  };
  credentials: Array<{
    key: CredentialKey;
    label: string;
    /** Keychain inspection is reported separately from the effective owner. */
    configured: boolean | null;
    storage: "keychain" | "config";
    effectiveSource: "environment" | "keychain" | "config" | "absent" | "inspection_unknown";
    editable: boolean;
  }>;
}

export interface CredentialManagedByEnvironmentResponse {
  ok: false;
  error: "credential_managed_by_environment";
  key: CredentialKey;
  source: "environment";
  message: string;
}

export interface CredentialStoreErrorResponse {
  ok: false;
  error: "credential_store_unavailable";
  reason: "operational_failure" | "partial_failure" | "unsupported_platform";
  message: string;
}

export const BrowserCapabilityIds = [
  "core-browser",
  "auto-apply-browser",
  "authenticated-linkedin-browser",
] as const;
export type BrowserCapabilityId = (typeof BrowserCapabilityIds)[number];

export const BrowserCapabilityStatusSchema = z.enum([
  "ready",
  "disabled",
  "missing",
  "failed",
  "unavailable",
]);

export const BrowserCapabilityItemSchema = z
  .object({
    id: z.enum(BrowserCapabilityIds),
    status: BrowserCapabilityStatusSchema,
    detail: z.string().trim().min(1).max(400),
    mutable: z.boolean(),
    enabled: z.boolean(),
    profileCopyReady: z.boolean(),
  })
  .strict();
export type BrowserCapabilityItem = z.infer<typeof BrowserCapabilityItemSchema>;

export const DetectedBrowserIds = ["google-chrome", "chromium"] as const;
export type DetectedBrowserId = (typeof DetectedBrowserIds)[number];

export const DetectedBrowserProfileIdSchema = z
  .string()
  .regex(/^profile-[a-f0-9]{32}$/);
export type DetectedBrowserProfileId = z.infer<typeof DetectedBrowserProfileIdSchema>;

export const DetectedBrowserProfileSchema = z
  .object({
    id: DetectedBrowserProfileIdSchema,
    label: z.string().trim().min(1).max(80),
  })
  .strict();
export type DetectedBrowserProfile = z.infer<typeof DetectedBrowserProfileSchema>;

export const DetectedBrowserSchema = z
  .object({
    id: z.enum(DetectedBrowserIds),
    label: z.string().trim().min(1).max(80),
    defaultProfileAvailable: z.boolean(),
    profiles: z.array(DetectedBrowserProfileSchema).max(64),
  })
  .strict();
export type DetectedBrowser = z.infer<typeof DetectedBrowserSchema>;

export const BrowserCapabilitiesResultSchema = z
  .object({
    capabilities: z.array(BrowserCapabilityItemSchema).length(BrowserCapabilityIds.length),
    detectedBrowsers: z.array(DetectedBrowserSchema).max(DetectedBrowserIds.length),
  })
  .strict();

export const BrowserCapabilitiesResponseSchema = z
  .object({
    ok: z.literal(true),
    capabilities: z.array(BrowserCapabilityItemSchema).length(BrowserCapabilityIds.length),
    detectedBrowsers: z.array(DetectedBrowserSchema).max(DetectedBrowserIds.length),
  })
  .strict();

export interface BrowserCapabilitiesResponse {
  ok: true;
  capabilities: BrowserCapabilityItem[];
  detectedBrowsers: DetectedBrowser[];
}

export const BrowserCapabilityEnableRequestSchema = z
  .union([
    z.object({ detectedBrowserId: z.enum(DetectedBrowserIds) }).strict(),
    z.object({ executablePath: z.string().trim().min(1).max(4096) }).strict(),
  ]);
export type BrowserCapabilityEnableRequest = z.infer<typeof BrowserCapabilityEnableRequestSchema>;

export const BrowserProfileCopyRequestSchema = z
  .union([
    z.object({
      detectedBrowserId: z.enum(DetectedBrowserIds),
      detectedProfileId: DetectedBrowserProfileIdSchema,
      consent: z.literal(true),
      consentMethod: z.literal("explicit-ui-v1"),
    }).strict(),
    z.object({
      detectedBrowserId: z.enum(DetectedBrowserIds),
      consent: z.literal(true),
      consentMethod: z.literal("explicit-ui-v1"),
    }).strict(),
    z.object({
      sourceProfilePath: z.string().trim().min(1).max(4096),
      consent: z.literal(true),
      consentMethod: z.literal("explicit-ui-v1"),
    }).strict(),
  ]);
export type BrowserProfileCopyRequest = z.infer<typeof BrowserProfileCopyRequestSchema>;

export interface BrowserCapabilityErrorResponse {
  ok: false;
  error: "browser_capability_failed";
  message: string;
}

export interface ProviderStatusResponse {
  ok: true;
  providers: ProviderStatusItem[];
}

export interface ProviderModelCatalogResponse {
  ok: true;
  providers: ProviderModelCatalogItem[];
}

export interface CodexVerifyResponse {
  ok: true;
  verification: z.infer<typeof CodexVerifyResultSchema>;
}

export interface ProviderOperationErrorResponse {
  ok: false;
  error: "provider_status_failed" | "provider_verification_failed" | "provider_models_failed";
  message: string;
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
  politeness: SourcePolitenessOutcomes;
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
  "robots_disallowed",
  "protected_internal_site",
  "ambiguous_career_system",
  "browser_extension_capture",
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
  "posting_inactive",
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
  "annual_period_inferred",
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

type CompensationAuditJobIdentity<T> = T extends { jobKey: string }
  ? Omit<T, "jobKey"> & { jobId: string }
  : T;

export type JobCompensationAuditPostedFact = CompensationAuditJobIdentity<
  PostedCompensationFact
>;

export type JobCompensationAuditPostedResponse =
  | {
      ok: true;
      recordStatus: "recorded";
      fact: JobCompensationAuditPostedFact;
    }
  | {
      ok: true;
      recordStatus: "not_recorded";
      jobId: string;
      legacyRawSalary: string | null;
    };

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

export const MARKET_COMPENSATION_SOURCE_PROVENANCE = [
  "public",
  "licensed",
  "manual",
  "employer_posted",
] as const;
export type MarketCompensationSourceProvenance =
  (typeof MARKET_COMPENSATION_SOURCE_PROVENANCE)[number];

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
  "benchmark_extrapolated",
  "benchmark_level_fallback",
  "reported_compensation_sample",
  "posted_salary_sample",
  "source_conflict_with_posted_salary",
  "stale_source_snapshot",
  "low_sample_count",
  "company_role_fallback",
  "cost_of_living_only",
  "factor_out_of_bounds",
  "limited_matched_company_evidence",
  "trimodal_tier_inferred",
  "location_mismatch",
] as const;
export type MarketCompensationWarningCode = (typeof MARKET_COMPENSATION_WARNING_CODES)[number];

export const MARKET_COMPENSATION_GEOGRAPHY_SCOPES = [
  "Europe",
  "reported",
  "country",
  "country_subdivision",
  "locality",
] as const;
export type MarketCompensationGeographyScope =
  (typeof MARKET_COMPENSATION_GEOGRAPHY_SCOPES)[number];

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
  provenance: MarketCompensationSourceProvenance;
  displayName: string;
  sourceType: "reported_compensation" | "posted_salary";
  releaseYear: number | null;
  snapshotVersion: string;
  geographyScope: MarketCompensationGeographyScope;
  aggregateBucket: string;
  attribution: string;
  sampleCount: number | null;
}

export interface MarketCompensationEvidenceRow {
  sourceId: MarketCompensationSourceId;
  displayName: string;
  sourceUrl: string | null;
  companyName: string;
  roleTitle: string;
  location: string | null;
  levelLabel: string | null;
  companyTier: "tier_1_local" | "tier_2_ambitious" | "tier_3_top_of_market" | "unknown";
  component: MarketCompensationComponent;
  currency: string;
  period: MarketCompensationPeriod;
  minimumAmount: number;
  maximumAmount: number;
  sampleCount: number | null;
  releaseYear: number | null;
  companyScore: number;
  roleScore: number;
  levelScore: number;
  locationScore: number;
  freshnessScore: number;
}

export interface MarketCompensationBenchmarkGeography {
  countryCode: string;
  subdivisionCode: string | null;
  locality: string | null;
  scope: "country" | "country_subdivision" | "locality";
}

export interface MarketCompensationDirectBenchmarkInput {
  factId: string;
  inputRole:
    | "anchor"
    | "matched_company_source"
    | "matched_company_target"
    | "occupation_anchor";
  weight: number;
  geography: MarketCompensationBenchmarkGeography;
  marketScope: "market" | "company";
  normalizedCompany: string | null;
  minimumAmountEur: number;
  maximumAmountEur: number;
  confidenceScore: number;
  sampleCount: number;
  sourceId: string;
  sourceProvenance: "public" | "licensed" | "manual" | "official";
  sourceSnapshotId: string;
  asOfDate: string;
  fetchedAt: string;
  freshUntil: string;
}

export interface MarketCompensationPriceLevelInput {
  factId: string;
  inputRole: "source_price_level" | "target_price_level" | "shrinkage_prior";
  weight: number;
  countryCode: string;
  category:
    | "actual_individual_consumption"
    | "household_final_consumption"
    | "general_price_level";
  referenceYear: number;
  baseGeographyCode: string;
  indexValue: number;
  sourceId: "eurostat" | "world_bank" | "oecd" | "manual_official";
  sourceSnapshotId: string;
  asOfDate: string;
  fetchedAt: string;
  freshUntil: string;
}

interface MarketCompensationBenchmarkLineageBase {
  factId: string;
  taxonomyVersion: string;
  roleFamilyCode: string;
  seniorityLabel: string;
  targetGeography: MarketCompensationBenchmarkGeography;
  component: MarketCompensationComponent;
  asOfDate: string;
  observedAt: string;
  freshUntil: string;
  directInputs: MarketCompensationDirectBenchmarkInput[];
  priceLevelInputs: MarketCompensationPriceLevelInput[];
}

export interface MarketCompensationDirectBenchmarkLineage extends MarketCompensationBenchmarkLineageBase {
  kind: "direct";
}

export interface MarketCompensationExtrapolatedBenchmarkLineage extends MarketCompensationBenchmarkLineageBase {
  kind: "extrapolated";
  anchorDirectFactId: string;
  anchorGeography: MarketCompensationBenchmarkGeography;
  extrapolationMethod: "evidence_weighted_shrinkage";
  rawFactor: number;
  shrinkageWeight: number;
  lowerFactorBound: number;
  upperFactorBound: number;
  factorBoundState: "within_bounds" | "below_lower_bound" | "above_upper_bound";
  matchedCompanyCount: number;
  formulaVersion: string;
}

export type MarketCompensationBenchmarkLineage =
  | MarketCompensationDirectBenchmarkLineage
  | MarketCompensationExtrapolatedBenchmarkLineage;

interface MarketCompensationEstimateBase {
  tenantId: string;
  jobKey: string;
  estimateState: MarketCompensationEstimateState;
  confidenceBand: MarketCompensationConfidenceBand;
  confidenceScore: number;
  sourceCount: number;
  sampleCount: number | null;
  aggregateBucket: string | null;
  geographyScope: MarketCompensationGeographyScope | null;
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
  evidence: MarketCompensationEvidenceRow[];
  warnings: MarketCompensationWarning[];
  benchmarkLineage: MarketCompensationBenchmarkLineage | null;
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

export type JobCompensationAuditMarketEstimate = CompensationAuditJobIdentity<
  MarketCompensationEstimate
>;

export type JobCompensationAuditMarketResponse =
  | {
      ok: true;
      recordStatus: "recorded";
      estimate: JobCompensationAuditMarketEstimate;
    }
  | {
      ok: true;
      recordStatus: "not_requested";
      jobId: string;
    };

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

export const JobUrlImportUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .regex(/^https?:\/\/[^\s]+$/i, "url must be a valid http(s) URL")
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.username === "" && parsed.password === "";
      } catch {
        return false;
      }
    },
    { message: "url must not contain embedded credentials" },
  );

export const JobUrlImportRequestSchema = z
  .object({
    url: JobUrlImportUrlSchema,
  })
  .strict();
export type JobUrlImportRequest = z.infer<typeof JobUrlImportRequestSchema>;

export type JobUrlImportResponse =
  | {
      ok: true;
      status: "imported";
      jobKey: string;
      importedAt: string;
      alreadyExisted: boolean;
    }
  | {
      ok: true;
      status: "manual_capture_required";
      itemId: string;
      reason: ManualActionReasonValue;
    };

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
    captureClient?: string;
    extensionVersion?: string;
  };
}

export const ExtensionCaptureIngestSchema = z
  .object({
    captureId: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    originatingUrl: z
      .string()
      .trim()
      .max(2048)
      .regex(/^https?:\/\/[^\s]+$/i, "originatingUrl must be a valid http(s) URL"),
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
    captureClient: z.literal("browser_extension").default("browser_extension"),
    extensionVersion: z.string().trim().min(1).max(80).default("unknown"),
  })
  .strict()
  .refine(
    (value) =>
      value.capturedUrl !== undefined ||
      value.contentText !== undefined ||
      value.contentHtmlBase64 !== undefined,
    { message: "One of capturedUrl, contentText, or contentHtmlBase64 must be provided." },
  );
export type ExtensionCaptureIngestRequest = z.infer<typeof ExtensionCaptureIngestSchema>;

export interface ExtensionCaptureDismissedReplayResponse {
  ok: true;
  itemId: string;
  jobKey: null;
  status: "dismissed";
  dismissedAt: string | null;
  message: string;
}

export type ExtensionCaptureIngestResponse =
  | ManualCaptureImportResponse
  | ExtensionCaptureDismissedReplayResponse;

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

// ---------------------------------------------------------------------------
// Contact & Outreach (R6 Phase 1 — Contact records)
//
// The ninth bounded context. Phase 1 ships contact records only: create,
// update, CSV import (resolved decision 4), delete, and provenance-bearing
// reads. No research, no drafts, no send (INV-1). Attribute VALUES (names,
// emails, notes) live only in contact_attributes.value_json and reach the
// client solely through these read DTOs — never through events, projections,
// logs, or telemetry (outreach planner plan §6; CLAUDE.md sensitive-data rule).
// Every rendered fact carries inspectable provenance (INV-2).
// ---------------------------------------------------------------------------

export const ContactRoleSchema = z.enum(CONTACT_ROLES).catch("other");
export type ContactRole = (typeof CONTACT_ROLES)[number];

export const ContactSourceKindSchema = z.enum(CONTACT_SOURCE_KINDS);
export type ContactSourceKind = (typeof CONTACT_SOURCE_KINDS)[number];

export const CONTACT_ATTRIBUTE_KINDS = [
  "name",
  "title",
  "email",
  "phone",
  "profile_url",
  "note",
] as const;
export const ContactAttributeKindSchema = z.enum(CONTACT_ATTRIBUTE_KINDS);
export type ContactAttributeKind = (typeof CONTACT_ATTRIBUTE_KINDS)[number];

/** Where one contact fact came from (INV-2). Safe references only — never a value. */
export interface ContactFactProvenance {
  sourceKind: ContactSourceKind;
  sourceRef: string;
  captureMethod: string;
  capturedAt: string;
  confidence: number;
  userConfirmed: boolean;
}

/** One contact fact. `value` is sensitive and served only through read DTOs. */
export interface ContactAttributeDto {
  attributeId: string;
  kind: string;
  value: string;
  provenance: ContactFactProvenance;
}

export interface ContactSummary {
  contactId: string;
  displayName: string;
  role: ContactRole;
  employer: string | null;
  jobId: string | null;
  attributeCount: number;
  confirmedCount: number;
  sourceKinds: ContactSourceKind[];
  allConfirmed: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ContactDetail {
  contactId: string;
  displayName: string;
  role: ContactRole;
  employer: string | null;
  jobId: string | null;
  attributes: ContactAttributeDto[];
  createdAt: string | null;
  updatedAt: string | null;
}

export const ContactAttributeInputSchema = z
  .object({
    kind: ContactAttributeKindSchema,
    value: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ContactAttributeInput = z.infer<typeof ContactAttributeInputSchema>;

const contactEmployerField = z.string().trim().min(1).max(200).nullish();
const contactApiJobIdField = z
  .string()
  .trim()
  .uuid()
  .refine((value) => value === value.toLowerCase(), {
    message: "jobId must be a canonical UUID",
  })
  .nullish();
const outreachJobIdField = z
  .string()
  .trim()
  .uuid()
  .refine((value) => value === value.toLowerCase(), {
    message: "jobId must be a canonical UUID",
  })
  .nullish();

export const ContactCreateRequestSchema = z
  .object({
    role: ContactRoleSchema.default("other"),
    employer: contactEmployerField,
    jobId: contactApiJobIdField,
    attributes: z.array(ContactAttributeInputSchema).max(50).default([]),
  })
  .strict()
  .refine(
    (value) => Boolean((value.employer ?? "").trim()) || Boolean((value.jobId ?? "").trim()),
    { message: "A contact must link to at least one of employer or jobId.", path: ["employer"] },
  );
export type ContactCreateRequest = z.infer<typeof ContactCreateRequestSchema>;

export const ContactUpdateRequestSchema = z
  .object({
    role: ContactRoleSchema.optional(),
    employer: contactEmployerField,
    jobId: contactApiJobIdField,
    attributes: z.array(ContactAttributeInputSchema).max(50).optional(),
  })
  .strict();
export type ContactUpdateRequest = z.infer<typeof ContactUpdateRequestSchema>;

export const ContactImportRequestSchema = z
  .object({
    filename: z.string().trim().min(1).max(300),
    csvText: z.string().min(1).max(1_000_000),
  })
  .strict();
export type ContactImportRequest = z.infer<typeof ContactImportRequestSchema>;

export const ContactListQuerySchema = z
  .object({
    jobId: contactApiJobIdField,
    employer: optionalText,
  })
  .strict();
export type ContactListQuery = z.infer<typeof ContactListQuerySchema>;

export const ContactDeleteRequestSchema = z
  .object({ reason: z.string().trim().max(400).optional() })
  .strict();
export type ContactDeleteRequest = z.infer<typeof ContactDeleteRequestSchema>;

export interface ContactListResponse {
  ok: true;
  items: ContactSummary[];
}

export interface ContactDetailResponse {
  ok: true;
  contact: ContactDetail;
}

export interface ContactMutationResponse {
  ok: true;
  contact: ContactDetail;
}

export interface ContactImportResponse {
  ok: true;
  imported: number;
  skipped: number;
  contactIds: string[];
}

export interface ContactDeleteResponse {
  ok: true;
  contactId: string;
  deletedAt: string;
}

// ---------------------------------------------------------------------------
// Contact & Outreach (R6 Phase 2 — supervised research)
// ---------------------------------------------------------------------------
//
// Research proposes candidates from the conservative opt-in allowlist (INV-3),
// fetched only through the merged politeness gateway; candidates land
// needs_review and require an explicit user confirmation before becoming a
// stored Contact fact (INV-4). Every candidate + attribute carries provenance
// (INV-2). Candidate VALUES reach the client only through the detail DTO below,
// never through events, projections, logs, or telemetry (plan §6).

export const RESEARCH_TASK_STATUSES = [
  "queued",
  "running",
  "needs_review",
  "completed",
  "failed",
] as const;
export type ResearchTaskStatus = (typeof RESEARCH_TASK_STATUSES)[number];

export const CANDIDATE_STATUSES = ["needs_review", "confirmed", "dismissed"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const RESEARCH_SOURCE_OUTCOMES = [
  "allowed",
  "no_candidates",
  "robots_disallowed",
  "rate_limited",
  "budget_exhausted",
  "manual_capture_required",
  "rejected",
  "extraction_failed",
] as const;
export type ResearchSourceOutcome = (typeof RESEARCH_SOURCE_OUTCOMES)[number];

export const RESEARCH_SOURCE_CATEGORIES = [
  "user_entered",
  "public_web_page",
  "user_imported_list",
] as const;
export type ResearchSourceCategory = (typeof RESEARCH_SOURCE_CATEGORIES)[number];

/** Provenance of the search itself: which allowed source was tried + its outcome. */
export interface ContactResearchSourceAttempt {
  sourceKind: string;
  sourceRef: string;
  outcome: ResearchSourceOutcome | string;
  attemptedAt: string;
  detail: string;
}

/** A proposed candidate. `attributes` carry values (served only in the detail DTO). */
export interface ContactCandidateDto {
  candidateId: string;
  taskId: string;
  role: ContactRole;
  status: CandidateStatus;
  confidence: number;
  provenance: ContactFactProvenance;
  attributes: ContactAttributeDto[];
  confirmedContactId: string | null;
  confirmedAt: string | null;
}

export interface ContactResearchTaskSummary {
  taskId: string;
  employer: string | null;
  jobId: string | null;
  status: ResearchTaskStatus;
  candidateCount: number;
  needsReviewCount: number;
  confirmedCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  needsReviewAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorClass: string | null;
}

export interface ContactResearchTaskDetail extends ContactResearchTaskSummary {
  sourceAttempts: ContactResearchSourceAttempt[];
  candidates: ContactCandidateDto[];
}

export const ContactResearchSourceRequestSchema = z
  .object({
    category: z.enum(RESEARCH_SOURCE_CATEGORIES).default("public_web_page"),
    url: z.string().trim().max(2000).default(""),
    label: z.string().trim().max(200).default(""),
  })
  .strict();
export type ContactResearchSourceRequest = z.infer<typeof ContactResearchSourceRequestSchema>;

export const RunContactResearchRequestSchema = z
  .object({
    employer: contactEmployerField,
    jobId: contactApiJobIdField,
    sources: z.array(ContactResearchSourceRequestSchema).max(25).default([]),
    llmModel: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((request) => Boolean(request.employer) || Boolean(request.jobId), {
    message: "A research task must be scoped to at least one of employer or jobId.",
    path: ["employer"],
  });
export type RunContactResearchRequest = z.infer<typeof RunContactResearchRequestSchema>;

export const ContactResearchListQuerySchema = z
  .object({
    jobId: contactApiJobIdField,
    employer: optionalText,
  })
  .strict();
export type ContactResearchListQuery = z.infer<typeof ContactResearchListQuerySchema>;

export const ConfirmContactCandidateRequestSchema = z
  .object({
    role: ContactRoleSchema.optional(),
  })
  .strict();
export type ConfirmContactCandidateRequest = z.infer<typeof ConfirmContactCandidateRequestSchema>;

export interface ContactResearchStartResponse {
  ok: true;
  taskId: string;
  runId: string | null;
  workflowId: string | null;
  status: string;
}

export interface ContactResearchListResponse {
  ok: true;
  items: ContactResearchTaskSummary[];
}

export interface ContactResearchDetailResponse {
  ok: true;
  task: ContactResearchTaskDetail;
}

export interface ConfirmContactCandidateResponse {
  ok: true;
  contact: ContactDetail;
  task: ContactResearchTaskSummary;
}

// ---------------------------------------------------------------------------
// Contact & Outreach (R6 Phase 3 — outreach drafts)
//
// Truthful, reviewable, generation-versioned outreach drafts. Generation +
// revision run the LLM + the reused materials gate stack on the Python worker
// (draft body, gate results, and claim -> fact provenance are user-owned content
// that reaches the client through these read DTOs and lives in the thread read
// model). Approval/rejection are TS-API transitions gated on the persisted gate
// outcome (INV-5). There is NO send transport on any outreach surface (INV-1):
// an approved draft is copied out via the browser clipboard, never sent.
// ---------------------------------------------------------------------------

export const OUTREACH_DRAFT_KINDS = ["intro_request", "follow_up"] as const;
export const OutreachDraftKindSchema = z.enum(OUTREACH_DRAFT_KINDS).catch("intro_request");
export type OutreachDraftKind = (typeof OUTREACH_DRAFT_KINDS)[number];

export const OUTREACH_DRAFT_STATUSES = [
  "candidate",
  "approved",
  "rejected",
  "superseded",
] as const;
export type OutreachDraftStatus = (typeof OUTREACH_DRAFT_STATUSES)[number];

/** One deterministic never-fabricate finding against the rendered draft text. */
export interface OutreachGateFabrication {
  section: string;
  kind: string;
  token: string;
  control: string;
  generatedText: string;
}

export interface OutreachGateValidation {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

export interface OutreachGateJudge {
  approved: boolean;
  score: number;
  criterionScores: Record<string, number>;
  issues: string[];
  notes: string;
}

/** The persisted gate-stack outcome; `passed` is the sole approval authority (INV-5). */
export interface OutreachDraftGateResults {
  passed: boolean;
  computedAgainst: string;
  fabrications: OutreachGateFabrication[];
  validation: OutreachGateValidation;
  judge: OutreachGateJudge | null;
}

/** One claim in a draft bound to the confirmed fact(s) it rests on (INV-2). */
export interface OutreachClaimProvenanceDto {
  claimId: string;
  section: string;
  generatedText: string;
  contactFactIds: string[];
  profileGrounded: boolean;
  rationale: string;
}

export interface OutreachDraftDto {
  draftId: string;
  threadId: string;
  generation: number;
  kind: OutreachDraftKind;
  status: OutreachDraftStatus;
  bodyText: string;
  gateResults: OutreachDraftGateResults;
  provenance: OutreachClaimProvenanceDto[];
  createdAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  reason: string;
}

export interface OutreachThreadSummary {
  threadId: string;
  contactId: string;
  jobId: string | null;
  draftCount: number;
  latestGeneration: number;
  hasApprovedDraft: boolean;
  approvedDraftId: string | null;
  latestStatus: OutreachDraftStatus | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface OutreachThreadDetail extends OutreachThreadSummary {
  drafts: OutreachDraftDto[];
  /** User-attested send records — the ONLY source of a "sent" state (INV-1). */
  sendLogs: OutreachSendLogDto[];
  /** The thread's follow-up schedule, or null when none is scheduled. */
  followUp: OutreachFollowUp | null;
  /** Derived: true iff the thread carries at least one user-attested send log. */
  isSent: boolean;
}

export const GenerateOutreachDraftRequestSchema = z
  .object({
    jobId: outreachJobIdField,
    kind: OutreachDraftKindSchema.optional(),
    applicationRole: z.string().trim().max(200).optional(),
    llmModel: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type GenerateOutreachDraftRequest = z.infer<typeof GenerateOutreachDraftRequestSchema>;

export const ReviseOutreachDraftRequestSchema = z
  .object({
    editedBodyText: z.string().trim().min(1).max(8000),
    kind: OutreachDraftKindSchema.optional(),
    applicationRole: z.string().trim().max(200).optional(),
    llmModel: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type ReviseOutreachDraftRequest = z.infer<typeof ReviseOutreachDraftRequestSchema>;

export const RejectOutreachDraftRequestSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type RejectOutreachDraftRequest = z.infer<typeof RejectOutreachDraftRequestSchema>;

export const OutreachThreadQuerySchema = z
  .object({
    contactId: optionalText,
    jobId: outreachJobIdField,
  })
  .strict();
export type OutreachThreadQuery = z.infer<typeof OutreachThreadQuerySchema>;

export interface OutreachThreadResponse {
  ok: true;
  thread: OutreachThreadDetail | null;
}

// ---------------------------------------------------------------------------
// Contact & Outreach (R6 Phase 4 — user-attested send log + follow-ups)
//
// INV-1: JobCtrl NEVER sends. A thread reaches a "sent" state ONLY via a
// user-attested `OutreachSendLog` over an APPROVED draft — a recorded fact, not a
// transmission. `channel` is a controlled label ("email", "linkedin_message"),
// never an address. Follow-ups are surfaced-only: a derived suggested date, fully
// user-editable, never auto-acted and never sent.
// ---------------------------------------------------------------------------

export const OUTREACH_SEND_CHANNELS = [
  "email",
  "personal_email",
  "work_email",
  "linkedin_message",
  "phone_call",
  "other",
] as const;
export type OutreachSendChannel = (typeof OUTREACH_SEND_CHANNELS)[number];

/** A user-attested record that the user sent an approved draft (INV-1). */
export interface OutreachSendLogDto {
  sendLogId: string;
  threadId: string;
  draftId: string;
  channel: string;
  sentAt: string;
  loggedAt: string;
}

export const FOLLOW_UP_STATES = ["none", "scheduled", "completed", "dismissed"] as const;
export type FollowUpState = (typeof FOLLOW_UP_STATES)[number];

export const FOLLOW_UP_BASES = [
  "application_submitted",
  "no_reply_nudge",
  "manual",
] as const;
export type FollowUpBasis = (typeof FOLLOW_UP_BASES)[number];

/** A thread's follow-up schedule (a plan, never an action). */
export interface OutreachFollowUp {
  state: FollowUpState;
  dueAt: string | null;
  basis: string;
}

/** One scheduled outreach follow-up surfaced in the due-follow-ups read model. */
export interface DueFollowUpSummary {
  threadId: string;
  contactId: string;
  jobId: string | null;
  dueAt: string | null;
  basis: string;
  state: FollowUpState;
  /** Derived over schedule + clock at read time: has the follow-up date arrived? */
  isDue: boolean;
}

export interface DueFollowUpsResponse {
  ok: true;
  followUps: DueFollowUpSummary[];
}

export const LogOutreachSendRequestSchema = z
  .object({
    draftId: z.string().trim().min(1).max(200),
    channel: z.enum(OUTREACH_SEND_CHANNELS),
    sentAt: z.string().trim().min(1).max(40),
  })
  .strict();
export type LogOutreachSendRequest = z.infer<typeof LogOutreachSendRequestSchema>;

export const ScheduleFollowUpRequestSchema = z
  .object({
    dueAt: z.string().trim().min(1).max(40).optional(),
    basis: z.enum(FOLLOW_UP_BASES).optional(),
    hasLoggedReply: z.boolean().optional(),
  })
  .strict();
export type ScheduleFollowUpRequest = z.infer<typeof ScheduleFollowUpRequestSchema>;
