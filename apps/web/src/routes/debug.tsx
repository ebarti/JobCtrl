import { createFileRoute } from "@tanstack/react-router";

import { activityKeys } from "../contexts/operations/activityKeys.js";
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
  loader: ({ deps, context }) => {
    const input = activityInput(deps.search);
    return context.queryClient.ensureQueryData({
      queryKey: activityKeys.list(context.tenantId, input),
      queryFn: () => context.ports.api.activity(input),
    });
  },
  component: DebugView,
});
