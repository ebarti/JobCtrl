import type {
  TailoringPolicyRollbackRequest,
  TailoringPolicyRollbackResponse,
} from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { learningKeys } from "../../operations/learningKeys.js";

export function useRollbackTailoringPolicyMutation(): UseMutationResult<
  TailoringPolicyRollbackResponse,
  Error,
  TailoringPolicyRollbackRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (command) => api.rollbackTailoringPolicy(command),
    // The server may replay an old receipt while a newer policy is current.
    // Refetch committed history instead of predicting or patching a head.
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: learningKeys.policyRevisions(tenantId) });
    },
  });
}
