import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { JobCtrlApiError } from "@jobctrl/api-client";
import { useMemo } from "react";
import { z } from "zod";

import { useRuntimeHealth } from "../runtime/index.js";

import { cancellationDeliverySchema } from "../../shared/lib/actionStop.js";
import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";
import type { SessionRequestIdentity } from "../../shared/lib/useSessionRequestIdentity.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { preparationRequestInput, type PreparationRetryRequest, usePreparationRecovery } from "./recovery.js";

export const recipeSchema = z.enum(["run", "discover", "enrich", "analyze", "score", "tailor", "prepare"]);
export type PreparationRecipe = z.infer<typeof recipeSchema>;
export type PreparationResumeMode = "baseline" | "tailored";
export type PreparationRequest = {
  recipe: PreparationRecipe;
  job_ids?: readonly string[];
  scope?: "selected" | "pending";
  limit?: number;
  force?: boolean;
  min_fit_score?: number;
  allow_below_threshold?: boolean;
  resume_mode?: PreparationResumeMode;
};
const stepSchema = z.object({
  jobId: z.string().nullable(), stage: z.string(), status: z.string(), postingRevision: z.number().int().positive().optional(),
  result: z.record(z.string(), z.unknown()).nullable(), errorCode: z.string().nullable(), updatedAt: z.string(),
});
const runSchema = z.object({
  runId: z.string(), status: z.string(), recipe: z.enum([...recipeSchema.options, "search", "assess"]), parentRunId: z.string().nullable(),
  cohortFrozen: z.boolean().optional(), targetRoute: z.string().optional(),
  executionPolicy: z.object({ version: z.enum(["search-cohort-v1", "search-jobs-v1"]) }).optional(),
  jobIds: z.array(z.string()), retryableJobIds: z.array(z.string()).optional(), createdAt: z.string(), updatedAt: z.string(), steps: z.array(stepSchema),
});
const executionSchema = z.object({ runId: z.string(), status: z.string(), errorCode: z.string().nullable().optional(),
  cancellationRequested: z.boolean(), cancellationDelivery: cancellationDeliverySchema }).passthrough();
const listSchema = z.object({ runs: z.array(runSchema) });
const receiptSchema = z.object({ runId: z.string().min(1), workflowId: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]) });
const retryAdmissionRefusals = new Map([
  ["preparation_cohort_retry_scope_required", "The earlier retry did not start. Continue the original search to finish assessing its jobs."],
  ["preparation_retry_superseded", "This run already has a retry. Follow it in preparation history."],
  ["nothing_to_retry", "All jobs from this search have already finished assessment."],
]);
export type PreparationRun = z.infer<typeof runSchema>;

export const preparationKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "preparation"] as const,
  runs: (tenantId: string) => [...preparationKeys.all(tenantId), "runs"] as const,
  detail: (tenantId: string, runId: string) => [...preparationKeys.all(tenantId), "detail", runId] as const,
};

export function usePreparationRuns({ enabled = true, databaseInstanceId, active = false }: {
  enabled?: boolean; databaseInstanceId?: string | undefined; active?: boolean;
} = {}) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const health = useRuntimeHealth();
  const databaseId = databaseInstanceId ?? health.data?.databaseInstanceId;
  return useQuery({
    queryKey: [...preparationKeys.runs(tenantId), databaseId ?? ""],
    enabled: enabled && !health.isPending && Boolean(health.data?.features.includes("preparation")),
    queryFn: async () => {
      const parsed = listSchema.safeParse(await http.json<unknown>("GET", "/v1/preparation/runs",
        databaseId ? { expectedDatabaseInstanceId: databaseId } : undefined));
      if (!parsed.success) throw new Error("Preparation runs could not be read safely.");
      return parsed.data.runs;
    },
    meta: { suppressGlobalErrorToast: true },
    refetchInterval: (query) => active || query.state.data?.some((run) => ["pending", "queued", "running"].includes(run.status)) ? 3000 : false,
  });
}

