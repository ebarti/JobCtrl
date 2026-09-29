import type { ApplyAuditFact, ApplyAuditSource } from "@jobctrl/contracts";

import type { JobDetail } from "../../contexts/operations/types.js";
import { ResetStaleScoresButton } from "../../contexts/scoring/components/ResetStaleScoresButton.js";
import { ScoreCorrectionControl } from "../../contexts/scoring/components/ScoreCorrectionControl.js";
import { ScoreStalenessBadge } from "../../contexts/scoring/components/ScoreStalenessBadge.js";
import { ContextHelp } from "../../shared/ui/context-help.js";
import { fitScoreHelp } from "./fit-score-help.js";

const metricHelp = {
  "Fit score": "The latest stored candidate fit score, on a 1–10 scale. It may come from policy scoring or a saved manual correction; inspect the score record before relying on it.",
  Band: "The policy's named fit category for the stored score. This is a ranking summary, not a hiring prediction.",
  Confidence: "How strongly the scoring evidence supports the fit assessment. It is not the probability of an offer or proof that every source is correct.",
  Eligibility: "The scoring policy's eligibility assessment from known job and profile facts. Unknown means the available evidence does not establish eligibility.",
  "Requirement fit": "Weighted coverage of the employer requirements assessed against candidate evidence. It appears only for a current requirement-fit report; an old or missing report is not treated as current.",
  "Must-haves": "Coverage of requirements marked must-have in the current requirement-fit report. This is separate from the overall weighted requirement fit.",
} as const;

const tagHelp = {
  "Matched requirements": "Current analyzed requirements with candidate evidence assessed as matched. The detailed evidence is in Role Analysis.",
  "Missing requirements": "Current analyzed requirements assessed as missing or blocked against candidate evidence; inspect each requirement before deciding on an application.",
  "Transferable requirements": "Current requirements supported by related candidate experience rather than a direct match; inspect the evidence and tailoring directive.",
  "Unassessed requirements": "Requirements for which the current score did not establish candidate fit. They must not be treated as matches.",
  "Matched signals": "Signals the stored legacy score found in the available candidate and job evidence.",
  "Missing signals": "Signals the stored legacy score did not substantiate. Their absence is an assessment result, not proof that the candidate lacks the skill.",
  "Transferable signals": "Related experience recognized by the stored legacy score as potentially transferable.",
  Keywords: "Keywords saved with the scoring record; their presence here does not prove coverage in a generated resume.",
} as const;

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
            <h2 aria-label="Fit & evidence">Fit & evidence <ContextHelp label="Fit and evidence" description="Saved scoring results, requirement-level assessments, rationale, and apply concerns. These derive from the scoring record and current job analysis; inspect the details before acting on a summary." /></h2>
          </header>
          <dl className="job-audit-metrics" aria-label="Ranking summary">
            <Metric
              label="Fit score"
              help={fitScoreHelp(job)}
              value={
                job.fitScore === null ? "Not scored" : `${job.fitScore}/10`
              }
            />
            <Metric label="Band" value={score?.fitBand ?? "not recorded"} help={job.scoreCorrection ? "This fit band comes from the retained original scoring breakdown. A manual score correction changes the displayed fit score but does not recalculate the band; the two may differ." : undefined} />
            <Metric label="Confidence" value={score?.confidence ?? "not recorded"} help={job.scoreCorrection ? "This confidence value comes from the retained original scoring breakdown. A manual score correction does not recalculate it; it is not confidence in the corrected score or a probability of an offer." : undefined} />
            <Metric label="Eligibility" value={score?.eligibility.status ?? "unknown"} help={job.scoreCorrection ? "This eligibility assessment comes from the retained original scoring breakdown. A manual fit-score correction does not recheck eligibility; verify current prerequisites and concerns before applying." : undefined} />
            <Metric
              label="Requirement fit"
              value={
                requirementFitReport
                  ? percent(requirementFitReport.summary.weightedFit)
                  : "not assessed"
              }
            />
            <Metric
              label="Must-haves"
              value={
                requirementFitReport
                  ? percent(requirementFitReport.summary.mustHaveCoverage)
                  : "not assessed"
              }
            />
          </dl>
          {reasoning ? (
            <p className="job-audit-rationale">{reasoning}</p>
          ) : (
            <p className="job-audit-rationale muted">No score rationale was stored for this job.</p>
          )}
          {factGroups.length ? (
            <div className="job-audit-concerns">
              <div className="job-audit-triage-kicker" data-typography="label">
                Apply concerns <ContextHelp label="Apply concerns" description="Preflight facts grouped by missing prerequisites, hard blockers, eligibility concerns, and unverified or missing sources. These explain why readiness may be blocked or uncertain." />
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
              <ContextHelp label="Score evidence and controls" description="Inspect requirement assessments or matched, missing, and transferable signals, recorded keywords, scoring policy details, and correction controls. Rescoring may be needed when the saved policy or analysis is outdated." />
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
                  Score correction <ContextHelp label="Score correction" description="Review or correct the stored fit assessment through the scoring control. The original scoring trace remains available for audit." />
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

function Metric({ label, value, help }: { label: keyof typeof metricHelp; value: string; help?: string | undefined }) {
  return (
    <div>
      <dt data-typography="label">{label} <ContextHelp label={label} description={help ?? metricHelp[label]} /></dt>
      <dd data-typography="metric">{value}</dd>
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
  label: keyof typeof tagHelp;
  values: readonly string[] | undefined;
  tone?: "info" | "warn";
}) {
  if (!values?.length) {
    return null;
  }
  return (
    <div className="job-audit-tag-group">
      <span data-typography="label">{label} <ContextHelp label={label} description={tagHelp[label]} /></span>
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
