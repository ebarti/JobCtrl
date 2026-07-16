import { IconClock } from "@tabler/icons-react";
import type { JSX } from "react";

import { StatusBadge } from "../../../shared/ui/status-badge.js";
import {
  applyRunResultTone,
  type ApplyRunResult,
  type ApplyRunTone,
} from "../lib/apply-run-tone.js";

export interface ApplyRunBadgeProps {
  result: ApplyRunResult;
}

export function ApplyRunBadge({ result }: ApplyRunBadgeProps): JSX.Element {
  const tone: ApplyRunTone = applyRunResultTone(result);
  const icon =
    result === "starting" || result === "in_progress" ? IconClock : undefined;
  return (
    <StatusBadge icon={icon} tone={tone}>
      {result}
    </StatusBadge>
  );
}