/** Recover older whole-run and job-level retry buttons from their exact saved fingerprint. */
export function usePreviousPreparationRetry(record: SessionRequestIdentity, jobId?: string) {
  const tenantId = useTenantId();
  const { requestIdentity } = usePorts();
  const runs = usePreparationRuns({ databaseInstanceId: record.databaseInstanceId });
  return useQuery({
    queryKey: [...preparationKeys.all(tenantId), "previous-retry", record.requestId, jobId ?? "", runs.dataUpdatedAt],
    enabled: Boolean(runs.data),
    queryFn: async () => {
      const candidates: PreparationRetryRequest[] = (runs.data ?? []).flatMap((run) => {
        const body = { run_id: run.runId };
        return jobId && run.jobIds.includes(jobId) ? [body, { ...body, job_ids: [jobId] }] : [body];
      });
      const fingerprints = await Promise.all(candidates.map((body) => requestIdentity.fingerprint(preparationRequestInput("preparation.retry", body))));
      return candidates[fingerprints.indexOf(record.fingerprint)] ?? null;
    },
    meta: { suppressGlobalErrorToast: true },
  });
}

/** The header and Jobs projections share the same workspace-bound bulk read. */
export function useSearchPreparationProgress({ runId, databaseInstanceId, enabled, active }: {
  runId: string | null; databaseInstanceId: string | undefined; enabled: boolean; active: boolean;
}) {
  const runs = usePreparationRuns({ enabled: enabled && Boolean(runId && databaseInstanceId), databaseInstanceId, active });
  const data = useMemo(() => {
    if (!enabled || !runId || !databaseInstanceId) return null;
    const run = runs.data?.find((item) => item.runId === runId && item.recipe === "search");
    if (!run) return null;
    const targets = new Set(run.jobIds);
    const targetSteps = run.steps.filter((step) => step.jobId !== null && targets.has(step.jobId));
    const discovered = run.steps.some((step) => step.jobId === null && step.stage === "discover" && ["succeeded", "warning"].includes(step.status));
    const fits = new Set(targetSteps.filter((step) => step.stage === "fit" && step.status === "succeeded" && typeof step.result?.score === "number").map((step) => step.jobId));
    const skipped = targetSteps.flatMap((step) => {
      if (!step.jobId || step.stage !== "fit") return [];
      if (step.status === "skipped" && step.result?.skip === "unsupported_posting_language") return [{ jobId: step.jobId, reason: "unsupported_posting_language" }];
      if (step.status === "succeeded" && step.result?.score === null) return [{ jobId: step.jobId, reason: "no_extractable_requirements" }];
      return [];
    });
    const failures = targetSteps.filter((step) => step.status === "failed").map((step) => ({ jobId: step.jobId!, stage: step.stage, code: step.errorCode }));
    const completedChecks = (stage: string) => {
      const recorded = targetSteps.filter((step) => step.stage === stage);
      if (!recorded.length) return null;
      return new Set(recorded.filter((step) => step.status === "succeeded" ||
        (stage === "enrich" && step.status === "skipped" && step.result?.skip === "accepted_detail_current")).map((step) => step.jobId)).size;
    };
    const scoring = targetSteps.some((step) => step.stage === "fit" && ["running", "succeeded"].includes(step.status));
    const sharedStage = run.steps.find((step) => step.jobId === null && step.status === "running" &&
      ["requirements_normalize", "fit_qualify"].includes(step.stage))?.stage;
    const checkpoint = active && discovered && run.status === "running" && run.cohortFrozen === true && targets.size > 0 && !scoring &&
      (run.targetRoute === "cohort" || run.targetRoute === "per_job") ? {
        postingsChecked: completedChecks("enrich"), requirementsChecked: completedChecks(run.targetRoute === "cohort" ? "requirements_extract" : "requirements"),
        phase: run.executionPolicy?.version === "search-jobs-v1" ? "checking_each_job" as const :
          sharedStage === "fit_qualify" ? "qualifying" as const : sharedStage === "requirements_normalize" ? "normalizing" as const : "checking" as const,
      } : null;
    const haveTargets = run.cohortFrozen === true || run.executionPolicy?.version === "search-jobs-v1";
    return { phase: active ? discovered ? "assessing" as const : "acquiring" as const : null,
      checkpoint,
      assessedJobs: haveTargets ? fits.size : null,
      failedJobs: haveTargets ? new Set(failures.map((failure) => failure.jobId)).size : null,
      skippedJobs: haveTargets ? skipped.length : null, skipped,
      totalJobs: haveTargets ? targets.size : null, failures };
  }, [runs.data, runId, databaseInstanceId, enabled, active]);
  return { data, isError: runs.isError, error: runs.error };
}

