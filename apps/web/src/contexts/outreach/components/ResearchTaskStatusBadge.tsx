import type { ResearchTaskStatus } from "@jobctrl/contracts";
import type { JSX } from "react";

import { StatusBadge } from "../../../shared/ui/status-badge.js";
import type { StatusTagTone } from "../../../shared/ui/status-tokens.js";
import { researchTaskStatusLabel } from "../lib/research-copy.js";

const RESEARCH_TASK_STATUS_TONES: Record<ResearchTaskStatus, StatusTagTone> = {
  queued: "muted",
  running: "info",
  needs_review: "warn",
  completed: "ok",
  failed: "danger",
};

export function ResearchTaskStatusBadge({
  status,
}: {
  readonly status: ResearchTaskStatus;
}): JSX.Element {
  return (
    <StatusBadge tone={RESEARCH_TASK_STATUS_TONES[status]}>
      {researchTaskStatusLabel(status)}
    </StatusBadge>
  );
}
