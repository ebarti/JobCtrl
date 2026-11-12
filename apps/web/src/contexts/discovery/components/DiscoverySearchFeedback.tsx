import { Button } from "../../../shared/ui/button.js";
import { Progress } from "../../../shared/ui/progress.js";
import type { DiscoverySearchController } from "../hooks/useDiscoverySearchController.js";

import "./discovery-search-feedback.css";

const STATUS_LABELS: Readonly<Record<string, string>> = {
  queueing: "Queueing search…", pending: "Search pending", queued: "Search queued", running: "Searching for jobs",
  start_failed: "Search could not be queued", completed: "Search completed", partial: "Search completed · some sources unavailable",
  failed: "Search failed", "cancel-requested": "Stop requested", cancelled: "Search cancelled",
  "status-unavailable": "Search status unavailable", checking: "Checking search status…", unconfirmed: "Search request needs confirmation",
};

const BOARD_LABELS: Readonly<Record<string, string>> = { indeed: "Indeed", linkedin: "LinkedIn", glassdoor: "Glassdoor", zip_recruiter: "ZipRecruiter", google: "Google Jobs", bayt: "Bayt", bdjobs: "Bdjobs", naukri: "Naukri" };
function sourceLabel(failure: DiscoverySearchController["sourceFailures"][number]) {
  return failure.boards?.map((board) => BOARD_LABELS[board] ?? "Job board").join(", ") ?? "Employer source";
}

/** Shared factual feedback for the Jobs header and the independent run panel. */
export function DiscoverySearchFeedback({ controller }: { readonly controller: DiscoverySearchController }) {
  const { status, action, recovery, counts } = controller;
  const active = ["queueing", "pending", "queued", "running", "cancel-requested"].includes(status);
  const needsReconciliation = Boolean(recovery.record && (["unconfirmed", "status-unavailable", "start_failed"].includes(status) || controller.hasUnconfirmedRequest));
  const label = STATUS_LABELS[status] ?? (controller.blockedReason ? "Search needs attention" : "Ready to search");
  return <section className="discovery-search-feedback" aria-label="Job search progress" data-search-state={status}>
    <div className="discovery-search-status" aria-live="polite" aria-atomic="true">
      <div className="discovery-search-status-row" role="status"><h2>{label}</h2>{counts ? <p className="discovery-search-counts">{controller.countsStale ? <span>Last recorded:</span> : null}<span>{counts.newJobs} new jobs</span><span>{counts.observedJobs} observed</span></p> : null}</div>
      {active ? <Progress value={null} aria-label="Job search progress" className="discovery-search-progress" /> : null}
    </div>
    {status === "idle" && !controller.blockedReason ? <p>Uses your saved Search preferences. Saving preferences does not start a search.</p> : null}
    {status === "partial" ? <p>Some sources did not finish. Jobs already saved by the search remain available.</p> : null}
    {controller.sourceFailures.length > 0 ? <ul aria-label="Search source failures">{controller.sourceFailures.map((failure, index) => <li key={`${failure.sourceId ?? failure.boards?.join(",") ?? "source"}:${index}`}><strong>{sourceLabel(failure)}</strong>: {failure.message ?? failure.code}</li>)}</ul> : null}
    {status === "failed" ? <p>The search did not complete. Any jobs already saved remain available.</p> : null}
    {status === "cancel-requested" ? <p>The stop request was received. The search remains active until it settles.</p> : null}
    {status === "status-unavailable" ? <p role="alert">Current search status could not be checked. Any counts shown are the last recorded values; another search remains blocked.</p> : null}
    {controller.historyError && !controller.statusUnavailable ? <p role="alert">Search history could not be refreshed.{counts ? " The last recorded counts remain visible." : " Job counts are unavailable."}</p> : null}
    {!active && controller.blockedReason && status !== "status-unavailable" ? <p>{controller.blockedReason}</p> : null}
    {needsReconciliation ? <div className="discovery-search-recovery" role="alert"><p>The earlier request keeps its original identity. Check that request before starting another search.</p><Button type="button" size="sm" variant="outline" disabled={recovery.checking} onClick={() => { void controller.checkPrevious(); }}>Check previous search</Button></div> : null}
    {!recovery.ready && recovery.error ? <p role="alert">Session recovery storage is unavailable or invalid. Restore it before starting a search.</p> : null}
    {controller.startError ? <p role="alert">Search could not be confirmed: {controller.startError.message}</p> : null}
    {controller.startMessage ? <p role="status">{controller.startMessage}</p> : null}
    <div className="discovery-search-actions">
      {controller.canStop ? <Button type="button" size="sm" variant="outline" disabled={controller.isStopping} onClick={() => controller.requestStop()}>{controller.isStopping ? "Requesting stop…" : "Request stop"}</Button> : null}
      {controller.statusUnavailable || controller.historyError ? <Button type="button" size="sm" variant="outline" onClick={controller.refresh}>Check search status</Button> : null}
      {action ? <details className="discovery-search-details"><summary>Search details</summary><p>Run {action.runId}{action.errorCode ? ` · ${action.errorCode}` : ""}</p></details> : null}
    </div>
    {controller.stopError ? <p role="alert">Could not confirm stop: {controller.stopError.message}. Check search status before retrying.</p> : null}
  </section>;
}
