import type { JSX } from "react";

import { artifactStatusTone } from "../lib/artifact-status-tone.js";

export interface ArtifactStatusBadgeProps {
  status: string;
}

export function ArtifactStatusBadge({ status }: ArtifactStatusBadgeProps): JSX.Element {
  return <span className={`tag ${artifactStatusTone(status)}`}>{status}</span>;
}
