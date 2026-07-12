import type { ArtifactOpenResponse } from "@jobctrl/contracts";
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
  const { openInOs } = usePorts();
  return useMutation({
    mutationFn: ({ artifactId }) => openInOs.open(artifactId),
  });
}