/** Actions may be queued before Preparation has opened its own checkpoint row. */
export function usePreparationExecution(runId: string | null) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  return useQuery({
    queryKey: [...preparationKeys.all(tenantId), "execution", runId] as const,
    enabled: Boolean(runId),
    queryFn: async () => {
      const value = executionSchema.parse(await http.json<unknown>("GET", `/v1/action-runs/${encodeURIComponent(runId ?? "")}`));
      void client.invalidateQueries({ queryKey: preparationKeys.runs(tenantId) });
      return value;
    },
    refetchInterval: (query) => ["pending", "queued", "running"].includes(query.state.data?.status ?? "pending") ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
}

export function usePreparationRun(runId: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: preparationKeys.detail(tenantId, runId),
    queryFn: async () => {
      let value: unknown;
      try {
        value = await http.json<unknown>("GET", `/v1/preparation/runs/${encodeURIComponent(runId)}`);
      } catch (error) {
        if (error && typeof error === "object" && "status" in error && error.status === 404) return null;
        throw error;
      }
      const parsed = runSchema.safeParse(value);
      if (!parsed.success) throw new Error("The preparation run could not be read safely.");
      return parsed.data;
    },
    meta: { suppressGlobalErrorToast: true },
  });
}

export function usePreparationCommands() {
  const tenantId = useTenantId();
  const client = useQueryClient();
  const { http } = usePorts();
  const recovery = usePreparationRecovery();
  const submit = useMutation({
    mutationFn: async (input: { action: "preparation.run"; body: PreparationRequest } | { action: "preparation.retry"; body: PreparationRetryRequest }) => {
      const { identity, previous } = await recovery.begin(input.action, input.body);
      const path = `/v1/actions/${input.action}`;
      try {
        const parsed = receiptSchema.safeParse(await http.json<unknown>("POST", path, {
          body: input.body, idempotencyKey: identity.requestId, expectedDatabaseInstanceId: identity.databaseInstanceId,
        }));
        if (!parsed.success) throw createUnconfirmedWriteError("POST", path, parsed.error);
        try { recovery.clear(identity); }
        catch (error) { throw createUnconfirmedWriteError("POST", path, error); }
        return parsed.data;
      } catch (error) {
        const errorBody = error instanceof JobCtrlApiError ? error.responseBody : null;
        const errorCode = errorBody && typeof errorBody === "object" && "error" in errorBody
          && errorBody.error && typeof errorBody.error === "object" && "code" in errorBody.error
          ? errorBody.error.code : null;
        // These exact retry refusals roll back the admission transaction,
        // including when the client resends an earlier request with the same key.
        const retryRefusal = input.action === "preparation.retry" && typeof errorCode === "string"
          ? retryAdmissionRefusals.get(errorCode) : undefined;
        const rejectedBeforeAdmission = error instanceof JobCtrlApiError && (
          (error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status))
          || errorCode === "worker_unavailable" || errorCode === "workspace_changed"
        );
        if (retryRefusal || (!previous && rejectedBeforeAdmission)) {
          try { recovery.clear(identity); } catch { /* Retain for explicit reconciliation. */ }
        }
        if (retryRefusal) throw new Error(retryRefusal);
        throw error;
      }
    },
    onSettled: () => { recovery.refresh(); void client.invalidateQueries({ queryKey: preparationKeys.all(tenantId) }); },
    meta: { suppressGlobalErrorToast: true },
  });
  const cancel = useMutation({
    mutationFn: async (runId: string) => {
      const path = `/v1/action-runs/${encodeURIComponent(runId)}/cancel`;
      const response = await http.json<unknown>("POST", path, { body: {} });
      const parsed = executionSchema.extend({ runId: z.literal(runId) }).safeParse(response);
      if (!parsed.success) throw createUnconfirmedWriteError("POST", path, parsed.error);
      return parsed.data;
    },
    onSettled: () => client.invalidateQueries({ queryKey: preparationKeys.all(tenantId) }),
  });
  return { submit, cancel, recovery };
}

export const preparationInvalidation: FeatureEventHandler = {
  eventTypes: ["PreparationUpdated"] as const,
  handle(event, invalidate) {
    invalidate(preparationKeys.all(event.tenantId));
  },
};
