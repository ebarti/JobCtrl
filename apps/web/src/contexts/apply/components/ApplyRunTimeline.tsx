import type { StatusTagTone } from "../../../shared/ui/status-tokens.js";
import {
  useApplicationActionRun,
  useApplicationQuery,
} from "../readQueries.js";

export interface ApplyRunTimelineProps {
  readonly runId: string;
  readonly jobId?: string;
  readonly events?: readonly unknown[];
  readonly applyEvents?: readonly unknown[];
}

export function applyRunEventLevelTone(level: string): StatusTagTone {
  return level === "error"
    ? "danger"
    : level === "warn" || level === "warning"
      ? "warn"
      : level === "debug"
        ? "muted"
        : "info";
}

function resultJobId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  if ("jobId" in result && typeof result.jobId === "string")
    return result.jobId;
  for (const field of ["run", "rehearsal"] as const) {
    const value = (result as Record<string, unknown>)[field];
    if (
      value &&
      typeof value === "object" &&
      "jobId" in value &&
      typeof value.jobId === "string"
    )
      return value.jobId;
  }
  return null;
}

export function ApplyRunTimeline({ runId, jobId }: ApplyRunTimelineProps) {
  const action = useApplicationActionRun(runId);
  const application = useApplicationQuery(jobId ?? "");
  const knownRun =
    !jobId ||
    application.data?.runs.some((run) => run.runId === runId) ||
    application.data?.rehearsals.some((run) => run.runId === runId) ||
    resultJobId(action.data?.result) === jobId;
  const foreignJob =
    jobId &&
    resultJobId(action.data?.result) &&
    resultJobId(action.data?.result) !== jobId;
  const terminal =
    action.data &&
    ["succeeded", "failed", "cancelled"].includes(action.data.status);
  return (
    <section
      className="apply-run-timeline grid gap-3"
      aria-label="Application action history"
      data-run-id={runId}
    >
      {action.isPending ? (
        <p role="status">Loading application action…</p>
      ) : null}
      {action.error ? (
        <p role="alert">
          The application action could not be refreshed. Retained application
          evidence remains available.
        </p>
      ) : null}
      {jobId && (!knownRun || foreignJob) && action.data ? (
        <p role={terminal || foreignJob ? "alert" : "status"}>
          {terminal || foreignJob
            ? "This action has no recorded authority binding it to this job. Open the operation from Runs to inspect its own identity."
            : "Waiting for a saved application record that binds this exact action to this job."}
        </p>
      ) : null}
      {action.data && knownRun && !foreignJob ? (
        <>
          <p>
            {action.data.action} · <strong>{action.data.status}</strong>
          </p>
          <p>
            Run {action.data.runId} · workflow {action.data.workflowId}
          </p>
          {action.data.temporalRunId ? (
            <p>Temporal run {action.data.temporalRunId}</p>
          ) : null}
          <ol aria-label="Application run timeline">
            <li>
              Accepted:{" "}
              <time dateTime={action.data.createdAt}>
                {action.data.createdAt}
              </time>
            </li>
            <li>
              Last update:{" "}
              <time dateTime={action.data.updatedAt}>
                {action.data.updatedAt}
              </time>
            </li>
            {action.data.cancellationRequested ? (
              <li>
                Cancellation requested; the final status remains authoritative.
              </li>
            ) : null}
          </ol>
          {action.data.errorCode ? (
            <p role="alert">Action failure: {action.data.errorCode}</p>
          ) : null}
          {action.data.result ? (
            <details>
              <summary>Recorded application result</summary>
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(action.data.result, null, 2)}
              </pre>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
