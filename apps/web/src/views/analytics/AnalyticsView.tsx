import { useNavigate, useSearch } from "@tanstack/react-router";

import { useOutcomeAnalyticsQuery } from "../../contexts/operations/hooks/useOutcomeAnalyticsQuery.js";
import {
  ANALYTICS_DIMENSIONS,
  type AnalyticsDimension,
  type AnalyticsSearch,
} from "../../routes/-analytics.search.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { DimensionBreakdownPanel } from "./DimensionBreakdownPanel.js";
import { SmallSampleNotice } from "./SmallSampleNotice.js";

const DIMENSION_OPTIONS: ReadonlyArray<{
  readonly value: AnalyticsDimension;
  readonly label: string;
}> = [
  { value: "source", label: "Source" },
  { value: "score_band", label: "Score band" },
  { value: "fit_band", label: "Fit band" },
  { value: "apply_mode", label: "Apply mode" },
  { value: "template", label: "Template" },
  { value: "policy", label: "Policy" },
];

function isAnalyticsDimension(value: string): value is AnalyticsDimension {
  return (ANALYTICS_DIMENSIONS as readonly string[]).includes(value);
}

function formatDuration(minutes: number | null | undefined, n: number, minSample: number | undefined): string {
  if (n === 0) return "No rows";
  if (minutes === null || minutes === undefined) return minSample === undefined ? `${n} rows` : `${n}/${minSample} rows`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

function formatAcceptance(rate: number | null | undefined, n: number, minSample: number | undefined): string {
  if (n === 0) return "No reviews";
  if (rate === null || rate === undefined) return minSample === undefined ? `${n} reviews` : `${n}/${minSample} reviews`;
  return `${Math.round(rate * 100)}%`;
}

export function AnalyticsView() {
  const search = useSearch({ from: "/analytics" });
  const navigate = useNavigate({ from: "/analytics" });
  const dimension = search.dimension;
  const analyticsQuery = useOutcomeAnalyticsQuery({ dimension });
  const analytics = analyticsQuery.data ?? null;
  const message = analyticsQuery.error instanceof Error ? analyticsQuery.error.message : null;
  const applied = analytics?.totals.applied ?? 0;
  const activeDimensionLabel =
    DIMENSION_OPTIONS.find((option) => option.value === dimension)?.label ?? "Dimension";

  const setDimension = (next: AnalyticsDimension) => {
    void navigate({ search: (prev: AnalyticsSearch) => ({ ...prev, dimension: next }) });
  };

  return (
    <>
      <PageHead
        eyebrow="Overview"
        title="Outcome analytics"
        subtitle={analytics ? `${applied} applied` : "loading"}
      />
      <section className="card full analytics-view data-list-card" aria-label="Outcome analytics workspace">
        {message ? <div className="banner inline">{message}</div> : null}
        <div className="analytics-controls">
          <div className="analytics-controls-copy">
            <span>Breakdown</span>
            <strong>{activeDimensionLabel}</strong>
          </div>
          <div className="analytics-toolbar" role="group" aria-label="Outcome analytics dimension">
            {DIMENSION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={option.value === dimension ? "segmented active" : "segmented"}
                aria-pressed={option.value === dimension}
                onClick={() => setDimension(option.value)}
              >
                {option.label}
              </button>
            ))}
            <label className="analytics-select-label">
              <span>Dimension</span>
              <select
                className="select"
                value={dimension}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isAnalyticsDimension(next)) setDimension(next);
                }}
              >
                {DIMENSION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <dl className="analytics-summary-strip" aria-label="Outcome summary">
          <div className="analytics-summary-metric analytics-summary-metric-primary">
            <dt>Applied</dt>
            <dd>{analytics?.totals.applied ?? "-"}</dd>
          </div>
          <div className="analytics-summary-metric analytics-summary-metric-primary">
            <dt>Replies</dt>
            <dd>{analytics?.totals.reply ?? "-"}</dd>
          </div>
          <div className="analytics-summary-metric analytics-summary-metric-primary">
            <dt>Interviews</dt>
            <dd>{analytics?.totals.interview ?? "-"}</dd>
          </div>
          <div className="analytics-summary-metric analytics-summary-metric-primary">
            <dt>Offers</dt>
            <dd>{analytics?.totals.offer ?? "-"}</dd>
          </div>
          <div className="analytics-summary-metric analytics-summary-metric-secondary">
            <dt>Median response</dt>
            <dd>
              {analytics
                ? formatDuration(
                    analytics.timeToResponse.medianMinutes,
                    analytics.timeToResponse.n,
                    analytics.minSample,
                  )
                : "-"}
            </dd>
          </div>
          <div className="analytics-summary-metric analytics-summary-metric-secondary">
            <dt>Suggestions accepted</dt>
            <dd>
              {analytics
                ? formatAcceptance(
                    analytics.suggestionAccuracy.acceptanceRate,
                    analytics.suggestionAccuracy.n,
                    analytics.minSample,
                  )
                : "-"}
            </dd>
          </div>
        </dl>
        <SmallSampleNotice {...(analytics ? { minSample: analytics.minSample } : {})} />
        <DimensionBreakdownPanel
          analytics={analytics}
          dimension={dimension}
          loading={analyticsQuery.isFetching}
        />
      </section>
    </>
  );
}
