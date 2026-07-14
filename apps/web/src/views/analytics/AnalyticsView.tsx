import { useNavigate, useSearch } from "@tanstack/react-router";

import { useOutcomeAnalyticsQuery } from "../../contexts/operations/hooks/useOutcomeAnalyticsQuery.js";
import {
  ANALYTICS_DIMENSIONS,
  type AnalyticsDimension,
  type AnalyticsSearch,
} from "../../routes/-analytics.search.js";
import { PageHead } from "../../shared/ui/page-head.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/select.js";
import { ToggleGroup, ToggleGroupItem } from "../../shared/ui/toggle-group.js";
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
    <div className="route-page route-page--analytics">
      <PageHead
        eyebrow="Overview"
        title="Outcome analytics"
        subtitle={
          analytics
            ? `${applied} applied · descriptive associations from recorded outcomes`
            : "Loading recorded outcomes"
        }
      />
      <section className="card full analytics-view">
        {message ? <div className="banner inline">{message}</div> : null}
        <div className="analytics-toolbar" role="group" aria-label="Outcome analytics dimension">
          <ToggleGroup
            type="single"
            value={dimension}
            className="analytics-dimension-control"
            aria-label="Outcome analytics dimension"
            onValueChange={(value) => {
              if (isAnalyticsDimension(value)) setDimension(value);
            }}
          >
            {DIMENSION_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <label className="analytics-select-label">
            <span>Dimension</span>
            <Select
              value={dimension}
              onValueChange={(value) => {
                if (isAnalyticsDimension(value)) setDimension(value);
              }}
            >
              <SelectTrigger aria-label="Outcome analytics dimension">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIMENSION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
    </div>
  );
}
