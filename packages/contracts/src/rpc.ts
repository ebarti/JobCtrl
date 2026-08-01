/**
 * JSON-RPC 2.0 wire envelope + JobCtrl method schemas.
 *
 * TypeScript mirror of `workers/automation/src/jobctrl/domain/rpc/messages.py`.
 * The TS API uses these schemas to validate requests it sends to the Python
 * worker over the local subprocess transport (target §6.5).
 */
import { z } from "zod";

import {
  DEFAULT_PIPELINE_LLM_MODEL,
  MANUAL_CAPTURE_MODE_VALUES,
  STAGES,
} from "./schemas.js";

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
  RunStage: "run_stage",
  RescoreJob: "rescore_job",
  RescoreJobsNotOnCurrentScoringPolicy: "rescore_jobs_not_on_current_scoring_policy",
  TailorJob: "tailor_job",
  RetailorJob: "retailor_job",
  RetailorCurrentPolicy: "retailor_current_policy",
  AnalyzeJob: "analyze_job",
  RefreshCompensation: "refresh_compensation",
  GenerateInterviewPrep: "generate_interview_prep",
  RunContactResearch: "run_contact_research",
  GenerateOutreachDraft: "generate_outreach_draft",
  Apply: "apply",
  ProfileImport: "profile_import",
  ManualCaptureImport: "manual_capture_import",
  CancelRun: "cancel_run",
  ProviderStatus: "provider_status",
  ProviderModels: "provider_models",
  ProviderVerify: "provider_verify",
  BrowserCapabilitiesList: "browser_capabilities_list",
  BrowserCapabilityEnable: "browser_capability_enable",
  BrowserCapabilityDisable: "browser_capability_disable",
  BrowserProfileCopy: "browser_profile_copy",
} as const;
export type RpcMethod = (typeof RpcMethods)[keyof typeof RpcMethods];

const TenantParam = z.string().trim().min(1).default("local");
const CanonicalJobIdParam = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "jobId must be a canonical lowercase UUID",
  );

/* --- complex commands (delegated to Python JSON-RPC / Temporal) ---------- */

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

/**
 * Import one user-mediated capture through the supervised Temporal worker.
 * The TypeScript API always awaits the result so the existing REST endpoint
 * retains its synchronous, imported-material response contract.
 */
export const ManualCaptureImportParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    itemId: z.string().trim().min(1),
    captureMode: z.enum(MANUAL_CAPTURE_MODE_VALUES),
    contentText: z.string().trim().max(200_000).optional(),
    contentHtmlBase64: z.string().trim().max(8_000_000).optional(),
    capturedUrl: z
      .string()
      .trim()
      .max(2048)
      .regex(/^https?:\/\/[^\s]+$/i, "capturedUrl must be a valid http(s) URL")
      .optional(),
    note: z.string().trim().max(400).optional(),
    futureManualActionRequired: z.boolean().default(false),
    awaitResult: z.literal(true),
  })
  .strict()
  .refine(
    (params) =>
      params.capturedUrl !== undefined ||
      params.contentText !== undefined ||
      params.contentHtmlBase64 !== undefined,
    { message: "provide capturedUrl, contentText, or contentHtmlBase64" },
  );
export type ManualCaptureImportParams = z.infer<typeof ManualCaptureImportParamsSchema>;

/** Nested result returned by the awaited manual-capture Temporal workflow. */
export const ManualCaptureImportWorkflowResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("succeeded"),
      item_id: z.string().trim().min(1),
      job_id: z.string().trim().min(1),
      imported_at: z.string().trim().min(1),
      retry_context: z.record(z.string(), z.unknown()),
      error: z.null(),
      error_code: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      item_id: z.null(),
      job_id: z.null(),
      imported_at: z.null(),
      retry_context: z.record(z.string(), z.unknown()),
      error: z.string().nullable(),
      error_code: z.string().nullable(),
    })
    .strict(),
]);
export type ManualCaptureImportWorkflowResult = z.infer<typeof ManualCaptureImportWorkflowResultSchema>;

export const RescoreJobParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    jobId: CanonicalJobIdParam,
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
    levelsFyiPublicObservationsLoaded: z.number().int().min(0).default(0),
    glassdoorObservationsLoaded: z.number().int().min(0).default(0),
    euroTopTechObservationsLoaded: z.number().int().min(0).default(0),
    estimatesRefreshed: z.number().int().min(0),
    marketRefreshSkipped: z.boolean().default(false),
    tenantId: z.string().min(1),
  })
  .strict();
