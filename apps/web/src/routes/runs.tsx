import { createFileRoute } from "@tanstack/react-router";

import { workflowRunsKeys } from "../contexts/operations/workflowRunsKeys.js";
import { RunsView } from "../views/runs/RunsView.js";
import { runsSearchSchema, type RunsSearch } from "./-runs.search.js";

function workflowRunsInput(search: RunsSearch) {
  return {
    page: search.page,
    pageSize: search.pageSize,
    status: search.status,
  };
}

export const Route = createFileRoute("/runs")({
  validateSearch: (search) => runsSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ deps, context }) => {
    const input = workflowRunsInput(deps.search);
    return context.queryClient.prefetchQuery({
      queryKey: workflowRunsKeys.list(context.tenantId, input),
      queryFn: () => context.ports.api.workflowRuns(input),
    });
  },
  component: RunsView,
});
