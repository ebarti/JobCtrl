import type { JSX } from "react";

import { applyRunResultTone, type ApplyRunResult, type ApplyRunTone } from "../lib/apply-run-tone.js";

export interface ApplyRunBadgeProps {
  result: ApplyRunResult;
}

export function ApplyRunBadge({ result }: ApplyRunBadgeProps): JSX.Element {
  const tone: ApplyRunTone = applyRunResultTone(result);
  return <span className={`tag ${tone}`}>{result}</span>;
}
