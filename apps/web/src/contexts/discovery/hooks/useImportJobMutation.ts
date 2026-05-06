import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { NotImplementedError } from "../../../shared/lib/errors.js";

export interface ImportJobVariables {
  readonly url: string;
}

export function useImportJobMutation(): UseMutationResult<never, Error, ImportJobVariables> {
  return useMutation({
    mutationFn: () => {
      throw new NotImplementedError("useImportJobMutation");
    },
  });
}
