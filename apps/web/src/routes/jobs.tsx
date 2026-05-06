import { createFileRoute } from "@tanstack/react-router";

import { jobsKeys } from "../contexts/operations/jobsKeys.js";
import { JobsView } from "../views/jobs/JobsView.js";
import { jobsSearchSchema, type JobsSearch } from "./-jobs.search.js";

function jobsListInput(search: JobsSearch) {
  return {
    page: search.page,
    pageSize: search.pageSize,
    q: search.q,
    sort: search.sort,
    dir: search.dir,
    deleted: search.deleted,
    ...(search.stage !== "all" ? { stage: search.stage } : {}),
    ...(search.state !== "all" ? { state: search.state } : {}),
  };
}

export const Route = createFileRoute("/jobs")({
  validateSearch: (search) => jobsSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ deps, context }) => {
    const input = jobsListInput(deps.search);
    return context.queryClient.ensureQueryData({
      queryKey: jobsKeys.list(context.tenantId, input),
      queryFn: () => context.ports.api.jobs(input),
    });
  },
  component: JobsView,
});
