import type {
  TargetRoleSuggestionRequest,
  TargetRoleSuggestionResponse,
} from "@jobctrl/contracts";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";

export function useTargetRoleSuggestionsMutation(): UseMutationResult<
  TargetRoleSuggestionResponse,
  Error,
  TargetRoleSuggestionRequest
> {
  const { api } = usePorts();
  return useMutation({
    mutationKey: ["profile", "target-role-suggestions"],
    mutationFn: (body) => api.targetRoleSuggestions(body),
  });
}
