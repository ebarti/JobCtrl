import { IconAlertTriangle } from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { useOutcomeAnalyticsQuery } from "../../contexts/operations/hooks/useOutcomeAnalyticsQuery.js";
import {
  ANALYTICS_DIMENSIONS,
  type AnalyticsDimension,
  type AnalyticsSearch,
} from "../../routes/-analytics.search.js";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.js";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../shared/ui/card.js";
import { PageHead } from "../../shared/ui/page-head.js";
import {
  Select,
  SelectContent,
  SelectGroup,
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
      <Card className="analytics-view data-list-card" aria-label="Outcome analytics workspace">
        <CardHeader className="analytics-controls">
          <CardTitle className="analytics-controls-copy">
            <span>Breakdown</span>
            <strong>{activeDimensionLabel}</strong>
          </CardTitle>
          <CardAction className="analytics-toolbar">
            <ToggleGroup
              className="analytics-dimension-toggle"
              type="single"
              value={dimension}
              aria-label="Outcome analytics dimension"
              onValueChange={(next) => {
                if (isAnalyticsDimension(next)) setDimension(next);
              }}
            >
              {DIMENSION_OPTIONS.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  aria-label={`Break down outcomes by ${option.label.toLowerCase()}`}
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Select
              items={[...DIMENSION_OPTIONS]}
              value={dimension}
              onValueChange={(next) => {
                if (isAnalyticsDimension(next)) setDimension(next);
              }}
            >
              <SelectTrigger className="analytics-dimension-select" aria-label="Outcome analytics dimension">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom">
                <SelectGroup>
                  {DIMENSION_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </CardAction>
        </CardHeader>
        <CardContent className="analytics-content">
          {message ? (
            <Alert variant="destructive" className="analytics-error">
              <IconAlertTriangle aria-hidden="true" />
              <AlertTitle>Outcome analytics could not be loaded</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
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
        </CardContent>
      </Card>
    </>
  );
}
