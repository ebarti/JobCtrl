import type { JSX } from "react";
import type { ScoreBreakdown as ScoreBreakdownValue } from "@jobhunter/contracts";

import { ScoreReasoning } from "./ScoreReasoning.js";
import { scoreTier } from "../lib/score-tier.js";

export interface ScoreBreakdownProps {
  fitScore: number | null;
  scoreBreakdown?: ScoreBreakdownValue | null;
  scoreKeywords?: readonly string[];
  scoreReasoning: string;
  scoreVersion?: number | null;
  scoredAt?: string | null;
}

type ScoreDimensionKey = "technicalFit" | "experienceFit" | "roleFit";

const DIMENSIONS: ReadonlyArray<[ScoreDimensionKey, string]> = [
  ["technicalFit", "Technical fit"],
  ["experienceFit", "Experience fit"],
  ["roleFit", "Role fit"],
];

export function ScoreBreakdown({
  fitScore,
  scoreBreakdown,
  scoreKeywords = [],
  scoreReasoning,
  scoreVersion = null,
  scoredAt = null,
}: ScoreBreakdownProps): JSX.Element {
  if (!scoreBreakdown) {
    return <ScoreReasoning text={scoreReasoning} fitScore={fitScore} />;
  }

  const metadata = [scoreVersion ? `version ${scoreVersion}` : null, scoredAt]
    .filter(Boolean)
    .join(" | ");

  return (
    <div className="score-explainer">
      <div className="score-line">
        <span className={`fit ${scoreTier(fitScore)}`}>{fitScore ?? "-"}</span>
        <span>
          <b>{fitScore ?? "-"} / 10 fit score</b>
          {metadata ? <small>{metadata}</small> : null}
        </span>
      </div>
      {scoreBreakdown.reasoning ? (
        <p>{scoreBreakdown.reasoning}</p>
      ) : (
        <p className="muted">No score rationale was stored for this score.</p>
      )}
      <div className="score-dimensions" aria-label="Score dimensions">
        {DIMENSIONS.map(([key, label]) => (
          <div className="score-dimension" key={key}>
            <span>{label}</span>
            <b>{scoreBreakdown[key]} / 10</b>
          </div>
        ))}
      </div>
      {scoreKeywords.length ? (
        <div className="keyword-list" aria-label="Matched keywords">
          {scoreKeywords.map((keyword) => (
            <span className="tag info" key={keyword}>
              {keyword}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
