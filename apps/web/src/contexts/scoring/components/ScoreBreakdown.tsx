import type { JSX } from "react";
import type {
  ScoreBreakdown as ScoreBreakdownValue,
  ScoreCorrection,
  ScoreTrace,
  ScoringCriteriaSnapshot,
} from "@jobhunter/contracts";

import { ScoreReasoning } from "./ScoreReasoning.js";
import { scoreTier } from "../lib/score-tier.js";

export interface ScoreBreakdownProps {
  fitScore: number | null;
  scoreBreakdown?: ScoreBreakdownValue | null;
  scoreKeywords?: readonly string[];
  scoreReasoning: string;
  scoreVersion?: number | null;
  scoredAt?: string | null;
  scoreCriteria?: ScoringCriteriaSnapshot | null;
  scoreTrace?: ScoreTrace | null;
  scoreCorrection?: ScoreCorrection | null;
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
  scoreCriteria = null,
  scoreTrace = null,
  scoreCorrection = null,
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
      <div className="score-dimensions" aria-label="Score assessment">
        <div className="score-dimension">
          <span>Fit band</span>
          <b>{scoreBreakdown.fitBand}</b>
        </div>
        <div className="score-dimension">
          <span>Confidence</span>
          <b>{scoreBreakdown.confidence}</b>
        </div>
        <div className="score-dimension">
          <span>Eligibility</span>
          <b>{scoreBreakdown.eligibility.status}</b>
        </div>
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
      <SignalList label="Matched signals" values={scoreBreakdown.matchedSignals} />
      <SignalList label="Missing signals" values={scoreBreakdown.missingSignals} />
      <SignalList label="Transferable signals" values={scoreBreakdown.transferableSignals} />
      <SignalList label="Hard blockers" tone="danger" values={scoreBreakdown.eligibility.hardBlockers} />
      <SignalList label="Warnings" values={scoreBreakdown.eligibility.warnings} />
      {scoreCriteria ? (
        <p className="muted">
          Criteria {scoreCriteria.criteriaVersion || "unversioned"} | minimum {scoreCriteria.minFitScore}/10
        </p>
      ) : null}
      {scoreTrace?.scoringPolicyVersion ? (
        <p className="muted">
          Policy v{scoreTrace.scoringPolicyVersion}
          {scoreTrace.rubricVersion ? ` | ${scoreTrace.rubricVersion}` : ""}
          {scoreTrace.policyAnchorCount ? ` | ${scoreTrace.policyAnchorCount} anchors` : ""}
          {scoreTrace.calibrationAdjustment
            ? ` | adjustment ${formatSigned(scoreTrace.calibrationAdjustment)}`
            : ""}
        </p>
      ) : null}
      {scoreTrace?.parserWarnings.length ? (
        <p className="muted">Parser warnings: {scoreTrace.parserWarnings.join(", ")}</p>
      ) : null}
      {scoreCorrection ? (
        <p className="muted">
          Corrected to {scoreCorrection.correctedScore}/10: {scoreCorrection.rationale}
        </p>
      ) : null}
    </div>
  );
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function SignalList({
  label,
  values,
  tone = "info",
}: {
  label: string;
  values?: readonly string[];
  tone?: "info" | "danger";
}) {
  if (!values?.length) return null;
  return (
    <div className="keyword-list" aria-label={label}>
      {values.map((value) => (
        <span className={`tag ${tone}`} key={value}>
          {value}
        </span>
      ))}
    </div>
  );
}
