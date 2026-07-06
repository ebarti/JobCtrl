import { useNavigate, useSearch } from "@tanstack/react-router";

import { useOutcomeAnalyticsQuery } from "../../contexts/operations/hooks/useOutcomeAnalyticsQuery.js";
import {
  ANALYTICS_DIMENSIONS,
  type AnalyticsDimension,
  type AnalyticsSearch,
} from "../../routes/-analytics.search.js";
import { CardHeader } from "../../shared/ui/card-header.js";
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

  const setDimension = (next: AnalyticsDimension) => {
    void navigate({ search: (prev: AnalyticsSearch) => ({ ...prev, dimension: next }) });
  };

  return (
    <section className="card full analytics-view">
      <CardHeader
        title="Outcome analytics"
        meta={analytics ? `${applied} applied` : "loading"}
      />
      {message ? <div className="banner inline">{message}</div> : null}
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
      <div className="analytics-summary-strip">
        <div>
          <span>Applied</span>
          <b>{analytics?.totals.applied ?? "-"}</b>
        </div>
        <div>
          <span>Replies</span>
          <b>{analytics?.totals.reply ?? "-"}</b>
        </div>
        <div>
          <span>Interviews</span>
          <b>{analytics?.totals.interview ?? "-"}</b>
        </div>
        <div>
          <span>Offers</span>
          <b>{analytics?.totals.offer ?? "-"}</b>
        </div>
        <div>
          <span>Median response</span>
          <b>
            {analytics
              ? formatDuration(
                  analytics.timeToResponse.medianMinutes,
                  analytics.timeToResponse.n,
                  analytics.minSample,
                )
              : "-"}
          </b>
        </div>
        <div>
          <span>Suggestions accepted</span>
          <b>
            {analytics
              ? formatAcceptance(
                  analytics.suggestionAccuracy.acceptanceRate,
                  analytics.suggestionAccuracy.n,
                  analytics.minSample,
                )
              : "-"}
          </b>
        </div>
      </div>
      <SmallSampleNotice {...(analytics ? { minSample: analytics.minSample } : {})} />
      <DimensionBreakdownPanel
        analytics={analytics}
        dimension={dimension}
        loading={analyticsQuery.isFetching}
      />
    </section>
  );
}
