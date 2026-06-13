import type { JobDetail } from "../../contexts/operations/types.js";
import { ScoreBadge } from "../../contexts/scoring/components/ScoreBadge.js";

export interface JobOverviewProps {
  detail: JobDetail;
}

export function JobOverview({ detail }: JobOverviewProps) {
  const { job } = detail;
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
      </span>
    </div>
  );
}
