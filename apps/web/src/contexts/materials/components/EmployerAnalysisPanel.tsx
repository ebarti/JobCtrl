import type {
  EmployerAnalysis,
  EmployerAnalysisFailure,
  EmployerAnalysisKeyword,
  EmployerAnalysisRequirement,
  EmployerAnalysisSubAnalysis,
} from "@jobhunter/contracts";
import type { JSX } from "react";

import { formatToken, scorePercent, weightPercent } from "../lib/audit-format.js";

export interface EmployerAnalysisPanelProps {
  /** The canonical employer analysis, or null when none has been produced yet. */
  readonly analysis: EmployerAnalysis | null;
  readonly className?: string;
}

function RequirementItem({
  requirement,
}: {
  readonly requirement: EmployerAnalysisRequirement;
}): JSX.Element {
  const tier = requirement.tier === "must_have" ? "warn" : "muted";
  return (
    <article className="employer-analysis-requirement">
      <header>
        <span className={`tag ${tier}`}>{formatToken(requirement.tier)}</span>
        <span
          className="tag muted"
          title="Relative priority from job-post analysis, not a match score"
        >
          importance {weightPercent(requirement.weight)}
        </span>
      </header>
      <p className="employer-analysis-requirement-text">{requirement.text}</p>
      {requirement.evidence_span ? (
        <blockquote className="employer-analysis-evidence">{requirement.evidence_span}</blockquote>
      ) : (
        <p className="muted">No job-description evidence span recorded.</p>
      )}
    </article>
  );
}

function KeywordItem({ keyword }: { readonly keyword: EmployerAnalysisKeyword }): JSX.Element {
  return (
    <article className="employer-analysis-keyword">
      <header>
        <b>{keyword.keyword}</b>
        {keyword.requirement_ref ? (
          <span className="tag muted" title="Serves requirement">
            {keyword.requirement_ref}
          </span>
        ) : null}
        {keyword.is_orphan ? (
          <span className="tag warn" title="Not tied to a specific requirement">
            orphan
          </span>
        ) : null}
      </header>
      {keyword.evidence_span ? (
        <blockquote className="employer-analysis-evidence">{keyword.evidence_span}</blockquote>
      ) : (
        <p className="muted">No job-description evidence span recorded.</p>
      )}
      {keyword.rationale ? <p className="employer-analysis-rationale">{keyword.rationale}</p> : null}
    </article>
  );
}

function SubAnalysisDetails({
  subAnalyses,
  failures,
}: {
  readonly subAnalyses: readonly EmployerAnalysisSubAnalysis[];
  readonly failures: readonly EmployerAnalysisFailure[];
}): JSX.Element | null {
  if (!subAnalyses.length && !failures.length) {
    return null;
  }
  return (
    <details className="employer-analysis-ensemble">
      <summary>Ensemble audit trail ({subAnalyses.length} model{subAnalyses.length === 1 ? "" : "s"})</summary>
      <div className="employer-analysis-ensemble-body">
        {subAnalyses.map((sub) => (
          <article className="employer-analysis-sub" key={sub.model_id}>
            <header>
              <b>{sub.model_id}</b>
              <span className="tag muted">{formatToken(sub.inferred_seniority)}</span>
            </header>
            {sub.role_framing ? <p>{sub.role_framing}</p> : null}
            <span className="muted">
              {sub.requirements.length} requirement{sub.requirements.length === 1 ? "" : "s"} ·{" "}
              {sub.keywords.length} keyword{sub.keywords.length === 1 ? "" : "s"}
            </span>
          </article>
        ))}
        {failures.length ? (
          <div className="finding-list warning">
            <b>Degraded legs</b>
            <ul className="compact-list">
              {failures.map((failure) => (
                <li key={failure.model_id}>
                  {failure.model_id}: {failure.error}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/**
 * INSPECT-02 / INSPECT-05 — the employer "ideal candidate" analysis.
 *
 * Renders the canonical analysis (requirements with must/nice tier + priority
 * weight, reasoned keywords each with its quoted job-description evidence span,
 * and the ensemble audit trail). When `analysis` is null — no analysis has been
 * produced for this job yet — it renders an explicit "not recorded" state rather
 * than a blank, and empty requirement/keyword sets render an explicit "none
 * recorded" line (never a fabricated value).
 */
export function EmployerAnalysisPanel({
  analysis,
  className = "section",
}: EmployerAnalysisPanelProps): JSX.Element {
  if (!analysis) {
    return (
      <section className={className} aria-label="Employer analysis">
        <h3>Employer analysis</h3>
        <p className="muted">
          No employer analysis has been recorded for this job yet. It is produced when materials are
          generated.
        </p>
      </section>
    );
  }

  return (
    <section className={className} aria-label="Employer analysis">
      <h3>Employer analysis</h3>
      <div className="employer-analysis">
        <dl className="evidence-summary-grid">
          <div>
            <dt>Inferred seniority</dt>
            <dd>{formatToken(analysis.inferred_seniority) || "-"}</dd>
          </div>
          <div>
            <dt>Model agreement</dt>
            <dd>{scorePercent(analysis.agreement.score)}</dd>
          </div>
          <div>
            <dt>Ensemble</dt>
            <dd>
              {analysis.is_degraded ? (
                <span className="tag warn" title={`${analysis.legs_succeeded}/${analysis.legs_attempted} models succeeded`}>
                  degraded ({analysis.legs_succeeded}/{analysis.legs_attempted})
                </span>
              ) : (
                <span className="tag ok">{formatToken(analysis.ensemble_completeness) || "complete"}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Generation</dt>
            <dd>{analysis.generation}</dd>
          </div>
        </dl>

        {analysis.role_framing ? (
          <div className="evidence-block">
            <h4>Role framing</h4>
            <p>{analysis.role_framing}</p>
          </div>
        ) : null}
        {analysis.ideal_candidate_narrative ? (
          <div className="evidence-block">
            <h4>Ideal candidate</h4>
            <p>{analysis.ideal_candidate_narrative}</p>
          </div>
        ) : null}

        <div className="evidence-block">
          <h4>Requirements ({analysis.requirements.length})</h4>
          {analysis.requirements.length ? (
            <div className="employer-analysis-requirement-list">
              {analysis.requirements.map((requirement) => (
                <RequirementItem key={requirement.id} requirement={requirement} />
              ))}
            </div>
          ) : (
            <p className="muted">No requirements were recorded for this analysis.</p>
          )}
        </div>

        <div className="evidence-block">
          <h4>Reasoned keywords ({analysis.keywords.length})</h4>
          {analysis.keywords.length ? (
            <div className="employer-analysis-keyword-list">
              {analysis.keywords.map((keyword) => (
                <KeywordItem key={keyword.keyword} keyword={keyword} />
              ))}
            </div>
          ) : (
            <p className="muted">No reasoned keywords were recorded for this analysis.</p>
          )}
        </div>

        <SubAnalysisDetails subAnalyses={analysis.sub_analyses} failures={analysis.failures} />
      </div>
    </section>
  );
}
