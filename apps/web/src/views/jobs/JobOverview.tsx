import type { JobDetail } from "../../contexts/operations/types.js";
import { ScoreBadge } from "../../contexts/scoring/components/ScoreBadge.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";

export interface JobOverviewProps {
  detail: JobDetail;
}

function auditTone(state: JobDetail["applyAudit"]["state"]): "ok" | "info" | "warn" {
  if (state === "ready") return "ok";
  if (state === "preparing") return "info";
  return "warn";
}

export function JobOverview({ detail }: JobOverviewProps) {
  const { applyAudit, job } = detail;
  return (
    <header className="drawer-head job-overview">
      <div className="job-overview-score" aria-label={`Fit score ${job.fitScore ?? "not scored"}`}>
        <span className="job-overview-score-label">Fit</span>
        <ScoreBadge score={job.fitScore} />
      </div>
      <div className="job-overview-copy">
        <small className="job-overview-provenance">
          {job.company}
          {job.postingSource ? ` · posting: ${job.postingSource}` : ""}
          {job.discoverySource ? ` · discovered via: ${job.discoverySource}` : ""}
        </small>
        <h1>{job.title}</h1>
        <p className="job-overview-location">
          {job.location || "-"} · {job.salary || "-"}
        </p>
        <div className="job-overview-meta-row">
          <a className="external-link" href={job.url} rel="noreferrer" target="_blank">
            open original posting
          </a>
          <div className="job-overview-readiness" aria-label="Apply readiness">
            <span className="job-overview-readiness-label">Apply readiness</span>
            <StatusBadge tone={auditTone(applyAudit.state)} title={applyAudit.summary}>
              {applyAudit.label}
            </StatusBadge>
          </div>
        </div>
      </div>
    </header>
  );
}
