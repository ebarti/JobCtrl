import { prefetchActivityList } from "../contexts/operations/readQueries.js";
import { createFileRoute } from "@tanstack/react-router";

import { DebugView } from "../views/debug/DebugView.js";
import { debugSearchSchema, type DebugSearch } from "./-debug.search.js";

function activityInput(search: DebugSearch) {
  return {
    page: search.page,
    pageSize: search.pageSize,
    sort: search.sort,
    dir: search.dir,
    q: search.q,
    level: search.level,
    stage: search.stage,
    eventType: search.eventType,
  };
}

export const Route = createFileRoute("/debug")({
  validateSearch: debugSearchSchema,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ context, deps }) =>
    prefetchActivityList(context, activityInput(deps.search)),
  component: DebugView,
});
