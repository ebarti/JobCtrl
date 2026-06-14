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

export function JobOverview({ detail }: JobOverviewProps) {
  const { applyAudit, job } = detail;
  return (
    <div className="drawer-head">
      <ScoreBadge score={job.fitScore} />
      <span>
        <small>
          {job.company}
          {job.postingSource ? ` · posting: ${job.postingSource}` : ""}
          {job.discoverySource ? ` · discovered via: ${job.discoverySource}` : ""}
        </small>
        <h2>{job.title}</h2>
        <p>
          {job.location || "-"} · {job.salary || "-"}
        </p>
        <a className="external-link" href={job.url} rel="noreferrer" target="_blank">
          open original posting
        </a>
        <div className="job-overview-readiness" aria-label="Apply readiness">
          <span className="job-overview-readiness-label">Apply readiness</span>
          <span className={`tag ${auditTone(applyAudit.state)}`} title={applyAudit.summary}>
            {applyAudit.label}
          </span>
        </div>
      </span>
    </div>
  );
}
