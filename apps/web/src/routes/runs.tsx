import { prefetchWorkflowRunsList } from "../contexts/operations/readQueries.js";
import { createFileRoute, Outlet } from "@tanstack/react-router";

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
  loader: ({ context, deps }) =>
    prefetchWorkflowRunsList(context, workflowRunsInput(deps.search)),
  component: Outlet,
});
