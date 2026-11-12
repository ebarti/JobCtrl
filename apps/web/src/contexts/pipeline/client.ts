import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { JobCtrlApiError } from "@jobctrl/api-client";
import { z } from "zod";

import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";
import type { DomainEventEnvelope } from "../../shared/ports/EventStreamPort.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { usePreparationRecovery } from "./recovery.js";

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
  jobId: z.string().nullable(), stage: z.string(), status: z.string(),
  result: z.record(z.string(), z.unknown()).nullable(), errorCode: z.string().nullable(), updatedAt: z.string(),
});
const runSchema = z.object({
  runId: z.string(), status: z.string(), recipe: recipeSchema, parentRunId: z.string().nullable(),
  jobIds: z.array(z.string()), createdAt: z.string(), updatedAt: z.string(), steps: z.array(stepSchema),
});
const listSchema = z.object({ runs: z.array(runSchema) });
const receiptSchema = z.object({ runId: z.string().min(1), workflowId: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]) });
export type PreparationRun = z.infer<typeof runSchema>;

export const preparationKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "preparation"] as const,
  runs: (tenantId: string) => [...preparationKeys.all(tenantId), "runs"] as const,
  detail: (tenantId: string, runId: string) => [...preparationKeys.all(tenantId), "detail", runId] as const,
};

export function usePreparationRuns() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: preparationKeys.runs(tenantId),
    queryFn: async () => {
      const parsed = listSchema.safeParse(await http.json<unknown>("GET", "/v1/preparation/runs"));
      if (!parsed.success) throw new Error("Preparation runs could not be read safely.");
      return parsed.data.runs;
    },
    meta: { suppressGlobalErrorToast: true },
    refetchInterval: (query) => query.state.data?.some((run) => ["pending", "queued", "running"].includes(run.status)) ? 3000 : false,
  });
}

/** Actions may be queued before Preparation has opened its own checkpoint row. */
export function usePreparationExecution(runId: string | null) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  const schema = z.object({ runId: z.string(), status: z.string(), errorCode: z.string().nullable().optional(), cancellationRequested: z.boolean() }).passthrough();
  return useQuery({
    queryKey: [...preparationKeys.all(tenantId), "execution", runId] as const,
    enabled: Boolean(runId),
    queryFn: async () => {
      const value = schema.parse(await http.json<unknown>("GET", `/v1/action-runs/${encodeURIComponent(runId ?? "")}`));
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
    mutationFn: async (input: { action: "preparation.run" | "preparation.retry"; body: PreparationRequest | { run_id: string; job_ids?: readonly string[] } }) => {
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
        // A definite client rejection before admission can be corrected. An
        // older uncertain identity, conflict, throttling or 5xx is retained.
        const errorBody = error instanceof JobCtrlApiError ? error.responseBody : null;
        const errorCode = errorBody && typeof errorBody === "object" && "error" in errorBody
          && errorBody.error && typeof errorBody.error === "object" && "code" in errorBody.error
          ? errorBody.error.code : null;
        const rejectedBeforeAdmission = error instanceof JobCtrlApiError && (
          (error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status))
          || errorCode === "worker_unavailable" || errorCode === "workspace_changed"
        );
        if (!previous && rejectedBeforeAdmission) {
          try { recovery.clear(identity); } catch { /* Retain for explicit reconciliation. */ }
        }
        throw error;
      }
    },
    onSettled: () => { recovery.refresh(); void client.invalidateQueries({ queryKey: preparationKeys.all(tenantId) }); },
  });
  const cancel = useMutation({
    mutationFn: async (runId: string) => {
      const path = `/v1/action-runs/${encodeURIComponent(runId)}/cancel`;
      const response = await http.json<unknown>("POST", path, { body: {} });
      const parsed = z.object({ runId: z.literal(runId), cancellationRequested: z.literal(true) }).passthrough().safeParse(response);
      if (!parsed.success) throw createUnconfirmedWriteError("POST", path, parsed.error);
      return parsed.data;
    },
    onSettled: () => client.invalidateQueries({ queryKey: preparationKeys.all(tenantId) }),
  });
  return { submit, cancel, recovery };
}

export const preparationInvalidation = {
  eventTypes: ["PreparationUpdated"] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) {
    void invalidateQueriesWithOptimisticOwnership(client, preparationKeys.all(event.tenantId));
  },
};