export type RefreshCompensationResult = z.infer<typeof RefreshCompensationResultSchema>;

export const GenerateInterviewPrepParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    jobUrl: z.string().min(1),
    llmModel: z.string().trim().min(1).max(120).default(DEFAULT_PIPELINE_LLM_MODEL),
  })
  .strict();
export type GenerateInterviewPrepParams = z.infer<typeof GenerateInterviewPrepParamsSchema>;

/**
 * Contact & Outreach (R6 Phase 2): start a supervised research run on the Python
 * worker via Temporal (plan §4.5). The TS API mints ``taskId`` so it can return
 * it immediately and the UI can poll the task. Fetching routes only through the
 * merged politeness gateway against the conservative opt-in allowlist (INV-3);
 * candidates land ``needs_review`` (INV-4).
 */
export const ContactResearchSourceInputSchema = z
  .object({
    category: z.enum(["user_entered", "public_web_page", "user_imported_list"]),
    url: z.string().trim().max(2000).default(""),
    label: z.string().trim().max(200).default(""),
  })
  .strict();
export type ContactResearchSourceInput = z.infer<typeof ContactResearchSourceInputSchema>;

export const RunContactResearchParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    taskId: z.string().trim().min(1).max(200),
    employer: z.string().trim().min(1).max(200).nullish(),
    jobUrl: z.string().trim().min(1).max(2000).nullish(),
    sources: z.array(ContactResearchSourceInputSchema).max(25).default([]),
    llmModel: z.string().trim().min(1).max(120).default(DEFAULT_PIPELINE_LLM_MODEL),
  })
  .strict()
  .refine((params) => Boolean(params.employer) || Boolean(params.jobUrl), {
    message: "provide at least one of employer or jobUrl",
    path: ["employer"],
  });
export type RunContactResearchParams = z.infer<typeof RunContactResearchParamsSchema>;

// Outreach draft generation/revision (Contact & Outreach, R6 Phase 3). Runs the
// LLM + the truthfulness gate stack on the worker (synchronous, like analyze_job)
// and persists a gated draft. ``editedBodyText`` selects the revise path. There
// is no send capability on this method (INV-1).
export const GenerateOutreachDraftParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    threadId: z.string().trim().min(1).max(200),
    contactId: z.string().trim().min(1).max(200).optional(),
    jobId: z.string().trim().min(1).max(2000).nullish(),
    kind: z.enum(["intro_request", "follow_up"]).default("intro_request"),
    editedBodyText: z.string().trim().min(1).max(8000).optional(),
    applicationRole: z.string().trim().max(200).optional(),
    llmModel: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((params) => Boolean(params.contactId) || Boolean(params.editedBodyText), {
    message: "provide contactId (generate) or editedBodyText (revise)",
    path: ["contactId"],
  });
export type GenerateOutreachDraftParams = z.infer<typeof GenerateOutreachDraftParamsSchema>;

export const GenerateOutreachDraftResultSchema = z
  .object({
    threadId: z.string(),
    contactId: z.string(),
    jobId: z.string().nullable(),
    draftId: z.string(),
    generation: z.number().int().nonnegative(),
    kind: z.enum(["intro_request", "follow_up"]),
    status: z.enum(["candidate", "approved", "rejected", "superseded"]),
    gatePassed: z.boolean(),
  })
  .strict();
export type GenerateOutreachDraftResult = z.infer<typeof GenerateOutreachDraftResultSchema>;

export const RetailorJobParamsSchema = z
  .object({
    tenantId: TenantParam,
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    jobId: CanonicalJobIdParam,
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

// NOTE: rescore_job / tailor_job / retailor_job / retailor_current_policy /
// rescore_jobs_not_on_current_scoring_policy are ``mode="workflow"`` handlers.
// They return the ``{runId, workflowId, firstExecutionRunId}`` start shape
// (ApplyResult), so their old per-action result schemas were stale and have
// been removed.

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
    expectedAppDir: z.string().trim().min(1).optional(),
    expectedDbPath: z.string().trim().min(1).optional(),
    pdfPath: z.string().min(1),
    importProfile: z.boolean().default(true),
    importStyle: z.boolean().default(true),
  })
  .strict();
export type ProfileImportParams = z.infer<typeof ProfileImportParamsSchema>;

/* --- Legacy LocalActionResult shape (still parsed for old sync adapters) -- */

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
