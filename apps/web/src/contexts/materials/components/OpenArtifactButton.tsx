import type { JSX } from "react";

import { useOpenArtifactMutation } from "../hooks/useOpenArtifactMutation.js";

export interface OpenArtifactButtonProps {
  artifactId: string;
  disabled?: boolean;
  label?: string;
  className?: string;
}

export function OpenArtifactButton({
  artifactId,
  disabled,
  label = "open",
  className = "tab on",
}: OpenArtifactButtonProps): JSX.Element {
  const openArtifact = useOpenArtifactMutation();
  const isPending = openArtifact.isPending;
  return (
    <button
      type="button"
      className={className}
      disabled={Boolean(disabled) || isPending}
      onClick={(event) => {
        event.stopPropagation();
        openArtifact.mutate({ artifactId });
      }}
    >
      {isPending ? "opening" : label}
    </button>
  );
}
