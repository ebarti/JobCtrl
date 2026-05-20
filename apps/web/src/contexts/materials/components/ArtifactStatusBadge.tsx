import type { JSX } from "react";

import { artifactStatusDescription } from "../lib/artifact-status-copy.js";
import { artifactStatusTone } from "../lib/artifact-status-tone.js";

export interface ArtifactStatusBadgeProps {
  status: string;
}

export function ArtifactStatusBadge({ status }: ArtifactStatusBadgeProps): JSX.Element {
  const description = artifactStatusDescription(status);
  return (
    <span
      aria-label={`${status}: ${description}`}
      className={`tag ${artifactStatusTone(status)}`}
      title={description}
    >
      {status}
    </span>
  );
}
