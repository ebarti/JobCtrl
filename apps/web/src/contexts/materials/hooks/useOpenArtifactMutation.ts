import type { ArtifactOpenResponse } from "@jobctl/contracts";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";

export interface OpenArtifactVariables {
  readonly artifactId: string;
}

export function useOpenArtifactMutation(): UseMutationResult<
  ArtifactOpenResponse,
  Error,
  OpenArtifactVariables
> {
  const { api } = usePorts();
  return useMutation({
    mutationFn: ({ artifactId }) => api.openArtifact(artifactId),
  });
}
