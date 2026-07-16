import { IconClock } from "@tabler/icons-react";
import type { JSX } from "react";

import { StatusBadge } from "../../../shared/ui/status-badge.js";
import { artifactStatusDescription } from "../lib/artifact-status-copy.js";
import { artifactStatusTone } from "../lib/artifact-status-tone.js";

export interface ArtifactStatusBadgeProps {
  status: string;
}

export function ArtifactStatusBadge({
  status,
}: ArtifactStatusBadgeProps): JSX.Element {
  const description = artifactStatusDescription(status);
  return (
    <StatusBadge
      aria-label={`${status}: ${description}`}
      icon={status === "pending" || status === "queued" ? IconClock : undefined}
      title={description}
      tone={artifactStatusTone(status)}
    >
      {status}
    </StatusBadge>
  );
}
