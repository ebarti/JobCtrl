import type { SampleDataMutationResponse } from "@jobhunter/contracts";
import type { TenantId } from "@jobhunter/domain-types";
import { useMutation, useQueryClient, type QueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { applyReviewKeys } from "../applyReviewKeys.js";
import { artifactsKeys } from "../artifactsKeys.js";
import { dashboardKeys } from "../dashboardKeys.js";
import { jobsKeys } from "../jobsKeys.js";
import { sampleDataKeys } from "../sampleDataKeys.js";

export function useLoadSampleDataMutation(): UseMutationResult<SampleDataMutationResponse, Error, void> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.loadSampleData(),
    onSettled: async () => {
      await invalidateSampleDataSurfaces(queryClient, tenantId);
    },
  });
}

export function useClearSampleDataMutation(): UseMutationResult<SampleDataMutationResponse, Error, void> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearSampleData(),
    onSettled: async () => {
      await invalidateSampleDataSurfaces(queryClient, tenantId);
    },
  });
}

async function invalidateSampleDataSurfaces(
  queryClient: QueryClient,
  tenantId: TenantId,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: sampleDataKeys.all(tenantId) }),
    queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
    queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
    queryClient.invalidateQueries({ queryKey: jobsKeys.details(tenantId) }),
    queryClient.invalidateQueries({ queryKey: applyReviewKeys.queue(tenantId) }),
    queryClient.invalidateQueries({ queryKey: artifactsKeys.lists(tenantId) }),
  ]);
}
