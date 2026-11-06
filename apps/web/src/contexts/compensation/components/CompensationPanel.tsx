import { Empty } from "../../../shared/ui/empty.js";
import { Button } from "../../../shared/ui/button.js";
import { formatDateTime } from "../../../shared/lib/formatters.js";
import { useCompensationEvidenceQuery } from "../hooks/useCompensationEvidenceQuery.js";
import { CompensationAuditSection } from "./CompensationEvidence.js";

/** Independently composed Job Detail panel backed by Compensation's public read. */
export function CompensationPanel({ jobId }: { jobId: string }) {
  const query = useCompensationEvidenceQuery(jobId);
  const refresh = query.data?.refresh;
  const hasAccepted = query.data?.audit?.posted.recordStatus === "recorded" || query.data?.audit?.market.recordStatus === "recorded";
  const posted = query.data?.audit?.posted;
  const market = query.data?.audit?.market;
  return <>
    {query.error ? <div role="alert">{query.error.message}{query.data ? " Showing the last accepted evidence." : ""}{" "}<Button type="button" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Retry loading evidence</Button></div> : null}
    {refresh?.status === "running" ? <p role="status">Compensation refresh is running.</p> : null}
    {refresh?.status === "failed" ? <p role="alert">The last compensation refresh failed{refresh.failure_code ? ` (${refresh.failure_code})` : ""} at {formatDateTime(refresh.updated_at)}.{hasAccepted ? " Previously accepted evidence remains available." : ""}</p> : null}
    {posted?.sourceCurrent === false ? <p role="status">The recorded posting evidence refers to an earlier posting revision{posted.sourceRevision != null ? ` (${posted.sourceRevision})` : ""}. Refresh to assess the current posting.</p> : null}
    {market?.sourceCurrent === false ? <p role="status">The recorded market evidence refers to an earlier posting revision{market.sourceRevision != null ? ` (${market.sourceRevision})` : ""}. Refresh to assess the current posting.</p> : null}
    {market?.evidenceFresh === false ? <p role="status">The recorded market inputs have passed their refresh window{market.evidenceFreshUntil ? ` (${formatDateTime(market.evidenceFreshUntil)})` : ""}. The prior evidence remains available for review.</p> : null}
    {!query.data && !query.error ? <Empty title="Loading compensation evidence." /> : null}
    {query.data ? <CompensationAuditSection jobId={jobId} summary={query.data.summary} audit={query.data.audit} refreshing={refresh?.status === "running"} /> : null}
  </>;
}
