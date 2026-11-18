import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";

import { buttonVariants } from "../shared/ui/button.js";
import { JobsSearchHeader } from "../views/search-preferences/JobsSearchHeader.js";

import { jobsSearchSchema } from "./-jobs.search.js";
import { JobsWorkspace } from "./-jobs.workspace.js";

function JobsRoute() {
  const activeJobId = useRouterState({ select: (state) => state.matches.find((match) => match.routeId === "/jobs/$jobId")?.params.jobId ?? null });
  const activeRunId = useRouterState({ select: (state) => state.matches.find((match) => match.routeId === "/jobs/$jobId/run/$runId")?.params.runId ?? null });
  const search = Route.useSearch();
  const focused = Boolean(activeJobId && search.jobTab === "resume");
  return <div className="route-page jobs-route">
    <JobsSearchHeader
      preferencesAction={<Link className={buttonVariants({ variant: "outline" })} to="/discovery" search={(previous) => ({ ...previous, returnTo: "jobs", jobsReturn: search })}>Search preferences</Link>}
      spendingAction={<Link className={buttonVariants({ variant: "outline", size: "sm" })} to="/settings/budgets" search={{ returnTo: "jobs", returnJobs: search }}>Review spending setup</Link>}
      connectionAction={<Link className={buttonVariants({ variant: "outline", size: "sm" })} to="/settings" search={{ returnTo: "jobs", returnJobs: search }}>Review connections</Link>} />
    <div className={`jobs-daily-workspace${activeJobId ? " jobs-daily-workspace--selected" : ""}${focused ? " jobs-daily-workspace--document" : ""}`}>
      <section className="jobs-grid-pane" aria-label="Saved jobs workspace" hidden={focused}><JobsWorkspace activeJobId={activeJobId} activeRunId={activeRunId} /></section>
      <Outlet />
    </div>
  </div>;
}

export const Route = createFileRoute("/jobs")({
  validateSearch: (search) => jobsSearchSchema.parse(search),
  // JobsView owns fetching because the effective query also includes grid and
  // saved-view stage selections, which are not represented by scalar URL links.
  component: JobsRoute,
});
