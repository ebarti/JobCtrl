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
];

function isAnalyticsDimension(value: string): value is AnalyticsDimension {
  return (ANALYTICS_DIMENSIONS as readonly string[]).includes(value);
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
