import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import { RefreshAllCompensationButton } from "../contexts/compensation/index.js";
import { DigestAttentionPanel } from "../contexts/digest/index.js";
import { AffectedMatchesPanel } from "../contexts/fit/index.js";
import type { JobGridQuery } from "../contexts/jobs/index.js";
import { PipelineBulkActions } from "../contexts/pipeline/index.js";
import { useMountedFeatures } from "../contexts/runtime/index.js";
import { JobsView } from "../views/jobs/JobsView.js";
import { jobsSearchSchema, type JobsSearch } from "./-jobs.search.js";

function gridQuery(search: JobsSearch): JobGridQuery | null {
  if (search.grid !== "v1") {
    const explicit = search.q || search.stage !== "all" || search.state !== "all" || search.applyStatus !== "all" || search.deleted !== "active"
      || search.jobStates || search.minFitScore !== undefined || search.maxFitScore !== undefined || search.discoveredSince || search.scoredSince
      || search.page !== 1 || search.pageSize !== 50 || search.sort !== "discovered_at" || search.dir !== "desc";
    if (!explicit) return null;
    const columnFilters = { ...search.column_filters };
    for (const [field, value] of [["current_stage", search.stage], ["current_state", search.state], ["apply_status", search.applyStatus]]) {
      if (field && value && value !== "all") columnFilters[field] = { operator: "contains", text: "", selectedValues: [value] };
    }
    return { q: search.q, job_state: search.jobStates?.join(",") ?? search.deleted, sort: search.sort, direction: search.dir,
      offset: (search.page - 1) * search.pageSize, limit: search.pageSize, column_filters: columnFilters,
      ...(search.minFitScore !== undefined ? { min_fit_score: search.minFitScore } : {}), ...(search.maxFitScore !== undefined ? { max_fit_score: search.maxFitScore } : {}),
      ...(search.discoveredSince ? { discovered_since: search.discoveredSince } : {}), ...(search.scoredSince ? { scored_since: search.scoredSince } : {}) };
  }
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

/** The parent Jobs route retains this list while its selected job changes. */
export function JobsWorkspace({ activeJobId, activeRunId = null }: { readonly activeJobId: string | null; readonly activeRunId?: string | null }) {
  const features = useMountedFeatures();
  const search = useSearch({ from: "/jobs" });
  const navigate = useNavigate({ from: "/jobs" });
  const navigateGrid = useCallback((query: JobGridQuery): string | null => {
    const parsed = jobsSearchSchema.safeParse({ ...search, stage: "all", state: "all", applyStatus: "all", deleted: "active", jobStates: undefined,
      minFitScore: undefined, maxFitScore: undefined, discoveredSince: undefined, scoredSince: undefined,
      fit_state: undefined, min_fit_score: undefined, max_fit_score: undefined, discovered_since: undefined, scored_since: undefined,
      posted_min_eur: undefined, posted_max_eur: undefined, market_min_eur: undefined, market_max_eur: undefined,
      posted_known: undefined, market_known: undefined, compensation_confidence: undefined, compensation_warnings: undefined,
      column_filters: undefined, query_revision: undefined, ...query, grid: "v1" });
    if (!parsed.success) return parsed.error.issues[0]?.message ?? "The Jobs view is too large or invalid.";
    // A parent-relative destination would close a directly opened job or run.
    // Keep its exact typed identity while replacing only the grid search.
    if (activeJobId && activeRunId) {
      void navigate({ to: "/jobs/$jobId/run/$runId", params: { jobId: activeJobId, runId: activeRunId }, search: () => parsed.data, replace: true });
    } else if (activeJobId) {
      void navigate({ to: "/jobs/$jobId", params: { jobId: activeJobId }, search: () => parsed.data, replace: true });
    } else {
      void navigate({ to: "/jobs", search: () => parsed.data, replace: true });
    }
    return null;
  }, [navigate, search, activeJobId, activeRunId]);
  return <JobsView showHeading={false} activeJobId={activeJobId} navigation={gridQuery(search)} normalizeNavigation={search.grid !== "v1"} onNavigationChange={navigateGrid}
    attention={features.has("digest") ? <DigestAttentionPanel /> : null}
    optionalGlobalActions={features.has("compensation") ? <RefreshAllCompensationButton /> : null}
    optionalBulkActions={(jobIds) => <>
      {features.has("fit") ? <details><summary>Update affected matches for selected jobs</summary><AffectedMatchesPanel jobIds={jobIds} /></details> : null}
      {features.has("preparation") ? <details><summary>Selected jobs preparation tools</summary><PipelineBulkActions jobIds={jobIds} /></details> : null}
    </>} />;
}
