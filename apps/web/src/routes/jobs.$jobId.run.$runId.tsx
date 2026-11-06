import { createFileRoute, Link } from "@tanstack/react-router";

import {
  ApplyRunTimeline,
  prefetchApplicationRun,
} from "../contexts/apply/index.js";
import { buttonVariants } from "../shared/ui/button.js";

export const Route = createFileRoute("/jobs/$jobId/run/$runId")({
  loader: ({ context, params }) =>
    prefetchApplicationRun(context, params.jobId, params.runId),
  component: JobRunTimelineRoute,
});

function JobRunTimelineRoute() {
  const { jobId, runId } = Route.useParams();
  return <JobRunTimelineWorkspace jobId={jobId} runId={runId} />;
}

export interface JobRunTimelineWorkspaceProps {
  readonly jobId: string;
  readonly runId: string;
}
export function JobRunTimelineWorkspace({
  jobId,
  runId,
}: JobRunTimelineWorkspaceProps) {
  return (
    <main
      className="route-page route-page--job-run-detail grid gap-6"
      aria-label="Application run details"
    >
      <header className="page-header">
        <Link
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          to="/jobs/$jobId"
          params={{ jobId }}
        >
          Back to job details
        </Link>
        <h1>Application run timeline</h1>
        <p className="mono break-all">{runId}</p>
        <Link to="/apply-review" search={{ jobKey: jobId }}>
          Open application review
        </Link>
      </header>
      <ApplyRunTimeline jobId={jobId} runId={runId} />
      <p>
        A cancellation request does not establish an external outcome. Review
        the saved application intent, receipt and actual outcome before
        considering another action.
      </p>
    </main>
  );
}
