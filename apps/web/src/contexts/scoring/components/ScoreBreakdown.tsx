import type { JSX } from "react";

import { ScoreReasoning } from "./ScoreReasoning.js";

export interface ScoreBreakdownProps {
  scoreReasoning: string;
  fitScore: number | null;
}

export function ScoreBreakdown({ scoreReasoning, fitScore }: ScoreBreakdownProps): JSX.Element {
  return <ScoreReasoning text={scoreReasoning} fitScore={fitScore} />;
}
