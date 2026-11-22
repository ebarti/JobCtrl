import { createFileRoute } from "@tanstack/react-router";

import { ActionRunsPage } from "../contexts/runs/index.js";

export const Route = createFileRoute("/runs/")({ component: RunsComposition });

function RunsComposition() {
  const search = Route.useSearch(); const navigate = Route.useNavigate();
  return <ActionRunsPage filters={{ status: search.status, action: search.workflowType, since: search.startedSince, until: search.startedBefore }}
    onFilterChange={(filters) => { void navigate({ search: (previous) => ({ ...previous,
      status: filters.status, workflowType: filters.action,
      startedSince: filters.since, startedBefore: filters.until, page: 1 }) }); }} />;
}
