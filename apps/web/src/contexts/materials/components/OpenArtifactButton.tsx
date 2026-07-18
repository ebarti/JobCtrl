import type { JSX } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
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
  label,
  className = "tab on",
}: OpenArtifactButtonProps): JSX.Element {
  const { featureFlags } = usePorts();
  const isDemo = featureFlags.get("demoMode", false);
  const openArtifact = useOpenArtifactMutation();
  const isPending = openArtifact.isPending;
  const actionLabel = label ?? (isDemo ? "Preview in browser" : "Open");
  return (
    <Button
      type="button"
      className={className}
      disabled={Boolean(disabled) || isPending}
      onClick={(event) => {
        event.stopPropagation();
        openArtifact.mutate({ artifactId });
      }}
    >
      {isPending ? "Opening" : actionLabel}
    </Button>
  );
}
