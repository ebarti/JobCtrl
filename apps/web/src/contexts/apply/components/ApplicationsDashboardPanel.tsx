import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { useApplicationsSummaryQuery } from "../applicationSummary.js";

/** Application-owned summary, independent of other Dashboard feature reads. */
export function ApplicationsDashboardPanel() {
  const query = useApplicationsSummaryQuery();
  const summary = query.data;
  const queued = summary && summary.queueCountComplete && summary.queuedCount !== null ? summary.queuedCount : "Unavailable";
  return <section className="card col-span-full" aria-label="Application activity">
    <CardHeader title="Application activity" meta="Recorded application state" />
    {query.error ? <p role="alert">Application activity could not be loaded: {query.error.message}</p> : null}
    {query.isFetching && !summary ? <Empty title="Loading application activity." /> : null}
    {summary ? <>
      <dl className="detail-list">
        <div><dt>Awaiting rehearsal or approval</dt><dd>{summary.pendingApprovalCount}</dd></div>
        <div><dt>Queued</dt><dd>{queued}</dd></div>
        <div><dt>Running</dt><dd>{summary.runningCount}</dd></div>
        <div><dt>Needs verification</dt><dd>{summary.needsVerificationCount}</dd></div>
        <div><dt>Failed</dt><dd>{summary.failedCount}</dd></div>
        <div><dt>Recorded as applied</dt><dd>{summary.appliedCount}</dd></div>
        <div><dt>Follow-ups due</dt><dd>{summary.followUpsDueCount}</dd></div>
      </dl>
      {!summary.queueCountComplete ? <p role="status">The queued count is unavailable because the complete run history could not be read.</p> : null}
      <a href="/apply-review">Review applications</a>
      {summary.followUpJobIds.length ? <details>
        <summary>Applications with follow-ups due</summary>
        <ul>{summary.followUpJobIds.map((jobId) => <li key={jobId}><a href={`/jobs/${encodeURIComponent(jobId)}`}>{jobId}</a></li>)}</ul>
      </details> : null}
    </> : null}
  </section>;
}
