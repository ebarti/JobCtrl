import type { ActionRunResponse, GenerateMaterialsRequest, MaterialStage } from "@jobctrl/contracts";
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
