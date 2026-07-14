import type { JobDetail } from "../../contexts/operations/types.js";
import { ScoreBadge } from "../../contexts/scoring/components/ScoreBadge.js";

export interface JobOverviewProps {
  detail: JobDetail;
}

function auditTone(state: JobDetail["applyAudit"]["state"]): "ok" | "info" | "warn" {
  if (state === "ready") return "ok";
  if (state === "preparing") return "info";
  return "warn";
}

function formatStage(stage: string): string {
  return stage.replaceAll("_", " ");
}

export function JobOverview({ detail }: JobOverviewProps) {
  const { applyAudit, job } = detail;
  return (
    <div className="job-overview">
      <div
        className="job-overview__fit"
        aria-label={`Fit score ${job.fitScore ?? "not scored"} out of 10`}
      >
        <ScoreBadge score={job.fitScore} />
        <span>Fit</span>
      </div>
      <div className="job-overview__identity">
        <small className="job-overview__company">
          {job.company}
          {job.postingSource ? ` · posting: ${job.postingSource}` : ""}
          {job.discoverySource ? ` · discovered via: ${job.discoverySource}` : ""}
        </small>
        <h1>{job.title}</h1>
        <p className="job-overview__metadata">
          {job.location || "-"} · {job.salary || "-"}
        </p>
        <a className="external-link" href={job.url} rel="noreferrer" target="_blank">
          open original posting
        </a>
        <div className="job-overview-readiness" aria-label="Apply readiness">
          <span className="job-overview-readiness-label">Apply readiness</span>
          <span
            className={`job-overview-readiness-value job-overview-readiness-value--${auditTone(
              applyAudit.state,
            )}`}
            title={applyAudit.summary}
          >
            {applyAudit.label}
          </span>
        </div>
      </div>
    </div>
  );
}

export function JobSummaryLedger({ detail }: JobOverviewProps) {
  const { applyAudit, job } = detail;
  const readinessTone = auditTone(applyAudit.state);
  const currentStage = formatStage(job.currentSubstage || job.currentStage);
  const source = job.postingSource || job.discoverySource;

  return (
    <dl className="job-summary-ledger" aria-label="Job summary">
      <div>
        <dt>Fit</dt>
        <dd>
          <b>{job.fitScore === null ? "Not scored" : `${job.fitScore}/10`}</b>
          <span>{job.scoreBreakdown?.fitBand || "Current score"}</span>
        </dd>
      </div>
      <div>
        <dt>Readiness</dt>
        <dd>
          <b className={`job-summary-ledger__status job-summary-ledger__status--${readinessTone}`}>
            {applyAudit.label}
          </b>
          <span>{applyAudit.summary}</span>
        </dd>
      </div>
      <div>
        <dt>Compensation</dt>
        <dd>
          <b>{job.salary || "Not published"}</b>
          <span>{job.salary ? "Published range" : "No published range"}</span>
        </dd>
      </div>
      <div>
        <dt>Current stage</dt>
        <dd>
          <b>{currentStage}</b>
          <span>{source ? `via ${source}` : "Source not recorded"}</span>
        </dd>
      </div>
    </dl>
  );
}
