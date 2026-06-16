import type {
  EmployerAnalysis,
  EmployerAnalysisFailure,
  EmployerAnalysisKeyword,
  EmployerAnalysisRequirement,
  EmployerAnalysisSubAnalysis,
  RequirementFitAssessment,
  RequirementFitReport,
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
  /** Canonical requirement-led score report for the same job, or null for legacy scores. */
  readonly requirementFitReport?: RequirementFitReport | null;
  /** Fit-score evidence used to explain whether extracted requirements were matched. */
  readonly scoreEvidence?: EmployerRequirementScoreEvidence | null;
  readonly className?: string;
}

interface RequirementAssessment {
  readonly label: string;
  readonly tone: "ok" | "warn" | "info" | "muted";
  readonly title: string;
  readonly source: "requirement_fit" | "legacy_signals";
  readonly explanation: string;
  readonly rows: readonly RequirementAssessmentRow[];
}

interface RequirementAssessmentRow {
  readonly label: string;
  readonly values: readonly string[];
  readonly tone?: "ok" | "warn" | "info" | "muted";
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
  requirementFitReport: RequirementFitReport | null | undefined,
  scoreEvidence: EmployerRequirementScoreEvidence | null | undefined,
): RequirementAssessment {
  const fitAssessment = matchingRequirementFit(requirement, requirementFitReport);
  if (fitAssessment) {
    return requirementFitAssessment(fitAssessment);
  }

  if (!scoreEvidence) {
    return {
      label: "score evidence not recorded",
      tone: "muted",
      title: "No fit-score signal evidence was recorded for this job.",
      source: "legacy_signals",
      explanation: "No matched, missing, or transferable score signals were recorded for this job.",
      rows: [],
    };
  }

  const missing = matchingSignals(requirement, scoreEvidence.missingSignals);
  if (missing.length) {
    return {
      label: "not matched",
      tone: "warn",
      title: "The scoring evidence names this requirement as a missing signal.",
      source: "legacy_signals",
      explanation: "The fit-score assessment explicitly recorded this requirement as missing.",
      rows: [{ label: "Missing score signal", values: missing, tone: "warn" }],
    };
  }

  const matched = matchingSignals(requirement, scoreEvidence.matchedSignals);
  if (matched.length) {
    return {
      label: "matched",
      tone: "ok",
      title: "The scoring evidence names this requirement as a matched signal.",
      source: "legacy_signals",
      explanation: "The fit-score assessment explicitly recorded matching profile evidence.",
      rows: [{ label: "Matched score signal", values: matched, tone: "ok" }],
    };
  }

  const transferable = matchingSignals(requirement, scoreEvidence.transferableSignals);
  if (transferable.length) {
    return {
      label: "transferable",
      tone: "info",
      title: "The scoring evidence names this requirement as a transferable signal.",
      source: "legacy_signals",
      explanation: "The fit-score assessment recorded related experience rather than a direct match.",
      rows: [{ label: "Transferable score signal", values: transferable, tone: "info" }],
    };
  }

  return {
    label: "no explicit match",
    tone: "muted",
    title: "The score evidence did not name this requirement as matched, missing, or transferable.",
    source: "legacy_signals",
    explanation: "No matched, missing, or transferable score signal was linked to this requirement.",
    rows: [],
  };
}

function matchingRequirementFit(
  requirement: EmployerAnalysisRequirement,
  report: RequirementFitReport | null | undefined,
): RequirementFitAssessment | null {
  if (!report?.assessments.length) return null;
  const byId = report.assessments.find((assessment) => assessment.requirementId === requirement.id);
  if (byId) return byId;

  const requirementText = normalizeText(requirement.text);
  return (
    report.assessments.find((assessment) => normalizeText(assessment.requirementText) === requirementText) ?? null
  );
}

function requirementFitAssessment(assessment: RequirementFitAssessment): RequirementAssessment {
  const status = assessment.fit;
  const rows = requirementFitRows(assessment);
  if (status.kind === "matched") {
    return {
      label: "matched",
      tone: "ok",
      title: "The requirement-fit report records direct profile evidence for this requirement.",
      source: "requirement_fit",
      explanation: assessment.contribution.rationale || "Profile evidence covers this requirement.",
      rows,
    };
  }
  if (status.kind === "transferable") {
    return {
      label: "transferable",
      tone: "info",
      title: "The requirement-fit report records related evidence that can bridge this requirement.",
      source: "requirement_fit",
      explanation: assessment.contribution.rationale || status.bridge,
      rows,
    };
  }
  if (status.kind === "missing") {
    return {
      label: "missing",
      tone: "warn",
      title: "The requirement-fit report records this requirement as missing.",
      source: "requirement_fit",
      explanation: assessment.contribution.rationale || status.reason,
      rows,
    };
  }
  if (status.kind === "blocked") {
    return {
      label: "blocked",
      tone: "warn",
      title: "The requirement-fit report records this requirement as a blocker.",
      source: "requirement_fit",
      explanation: assessment.contribution.rationale || status.blocker,
      rows,
    };
  }
  return {
    label: "not assessed",
    tone: "muted",
    title: "The requirement-fit report did not assess this requirement.",
    source: "requirement_fit",
    explanation: assessment.contribution.rationale || status.reason,
    rows,
  };
}

