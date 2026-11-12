import type { ReactNode } from "react";

import { Button } from "../../../shared/ui/button.js";
import { Progress } from "../../../shared/ui/progress.js";
import type { DiscoverySearchController } from "../hooks/useDiscoverySearchController.js";
import { useDiscoverySearchFeedback } from "../hooks/useDiscoverySearchFeedback.js";

import "./discovery-search-feedback.css";

export interface DiscoveryAssessmentProgress {
  phase: "acquiring" | "assessing" | null;
  assessedJobs: number | null; failedJobs: number | null; totalJobs: number | null;
  failures: readonly { jobId: string; stage: string; code: string | null }[];
  unavailable: boolean;
}
export type DiscoverySearchFeedbackRenderer = (controller: DiscoverySearchController, render: (progress?: DiscoveryAssessmentProgress) => ReactNode) => ReactNode;

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

function groupSourceFailures(failures: DiscoverySearchController["sourceFailures"]) {
  const groups = new Map<string, { key: string; failure: typeof failures[number]; failures: typeof failures }>();
  for (const failure of failures) {
    // Group recorded identities and exact messages, never inferred prose meaning.
    const key = JSON.stringify([failure.sourceFamily ?? null, failure.boards ? [...failure.boards].sort() : null, failure.sourceId ?? null, failure.code, failure.message ?? null]);
    const group = groups.get(key);
    if (group) group.failures.push(failure);
    else groups.set(key, { key, failure, failures: [failure] });
  }
  return [...groups.values()];
}

