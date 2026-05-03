import { z } from "zod";

export const STAGES = ["discover", "enrich", "score", "tailor", "cover", "pdf", "apply"] as const;
export type Stage = (typeof STAGES)[number];

export const MATERIAL_STAGES = ["tailor", "cover", "pdf"] as const;
export type MaterialStage = (typeof MATERIAL_STAGES)[number];

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

export const JOB_SORT_FIELDS = [
  "discovered_at",
  "title",
  "company",
  "fit_score",
  "current_stage",
  "current_state",
] as const;
export type JobSortField = (typeof JOB_SORT_FIELDS)[number];

export const ARTIFACT_SORT_FIELDS = ["created_at", "title", "company", "type", "status", "size_bytes"] as const;
export type ArtifactSortField = (typeof ARTIFACT_SORT_FIELDS)[number];

export const SortDirectionSchema = z.enum(["asc", "desc"]).default("desc").catch("desc");

export const RetryStageRequestSchema = z
  .object({
    stage: z.enum(STAGES),
    resetAttempts: z.boolean().default(false),
    runAfter: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  })
  .strict();
export type RetryStageRequest = z.infer<typeof RetryStageRequestSchema>;

export const GenerateMaterialsRequestSchema = z
  .object({
    stages: z.array(z.enum(MATERIAL_STAGES)).min(1).default(["tailor", "cover", "pdf"]),
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
    model: z.string().trim().min(1).max(80).default("haiku"),
  })
  .strict();
export type ApplyJobRequest = z.infer<typeof ApplyJobRequestSchema>;

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

const optionalText = z
  .string()
  .trim()
  .optional()
  .catch("")
  .transform((value) => value ?? "");

const optionalNumber = z.coerce.number().int().optional().catch(undefined);

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

export interface JobSummary {
  jobKey: string;
  url: string;
  title: string;
  company: string;
  source: string;
  strategy: string;
  location: string;
  salary: string;
  discoveredAt: string | null;
  applicationUrl: string | null;
  fitScore: number | null;
  currentStage: Stage;
  currentState: StageState;
  errorCode: string | null;
  errorMessage: string | null;
  nextAction: string | null;
  artifactCount: number;
  applyStatus: string | null;
  appliedAt: string | null;
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
    jobKey: string | null;
    stage: string;
    level: string;
    message: string;
    at: string | null;
  }>;
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
  profile: unknown;
  style: unknown;
  templateText: string;
}

export interface ProfileImportResponse {
  ok: true;
  profile?: unknown;
  style?: unknown;
  templateText?: string;
  source?: unknown;
  action?: ActionRunResponse;
}

export interface ActionCommandPayload {
  action:
    | "retry_stage"
    | "generate_materials"
    | "apply"
    | "cancel"
    | "mark_applied"
    | "mark_skipped"
    | "profile_import";
  jobKey: string;
  stage?: Stage;
  stages?: MaterialStage[];
  resetAttempts?: boolean;
  runAfter?: boolean;
  dryRun?: boolean;
  limit?: number;
  model?: string;
  headless?: boolean;
  runId?: string;
  reason?: string;
}

export interface ActionRunResponse {
  ok: true;
  runId: string;
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

export interface DashboardSettings {
  targetRole: string;
  locationFilter: string;
  minFitScore: number;
  autoApply: boolean;
  applyConcurrency: number;
}

export interface SettingsResponse {
  ok: true;
  settings: DashboardSettings;
  paths: {
    settingsPath: string;
  };
}
