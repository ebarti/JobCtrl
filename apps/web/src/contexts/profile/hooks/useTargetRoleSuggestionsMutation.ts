import {
  TargetRoleSuggestionResponseSchema,
  type TargetRoleSuggestionRequest,
  type TargetRoleSuggestionResponse,
} from "@jobctrl/contracts";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";

export function useTargetRoleSuggestionsMutation(): UseMutationResult<
  TargetRoleSuggestionResponse,
  Error,
  TargetRoleSuggestionRequest
> {
  const { http } = usePorts();
  const tenantId = useTenantId();
  return useMutation({
    mutationKey: ["tenant", tenantId, "profile", "target-role-suggestions"],
    mutationFn: async (body) => {
      const result = TargetRoleSuggestionResponseSchema.safeParse(await http.json<unknown>("POST", "/v1/profile/target-role-suggestions", { body }));
      if (!result.success) throw new Error("The target role response could not be verified. Saved Profile data is unchanged.");
      return result.data;
    },
  });
}
