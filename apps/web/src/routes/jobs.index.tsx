import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";

import { RefreshAllCompensationButton } from "../contexts/compensation/index.js";
import type { JobGridQuery } from "../contexts/jobs/index.js";
import { PipelineBulkActions } from "../contexts/pipeline/index.js";
import { useMountedFeatures } from "../contexts/runtime/index.js";
import { JobsView } from "../views/jobs/JobsView.js";
import { jobsSearchSchema, type JobsSearch } from "./-jobs.search.js";

export const Route = createFileRoute("/jobs/")({ component: JobsComposition });

function gridQuery(search: JobsSearch): JobGridQuery | null {
  if (search.grid !== "v1") return null;
  return { q: search.q, job_state: search.job_state ?? "active", sort: search.sort, direction: search.direction ?? "desc",
    offset: search.offset ?? 0, limit: search.limit ?? 50,
    ...(search.fit_state ? { fit_state: search.fit_state } : {}),
    ...(search.min_fit_score !== undefined ? { min_fit_score: search.min_fit_score } : {}), ...(search.max_fit_score !== undefined ? { max_fit_score: search.max_fit_score } : {}),
    ...(search.discovered_since ? { discovered_since: search.discovered_since } : {}), ...(search.scored_since ? { scored_since: search.scored_since } : {}),
    ...(search.posted_min_eur !== undefined ? { posted_min_eur: search.posted_min_eur } : {}), ...(search.posted_max_eur !== undefined ? { posted_max_eur: search.posted_max_eur } : {}),
    ...(search.market_min_eur !== undefined ? { market_min_eur: search.market_min_eur } : {}), ...(search.market_max_eur !== undefined ? { market_max_eur: search.market_max_eur } : {}),
    ...(search.posted_known ? { posted_known: search.posted_known } : {}), ...(search.market_known ? { market_known: search.market_known } : {}),
    ...(search.compensation_confidence ? { compensation_confidence: search.compensation_confidence } : {}),
    ...(search.compensation_warnings ? { compensation_warnings: search.compensation_warnings } : {}),
    ...(search.column_filters ? { column_filters: search.column_filters } : {}), ...(search.query_revision ? { query_revision: search.query_revision } : {}) };
}
function JobsComposition() {
  const features = useMountedFeatures();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const navigateGrid = useCallback((query: JobGridQuery): string | null => {
    // Clear old URL fields explicitly; they are not a source of Python-grid state.
    const parsed = jobsSearchSchema.safeParse({ ...search, stage: "all", state: "all", applyStatus: "all", deleted: "active", jobStates: undefined,
      minFitScore: undefined, maxFitScore: undefined, discoveredSince: undefined, scoredSince: undefined,
      fit_state: undefined, min_fit_score: undefined, max_fit_score: undefined, discovered_since: undefined, scored_since: undefined,
      posted_min_eur: undefined, posted_max_eur: undefined, market_min_eur: undefined, market_max_eur: undefined,
      posted_known: undefined, market_known: undefined, compensation_confidence: undefined, compensation_warnings: undefined,
      column_filters: undefined, query_revision: undefined, ...query, grid: "v1" });
    if (!parsed.success) return parsed.error.issues[0]?.message ?? "The Jobs view is too large or invalid.";
    void navigate({ search: () => parsed.data, replace: true });
    return null;
  }, [navigate, search]);
  return <JobsView navigation={gridQuery(search)} onNavigationChange={navigateGrid}
    optionalGlobalActions={features.has("compensation") ? <RefreshAllCompensationButton /> : null}
    optionalBulkActions={(jobIds) => features.has("preparation") ? <PipelineBulkActions jobIds={jobIds} /> : null} />;
}
