import type { ActionRunResponse, GenerateMaterialsRequest, MaterialStage } from "@jobctrl/contracts";
import type { ApiClientPort } from "../../../shared/ports/ApiClientPort.js";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { materialsKeys } from "../queryKeys.js";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { artifactsKeys } from "../../operations/artifactsKeys.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";
import { patchStageRunning } from "../lib/materialsJobDetailPatches.js";

export interface GenerateMaterialsVariables {
  readonly jobId: JobId;
  readonly stages?: readonly MaterialStage[];
  readonly dryRun?: boolean;
}

const DEFAULT_MATERIAL_STAGES: readonly MaterialStage[] = ["tailor", "cover"];

function toRequest(variables: GenerateMaterialsVariables): Partial<GenerateMaterialsRequest> {
  return {
    stages: [...(variables.stages ?? DEFAULT_MATERIAL_STAGES)],
    dryRun: variables.dryRun ?? false,
    limit: 1,
  };
}

/**
 * INSPECT-01 — per-job material generation.
 *
 * Async (202) mutation: the worker runs the canonical analyze → tailor → voice
 * → audit flow off-process and the real result arrives via the SSE invalidation
 * router (`ResumeApproved` / `ResumeFailed` → `contexts/materials/handlers.ts`).
 * Per `docs/frontend-target.md` §7.4 we optimistically reflect the queued state
 * by patching the first requested material stage to `running` on the cached job
 * detail, then invalidate on settle so the server-confirmed state replaces the
 * optimistic patch. The optimistic patch is rolled back if the request itself
 * fails (e.g. the worker is offline → 503).
 */
export function useGenerateMaterialsMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  GenerateMaterialsVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ActionRunResponse, GenerateMaterialsVariables>(queryClient, {
      mutationFn: (variables) => api.generateMaterials(variables.jobId, toRequest(variables)),
      optimisticUpdates: (variables) => [
        {
          queryKey: jobsKeys.detail(tenantId, variables.jobId),
          patch: (current) =>
            patchStageRunning(current, (variables.stages ?? DEFAULT_MATERIAL_STAGES)[0] ?? "tailor"),
        },
      ],
      settle: (variables) => [
        jobsKeys.detail(tenantId, variables.jobId),
        jobsKeys.lists(tenantId),
        artifactsKeys.lists(tenantId),
        dashboardKeys.summary(tenantId),
      ],
    }),
  );
}

/** Locale mutations retain accepted revisions while a refresh/review is pending. */
export type LocaleHistory = Awaited<ReturnType<ApiClientPort["materialLocaleVariants"]>>;
export type LocaleRequest = Parameters<ApiClientPort["materialLocaleVariants"]>[1];
export type LocaleVariant = LocaleHistory["variants"][number];
export function useMaterialLocaleVariants(jobId: string) {
  const tenantId = useTenantId();
  const { api, openInOs, eventStream } = usePorts();
  const queryClient = useQueryClient();
  const key = [...materialsKeys.all(tenantId), "locales", jobId] as const;
  const history = useQuery({ queryKey: key, queryFn: () => api.materialLocaleVariants(jobId, { operation: "history" }), refetchInterval: 15_000 });
  useEffect(() => {
    const subscription = eventStream.subscribe({ tenantId });
    const unsubscribe = subscription.on(event => {
      if (!["ResumeApproved", "CoverLetterGenerated", "TailoredArtifactsSuppressed", "ResumeTemplateRefreshCompleted"].includes(event.eventType)) return;
      if (typeof event.payload === "object" && event.payload !== null && "jobId" in event.payload && event.payload.jobId === jobId) {
        void queryClient.invalidateQueries({ queryKey: [...materialsKeys.all(tenantId), "locales", jobId] });
      }
    });
    return () => { unsubscribe(); subscription.close(); };
  }, [eventStream, tenantId, jobId, queryClient]);
  const mutation = useMutation({
    mutationFn: (request: LocaleRequest) => api.materialLocaleVariants(jobId, request),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<LocaleHistory>(key);
      return { previous };
    },
    onError: (_error, _request, context) => { if (context?.previous) queryClient.setQueryData(key, context.previous); },
    onSuccess: (result) => queryClient.setQueryData(key, result),
    onSettled: async () => { await queryClient.invalidateQueries({ queryKey: key }); await queryClient.invalidateQueries({ queryKey: jobsKeys.detail(tenantId, jobId) }); },
  });
  const exportAndOpen = async (request: Extract<LocaleRequest, { operation: "export" }>) => {
    const result = await mutation.mutateAsync(request);
    const variant = result.variants.find(row => row.revisionId === request.revisionId);
    const artifact = variant?.exports.at(-1);
    if (artifact) await openInOs.open(artifact.artifactId);
  };
  const openRetainedExport = (artifactId: string) => openInOs.open(artifactId);
  return { history, mutation, exportAndOpen, openRetainedExport };
}
