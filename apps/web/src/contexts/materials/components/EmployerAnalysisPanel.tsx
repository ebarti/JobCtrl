import type {
  EmployerAnalysis,
  EmployerAnalysisFailure,
  EmployerAnalysisKeyword,
  EmployerAnalysisRequirement,
  EmployerAnalysisSubAnalysis,
  RequirementFitAssessment,
  RequirementFitReport,
} from "@jobctl/contracts";
import type { JSX } from "react";

import { formatToken, scorePercent, weightPercent } from "../lib/audit-format.js";

export interface EmployerAnalysisPanelProps {
  /** The canonical employer analysis, or null when none has been produced yet. */
  readonly analysis: EmployerAnalysis | null;
  /** Canonical requirement-led score report for the same job, or null for legacy scores. */
  readonly requirementFitReport?: RequirementFitReport | null;
  readonly className?: string;
}

interface RequirementAssessment {
  readonly label: string;
  readonly tone: "ok" | "warn" | "info" | "muted";
  readonly title: string;
  readonly explanation: string;
  readonly rows: readonly RequirementAssessmentRow[];
}

interface RequirementAssessmentRow {
  readonly label: string;
  readonly values: readonly string[];
  readonly tone?: "ok" | "warn" | "info" | "muted";
}

function compactTextValues(values: readonly unknown[] | null | undefined): string[] {
  if (!values) return [];
  return values.flatMap((value) => {
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    return trimmed.length ? [trimmed] : [];
  });
}

function pushTextRow(
  rows: RequirementAssessmentRow[],
  row: {
    readonly label: string;
    readonly values: readonly unknown[] | null | undefined;
    readonly tone?: RequirementAssessmentRow["tone"];
  },
): void {
  const values = compactTextValues(row.values);
  if (!values.length) return;
  if (row.tone) {
    rows.push({ label: row.label, values, tone: row.tone });
    return;
  }
  rows.push({ label: row.label, values });
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
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
): RequirementAssessment {
  const fitAssessment = matchingRequirementFit(requirement, requirementFitReport);
  if (fitAssessment) {
    return requirementFitAssessment(fitAssessment);
  }

  return {
    label: "not assessed",
    tone: "muted",
    title: "This job has employer requirements, but no requirement-fit report for this score.",
    explanation: "Re-score this job with the current policy to produce requirement-level candidate fit.",
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
      explanation: assessment.contribution.rationale || "Profile evidence covers this requirement.",
      rows,
    };
  }
  if (status.kind === "transferable") {
    return {
      label: "transferable",
      tone: "info",
      title: "The requirement-fit report records related evidence that can bridge this requirement.",
      explanation: assessment.contribution.rationale || status.bridge,
      rows,
    };
  }
  if (status.kind === "missing") {
    return {
      label: "missing",
      tone: "warn",
      title: "The requirement-fit report records this requirement as missing.",
      explanation: assessment.contribution.rationale || status.reason,
      rows,
    };
  }
  if (status.kind === "blocked") {
    return {
      label: "blocked",
      tone: "warn",
      title: "The requirement-fit report records this requirement as a blocker.",
      explanation: assessment.contribution.rationale || status.blocker,
      rows,
    };
  }
  return {
    label: "not assessed",
    tone: "muted",
    title: "The requirement-fit report did not assess this requirement.",
    explanation: assessment.contribution.rationale || status.reason,
    rows,
  };
}

function requirementFitRows(assessment: RequirementFitAssessment): RequirementAssessmentRow[] {
  const rows: RequirementAssessmentRow[] = [];
  pushTextRow(rows, {
    label: "Score contribution",
    values: [
      `${formatPoints(assessment.contribution.awardedPoints)} / ${formatPoints(
        assessment.contribution.maxPoints,
      )} points`,
    ],
    tone: assessment.fit.kind === "matched" ? "ok" : assessment.fit.kind === "transferable" ? "info" : "warn",
  });
  pushTextRow(rows, {
    label: "Tailoring directive",
    values: [
      `${formatToken(assessment.tailoring.action)} · priority ${weightPercent(
        assessment.tailoring.priority,
      )}`,
    ],
    tone: assessment.tailoring.action === "avoid_claim" ? "warn" : "info",
  });

  if (assessment.fit.kind === "matched" || assessment.fit.kind === "transferable") {
    pushTextRow(rows, {
      label: "Profile evidence IDs",
      values: assessment.fit.evidenceIds,
      tone: assessment.fit.kind === "matched" ? "ok" : "info",
    });
  }
  if (assessment.fit.kind === "transferable") {
    pushTextRow(rows, { label: "Gap", values: [assessment.fit.gap], tone: "warn" });
    pushTextRow(rows, { label: "Bridge", values: [assessment.fit.bridge], tone: "info" });
  }
  if (assessment.fit.kind === "missing") {
    pushTextRow(rows, { label: "Missing reason", values: [assessment.fit.reason], tone: "warn" });
  }
  if (assessment.fit.kind === "blocked") {
    pushTextRow(rows, { label: "Blocker", values: [assessment.fit.blocker], tone: "warn" });
  }
  if (assessment.fit.kind === "not_assessed") {
    pushTextRow(rows, { label: "Reason", values: [assessment.fit.reason], tone: "muted" });
  }
  pushTextRow(rows, { label: "Target keywords", values: assessment.tailoring.targetKeywords, tone: "info" });
  pushTextRow(rows, { label: "Do not claim", values: assessment.tailoring.prohibitedClaims, tone: "warn" });
  if (assessment.artifactCoverage) {
    const coverage = assessment.artifactCoverage;
    const coverageExamples = Array.isArray(coverage.examples) ? coverage.examples : [];
    const coverageValues = [
      `${formatArtifactCoverageState(coverage.state)} · ${coverage.bulletCount} bullet${
        coverage.bulletCount === 1 ? "" : "s"
      }`,
      ...coverageExamples,
    ];
    pushTextRow(rows, {
      label: "Artifact coverage",
      values: coverageValues,
      tone: coverage.state === "covered" ? "ok" : coverage.state === "not_recorded" ? "muted" : "warn",
    });
  }
  return rows;
}

function formatArtifactCoverageState(state: string): string {
  if (state === "missing_from_resume") return "missing from tailored resume";
  if (state === "missing_from_profile") return "missing from profile";
  if (state === "not_covered") return "not covered in tailored resume";
  return formatToken(state);
}

function formatPoints(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function RequirementItem({
  requirement,
  requirementFitReport,
  flaggedRequirements,
}: {
  readonly requirement: EmployerAnalysisRequirement;
  readonly requirementFitReport?: RequirementFitReport | null;
  readonly flaggedRequirements: readonly string[];
}): JSX.Element {
  const tier = requirement.tier === "must_have" ? "warn" : "muted";
  const assessment = requirementAssessment(requirement, requirementFitReport);
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
          <span>Requirement fit</span>
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
  className = "section",
}: EmployerAnalysisPanelProps): JSX.Element {
  if (!analysis) {
    return (
      <section className={className} aria-label="Role Analysis">
        <h3>Role Analysis</h3>
        <p className="muted">
          No role analysis has been recorded for this job yet. It is produced when materials are generated.
        </p>
      </section>
    );
  }

  return (
    <section className={className} aria-label="Role Analysis">
      <h3>Role Analysis</h3>
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
