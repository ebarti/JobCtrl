import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { NotImplementedError } from "../../../shared/lib/errors.js";
import type { JobId } from "../../operations/types.js";

export interface EnrichmentRetryVariables {
  readonly jobId: JobId;
}

export function useEnrichmentRetryMutation(): UseMutationResult<
  never,
  Error,
  EnrichmentRetryVariables
> {
  return useMutation({
    mutationFn: () => {
      throw new NotImplementedError("useEnrichmentRetryMutation");
    },
  });
}