function requirementFitRows(assessment: RequirementFitAssessment): RequirementAssessmentRow[] {
  const rows: RequirementAssessmentRow[] = [
    {
      label: "Score contribution",
      values: [
        `${formatPoints(assessment.contribution.awardedPoints)} / ${formatPoints(
          assessment.contribution.maxPoints,
        )} points`,
      ],
      tone: assessment.fit.kind === "matched" ? "ok" : assessment.fit.kind === "transferable" ? "info" : "warn",
    },
    {
      label: "Tailoring directive",
      values: [
        `${formatToken(assessment.tailoring.action)} · priority ${weightPercent(
          assessment.tailoring.priority,
        )}`,
      ],
      tone: assessment.tailoring.action === "avoid_claim" ? "warn" : "info",
    },
  ];

  if (assessment.fit.kind === "matched" || assessment.fit.kind === "transferable") {
    rows.push({
      label: "Profile evidence IDs",
      values: assessment.fit.evidenceIds,
      tone: assessment.fit.kind === "matched" ? "ok" : "info",
    });
  }
  if (assessment.fit.kind === "transferable") {
    rows.push(
      { label: "Gap", values: [assessment.fit.gap], tone: "warn" },
      { label: "Bridge", values: [assessment.fit.bridge], tone: "info" },
    );
  }
  if (assessment.fit.kind === "missing") {
    rows.push({ label: "Missing reason", values: [assessment.fit.reason], tone: "warn" });
  }
  if (assessment.fit.kind === "blocked") {
    rows.push({ label: "Blocker", values: [assessment.fit.blocker], tone: "warn" });
  }
  if (assessment.fit.kind === "not_assessed") {
    rows.push({ label: "Reason", values: [assessment.fit.reason], tone: "muted" });
  }
  if (assessment.tailoring.targetKeywords.length) {
    rows.push({ label: "Target keywords", values: assessment.tailoring.targetKeywords, tone: "info" });
  }
  if (assessment.tailoring.prohibitedClaims.length) {
    rows.push({ label: "Do not claim", values: assessment.tailoring.prohibitedClaims, tone: "warn" });
  }
  if (assessment.artifactCoverage) {
    const coverage = assessment.artifactCoverage;
    const coverageValues = [
      `${formatToken(coverage.state)} · ${coverage.bulletCount} bullet${
        coverage.bulletCount === 1 ? "" : "s"
      }`,
      ...coverage.examples,
    ];
    rows.push({
      label: "Artifact coverage",
      values: coverageValues,
      tone: coverage.state === "covered" ? "ok" : coverage.state === "not_covered" ? "warn" : "muted",
    });
  }
  return rows.filter((row) => row.values.some((value) => value.trim().length > 0));
}

function formatPoints(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function RequirementItem({
  requirement,
  requirementFitReport,
  scoreEvidence,
  flaggedRequirements,
}: {
  readonly requirement: EmployerAnalysisRequirement;
  readonly requirementFitReport?: RequirementFitReport | null;
  readonly scoreEvidence?: EmployerRequirementScoreEvidence | null;
  readonly flaggedRequirements: readonly string[];
}): JSX.Element {
  const tier = requirement.tier === "must_have" ? "warn" : "muted";
  const assessment = requirementAssessment(requirement, requirementFitReport, scoreEvidence);
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
          <span>{assessment.source === "requirement_fit" ? "Requirement fit" : "Legacy score signals"}</span>
          <span className={`tag ${assessment.tone}`} title={assessment.title}>
            {assessment.label}
          </span>
        </header>
        <p className="employer-analysis-rationale">{assessment.explanation}</p>
        {assessment.rows.map((row) => (
          <div className="employer-analysis-signal-row" key={`${requirement.id}:${row.label}`}>
            <span>{row.label}</span>
            <span>
              {row.values.map((value) => (
                <span className={`tag ${row.tone ?? assessment.tone}`} key={`${row.label}:${value}`}>
                  {value}
                </span>
              ))}
            </span>
          </div>
        ))}
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
  requirementFitReport = null,
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
                  requirementFitReport={requirementFitReport}
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
