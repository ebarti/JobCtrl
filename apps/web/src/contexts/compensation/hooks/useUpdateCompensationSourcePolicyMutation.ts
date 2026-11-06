import type { CompensationPolicyRegistry, CompensationPolicyUpdate } from "../contracts.js";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { invalidateQueriesWithOptimisticOwnership } from "../../../shared/lib/createOptimisticMutation.js";
import { compensationKeys } from "../queryKeys.js";
import { compensationPolicyEnvelope } from "../responseSchemas.js";

export function useUpdateCompensationSourcePolicyMutation(): UseMutationResult<
  CompensationPolicyRegistry,
  Error,
  CompensationPolicyUpdate
> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...compensationKeys.sources(tenantId), "update"],
    mutationFn: async (body) => {
      const value = await http.json<unknown>("PATCH", "/v1/compensation/sources", { body });
      if (!compensationPolicyEnvelope.safeParse(value).success) {
        throw new Error("The policy update was submitted but its response could not be confirmed. Reload the saved policy before retrying.");
      }
      return value as CompensationPolicyRegistry;
    },
    onSettled: () =>
      invalidateQueriesWithOptimisticOwnership(queryClient, compensationKeys.sources(tenantId)),
  });
}
