import { prefetchOutcomeAnalytics } from "../contexts/operations/readQueries.js";
import { createFileRoute } from "@tanstack/react-router";

import { AnalyticsView } from "../views/analytics/AnalyticsView.js";
import { analyticsSearchSchema } from "./-analytics.search.js";

export const Route = createFileRoute("/analytics")({
  validateSearch: (search) => analyticsSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ context, deps }) => prefetchOutcomeAnalytics(context, deps.search),
  component: AnalyticsView,
});
