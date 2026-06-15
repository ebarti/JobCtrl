import type {
  EmployerAnalysis,
  EmployerAnalysisFailure,
  EmployerAnalysisKeyword,
  EmployerAnalysisRequirement,
  EmployerAnalysisSubAnalysis,
} from "@jobhunter/contracts";
import type { JSX } from "react";

import { formatToken, scorePercent, weightPercent } from "../lib/audit-format.js";

export interface EmployerRequirementScoreEvidence {
  readonly matchedSignals?: readonly string[];
  readonly missingSignals?: readonly string[];
  readonly transferableSignals?: readonly string[];
}

export interface EmployerAnalysisPanelProps {
  /** The canonical employer analysis, or null when none has been produced yet. */
  readonly analysis: EmployerAnalysis | null;
  /** Fit-score evidence used to explain whether extracted requirements were matched. */
  readonly scoreEvidence?: EmployerRequirementScoreEvidence | null;
  readonly className?: string;
}

interface RequirementAssessment {
  readonly label: string;
  readonly tone: "ok" | "warn" | "info" | "muted";
  readonly title: string;
  readonly sourceLabel: string;
  readonly signals: readonly string[];
  readonly explanation: string;
}

const STOPWORDS = new Set([
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "no",
  "of",
  "on",
  "or",
  "our",
  "so",
  "the",
  "that",
  "this",
  "to",
  "we",
  "with",
  "your",
]);

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function signalTokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function signalMatchesRequirement(signal: string, requirement: EmployerAnalysisRequirement): boolean {
  const normalizedSignal = normalizeText(signal);
  if (!normalizedSignal) return false;

  const haystack = normalizeText(`${requirement.text} ${requirement.evidence_span}`);
  if (haystack.includes(normalizedSignal)) return true;

  const tokens = signalTokens(normalizedSignal);
  if (!tokens.length) return false;
  const haystackTokens = new Set(signalTokens(haystack));
  const overlap = tokens.filter((token) => haystackTokens.has(token)).length;
  if (tokens.length <= 2) {
    return overlap === tokens.length;
  }
  return overlap >= 3 || (overlap >= 2 && overlap / tokens.length >= 0.35);
}

function matchingSignals(
  requirement: EmployerAnalysisRequirement,
  signals: readonly string[] | undefined,
): readonly string[] {
  return (signals ?? []).filter((signal) => signalMatchesRequirement(signal, requirement));
}

function isFlaggedByAgreement(
  requirement: EmployerAnalysisRequirement,
  flaggedRequirements: readonly string[],
): boolean {
  const requirementId = normalizeText(requirement.id);
  const requirementText = normalizeText(requirement.text);
  return flaggedRequirements.some((flag) => {
    const normalized = normalizeText(flag);
    return (
      normalized === requirementId ||
      normalized === requirementText ||
      (normalized.length >= 12 && requirementText.includes(normalized))
    );
  });
}

function requirementAssessment(
  requirement: EmployerAnalysisRequirement,
  scoreEvidence: EmployerRequirementScoreEvidence | null | undefined,
): RequirementAssessment {
  if (!scoreEvidence) {
    return {
      label: "score evidence not recorded",
      tone: "muted",
      title: "No fit-score signal evidence was recorded for this job.",
      sourceLabel: "Fit-score evidence",
      signals: [],
      explanation: "No matched, missing, or transferable score signals were recorded for this job.",
    };
  }

  const missing = matchingSignals(requirement, scoreEvidence.missingSignals);
  if (missing.length) {
    return {
      label: "not matched",
      tone: "warn",
      title: "The scoring evidence names this requirement as a missing signal.",
      sourceLabel: "Missing score signal",
      signals: missing,
      explanation: "The fit-score assessment explicitly recorded this requirement as missing.",
    };
  }

  const matched = matchingSignals(requirement, scoreEvidence.matchedSignals);
  if (matched.length) {
    return {
      label: "matched",
      tone: "ok",
      title: "The scoring evidence names this requirement as a matched signal.",
      sourceLabel: "Matched score signal",
      signals: matched,
      explanation: "The fit-score assessment explicitly recorded matching profile evidence.",
    };
  }

  const transferable = matchingSignals(requirement, scoreEvidence.transferableSignals);
  if (transferable.length) {
    return {
      label: "transferable",
      tone: "info",
      title: "The scoring evidence names this requirement as a transferable signal.",
      sourceLabel: "Transferable score signal",
      signals: transferable,
      explanation: "The fit-score assessment recorded related experience rather than a direct match.",
    };
  }

  return {
    label: "no explicit match",
    tone: "muted",
    title: "The score evidence did not name this requirement as matched, missing, or transferable.",
    sourceLabel: "Fit-score evidence",
    signals: [],
    explanation: "No matched, missing, or transferable score signal was linked to this requirement.",
  };
}

function RequirementItem({
  requirement,
  scoreEvidence,
  flaggedRequirements,
}: {
  readonly requirement: EmployerAnalysisRequirement;
  readonly scoreEvidence?: EmployerRequirementScoreEvidence | null;
  readonly flaggedRequirements: readonly string[];
}): JSX.Element {
  const tier = requirement.tier === "must_have" ? "warn" : "muted";
  const assessment = requirementAssessment(requirement, scoreEvidence);
  const flagged = isFlaggedByAgreement(requirement, flaggedRequirements);
  return (
    <article className="employer-analysis-requirement" aria-label={`Requirement: ${requirement.text}`}>
      <div className="employer-analysis-requirement-side">
        <header>
          <span className={`tag ${tier}`}>{formatToken(requirement.tier)}</span>
          <span
            className="tag muted"
            title="Relative priority from job-post analysis, not a match score"
          >
            importance {weightPercent(requirement.weight)}
          </span>
          {flagged ? (
            <span
              className="tag warn"
              title="The ensemble agreement marked this requirement as non-unanimous across model legs."
            >
              ensemble divergence
            </span>
          ) : null}
        </header>
        <p className="employer-analysis-requirement-text">{requirement.text}</p>
        {requirement.evidence_span ? (
          <blockquote className="employer-analysis-evidence">{requirement.evidence_span}</blockquote>
        ) : (
          <p className="muted">No job-description evidence span recorded.</p>
        )}
      </div>
      <div className="employer-analysis-match-side">
        <header>
          <span>Fit-score match</span>
          <span className={`tag ${assessment.tone}`} title={assessment.title}>
            {assessment.label}
          </span>
        </header>
        <p className="employer-analysis-rationale">{assessment.explanation}</p>
        {assessment.signals.length ? (
          <div className="employer-analysis-signal-row">
            <span>{assessment.sourceLabel}</span>
            <span>
              {assessment.signals.map((signal) => (
                <span className={`tag ${assessment.tone}`} key={signal}>
                  {signal}
                </span>
              ))}
            </span>
          </div>
        ) : null}
      </div>
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
  scoreEvidence = null,
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
                <RequirementItem
                  key={requirement.id}
                  requirement={requirement}
                  scoreEvidence={scoreEvidence}
                  flaggedRequirements={analysis.agreement.flagged_requirements}
                />
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
