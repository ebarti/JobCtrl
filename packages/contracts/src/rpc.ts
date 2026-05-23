/**
 * JSON-RPC 2.0 wire envelope + JobHunter method schemas.
 *
 * TypeScript mirror of `workers/automation/src/jobhunter/domain/rpc/messages.py`.
 * The TS API uses these schemas to validate requests it sends to the Python
 * worker over the local subprocess transport (target §6.5).
 */
import { z } from "zod";

import { STAGES } from "./schemas.js";

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
    continuous: z.boolean().default(false),
  })
  .strict();
export type RunStageParams = z.infer<typeof RunStageParamsSchema>;

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
