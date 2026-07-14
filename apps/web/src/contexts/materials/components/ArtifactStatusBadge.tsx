import type { JSX } from "react";

import { StatusLabel } from "../../../shared/ui/status-label.js";
import { artifactStatusDescription } from "../lib/artifact-status-copy.js";
import { artifactStatusTone } from "../lib/artifact-status-tone.js";

export interface ArtifactStatusBadgeProps {
  status: string;
}

export function ArtifactStatusBadge({ status }: ArtifactStatusBadgeProps): JSX.Element {
  const description = artifactStatusDescription(status);
  return (
    <StatusLabel ariaLabel={`${status}: ${description}`} title={description} tone={artifactStatusTone(status)}>
      {status}
    </StatusLabel>
  );
}
