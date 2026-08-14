import type { SettingsResponse, SettingsUpdateRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { patchSettingsResponse } from "../../../shared/lib/settings-patches.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { settingsKeys } from "../../operations/settingsKeys.js";

export function useUpdatePipelineInternalConcurrencyMutation(): UseMutationResult<
  SettingsResponse,
  Error,
  number
> {
  const { api } = usePorts();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const queryKey = settingsKeys.settings(tenantId);

  return useMutation(
    createOptimisticMutation<SettingsResponse, number>(queryClient, {
      mutationKey: [...queryKey, "pipeline-internal-concurrency"],
      mutationFn: (pipelineInternalConcurrency) =>
        api.updateSettings({ pipelineInternalConcurrency }),
      optimisticUpdates: (pipelineInternalConcurrency) => [
        {
          queryKey,
          patch: (current) =>
            patchSettingsResponse(current, {
              pipelineInternalConcurrency,
            } satisfies SettingsUpdateRequest),
        },
      ],
      settle: () => [queryKey],
    }),
  );
}
