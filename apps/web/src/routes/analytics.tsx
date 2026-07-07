import { createFileRoute } from "@tanstack/react-router";

import { analyticsKeys } from "../contexts/operations/analyticsKeys.js";
import { AnalyticsView } from "../views/analytics/AnalyticsView.js";
import { analyticsSearchSchema } from "./-analytics.search.js";

export const Route = createFileRoute("/analytics")({
  validateSearch: (search) => analyticsSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ deps, context }) =>
    context.queryClient.prefetchQuery({
      queryKey: analyticsKeys.outcomes(context.tenantId, deps.search),
      queryFn: () => context.ports.api.outcomeAnalytics(),
    }),
  component: AnalyticsView,
});
