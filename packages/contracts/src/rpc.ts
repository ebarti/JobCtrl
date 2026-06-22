/**
 * JSON-RPC 2.0 wire envelope + JobHunter method schemas.
 *
 * TypeScript mirror of `workers/automation/src/jobhunter/domain/rpc/messages.py`.
 * The TS API uses these schemas to validate requests it sends to the Python
 * worker over the local subprocess transport (target §6.5).
 */
import { z } from "zod";

import { DEFAULT_PIPELINE_LLM_MODEL, STAGES } from "./schemas.js";

/* ------------------------------------------------------------------ codes */

export const JsonRpcErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;
export type JsonRpcErrorCode = (typeof JsonRpcErrorCodes)[keyof typeof JsonRpcErrorCodes];

/* ---------------------------------------------------------------- envelope */

export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
    id: JsonRpcIdSchema.optional(),
  })
  .strict();
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .strict();
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;

export const JsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    result: z.unknown().optional(),
    error: JsonRpcErrorSchema.optional(),
  })
  .strict()
  .refine((value) => (value.result === undefined) !== (value.error === undefined), {
    message: "Response must include exactly one of 'result' or 'error'",
  });
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/* ------------------------------------------------------------------ methods */

export const RpcMethods = {
  ResetStage: "reset_stage",
  MarkApplied: "mark_applied",
  MarkSkipped: "mark_skipped",
  CancelStage: "cancel_stage",
  RunStage: "run_stage",
  RescoreJob: "rescore_job",
  RescoreJobsNotOnCurrentScoringPolicy: "rescore_jobs_not_on_current_scoring_policy",
  TailorJob: "tailor_job",
  RetailorJob: "retailor_job",
  RetailorCurrentPolicy: "retailor_current_policy",
  AnalyzeJob: "analyze_job",
  RefreshCompensation: "refresh_compensation",
  Apply: "apply",
  ProfileImport: "profile_import",
  CancelRun: "cancel_run",
} as const;
export type RpcMethod = (typeof RpcMethods)[keyof typeof RpcMethods];

const TenantParam = z.string().trim().min(1).default("local");

/* --- simple state-transition commands ------------------------------------ */

export const ResetStageParamsSchema = z
  .object({
    tenantId: TenantParam,
    jobUrl: z.string().min(1),
    stage: z.enum(STAGES),
    resetAttempts: z.boolean().default(false),
  })
  .strict();
export type ResetStageParams = z.infer<typeof ResetStageParamsSchema>;

export const ResetStageResultSchema = z
  .object({
    jobUrl: z.string(),
    stage: z.enum(STAGES),
    state: z.literal("pending"),
  })
  .strict();
export type ResetStageResult = z.infer<typeof ResetStageResultSchema>;

export const MarkAppliedParamsSchema = z
  .object({
    tenantId: TenantParam,
    jobUrl: z.string().min(1),
  })
  .strict();
export type MarkAppliedParams = z.infer<typeof MarkAppliedParamsSchema>;

export const MarkAppliedResultSchema = z
  .object({
    jobUrl: z.string(),
    state: z.literal("succeeded"),
  })
  .strict();
export type MarkAppliedResult = z.infer<typeof MarkAppliedResultSchema>;

export const MarkSkippedParamsSchema = z
  .object({
    tenantId: TenantParam,
    jobUrl: z.string().min(1),
    stage: z.enum(STAGES),
    reason: z.string().max(400).optional(),
  })
  .strict();
export type MarkSkippedParams = z.infer<typeof MarkSkippedParamsSchema>;

export const MarkSkippedResultSchema = z
  .object({
    jobUrl: z.string(),
    stage: z.enum(STAGES),
    state: z.literal("skipped"),
  })
  .strict();
export type MarkSkippedResult = z.infer<typeof MarkSkippedResultSchema>;

export const CancelStageParamsSchema = z
  .object({
    tenantId: TenantParam,
    jobUrl: z.string().min(1),
    stage: z.enum(STAGES),
  })
  .strict();
export type CancelStageParams = z.infer<typeof CancelStageParamsSchema>;

export const CancelStageResultSchema = z
  .object({
    jobUrl: z.string(),
    stage: z.enum(STAGES),
    state: z.literal("canceled"),
  })
  .strict();
export type CancelStageResult = z.infer<typeof CancelStageResultSchema>;

/* --- complex commands (delegated to Python via run_local_action) --------- */

export const RunStageParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    stage: z.enum(STAGES),
    stages: z.array(z.enum(STAGES)).min(1).max(STAGES.length).optional(),
    jobUrl: z.string().optional(),
    limit: z.number().int().min(0).default(0),
    workers: z.number().int().min(1).default(1),
    minScore: z.number().int().min(0).max(10).default(7),
    validationMode: z.enum(["strict", "normal", "lenient"]).default("normal"),
    dryRun: z.boolean().default(false),
    rescore: z.boolean().default(false),
    retailor: z.boolean().default(false),
    headless: z.boolean().default(false),
    model: z.string().trim().min(1).max(80).default("default"),
    llmModel: z.string().trim().min(1).max(120).default(DEFAULT_PIPELINE_LLM_MODEL),
    tailorModels: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
    tailorJudgeModel: z.string().trim().min(1).max(120).optional(),
    tailorJudgeMinScore: z.number().min(0).max(1).optional(),
    continuous: z.boolean().default(false),
  })
  .strict();
