import type { ApplyAuditFact, ApplyAuditSource } from "@jobctrl/contracts";

import type { JobDetail } from "../../contexts/operations/types.js";
import { ResetStaleScoresButton } from "../../contexts/scoring/components/ResetStaleScoresButton.js";
import { ScoreCorrectionControl } from "../../contexts/scoring/components/ScoreCorrectionControl.js";
import { ScoreStalenessBadge } from "../../contexts/scoring/components/ScoreStalenessBadge.js";

export interface JobAuditTriageProps {
  detail: JobDetail;
}

export function JobAuditTriage({ detail }: JobAuditTriageProps) {
  const { job, applyAudit } = detail;
  const score = job.scoreBreakdown;
  const requirementFitReport = detail.requirementFitReport;
  const reasoning = score?.reasoning || job.scoreReasoning;
  const factGroups = auditFactGroups(detail);

  return (
    <section className="section job-audit-triage" aria-label="Job audit triage">
      <div className="job-audit-triage-grid">
        <div className="job-audit-triage-column">
          <header className="job-audit-triage-heading">
            <span className="job-audit-triage-kicker" data-typography="label">
              Assessment
            </span>
            <h2>Fit & evidence</h2>
          </header>
          <dl className="job-audit-metrics" aria-label="Ranking summary">
            <Metric label="Fit score" value={job.fitScore === null ? "Not scored" : `${job.fitScore}/10`} />
            <Metric label="Band" value={score?.fitBand ?? "not recorded"} />
            <Metric label="Confidence" value={score?.confidence ?? "not recorded"} />
            <Metric label="Eligibility" value={score?.eligibility.status ?? "unknown"} />
            {requirementFitReport ? (
              <>
                <Metric label="Requirement fit" value={percent(requirementFitReport.summary.weightedFit)} />
                <Metric label="Must-haves" value={percent(requirementFitReport.summary.mustHaveCoverage)} />
              </>
            ) : null}
          </dl>
          {reasoning ? (
            <p className="job-audit-rationale">{reasoning}</p>
          ) : (
            <p className="job-audit-rationale muted">No score rationale was stored for this job.</p>
          )}
          {factGroups.length ? (
            <div className="job-audit-concerns">
              <div className="job-audit-triage-kicker" data-typography="label">
                Apply concerns
              </div>
              <dl className="job-audit-fact-list">
                {factGroups.map((group) => (
                  <div key={group.label}>
                    <dt>{group.label}</dt>
                    <dd>
                      <ul className="job-audit-concern-list">
                        {group.facts.map((fact) => (
                          <li data-severity={fact.severity} key={`${group.label}:${fact.code}:${fact.detail ?? ""}`}>
                            <span className="job-audit-concern-marker" aria-hidden="true" />
                            <span data-typography="body">
                              <strong data-typography="strong-body">{fact.label}</strong>
                              {fact.detail ? `: ${fact.detail}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {applyAudit.state !== "ready" && !factGroups.length ? <p className="muted">{applyAudit.summary}</p> : null}
          <details className="job-audit-diagnostics">
            <summary data-typography="control">Score evidence and controls</summary>
            <div className="job-audit-diagnostics__content">
              {requirementFitReport ? (
                <RequirementFitGroups report={requirementFitReport} />
              ) : (
                <>
                  <TagGroup label="Matched signals" values={score?.matchedSignals} />
                  <TagGroup label="Missing signals" values={score?.missingSignals} tone="warn" />
                  <TagGroup label="Transferable signals" values={score?.transferableSignals} />
                </>
              )}
              <TagGroup label="Keywords" values={job.scoreKeywords} />
              <ScoreMetadata detail={detail} />
              {job.scoreStaleness.isStale ? (
                <div className="score-policy-row">
                  <ScoreStalenessBadge staleness={job.scoreStaleness} />
                  <span className="muted">scoring policy updated; reset this score before rescoring</span>
                  <ResetStaleScoresButton
                    className="tab on"
                    jobKeys={[job.jobKey]}
                    label="reset for rescore"
                    staleCount={1}
                  />
                </div>
              ) : null}
              <div className="job-audit-score-correction">
                <span className="job-audit-triage-kicker" data-typography="label">
                  Score correction
                </span>
                <ScoreCorrectionControl jobId={job.jobKey} currentScore={job.fitScore} />
              </div>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RequirementFitGroups({ report }: { report: NonNullable<JobDetail["requirementFitReport"]> }) {
  const matched = requirementTexts(report.assessments, ["matched"]);
  const missing = requirementTexts(report.assessments, ["missing", "blocked"]);
  const transferable = requirementTexts(report.assessments, ["transferable"]);
  const unassessed = requirementTexts(report.assessments, ["not_assessed"]);
  return (
    <>
      <TagGroup label="Matched requirements" values={matched} />
      <TagGroup label="Missing requirements" values={missing} tone="warn" />
      <TagGroup label="Transferable requirements" values={transferable} />
      <TagGroup label="Unassessed requirements" values={unassessed} tone="warn" />
      {report.summary.blockerCount || report.summary.missingHighWeightCount ? (
        <p className="muted">
          {report.summary.blockerCount} blocker
          {report.summary.blockerCount === 1 ? "" : "s"} · {report.summary.missingHighWeightCount} high-weight miss
          {report.summary.missingHighWeightCount === 1 ? "" : "es"}
        </p>
      ) : null}
    </>
  );
}

function requirementTexts(
  assessments: NonNullable<JobDetail["requirementFitReport"]>["assessments"],
  kinds: readonly string[],
): string[] {
  const wanted = new Set(kinds);
  return assessments
    .filter((assessment) => wanted.has(assessment.fit.kind))
    .map((assessment) => assessment.requirementText);
}

function TagGroup({
  label,
  values,
  tone = "info",
}: {
  label: string;
  values: readonly string[] | undefined;
  tone?: "info" | "warn";
}) {
  if (!values?.length) {
    return null;
  }
  return (
    <div className="job-audit-tag-group">
      <span data-typography="label">{label}</span>
      <ul data-tone={tone}>
        {values.map((value) => (
          <li data-typography="body" key={value}>
            {value}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScoreMetadata({ detail }: { detail: JobDetail }) {
  const { job } = detail;
  const metadata = [
    job.scoreCriteria ? `minimum ${job.scoreCriteria.minFitScore}/10` : null,
    job.scoreTrace?.scoringPolicyVersion ? `policy v${job.scoreTrace.scoringPolicyVersion}` : null,
    job.scoreTrace?.rubricVersion ?? null,
    detail.requirementFitReport ? detail.requirementFitReport.formulaVersion : null,
    job.scoreTrace?.policyAnchorCount ? `${job.scoreTrace.policyAnchorCount} anchors` : null,
    job.scoredAt ? `scored ${job.scoredAt}` : null,
  ].filter(Boolean);

  if (!metadata.length) {
    return null;
  }

  return (
    <details className="job-score-technical-details">
      <summary data-typography="control">Scoring technical details</summary>
      <p className="muted" data-typography="body">
        {metadata.join(" · ")}
      </p>
    </details>
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function auditFactGroups(detail: JobDetail): Array<{ label: string; facts: ApplyAuditFact[] }> {
  const { applyAudit } = detail;
  return [
    { label: "Missing", facts: applyAudit.missingPrerequisites },
    { label: "Blockers", facts: applyAudit.hardBlockers },
    { label: "Eligibility", facts: applyAudit.eligibilityConcerns },
    { label: "Sources", facts: sourceFacts(applyAudit.sources) },
  ].filter((group) => group.facts.length > 0);
}

function sourceFacts(sources: readonly ApplyAuditSource[]): ApplyAuditFact[] {
  return sources.filter(isInspectableSource).map((source) => ({
    code: `source_${source.kind}`,
    label: source.label,
    detail: sourceDetail(source),
    severity: source.status === "unknown" ? "unknown" : "warning",
    source: source.kind,
  }));
}

function isInspectableSource(source: ApplyAuditSource): boolean {
  if (source.status === "unknown") {
    return true;
  }
  return (
    source.status === "missing" &&
    (source.kind === "application_url" || source.kind === "materials.resume" || source.kind === "materials.pdf")
  );
}

function sourceDetail(source: ApplyAuditSource): string {
  const status = source.status.replace(/_/g, " ");
  return source.detail ? `${status}: ${source.detail}` : status;
}
