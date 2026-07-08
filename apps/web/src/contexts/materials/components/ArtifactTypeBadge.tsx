import type { JSX } from "react";

import { artifactKindLabel, artifactFormatLabel } from "../lib/artifact-type-format.js";

export interface ArtifactTypeBadgeProps {
  artifactType: string;
}

export function ArtifactTypeBadge({ artifactType }: ArtifactTypeBadgeProps): JSX.Element {
  return (
    <span className="artifact-type" data-artifact-type={artifactType}>
      <span className="tag muted">{artifactKindLabel(artifactType)}</span>
      <span>{artifactFormatLabel(artifactType)}</span>
    </span>
  );
}