export type RunStageParams = z.infer<typeof RunStageParamsSchema>;

export const RescoreJobParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    jobUrl: z.string().min(1),
    dryRun: z.boolean().default(false),
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type RescoreJobParams = z.infer<typeof RescoreJobParamsSchema>;

export const RescoreJobsNotOnCurrentScoringPolicyParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(1000).default(100),
    jobUrls: z.array(z.string().trim().min(1)).max(5000).default([]),
    dryRun: z.boolean().default(false),
    reason: z.string().trim().max(400).optional(),
  })
  .strict();
export type RescoreJobsNotOnCurrentScoringPolicyParams = z.infer<
  typeof RescoreJobsNotOnCurrentScoringPolicyParamsSchema
>;

export const TailorJobParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    jobUrl: z.string().min(1),
    dryRun: z.boolean().default(false),
    allowLowFitOverride: z.boolean().default(true),
    reason: z.string().trim().max(400).optional(),
    tailorModels: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
    tailorJudgeModel: z.string().trim().min(1).max(120).optional(),
    tailorJudgeMinScore: z.number().min(0).max(1).optional(),
  })
  .strict();
export type TailorJobParams = z.infer<typeof TailorJobParamsSchema>;

/**
 * Phase 1 (D-10): produce/inspect the canonical employer analysis for one job
 * independently of a full tailor. ``force`` bypasses the snapshot+version cache
 * to recompute (which supersedes, never destroys, the prior analysis — D-13).
 * The analysis runs the 2-SDK ensemble to completion with NO wall-clock
 * timeout (D-19); the call is synchronous and returns once persisted.
 */
export const AnalyzeJobParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    jobUrl: z.string().min(1),
    force: z.boolean().default(false),
  })
  .strict();
export type AnalyzeJobParams = z.infer<typeof AnalyzeJobParamsSchema>;

export const AnalyzeJobResultSchema = z
  .object({
    jobUrl: z.string(),
    generation: z.number().int(),
    cacheKey: z.string(),
    cached: z.boolean(),
    legsAttempted: z.number().int(),
    legsSucceeded: z.number().int(),
    degraded: z.boolean(),
  })
  .strict();
export type AnalyzeJobResult = z.infer<typeof AnalyzeJobResultSchema>;

export const RefreshCompensationParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    jobUrl: z.string().min(1).optional(),
    allJobs: z.literal(true).optional(),
    observationsJsonPath: z.string().trim().min(1).max(4000).optional(),
    includeEuroTopTech: z.boolean().optional(),
    euroTopTechMaxPages: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine((params) => Boolean(params.jobUrl) !== (params.allJobs === true), {
    message: "provide exactly one of jobUrl or allJobs",
  });
export type RefreshCompensationParams = z.infer<typeof RefreshCompensationParamsSchema>;

export const RefreshCompensationResultSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("succeeded"),
    jobUrl: z.string().nullable(),
    postedFactsRefreshed: z.number().int().min(0),
    reportedObservationsLoaded: z.number().int().min(0),
    localReportedObservationsLoaded: z.number().int().min(0).default(0),
    licensedReportedObservationsLoaded: z.number().int().min(0).default(0),
    levelsFyiObservationsLoaded: z.number().int().min(0).default(0),
    glassdoorObservationsLoaded: z.number().int().min(0).default(0),
    euroTopTechObservationsLoaded: z.number().int().min(0).default(0),
    estimatesRefreshed: z.number().int().min(0),
    marketRefreshSkipped: z.boolean().default(false),
    tenantId: z.string().min(1),
  })
  .strict();
export type RefreshCompensationResult = z.infer<typeof RefreshCompensationResultSchema>;

export const RetailorJobParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    jobUrl: z.string().min(1),
    dryRun: z.boolean().default(false),
    suppressExistingArtifacts: z.boolean().default(true),
    reason: z.string().trim().max(400).optional(),
    tailorModels: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
    tailorJudgeModel: z.string().trim().min(1).max(120).optional(),
    tailorJudgeMinScore: z.number().min(0).max(1).optional(),
  })
  .strict();
export type RetailorJobParams = z.infer<typeof RetailorJobParamsSchema>;

export const RetailorCurrentPolicyParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(1000).default(100),
    jobUrls: z.array(z.string().trim().min(1)).max(5000).default([]),
    dryRun: z.boolean().default(false),
    suppressExistingArtifacts: z.boolean().default(true),
    reason: z.string().trim().max(400).optional(),
    tailorModels: z.array(z.string().trim().min(1).max(120)).max(5).default([]),
    tailorJudgeModel: z.string().trim().min(1).max(120).optional(),
    tailorJudgeMinScore: z.number().min(0).max(1).optional(),
  })
  .strict();
export type RetailorCurrentPolicyParams = z.infer<typeof RetailorCurrentPolicyParamsSchema>;

