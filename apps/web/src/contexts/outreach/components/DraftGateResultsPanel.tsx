import type { OutreachDraftGateResults } from "@jobctrl/contracts";
import type { JSX } from "react";

export interface DraftGateResultsPanelProps {
  gateResults: OutreachDraftGateResults;
}

function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(2) : "unknown";
}

// The truthfulness gate stack is the sole approval authority (INV-5). Every field
// is rendered and a failing field is NEVER hidden (CLAUDE.md auditability
// discipline). Blocks are labelled by what they prove: deterministic
// never-fabricate findings, validator errors/warnings, and the persona judge.
export function DraftGateResultsPanel({ gateResults }: DraftGateResultsPanelProps): JSX.Element {
  const { passed, computedAgainst, fabrications, validation, judge } = gateResults;
  return (
    <div className="draft-gate-results" role="group" aria-label="Truthfulness gate results">
      <p className={`tag ${passed ? "ok" : "danger"}`} role="status">
        {passed ? "Truthfulness gates passed" : "Truthfulness gates blocked this draft"}
      </p>
      <p className="draft-gate-computed-against">
        Computed against <span className="mono">{computedAgainst}</span>
      </p>

      <div className="draft-gate-block">
        <p className="draft-gate-block-title">Deterministic never-fabricate findings</p>
        {fabrications.length === 0 ? (
          <p className="muted">No fabricated claims detected in the generated text.</p>
        ) : (
          <ul className="draft-gate-fabrication-list">
            {fabrications.map((fabrication, index) => (
              <li
                key={`${fabrication.section}:${fabrication.token}:${index}`}
                className="draft-gate-fabrication"
              >
                <dl className="detail-list" aria-label={`Fabrication finding ${index + 1}`}>
                  <div>
                    <dt>Kind</dt>
                    <dd>{fabrication.kind}</dd>
                  </div>
                  <div>
                    <dt>Token</dt>
                    <dd className="mono">{fabrication.token}</dd>
                  </div>
                  <div>
                    <dt>Control</dt>
                    <dd>{fabrication.control}</dd>
                  </div>
                  <div>
                    <dt>Section</dt>
                    <dd>{fabrication.section}</dd>
                  </div>
                  <div>
                    <dt>Offending text</dt>
                    <dd className="mono">{fabrication.generatedText}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="draft-gate-block">
        <p className="draft-gate-block-title">Validation</p>
        <p>
          <span className={`tag ${validation.passed ? "ok" : "danger"}`}>
            {validation.passed ? "Passed" : "Failed"}
          </span>
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
        <p className="draft-gate-block-title">Persona judge</p>
        {judge ? (
          <>
            <dl className="detail-list" aria-label="Judge result">
              <div>
                <dt>Verdict</dt>
                <dd>
                  <span className={`tag ${judge.approved ? "ok" : "danger"}`}>
                    {judge.approved ? "Approved" : "Blocked"}
                  </span>
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
