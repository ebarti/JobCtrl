import type { OutcomeAnalyticsSummary } from "../../contexts/operations/types.js";
import type { AnalyticsDimension } from "../../routes/-analytics.search.js";
import { Empty } from "../../shared/ui/empty.js";
import { OutcomeRateTable, type OutcomeRateRow } from "./OutcomeRateTable.js";

const DIMENSION_LABELS: Record<AnalyticsDimension, string> = {
  source: "Source",
  score_band: "Score band",
  fit_band: "Fit band",
  apply_mode: "Apply mode",
  template: "Resume template",
  policy: "Tailoring policy",
};

const DIMENSION_TONES: Record<AnalyticsDimension, OutcomeRateRow["badgeTone"]> = {
  source: "info",
  score_band: "ok",
  fit_band: "warn",
  apply_mode: "muted",
  template: "info",
  policy: "muted",
};

function humanizeToken(value: string): string {
  return value.replaceAll("_", " ");
}

function baseRow(
  dimension: AnalyticsDimension,
  label: string,
  group: OutcomeAnalyticsSummary["totals"],
  minSample: number,
): OutcomeRateRow {
  return {
    id: `${dimension}:${label}`,
    dimension: DIMENSION_LABELS[dimension],
    label: humanizeToken(label),
    badgeTone: DIMENSION_TONES[dimension],
    applied: group.applied,
    reply: group.reply,
    interview: group.interview,
    offer: group.offer,
    rejection: group.rejection,
    replyRate: group.replyRate,
    interviewRate: group.interviewRate,
    offerRate: group.offerRate,
    rejectionRate: group.rejectionRate,
    minSample,
  };
}

export function outcomeRows(
  analytics: OutcomeAnalyticsSummary,
  dimension: AnalyticsDimension,
): OutcomeRateRow[] {
  const minSample = analytics.minSample;
  switch (dimension) {
    case "source":
      return analytics.bySource.map((group) => baseRow("source", group.source, group, minSample));
    case "score_band":
      return analytics.byScoreBand.map((group) => baseRow("score_band", group.scoreBand, group, minSample));
    case "fit_band":
      return analytics.byFitBand.map((group) => baseRow("fit_band", group.fitBand, group, minSample));
    case "apply_mode":
      return analytics.byApplyMode.map((group) => baseRow("apply_mode", group.applyMode, group, minSample));
    case "template":
      return analytics.byTemplate.map((group) =>
        baseRow("template", group.templateName ?? group.templateId, group, minSample),
      );
    case "policy":
      return analytics.byPolicy.map((group) => baseRow("policy", group.policyLabel, group, minSample));
  }
}

export interface DimensionBreakdownPanelProps {
  readonly analytics: OutcomeAnalyticsSummary | null;
  readonly dimension: AnalyticsDimension;
  readonly loading: boolean;
}

export function DimensionBreakdownPanel({
  analytics,
  dimension,
  loading,
}: DimensionBreakdownPanelProps) {
  const rows = analytics ? outcomeRows(analytics, dimension) : [];
  return rows.length || loading ? (
    <div className="analytics-breakdown-region">
      <OutcomeRateTable
        rows={rows}
        loading={loading}
        title={`Outcomes by ${DIMENSION_LABELS[dimension].toLowerCase()}`}
      />
    </div>
  ) : (
    <div className="analytics-breakdown-empty">
      <Empty title={`No ${DIMENSION_LABELS[dimension].toLowerCase()} outcome rows yet.`} />
    </div>
  );
}
