import type {
  EmployerAnalysis,
  EmployerAnalysisFailure,
  EmployerAnalysisKeyword,
  EmployerAnalysisRequirement,
  EmployerAnalysisSubAnalysis,
  RequirementFitAssessment,
  RequirementFitReport,
} from "@jobctrl/contracts";
import type { JSX } from "react";

import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../shared/ui/card.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../shared/ui/collapsible.js";
import { Separator } from "../../../shared/ui/separator.js";
import {
  formatToken,
  scorePercent,
  weightPercent,
} from "../lib/audit-format.js";
import {
  type AuditEvidenceReference,
  AuditTechnicalDetails,
  type ResolveAuditEvidenceReference,
} from "./AuditTechnicalDetails.js";

export type EmployerAnalysisEvidenceReference = AuditEvidenceReference;

export interface EmployerAnalysisPanelProps {
  /** The canonical employer analysis, or null when none has been produced yet. */
  readonly analysis: EmployerAnalysis | null;
  /** Canonical requirement-led score report for the same job, or null for legacy scores. */
  readonly requirementFitReport?: RequirementFitReport | null;
  /** Resolves requirement-fit evidence foreign keys through the canonical Evidence Map read model. */
  readonly resolveEvidenceReference?: ResolveAuditEvidenceReference;
  readonly className?: string;
}

interface RequirementAssessment {
  readonly label: string;
  readonly tone: "ok" | "warn" | "info" | "muted";
  readonly title: string;
  readonly explanation: string;
  readonly rows: readonly RequirementAssessmentRow[];
}

interface RequirementAssessmentTextRow {
  readonly kind: "text";
  readonly label: string;
  readonly values: readonly string[];
  readonly tone?: "ok" | "warn" | "info" | "muted";
}

interface RequirementAssessmentEvidenceRow {
  readonly kind: "profile_evidence";
  readonly label: string;
  readonly evidenceIds: readonly string[];
}

type RequirementAssessmentRow =
  | RequirementAssessmentTextRow
  | RequirementAssessmentEvidenceRow;

function compactTextValues(
  values: readonly unknown[] | null | undefined,
): string[] {
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
    readonly tone?: RequirementAssessmentTextRow["tone"];
  },
): void {
  const values = compactTextValues(row.values);
  if (!values.length) return;
  if (row.tone) {
    rows.push({ kind: "text", label: row.label, values, tone: row.tone });
    return;
  }
  rows.push({ kind: "text", label: row.label, values });
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
  const fitAssessment = matchingRequirementFit(
    requirement,
    requirementFitReport,
  );
  if (fitAssessment) {
    return requirementFitAssessment(fitAssessment);
  }

  return {
    label: "not assessed",
    tone: "muted",
    title:
      "This job has employer requirements, but no requirement-fit report for this score.",
    explanation:
      "Re-score this job with the current policy to produce requirement-level candidate fit.",
    rows: [],
  };
}

function matchingRequirementFit(
  requirement: EmployerAnalysisRequirement,
  report: RequirementFitReport | null | undefined,
): RequirementFitAssessment | null {
  if (!report?.assessments.length) return null;
  const byId = report.assessments.find(
    (assessment) => assessment.requirementId === requirement.id,
  );
  if (byId) return byId;

  const requirementText = normalizeText(requirement.text);
  return (
    report.assessments.find(
      (assessment) =>
        normalizeText(assessment.requirementText) === requirementText,
    ) ?? null
  );
}