export const ApplyParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    jobUrl: z.string().optional(),
    limit: z.number().int().min(1).default(1),
    workers: z.number().int().min(1).default(1),
    minScore: z.number().int().min(0).max(10).default(7),
    dryRun: z.boolean().default(false),
    model: z.string().min(1).default("default"),
    headless: z.boolean().default(false),
    continuous: z.boolean().default(false),
  })
  .strict();
export type ApplyParams = z.infer<typeof ApplyParamsSchema>;

// PR 3 cut over to ``mode="workflow"``; the worker now returns three IDs:
// ``runId`` (kept as the canonical handle so the existing TS contract and
// SSE / dashboard wiring stays compatible) plus ``workflowId`` and
// ``firstExecutionRunId``. ``workflowId`` is a duplicate of ``runId`` for
// the apply path today but the field stays for forward compatibility with
// future workflows whose run id and workflow id diverge. NOT ``.strict()``
// because future Temporal versions may add more identifiers.
export const ApplyResultSchema = z.object({
  runId: z.string(),
  workflowId: z.string().optional(),
  firstExecutionRunId: z.string().optional(),
});
export type ApplyResult = z.infer<typeof ApplyResultSchema>;

export const RescoreJobResultSchema = z
  .object({
    ok: z.literal(true),
    status: z.string(),
    jobUrl: z.string(),
    currentPolicyVersion: z.number().int().nullable(),
    actionId: z.string().optional(),
    eventCursor: z.string().nullable().optional(),
  })
  .strict();
export type RescoreJobResult = z.infer<typeof RescoreJobResultSchema>;

export const RescoreJobsNotOnCurrentScoringPolicyResultSchema = z
  .object({
    ok: z.literal(true),
    status: z.string(),
    count: z.number().int().min(0),
    jobUrls: z.array(z.string()),
    currentPolicyVersion: z.number().int().nullable(),
    actionId: z.string().optional(),
    eventCursor: z.string().nullable().optional(),
  })
  .strict();
export type RescoreJobsNotOnCurrentScoringPolicyResult = z.infer<
  typeof RescoreJobsNotOnCurrentScoringPolicyResultSchema
>;

export const RetailorJobResultSchema = z
  .object({
    ok: z.literal(true),
    status: z.string(),
    jobUrl: z.string(),
    currentPolicyVersion: z.number().int().nullable(),
    actionId: z.string().optional(),
    eventCursor: z.string().nullable().optional(),
  })
  .strict();
export type RetailorJobResult = z.infer<typeof RetailorJobResultSchema>;

export const TailorJobResultSchema = z
  .object({
    ok: z.literal(true),
    status: z.string(),
    jobUrl: z.string(),
    currentPolicyVersion: z.number().int().nullable(),
    actionId: z.string().optional(),
    eventCursor: z.string().nullable().optional(),
  })
  .strict();
export type TailorJobResult = z.infer<typeof TailorJobResultSchema>;

export const RetailorCurrentPolicyResultSchema = z
  .object({
    ok: z.literal(true),
    status: z.string(),
    count: z.number().int().min(0),
    jobUrls: z.array(z.string()),
    currentPolicyVersion: z.number().int().nullable(),
    actionId: z.string().optional(),
    eventCursor: z.string().nullable().optional(),
  })
  .strict();
export type RetailorCurrentPolicyResult = z.infer<typeof RetailorCurrentPolicyResultSchema>;

/* --- cooperative workflow cancellation ----------------------------------- */

export const CancelRunParamsSchema = z
  .object({
    tenantId: TenantParam,
    runId: z.string().min(1),
  })
  .strict();
export type CancelRunParams = z.infer<typeof CancelRunParamsSchema>;

export const CancelRunResultSchema = z
  .object({
    runId: z.string(),
    status: z.literal("canceling"),
  })
  .strict();
export type CancelRunResult = z.infer<typeof CancelRunResultSchema>;

export const ProfileImportParamsSchema = z
  .object({
    tenantId: TenantParam,
    pdfPath: z.string().min(1),
    importProfile: z.boolean().default(true),
    importStyle: z.boolean().default(true),
  })
  .strict();
export type ProfileImportParams = z.infer<typeof ProfileImportParamsSchema>;

/* --- LocalActionResult shape (returned by run_stage / profile_import) ---- */

export const LocalActionResultSchema = z
  .object({
    ok: z.boolean(),
    action_id: z.string(),
    stage: z.string(),
    status: z.string(),
    started_at: z.string(),
    finished_at: z.string(),
    duration_ms: z.number().int(),
    job_url: z.string().nullable().optional(),
    dry_run: z.boolean().default(false),
    result: z.record(z.string(), z.unknown()).default({}),
    error: z.string().nullable().optional(),
    traceback: z.string().nullable().optional(),
  })
  .passthrough();
export type LocalActionResult = z.infer<typeof LocalActionResultSchema>;

/* ----------------------------------------------------------------- helpers */

export function buildJsonRpcRequest<P extends Record<string, unknown>>(
  method: RpcMethod,
  params: P,
  id: JsonRpcId = 1,
): JsonRpcRequest {
  return { jsonrpc: "2.0", method, params, id } satisfies JsonRpcRequest;
}
