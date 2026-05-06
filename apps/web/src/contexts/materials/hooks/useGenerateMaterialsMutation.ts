import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { NotImplementedError } from "../../../shared/lib/errors.js";
import type { JobId } from "../../operations/types.js";

export interface GenerateMaterialsVariables {
  readonly jobId: JobId;
}

export function useGenerateMaterialsMutation(): UseMutationResult<
  never,
  Error,
  GenerateMaterialsVariables
> {
  return useMutation({
    mutationFn: () => {
      throw new NotImplementedError("useGenerateMaterialsMutation");
    },
  });
}
