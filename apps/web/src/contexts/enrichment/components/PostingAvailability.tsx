import type { PostingAvailability as Availability } from "../../operations/types.js";

import { Button } from "../../../shared/ui/button.js";
import { useCheckAvailabilityMutation } from "../hooks/useCheckAvailabilityMutation.js";

const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "Never";

export function PostingAvailability({ jobId, postingUrl, availability }: {
  readonly jobId: string; readonly postingUrl: string; readonly availability?: Availability | undefined;
}) {
  const check = useCheckAvailabilityMutation();
  const busy = check.isPending || availability?.checkInProgress;
  const requestResolved = (availability?.request && Date.parse(availability.request.requestedAt) >= check.submittedAt) ||
    (availability?.lastAttemptedAt && Date.parse(availability.lastAttemptedAt) >= check.submittedAt &&
      Date.parse(availability.lastAttemptedAt) <= Date.now());
  return <section aria-label="Posting availability" className="section">
    <h3>Posting availability</h3>
    <p role="status">
      {busy ? "Checking availability…" : availability?.verdict === "active" ? "Last check: active" :
        availability?.verdict && availability.verdict !== "unknown" ? `Last check: ${availability.verdict}` : "Availability unverified"}
      {availability?.overdue ? " · Check overdue" : ""}
    </p>
    <p className="muted">Last attempt: {time(availability?.lastAttemptedAt)}. Last successful verification: {time(availability?.lastSuccessfullyVerifiedAt)}{availability?.lastSuccessfulState ? ` (${availability.lastSuccessfulState})` : ""}.</p>
    {availability?.reason && availability.reason !== "not_yet_checked" ? <p>Latest evidence: {availability.reason.replaceAll("_", " ")}.</p> : null}
    <p className="muted">Checks run while your local worker is available. Sleep or offline time can leave evidence overdue. Saved descriptions and materials remain available after a failed check.</p>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => check.mutate(jobId)}>Check availability</Button>{" "}
    <a href={postingUrl} target="_blank" rel="noopener noreferrer">Inspect employer posting</a>
    {availability?.request ? <p role="status">Check deferred: {availability.request.reason.replaceAll("_", " ")}.
      {availability.request.retryAt ? ` Retry after ${time(availability.request.retryAt)}, or inspect the employer posting.` : " Inspect the employer posting."}</p> : null}
    {check.isSuccess && !requestResolved ? <p role="status">Check requested. Employer evidence will update when the worker finishes.</p> : null}
    {check.isError ? <p role="alert">Check could not start. {check.error.message} Retry when the local worker is available.</p> : null}
    <details><summary>Availability evidence</summary>
      <p>Method: {availability?.method ?? "unknown"}. Next due: {time(availability?.nextDueAt)}.</p>
      <p>Evidence: {availability?.evidenceRef ?? "None"}</p>
      {availability?.lineage.map((entry, index) => <div key={`${entry.rawHash}-${index}`}>
        <p>{entry.method}: {entry.status ?? "unknown status"} · {entry.finalUrl ?? entry.sourceUrl} · {entry.rawHash ? `SHA-256 ${entry.rawHash}` : "Response unavailable"}</p>
        {entry.signals?.map((signal, signalIndex) => <p key={signalIndex}>{signal.kind.replaceAll("_", " ")}: {String(signal.value)}{signal.past === undefined ? "" : signal.past ? " (expired)" : " (future)"}</p>)}
      </div>)}
    </details>
  </section>;
}
