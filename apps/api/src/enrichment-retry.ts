import {
  ResetEnrichmentParamsSchema,
  ResetEnrichmentResultSchema,
  RpcMethods,
  type BulkJobMutationRequest,
  type Stage,
} from "./contracts.js";
import type { SqliteDatabase } from "./db.js";
import type { JsonRpcDispatcher } from "./json-rpc-adapter.js";
import type { ActionDispatchContext } from "./local-actions.js";
import {
  getStageStateById,
  InputError,
  resetJobStage,
  resolveJobId,
  retryFailedJobs,
  retryFailedJobTargets,
  type RetryFailedJobsResult,
} from "./write-model.js";

async function resetEnrichment(
  rpc: JsonRpcDispatcher,
  context: ActionDispatchContext,
  targets: { jobId: string; stage: Stage }[],
  resetAttempts: boolean,
  onlyFailed: boolean,
) {
  const params = ResetEnrichmentParamsSchema.parse({
    tenantId: "local", expectedAppDir: context.appDir, expectedDbPath: context.dbPath,
    targets, resetAttempts, onlyFailed,
  });
  const response = await rpc.call(RpcMethods.ResetEnrichment, params);
  if (response.error) throw new Error(response.error.message);
  const result = ResetEnrichmentResultSchema.parse(response.result);
  if (result.resets.length !== targets.length || result.resets.some((reset, index) =>
    reset.jobId !== targets[index]?.jobId || reset.stage !== targets[index]?.stage)) {
    throw new Error("Enrichment reset returned a different target cohort.");
  }
  return result.resets;
}

export async function resetJobStageWithEnrichmentOwner(
  db: SqliteDatabase, rpc: JsonRpcDispatcher, context: ActionDispatchContext,
  locator: string, stage: Stage, options: { resetAttempts: boolean },
) {
  if (stage !== "enrich") return resetJobStage(db, locator, stage, options);
  const jobId = resolveJobId(db, "local", locator);
  if (!jobId) throw new InputError("Job not found.");
  const [reset] = await resetEnrichment(rpc, context, [{ jobId, stage }], options.resetAttempts, false);
  return { jobUrl: reset!.jobUrl, stage: getStageStateById(db, "local", jobId, stage) };
}

export async function retryFailedJobsWithEnrichmentOwner(
  db: SqliteDatabase, rpc: JsonRpcDispatcher, context: ActionDispatchContext,
  request: BulkJobMutationRequest,
): Promise<RetryFailedJobsResult> {
  const targets = retryFailedJobTargets(db, request);
  if (!targets.some((target) => target.stage === "enrich")) return retryFailedJobs(db, request);
  // One RPC owns the whole cohort: splitting Enrich from the other stages
  // would turn the existing atomic bulk mutation into partial commits.
  const resets = await resetEnrichment(rpc, context, targets.map((target) => {
    const jobId = resolveJobId(db, "local", target.jobUrl);
    if (!jobId) throw new InputError("Job not found.");
    return { jobId, stage: target.stage };
  }), false, true);
  const stageCounts: Partial<Record<Stage, number>> = {};
  for (const reset of resets) stageCounts[reset.stage] = (stageCounts[reset.stage] ?? 0) + 1;
  return {
    ok: true, count: resets.length, jobKeys: resets.map((reset) => reset.jobUrl),
    targets: resets.map(({ jobUrl, stage }) => ({ jobUrl, stage })), stageCounts,
  };
}
