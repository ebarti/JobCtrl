import type { JobDetail } from "@jobhunter/contracts";

import { scoreTier } from "../../contexts/scoring/lib/score-tier.js";

export interface JobOverviewProps {
  detail: JobDetail;
}

export function JobOverview({ detail }: JobOverviewProps) {
  const { job } = detail;
  return (
    <div className="drawer-head">
      <span className={`fit ${scoreTier(job.fitScore)}`}>{job.fitScore ?? "-"}</span>
      <span>
        <small>
          {job.company}
          {job.source && job.source !== job.company ? ` · source: ${job.source}` : ""}
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
