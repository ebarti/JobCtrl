import type {
  RequiredBulletSuggestionRequest,
  RequiredBulletSuggestionResponse,
} from "../../operations/types.js";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";

export function useRequiredBulletSuggestionsMutation(): UseMutationResult<
  RequiredBulletSuggestionResponse,
  Error,
  RequiredBulletSuggestionRequest
> {
  const { api } = usePorts();
  return useMutation({
    mutationKey: ["profile", "required-bullet-suggestions"],
    mutationFn: (body) => api.requiredBulletSuggestions(body),
  });
}
