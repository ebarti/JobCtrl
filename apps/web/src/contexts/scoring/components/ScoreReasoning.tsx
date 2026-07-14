import { ScoreBadge } from "./ScoreBadge.js";
import { parseScoreReasoning } from "../lib/parse-reasoning.js";

export interface ScoreReasoningProps {
  text: string;
  fitScore: number | null;
}

export function ScoreReasoning({ text, fitScore }: ScoreReasoningProps) {
  const parsed = parseScoreReasoning(text);
  const keywordOnlyReason =
    parsed.reason && parsed.keywords.length
      ? parsed.reason.toLowerCase().replace(/\s+/g, " ") ===
        parsed.keywords.join(", ").toLowerCase().replace(/\s+/g, " ")
      : false;
  return (
    <div className="score-explainer">
      <div className="score-line">
        <ScoreBadge score={fitScore ?? parsed.score} />
        <span>
          <b>{fitScore ?? parsed.score ?? "-"} / 10 fit score</b>
          <small>
            Current scoring output. Feedback-based personalization is tracked as backlog work.
          </small>
        </span>
      </div>
      {parsed.reason && !keywordOnlyReason ? (
        <p>{parsed.reason}</p>
      ) : (
        <p className="muted">
          This stored score only includes keyword evidence. It does not yet explain weighting,
          missing signals, or why this landed at this exact value.
        </p>
      )}
      {parsed.keywords.length ? (
        <ul className="audit-value-list keyword-list" aria-label="Tracked keywords">
          {parsed.keywords.map((keyword) => (
            <li className="audit-value audit-value--info" key={keyword}>
              {keyword}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
