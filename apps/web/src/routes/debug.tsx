import { createFileRoute } from "@tanstack/react-router";

import { ActivityPage } from "../contexts/activity/index.js";
import { debugSearchSchema } from "./-debug.search.js";

export const Route = createFileRoute("/debug")({
  validateSearch: debugSearchSchema,
  component: ActivityComposition,
});

function ActivityComposition() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <ActivityPage filters={{ q: search.q, level: search.level, stage: search.stage, eventType: search.eventType,
    feature: search.feature, aggregateId: search.aggregateId, since: search.since, until: search.until }}
    onFilterChange={(filters) => { void navigate({ search: (previous) => ({ ...previous, ...filters, page: 1 }) }); }} />;
}