function requirementFitAssessment(
  assessment: RequirementFitAssessment,
): RequirementAssessment {
  const status = assessment.fit;
  const rows = requirementFitRows(assessment);
  if (status.kind === "matched") {
    return {
      label: "matched",
      tone: "ok",
      title:
        "The requirement-fit report records direct profile evidence for this requirement.",
      explanation:
        assessment.contribution.rationale ||
        "Profile evidence covers this requirement.",
      rows,
    };
  }
  if (status.kind === "transferable") {
    return {
      label: "transferable",
      tone: "info",
      title:
        "The requirement-fit report records related evidence that can bridge this requirement.",
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
      title:
        "The requirement-fit report records this requirement as a blocker.",
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

function requirementFitRows(
  assessment: RequirementFitAssessment,
): RequirementAssessmentRow[] {
  const rows: RequirementAssessmentRow[] = [];
  pushTextRow(rows, {
    label: "Score contribution",
    values: [
      `${formatPoints(assessment.contribution.awardedPoints)} / ${formatPoints(
        assessment.contribution.maxPoints,
      )} points`,
    ],
    tone:
      assessment.fit.kind === "matched"
        ? "ok"
        : assessment.fit.kind === "transferable"
          ? "info"
          : "warn",
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

  if (
    assessment.fit.kind === "matched" ||
    assessment.fit.kind === "transferable"
  ) {
    const evidenceIds = compactTextValues(assessment.fit.evidenceIds);
    if (evidenceIds.length) {
      rows.push({
        kind: "profile_evidence",
        label: "Profile evidence",
        evidenceIds,
      });
    }
  }
  if (assessment.fit.kind === "transferable") {
    pushTextRow(rows, {
      label: "Gap",
      values: [assessment.fit.gap],
      tone: "warn",
    });
    pushTextRow(rows, {
      label: "Bridge",
      values: [assessment.fit.bridge],
      tone: "info",
    });
  }
  if (assessment.fit.kind === "missing") {
    pushTextRow(rows, {
      label: "Missing reason",
      values: [assessment.fit.reason],
      tone: "warn",
    });
  }
  if (assessment.fit.kind === "blocked") {
    pushTextRow(rows, {
      label: "Blocker",
      values: [assessment.fit.blocker],
      tone: "warn",
    });
  }
  if (assessment.fit.kind === "not_assessed") {
    pushTextRow(rows, {
      label: "Reason",
      values: [assessment.fit.reason],
      tone: "muted",
    });
  }
  pushTextRow(rows, {
    label: "Target keywords",
    values: assessment.tailoring.targetKeywords,
    tone: "info",
  });
  pushTextRow(rows, {
    label: "Do not claim",
    values: assessment.tailoring.prohibitedClaims,
    tone: "warn",
  });
  if (assessment.artifactCoverage) {
    const coverage = assessment.artifactCoverage;
    const coverageExamples = Array.isArray(coverage.examples)
      ? coverage.examples
      : [];
    const coverageValues = [
      `${formatArtifactCoverageState(coverage.state)} · ${coverage.bulletCount} bullet${
        coverage.bulletCount === 1 ? "" : "s"
      }`,
      ...coverageExamples,
    ];
    pushTextRow(rows, {
      label: "Artifact coverage",
      values: coverageValues,
      tone:
        coverage.state === "covered"
          ? "ok"
          : coverage.state === "not_recorded"
            ? "muted"
            : "warn",
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
  return Number.isInteger(value)
    ? `${value}`
    : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function ProfileEvidenceReference({
  evidenceId,
  resolveEvidenceReference,
}: {
  readonly evidenceId: string;
  readonly resolveEvidenceReference: EmployerAnalysisPanelProps["resolveEvidenceReference"];
}): JSX.Element {
  const reference = resolveEvidenceReference?.(evidenceId);
  if (reference === undefined && resolveEvidenceReference) {
    return <li className="text-muted-foreground">Loading evidence details.</li>;
  }
  if (reference) {
    return (
      <li className="flex min-w-0 flex-col gap-0.5">
        <strong className="font-medium leading-snug">{reference.title}</strong>
        {reference.excerpt ? (
          <span className="text-muted-foreground leading-relaxed">
            {reference.excerpt}
          </span>
        ) : null}
      </li>
    );
  }
  return (
    <li className="text-muted-foreground">Evidence reference unavailable.</li>
  );
}

function ProfileEvidenceReferences({
  evidenceIds,
  resolveEvidenceReference,
}: {
  readonly evidenceIds: readonly string[];
  readonly resolveEvidenceReference: EmployerAnalysisPanelProps["resolveEvidenceReference"];
}): JSX.Element {
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-slot="requirement-profile-evidence"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Profile evidence
        </span>
        <Badge variant="outline">
          {evidenceIds.length} source{evidenceIds.length === 1 ? "" : "s"}
        </Badge>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {evidenceIds.map((evidenceId) => (
          <ProfileEvidenceReference
            evidenceId={evidenceId}
            key={evidenceId}
            resolveEvidenceReference={resolveEvidenceReference}
          />
        ))}
      </ul>
      <AuditTechnicalDetails>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {evidenceIds.map((evidenceId) => (
            <li key={evidenceId}>
              <code
                className="break-all text-muted-foreground"
                data-typography="code"
              >
                {evidenceId}
              </code>
            </li>
          ))}
        </ul>
      </AuditTechnicalDetails>
    </div>
  );
}

function RequirementFitMetric({
  row,
}: {
  readonly row: RequirementAssessmentTextRow;
}): JSX.Element {
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-slot="requirement-fit-metric"
    >
      <dt className="text-xs font-medium text-muted-foreground">{row.label}</dt>
      <dd className="m-0 flex min-w-0 flex-col gap-1 font-medium leading-snug">
        {row.values.map((value) => (
          <span className="break-words" key={`${row.label}:${value}`}>
            {value}
          </span>
        ))}
      </dd>
    </div>
  );
}

function RequirementAuditDetails({
  rows,
}: {
  readonly rows: readonly RequirementAssessmentTextRow[];
}): JSX.Element | null {
  if (!rows.length) return null;
  return (
    <Collapsible data-slot="requirement-fit-audit-details">
      <CollapsibleTrigger
        render={
          <Button
            aria-label="Additional audit details"
            className="w-full justify-between"
            size="sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <span>Additional audit details</span>
        <span className="text-xs text-muted-foreground" data-typography="label">
          {rows.length} signal{rows.length === 1 ? "" : "s"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <dl className="grid gap-3 sm:grid-cols-2">
          {rows.map((row) => (
            <div className="flex min-w-0 flex-col gap-1" key={row.label}>
              <dt className="text-xs font-medium text-muted-foreground">
                {row.label}
              </dt>
              <dd className="m-0 flex min-w-0 flex-col gap-1 leading-relaxed">
                {row.values.map((value) => (
                  <span className="break-words" key={`${row.label}:${value}`}>
                    {value}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RequirementItem({
  requirement,
  requirementFitReport,
  flaggedRequirements,
  resolveEvidenceReference,
}: {
  readonly requirement: EmployerAnalysisRequirement;
  readonly requirementFitReport?: RequirementFitReport | null;
  readonly flaggedRequirements: readonly string[];
  readonly resolveEvidenceReference: EmployerAnalysisPanelProps["resolveEvidenceReference"];
}): JSX.Element {
  const assessment = requirementAssessment(requirement, requirementFitReport);
  const flagged = isFlaggedByAgreement(requirement, flaggedRequirements);
  const primaryRows = assessment.rows.filter(
    (row): row is RequirementAssessmentTextRow =>
      row.kind === "text" &&
      (row.label === "Score contribution" ||
        row.label === "Tailoring directive"),
  );
  const evidenceRow = assessment.rows.find(
    (row): row is RequirementAssessmentEvidenceRow =>
      row.kind === "profile_evidence",
  );
  const auditRows = assessment.rows.filter(
    (row): row is RequirementAssessmentTextRow =>
      row.kind === "text" &&
      row.label !== "Score contribution" &&
      row.label !== "Tailoring directive",
  );
  return (
    <Card
      aria-label={`Requirement: ${requirement.text}`}
      className="employer-analysis-requirement employer-analysis-requirement-card [--card-spacing:--spacing(3)]"
      role="article"
      size="sm"
    >
      <CardHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{formatToken(requirement.tier)}</Badge>
          <Badge
            title="Relative priority from job-post analysis, not a match score"
            variant="secondary"
          >
            importance {weightPercent(requirement.weight)}
          </Badge>
          {flagged ? (
            <AuditTechnicalDetails>
              <StatusBadge
                title="The ensemble agreement marked this requirement as non-unanimous across model legs."
                tone="muted"
              >
                Ensemble divergence
              </StatusBadge>
            </AuditTechnicalDetails>
          ) : null}
        </div>
        <CardTitle>
          <h5 className="m-0 text-base font-medium leading-snug">
            {requirement.text}
          </h5>
        </CardTitle>
        {requirement.evidence_span ? (
          <CardDescription>
            <blockquote className="employer-analysis-evidence" data-typography="body">
              {requirement.evidence_span}
            </blockquote>
          </CardDescription>
        ) : (
          <CardDescription>
            No job-description evidence span recorded.
          </CardDescription>
        )}
        <CardAction>
          <StatusBadge
            title={assessment.title}
            tone={assessment.tone}
          >
            {assessment.label}
          </StatusBadge>
        </CardAction>
      </CardHeader>
      <Separator />
      <CardContent>
        <div
          aria-label="Fit summary"
          className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1.1fr)_minmax(220px,0.9fr)]"
          data-slot="requirement-fit-summary"
          role="group"
        >
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Requirement fit
              </span>
              <p className="m-0 leading-relaxed">{assessment.explanation}</p>
            </div>
            {primaryRows.length ? (
              <dl className="grid grid-cols-2 gap-3">
                {primaryRows.map((row) => (
                  <RequirementFitMetric key={row.label} row={row} />
                ))}
              </dl>
            ) : null}
          </div>
          {evidenceRow ? (
            <ProfileEvidenceReferences
              evidenceIds={evidenceRow.evidenceIds}
              resolveEvidenceReference={resolveEvidenceReference}
            />
          ) : null}
        </div>
      </CardContent>
      {auditRows.length ? (
        <>
          <Separator />
          <CardContent>
            <RequirementAuditDetails rows={auditRows} />
          </CardContent>
        </>
      ) : null}
    </Card>
  );
}

function KeywordItem({
  keyword,
  requirementsById,
}: {
  readonly keyword: EmployerAnalysisKeyword;
  readonly requirementsById: ReadonlyMap<
    string,
    EmployerAnalysisRequirement
  >;
}): JSX.Element {
  const requirement = keyword.requirement_ref
    ? requirementsById.get(keyword.requirement_ref)
    : undefined;
  return (
    <article className="employer-analysis-keyword">
      <header>
        <b>{keyword.keyword}</b>
        {keyword.is_orphan ? (
          <StatusBadge
            tone="warn"
            title="Not tied to a specific requirement"
          >
            Orphan
          </StatusBadge>
        ) : null}
      </header>
      {keyword.evidence_span ? (
        <blockquote className="employer-analysis-evidence" data-typography="body">
          {keyword.evidence_span}
        </blockquote>
      ) : (
        <p className="muted">No job-description evidence span recorded.</p>
      )}
      {keyword.rationale ? (
        <p className="employer-analysis-rationale">{keyword.rationale}</p>
      ) : null}
      {keyword.requirement_ref ? (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Serves requirement
          </span>
          <span className="leading-relaxed">
            {requirement?.text ?? "Requirement reference unavailable."}
          </span>
          <AuditTechnicalDetails>
            <code
              className="break-all text-muted-foreground"
              data-typography="code"
            >
              {keyword.requirement_ref}
            </code>
          </AuditTechnicalDetails>
        </div>
      ) : null}
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
      <summary>
        Ensemble audit trail ({subAnalyses.length} model
        {subAnalyses.length === 1 ? "" : "s"})
      </summary>
      <div className="employer-analysis-ensemble-body">
        {subAnalyses.map((sub) => (
          <article className="employer-analysis-sub" key={sub.model_id}>
            <header>
              <b>{sub.model_id}</b>
              <span className="tag muted">
                {formatToken(sub.inferred_seniority)}
              </span>
            </header>
            {sub.role_framing ? <p>{sub.role_framing}</p> : null}
            <span className="muted">
              {sub.requirements.length} requirement
              {sub.requirements.length === 1 ? "" : "s"} · {sub.keywords.length}{" "}
              keyword{sub.keywords.length === 1 ? "" : "s"}
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
  resolveEvidenceReference,
  className = "section",
}: EmployerAnalysisPanelProps): JSX.Element {
  if (!analysis) {
    return (
      <section className={className} aria-label="Role Analysis">
        <h3>Role Analysis</h3>
        <p className="muted">
          No role analysis has been recorded for this job yet. It is produced
          when materials are generated.
        </p>
      </section>
    );
  }

  const requirementsById = new Map(
    analysis.requirements.map((requirement) => [requirement.id, requirement]),
  );

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
                <StatusBadge
                  tone="warn"
                  title={`${analysis.legs_succeeded}/${analysis.legs_attempted} models succeeded`}
                >
                  Degraded ({analysis.legs_succeeded}/{analysis.legs_attempted})
                </StatusBadge>
              ) : (
                <StatusBadge tone="ok">
                  {formatToken(analysis.ensemble_completeness) || "complete"}
                </StatusBadge>
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
                  resolveEvidenceReference={resolveEvidenceReference}
                />
              ))}
            </div>
          ) : (
            <p className="muted">
              No requirements were recorded for this analysis.
            </p>
          )}
        </div>

        <div className="evidence-block">
          <h4>Reasoned keywords ({analysis.keywords.length})</h4>
          {analysis.keywords.length ? (
            <div className="employer-analysis-keyword-list">
              {analysis.keywords.map((keyword) => (
                <KeywordItem
                  key={keyword.keyword}
                  keyword={keyword}
                  requirementsById={requirementsById}
                />
              ))}
            </div>
          ) : (
            <p className="muted">
              No reasoned keywords were recorded for this analysis.
            </p>
          )}
        </div>

        <SubAnalysisDetails
          subAnalyses={analysis.sub_analyses}
          failures={analysis.failures}
        />
      </div>
    </section>
  );
}
