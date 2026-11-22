import { ApplicationHistory } from "./ApplicationPanel.js";
import { useApplicationQuery } from "../readQueries.js";

export interface ApplyHistoryProps {
  readonly jobId: string;
}
export function ApplyHistory({ jobId }: ApplyHistoryProps) {
  const query = useApplicationQuery(jobId);
  return (
    <section aria-label="Application history">
      {query.isPending ? (
        <p role="status">Loading application history…</p>
      ) : null}
      {query.error ? (
        <p role="alert">
          Application history could not be refreshed. Retained evidence remains
          visible.
        </p>
      ) : null}
      {query.data ? <ApplicationHistory application={query.data} /> : null}
    </section>
  );
}
