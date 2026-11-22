import type { OutreachDraftGateResults } from "@jobctrl/contracts";
import type { JSX } from "react";

import { StatusBadge } from "../../../shared/ui/status-badge.js";

export interface DraftGateResultsPanelProps {
  gateResults: OutreachDraftGateResults;
}

function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(2) : "unknown";
}

// The persisted claim and quality reviews gate approval. Show the recorded
// model findings and IDs without presenting them as deterministic conclusions.
export function DraftGateResultsPanel({ gateResults }: DraftGateResultsPanelProps): JSX.Element {
  const { passed, computedAgainst, fabrications, validation, judge } = gateResults;
  const recorded = gateResults;
  return (
    <div className="draft-gate-results" role="group" aria-label="Claim and quality review results">
      <StatusBadge role="status" tone={passed ? "ok" : "danger"}>
        {passed ? "Claim and quality reviews passed" : "Claim or quality review blocked this draft"}
      </StatusBadge>
      <p className="draft-gate-computed-against">
        Computed against <span className="mono">{computedAgainst}</span>
      </p>

      {gateResults.sourceContext ? <details>
        <summary>Recorded offer and compensation sources</summary>
        <p>Terms revision: {gateResults.sourceContext.binding.termsRevisionId}</p>
        <p>Decision: {gateResults.sourceContext.binding.decisionId ?? "Not recorded"}</p>
        <ul>{gateResults.sourceContext.sources.map((source) => <li key={source.source_id}>
          <p className="mono">{source.source_id}</p><pre className="whitespace-pre-wrap break-words">{source.text}</pre>
        </li>)}</ul>
      </details> : null}
      {recorded.determinationIds?.length ? <details>
        <summary>Recorded review identities and exact draft lines</summary>
        <ul>{recorded.determinationIds.map((id) => <li className="mono" key={id}>{id}</li>)}</ul>
        <pre className="whitespace-pre-wrap break-words">{JSON.stringify(recorded.lineAnchors ?? [], null, 2)}</pre>
      </details> : null}
      <div className="draft-gate-block">
        <p className="draft-gate-block-title">Claim verification findings</p>
        {fabrications.length === 0 ? (
          <p className="muted">No individual unsupported claim findings were recorded.</p>
        ) : (
          <ul className="draft-gate-fabrication-list">
            {fabrications.map((finding, index) => {
              return (
              <li
                key={`${finding.lineId ?? "claim"}:${index}`}
                className="draft-gate-fabrication"
              >
                <dl className="detail-list" aria-label={`Claim finding ${index + 1}`}>
                  <div>
                    <dt>Kind</dt>
                    <dd>{finding.kind}</dd>
                  </div>
                  <div>
                    <dt>Draft line</dt>
                    <dd className="mono">{finding.lineId}</dd>
                  </div>
                  <div>
                    <dt>Reason</dt>
                    <dd>{finding.rationale}</dd>
                  </div>
                  <div>
                    <dt>Reviewed text</dt>
                    <dd className="mono">{finding.generatedText}</dd>
                  </div>
                </dl>
              </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="draft-gate-block">
        <p className="draft-gate-block-title">Validation</p>
        <p>
          <StatusBadge tone={validation.passed ? "ok" : "danger"}>
            {validation.passed ? "Passed" : "Failed"}
          </StatusBadge>
        </p>
        {validation.errors.length > 0 ? (
          <>
            <p className="draft-gate-list-label">Errors</p>
            <ul className="draft-gate-message-list">
              {validation.errors.map((error, index) => (
                <li key={`error-${index}`}>{error}</li>
              ))}
            </ul>
          </>
        ) : null}
        {validation.warnings.length > 0 ? (
          <>
            <p className="draft-gate-list-label">Warnings</p>
            <ul className="draft-gate-message-list">
              {validation.warnings.map((warning, index) => (
                <li key={`warning-${index}`}>{warning}</li>
              ))}
            </ul>
          </>
        ) : null}
        {validation.errors.length === 0 && validation.warnings.length === 0 ? (
          <p className="muted">No validator errors or warnings.</p>
        ) : null}
      </div>

      <div className="draft-gate-block">
        <p className="draft-gate-block-title">Model quality review</p>
        {judge ? (
          <>
            <dl className="detail-list" aria-label="Judge result">
              <div>
                <dt>Verdict</dt>
                <dd>
                  <StatusBadge tone={judge.approved ? "ok" : "danger"}>
                    {judge.approved ? "Approved" : "Blocked"}
                  </StatusBadge>
                </dd>
              </div>
              <div>
                <dt>Score</dt>
                <dd>{formatScore(judge.score)}</dd>
              </div>
            </dl>
            {Object.keys(judge.criterionScores).length > 0 ? (
              <>
                <p className="draft-gate-list-label">Criterion scores</p>
                <dl className="detail-list" aria-label="Judge criterion scores">
                  {Object.entries(judge.criterionScores).map(([criterion, score]) => (
                    <div key={criterion}>
                      <dt>{criterion}</dt>
                      <dd>{formatScore(score)}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : null}
            {judge.issues.length > 0 ? (
              <>
                <p className="draft-gate-list-label">Blockers and issues</p>
                <ul className="draft-gate-message-list">
                  {judge.issues.map((issue, index) => (
                    <li key={`issue-${index}`}>{issue}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {judge.notes ? <p className="draft-gate-judge-notes">{judge.notes}</p> : null}
          </>
        ) : (
          <p className="muted">No judge review was recorded for this draft.</p>
        )}
      </div>
    </div>
  );
}