/** Shared factual feedback for the Jobs header and the independent run panel. */
export function DiscoverySearchFeedback({ controller, spendingAction, assessmentProgress }: { readonly controller: DiscoverySearchController; readonly spendingAction?: ReactNode; readonly assessmentProgress?: DiscoveryAssessmentProgress | undefined }) {
  const { status, action, recovery, counts } = controller;
  const feedback = useDiscoverySearchFeedback(controller);
  const active = ["queueing", "pending", "queued", "running", "cancel-requested"].includes(status);
  const needsReconciliation = Boolean(recovery.record && (["unconfirmed", "status-unavailable", "start_failed"].includes(status) || controller.hasUnconfirmedRequest));
  const accountingFailure = status === "failed" && action?.errorCode === "cost_accounting_unavailable";
  const assessedJobs = controller.assessment?.assessedJobs ?? assessmentProgress?.assessedJobs ?? null;
  const failedJobs = controller.assessment?.failedJobs ?? assessmentProgress?.failedJobs ?? null;
  const assessmentFailures = controller.assessment?.failures ?? assessmentProgress?.failures ?? [];
  const label = accountingFailure ? "Search stopped for missing cost tracking"
    : active && assessmentProgress?.phase === "assessing" ? "Assessing saved jobs"
    : status === "partial" && failedJobs !== null && failedJobs > 0 ? controller.sourceFailures.length ? "Search completed · source and fit assessment issues" : "Search completed · some fit assessments unavailable"
    : status === "partial" && !controller.sourceFailures.length ? "Search completed with issues"
    : STATUS_LABELS[status] ?? (controller.blockedReason ? "Search needs attention" : "Ready to search");
  const sourceFailureGroups = groupSourceFailures(controller.sourceFailures);
  const displayedFailures = feedback.terminal ? sourceFailureGroups.filter(({ failure }) => feedback.sourceState(failure) === "enabled") : sourceFailureGroups;
  const disabledFailures = feedback.terminal && sourceFailureGroups.some(({ failure }) => feedback.sourceState(failure) === "disabled");
  const unknownSources = feedback.terminal && sourceFailureGroups.some(({ failure }) => feedback.sourceState(failure) === "unknown");
  const sourceOnly = feedback.terminal && controller.assessmentAvailable === false;
  return <section className="discovery-search-feedback" aria-label="Job search progress" data-search-state={status}>
    {feedback.terminal ? <p>{feedback.dismissed ? "Last search result dismissed." : "Last search result"}</p> : null}
    {!feedback.dismissed && !feedback.loading ? <>
    <div className="discovery-search-status" aria-live="polite" aria-atomic="true">
      <div className="discovery-search-status-row" role="status"><h2>{label}</h2>{counts ? <p className="discovery-search-counts">{controller.countsStale ? <span>Last recorded:</span> : null}<span>{counts.newJobs} new jobs</span><span>{counts.observedJobs} observed</span></p> : null}</div>
      {active ? <Progress value={null} aria-label="Job search progress" className="discovery-search-progress" /> : null}
    </div>
    {assessedJobs !== null ? <p>{assessmentProgress?.unavailable && !controller.assessment ? "Last recorded: " : ""}{assessmentProgress?.totalJobs != null ? `${assessedJobs} of ${assessmentProgress.totalJobs} jobs assessed` : `${assessedJobs} jobs assessed`}{failedJobs !== null ? ` · ${failedJobs} failed` : ""}</p> : null}
    {sourceOnly ? <p>Initial fit assessment is unavailable in this application.</p> : null}
    {assessmentProgress?.unavailable && !controller.assessment ? <p role="alert">Fit assessment progress could not be checked. Recorded search status remains visible.</p> : null}
    {status === "idle" && !controller.blockedReason ? <p>Uses your saved Search preferences. Saving preferences does not start a search.</p> : null}
    {status === "partial" ? <p>{controller.sourceFailures.length ? "Some sources did not finish." : failedJobs !== null && failedJobs > 0 ? "Some fit assessments did not finish." : "Some search work did not finish."} Jobs already saved by the search remain available.</p> : null}
    {displayedFailures.length > 0 ? <ul aria-label="Search source failures">{displayedFailures.map(({ key, failure, failures }) => {
      const unitCount = failures.every((item) => item.unitId) ? new Set(failures.map((item) => item.unitId)).size : null;
      return <li key={key}><strong>{sourceLabel(failure)}</strong>: {failure.message ?? failure.code}<span> · {unitCount === null ? `${failures.length} recorded ${failures.length === 1 ? "failure" : "failures"}` : `${unitCount} ${unitCount === 1 ? "query/location combination" : "query/location combinations"} affected`}</span></li>;
    })}</ul> : null}
    {disabledFailures ? <p>Recorded failures from sources no longer enabled are retained in Search details.</p> : null}
    {unknownSources ? <p>Current source selection could not be verified. Recorded failures remain in Search details.</p> : null}
    {accountingFailure ? <div><p>Search query preparation stopped because the selected model had no configured monetary cost tracking. Job sources were not searched. Review the exact model pricing quote in Budgets, then start again. Your saved preferences and spending cap are unchanged.</p>{spendingAction}</div> : status === "failed" ? <p>The search did not complete. Any jobs already saved remain available.</p> : null}
    </> : null}
    {status === "cancel-requested" ? <p>The stop request was received. The search remains active until it settles.</p> : null}
    {status === "status-unavailable" ? <p role="alert">Current search status could not be checked. Any counts shown are the last recorded values; another search remains blocked.</p> : null}
    {controller.historyError && !controller.statusUnavailable ? <p role="alert">Search history could not be refreshed.{counts ? " The last recorded counts remain visible." : " Job counts are unavailable."}</p> : null}
    {!active && controller.blockedReason && status !== "status-unavailable" ? <p>{controller.blockedReason}</p> : null}
    {needsReconciliation ? <div className="discovery-search-recovery" role="alert"><p>The earlier request keeps its original identity. Check that request before starting another search.</p><Button type="button" size="sm" variant="outline" disabled={recovery.checking} onClick={() => { void controller.checkPrevious(); }}>Check previous search</Button></div> : null}
    {!recovery.ready && recovery.error ? <p role="alert">Session recovery storage is unavailable or invalid. Restore it before starting a search.</p> : null}
    {controller.startError ? <p role="alert">Search could not be confirmed: {controller.startError.message}</p> : null}
    {controller.startMessage ? <p role="status">{controller.startMessage}</p> : null}
    <div className="discovery-search-actions">
      {feedback.canDismiss ? <Button type="button" size="sm" variant="ghost" aria-label={feedback.dismissed ? "Show last search result" : "Dismiss last search result"} onClick={feedback.dismissed ? feedback.show : feedback.dismiss}>{feedback.dismissed ? "Show last search result" : "Dismiss result"}</Button> : null}
      {controller.canStop ? <Button type="button" size="sm" variant="outline" disabled={controller.isStopping} onClick={() => controller.requestStop()}>{controller.isStopping ? "Requesting stop…" : "Request stop"}</Button> : null}
      {controller.statusUnavailable || controller.historyError ? <Button type="button" size="sm" variant="outline" onClick={controller.refresh}>Check search status</Button> : null}
      {action || controller.sourceFailures.length ? <details className="discovery-search-details"><summary>Search details</summary>
        {action ? <p>Run {action.runId}{action.errorCode ? ` · ${action.errorCode}` : ""}</p> : null}
        {feedback.dismissed ? <p>{label}{counts ? ` · ${counts.newJobs} new jobs · ${counts.observedJobs} observed` : ""}</p> : null}
        {feedback.dismissed && assessedJobs !== null ? <p>{assessedJobs} jobs assessed{failedJobs !== null ? ` · ${failedJobs} failed` : ""}</p> : null}
        {feedback.dismissed && sourceOnly ? <p>Initial fit assessment is unavailable in this application.</p> : null}
        {controller.sourceFailures.length ? <ol aria-label="Recorded source failures">{controller.sourceFailures.map((failure, index) => <li key={`${failure.unitId ?? failure.sourceId ?? "source"}:${index}`}>
          {feedback.terminal ? <p>{feedback.sourceState(failure) === "disabled" ? "Currently not selected or disabled" : feedback.sourceState(failure) === "enabled" ? "Currently enabled" : "Current source selection unknown"}</p> : null}
          <p><strong>{sourceLabel(failure)}</strong>: {failure.message ?? failure.code}</p>
          <p>Code: {failure.code}{failure.boards ? ` · Boards: ${failure.boards.join(", ")}` : ""}{failure.sourceFamily ? ` · Family: ${failure.sourceFamily}` : ""}{failure.sourceId ? ` · Source: ${failure.sourceId}` : ""}{failure.unitId ? ` · Search unit: ${failure.unitId}` : ""}</p>
        </li>)}</ol> : null}
        {assessmentFailures.length ? <ol aria-label="Recorded fit assessment failures">{assessmentFailures.map((failure, index) => <li key={`${failure.jobId}:${failure.stage}:${index}`}><p>Job: {failure.jobId} · Stage: {failure.stage} · Code: {failure.code ?? "Not recorded"}</p></li>)}</ol> : null}
      </details> : null}
    </div>
    {feedback.error ? <p role="alert">{feedback.error}</p> : null}
    {controller.stopError ? <p role="alert">Could not confirm stop: {controller.stopError.message}. Check search status before retrying.</p> : null}
  </section>;
}
