import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { NotImplementedError } from "../../../shared/lib/errors.js";
import type { JobId } from "../../operations/types.js";

export interface CorrectScoreVariables {
  readonly jobId: JobId;
  readonly correctedScore: number;
  readonly reason: string;
}

export function useCorrectScoreMutation(): UseMutationResult<
  never,
  Error,
  CorrectScoreVariables
> {
  return useMutation({
    mutationFn: () => {
      throw new NotImplementedError("useCorrectScoreMutation");
    },
  });
}
