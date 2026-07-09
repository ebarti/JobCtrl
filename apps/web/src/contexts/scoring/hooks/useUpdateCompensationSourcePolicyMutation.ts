import type {
  CompensationSourcePolicyUpdateRequest,
  CompensationSourceRegistryResponse,
} from "@jobctrl/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { compensationKeys } from "../../operations/compensationKeys.js";

export function useUpdateCompensationSourcePolicyMutation(): UseMutationResult<
  CompensationSourceRegistryResponse,
  Error,
  CompensationSourcePolicyUpdateRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...compensationKeys.sources(tenantId), "update"],
    mutationFn: (body) => api.updateCompensationSourcePolicy(body),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: compensationKeys.sources(tenantId),
      }),
  });
}
