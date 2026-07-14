import type { JSX } from "react";

import { StatusLabel } from "../../../shared/ui/status-label.js";
import { applyRunResultTone, type ApplyRunResult, type ApplyRunTone } from "../lib/apply-run-tone.js";

export interface ApplyRunBadgeProps {
  result: ApplyRunResult;
}

export function ApplyRunBadge({ result }: ApplyRunBadgeProps): JSX.Element {
  const tone: ApplyRunTone = applyRunResultTone(result);
  return <StatusLabel tone={tone}>{result}</StatusLabel>;
}
