import {
  RequiredBulletSuggestionResponseSchema,
  type RequiredBulletSuggestionRequest,
  type RequiredBulletSuggestionResponse,
} from "@jobctrl/contracts";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";

export function useRequiredBulletSuggestionsMutation(): UseMutationResult<
  RequiredBulletSuggestionResponse,
  Error,
  RequiredBulletSuggestionRequest
> {
  const { http } = usePorts();
  const tenantId = useTenantId();
  return useMutation({
    mutationKey: ["tenant", tenantId, "profile", "required-bullet-suggestions"],
    // The card owns a persistent, actionable error beside the retained review.
    // Duplicate global toasts can cover its retry controls after repeated errors.
    meta: { suppressGlobalErrorToast: true },
    mutationFn: async (body) => {
      const result = RequiredBulletSuggestionResponseSchema.safeParse(await http.json<unknown>("POST", "/v1/profile/required-bullet-suggestions", { body }));
      if (!result.success) throw new Error("The coaching response could not be verified. Saved Profile data is unchanged.");
      return result.data;
    },
  });
}
