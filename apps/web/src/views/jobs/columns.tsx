import { type ChangeEvent, type MouseEvent, useRef } from "react";
import type { RowSelectionState } from "@tanstack/react-table";
import { STAGE_STATES } from "@jobctrl/contracts";

import { ApplyRunBadge } from "../../contexts/apply/components/ApplyRunBadge.js";
import { isApplyRunStatus } from "../../contexts/apply/lib/apply-run-status.js";
import { ResumeTemplateStatusBadge } from "../../contexts/materials/components/ResumeTemplateStatusBadge.js";
import { ScoreBadge } from "../../contexts/scoring/components/ScoreBadge.js";
import { ScoreStalenessBadge } from "../../contexts/scoring/components/ScoreStalenessBadge.js";
import { StageBadge } from "../../contexts/pipeline/components/StageBadge.js";
import { UserFacingStageBadge } from "../../contexts/pipeline/components/UserFacingStageBadge.js";
import type { JobSummary } from "../../contexts/operations/types.js";
import type {
  DataGridColumn,
  DataGridCellContext,
  DataGridHeaderContext,
} from "../../shared/ui/filterable-data-grid.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { TitleStack } from "../../shared/ui/title-stack.js";

interface JobColumnsOptions {
  rowSelection: RowSelectionState;
  onRowSelectionChange: (next: RowSelectionState) => void;
  selectionAnchorJobKey: string | null;
  onSelectionAnchorChange: (jobKey: string) => void;
}

const JOB_TABLE_STAGE_FILTERS = ["discover", "apply"] as const;

type CompensationSummary = NonNullable<JobSummary["compensationSummary"]>;
type MarketSummary = CompensationSummary["market"];
type CompensationRangeSummary = NonNullable<
  CompensationSummary["posted"]["range"]
>;

const EUR_PER_YEAR_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function MissingCompensationValue({ label }: { readonly label: string }) {
  return (
    <span className="job-compensation-dash" aria-label={label} title={label}>
      -
    </span>
  );
}

function confidenceLabel(band: MarketSummary["confidenceBand"]): string {
  return band === "none" ? "no confidence" : `${band} confidence`;
}

function confidenceDisplayLabel(band: MarketSummary["confidenceBand"]): string {
  if (band === "none") return "None";
  return band.charAt(0).toUpperCase() + band.slice(1);
}

function confidenceValueLabel(
  market: MarketSummary | null | undefined,
): string {
  if (!market || market.recordStatus === "not_requested")
    return "No confidence";
  const band = confidenceLabel(market.confidenceBand);
  if (!Number.isFinite(market.confidenceScore)) return band;
  return `${band}, ${Math.round(Number(market.confidenceScore) * 100)}%`;
}

function marketStateLabel(state: MarketSummary["estimateState"]): string {
  switch (state) {
    case "estimated_range":
      return "estimated";
    case "unsupported":
      return "unsupported";
    case "insufficient_evidence":
      return "insufficient";
    case "source_unavailable":
      return "unavailable";
    case "not_requested":
      return "not requested";
  }
}

function marketMissingLabel(state: MarketSummary["estimateState"]): string {
  switch (state) {
    case "unsupported":
      return "Market estimate unsupported";
    case "insufficient_evidence":
      return "Insufficient market evidence";
    case "source_unavailable":
      return "Market source unavailable";
    case "not_requested":
      return "Market estimate not requested";
    case "estimated_range":
      return "Market estimate recorded";
  }
}

function postedCompensationLabel(
  summary: CompensationSummary | null,
  fallbackSalary = "",
): string {
  const posted = summary?.posted;
  if (posted?.displayRange) return posted.displayRange;
  if (summary?.legacyRawSalary) return summary.legacyRawSalary;
  if (fallbackSalary) return fallbackSalary;
  if (posted?.parseState === "unparseable") return "Posted salary unparseable";
  if (posted?.parseState === "ambiguous") return "Posted salary ambiguous";
  return "No posted salary recorded";
}

function salaryAmountEur(
  summary: CompensationSummary | null,
  bound: "min" | "max",
): number | null {
  return compensationRangeAmountEur(summary?.posted.range, bound);
}

function salaryAmountSortValue(row: JobSummary, bound: "min" | "max"): number {
  return (
    salaryAmountEur(row.compensationSummary, bound) ?? Number.NEGATIVE_INFINITY
  );
}

function formatEurAmount(amount: number): string {
  return EUR_PER_YEAR_FORMATTER.format(amount);
}

function formatEurPerYearLabel(amount: number): string {
  return `${formatEurAmount(amount)} euros per year`;
}

function formatEurRange(
  range: CompensationRangeSummary | null | undefined,
): string | null {
  const minimum = compensationRangeAmountEur(range, "min");
  const maximum = compensationRangeAmountEur(range, "max");
  if (minimum === null && maximum === null) return null;
  if (minimum !== null && maximum !== null) {
    if (minimum === maximum) return formatEurAmount(minimum);
    return `${formatEurAmount(minimum)}-${formatEurAmount(maximum)}`;
  }
  return formatEurAmount(minimum ?? maximum ?? 0);
}

function salaryAmountLabel(
  summary: CompensationSummary | null,
  bound: "min" | "max",
  fallbackSalary = "",
): string {
  const amount = salaryAmountEur(summary, bound);
  if (amount !== null) return formatEurPerYearLabel(amount);
  return postedCompensationLabel(summary, fallbackSalary);
}

function compensationRangeAmountEur(
  range: CompensationRangeSummary | null | undefined,
  bound: "min" | "max",
): number | null {
  const normalized =
    bound === "min" ? range?.annualizedMinimumEur : range?.annualizedMaximumEur;
  if (Number.isFinite(normalized)) return Number(normalized);
  if (range?.currency?.toUpperCase() !== "EUR") return null;
  const annualized =
    bound === "min"
      ? range.annualizedMinimumAmount
      : range.annualizedMaximumAmount;
  if (Number.isFinite(annualized)) return Number(annualized);
  if (range.period !== "year") return null;
  const source = bound === "min" ? range.minimumAmount : range.maximumAmount;
  return Number.isFinite(source) ? Number(source) : null;
}

function marketCompensationLabel(summary: CompensationSummary | null): string {
  const market = summary?.market;
  if (!market) return "Market estimate not requested";
  const range = formatEurRange(market.range);
  if (market.estimateState === "estimated_range" && range) {
    return range;
  }
  return marketMissingLabel(market.estimateState);
}

function marketCompensationSortValue(row: JobSummary): number {
  const market = row.compensationSummary?.market;
  const amount =
    market?.range?.annualizedMinimumAmount ?? market?.range?.minimumAmount;
  if (Number.isFinite(amount)) return Number(amount);
  switch (market?.estimateState) {
    case "estimated_range":
      return -1;
    case "insufficient_evidence":
      return -2;
    case "source_unavailable":
      return -3;
    case "unsupported":
      return -4;
    case "not_requested":
    default:
      return Number.NEGATIVE_INFINITY;
  }
}

function marketConfidenceSortValue(row: JobSummary): number {
  const market = row.compensationSummary?.market;
  if (!market || market.recordStatus === "not_requested")
    return Number.NEGATIVE_INFINITY;
  if (Number.isFinite(market.confidenceScore))
    return Number(market.confidenceScore);
  switch (market.confidenceBand) {
    case "high":
      return 0.9;
    case "medium":
      return 0.62;
    case "low":
      return 0.3;
    case "none":
      return 0;
  }
}

function sourceSortValue(row: JobSummary): string {
  return (
    row.postingSource ||
    row.discoverySource ||
    row.source ||
    ""
  ).toLowerCase();
}

function postingLifecycleLabel(
  activeState: JobSummary["activeState"],
): string | null {
  switch (activeState) {
    case "active":
      return null;
    case "closed":
      return "Posting closed";
    case "expired":
      return "Posting expired";
    case "removed":
      return "Posting removed";
    case "location_incompatible":
      return "Location incompatible";
    case "unknown":
      return null;
  }
}

export function SalaryAmountCell({
  summary,
  bound,
}: {
  readonly summary: CompensationSummary | null;
  readonly bound: "min" | "max";
}) {
  const posted = summary?.posted;
  const amount = salaryAmountEur(summary, bound);
  if (amount === null) {
    const label = posted?.range
      ? "Posted salary is not normalized to EUR per year"
      : posted?.parseState === "unparseable"
        ? "Posted salary unparseable"
        : posted?.parseState === "ambiguous"
          ? "Posted salary ambiguous"
          : "No posted salary recorded";
    return <MissingCompensationValue label={label} />;
  }

  return (
    <span
      className="job-compensation-cell"
      aria-label={`${bound === "min" ? "Minimum" : "Maximum"} normalized salary ${formatEurPerYearLabel(amount)}`}
      title={`${bound === "min" ? "Minimum" : "Maximum"} normalized salary ${formatEurPerYearLabel(amount)}`}
    >
      <span className="job-compensation-primary">
        {formatEurAmount(amount)}
      </span>
    </span>
  );
}

export function MarketCompensationCell({
  summary,
}: {
  readonly summary: CompensationSummary | null;
}) {
  const market = summary?.market;
  if (!market || market.estimateState === "not_requested") {
    return <MissingCompensationValue label="Market estimate not requested" />;
  }

  const sourceCount =
    market.sourceCount > 0 ? pluralize(market.sourceCount, "source") : null;
  const stateLabel = marketStateLabel(market.estimateState);
  const primary =
    market.estimateState === "estimated_range" && formatEurRange(market.range)
      ? formatEurRange(market.range)
      : stateLabel;
  const interval =
    market.estimateState === "estimated_range" &&
    formatEurRange(market.confidenceInterval)
      ? `CI ${formatEurRange(market.confidenceInterval)}`
      : null;

  return (
    <span
      className="job-compensation-cell"
      aria-label={[
        marketMissingLabel(market.estimateState),
        primary,
        interval,
        confidenceValueLabel(market),
        sourceCount,
      ]
        .filter(Boolean)
        .join(", ")}
      title={[primary, interval, confidenceValueLabel(market), sourceCount]
        .filter(Boolean)
        .join(", ")}
    >
      <span className="job-compensation-primary">{primary}</span>
      {interval ? (
        <span className="job-compensation-meta">{interval}</span>
      ) : null}
      {sourceCount ? (
        <span className="job-compensation-meta">{sourceCount}</span>
      ) : null}
    </span>
  );
}

export function MarketConfidenceCell({
  summary,
}: {
  readonly summary: CompensationSummary | null;
}) {
  const market = summary?.market;
  if (!market || market.recordStatus === "not_requested") {
    return <MissingCompensationValue label="Market confidence not requested" />;
  }
  const score = Number.isFinite(market.confidenceScore)
    ? `${Math.round(Number(market.confidenceScore) * 100)}%`
    : null;
  return (
    <span
      className={`job-compensation-confidence job-compensation-confidence-${market.confidenceBand}`}
      aria-label={confidenceValueLabel(market)}
      title={confidenceValueLabel(market)}
    >
      <span className="job-compensation-confidence-label">
        {confidenceDisplayLabel(market.confidenceBand)}
      </span>
      {score ? (
        <span className="job-compensation-confidence-score">{score}</span>
      ) : null}
    </span>
  );
}

export function CompensationWarningsCell({
  summary,
}: {
  readonly summary: CompensationSummary | null;
}) {
  const warningCount = summary?.warningCount ?? 0;
  if (warningCount === 0) {
    return (
      <span className="job-compensation-warning-count muted">No warnings</span>
    );
  }
  return (
    <span className="job-compensation-warning-count warn">
      {pluralize(warningCount, "warning")}
    </span>
  );
}

function updateSelectedRows(
  rowSelection: RowSelectionState,
  onRowSelectionChange: (next: RowSelectionState) => void,
  rows: readonly JobSummary[],
  checked: boolean,
) {
  const next: RowSelectionState = { ...rowSelection };
  for (const row of rows) {
    if (checked) {
      next[row.jobKey] = true;
    } else {
      delete next[row.jobKey];
    }
  }
  onRowSelectionChange(next);
}

function updateSelectedRow(
  {
    rowSelection,
    onRowSelectionChange,
    selectionAnchorJobKey,
    onSelectionAnchorChange,
  }: JobColumnsOptions,
  row: JobSummary,
  checked: boolean,
  shiftKey: boolean,
  pageRows: readonly JobSummary[],
) {
  const anchorIndex = pageRows.findIndex(
    (pageRow) => pageRow.jobKey === selectionAnchorJobKey,
  );
  const rowIndex = pageRows.findIndex(
    (pageRow) => pageRow.jobKey === row.jobKey,
  );
  const rows =
    shiftKey && anchorIndex >= 0 && rowIndex >= 0
      ? pageRows.slice(
          Math.min(anchorIndex, rowIndex),
          Math.max(anchorIndex, rowIndex) + 1,
        )
      : [row];

  updateSelectedRows(rowSelection, onRowSelectionChange, rows, checked);
  onSelectionAnchorChange(row.jobKey);
}

function selectHeader(
  { rowSelection, onRowSelectionChange }: JobColumnsOptions,
  { pageRows }: DataGridHeaderContext<JobSummary>,
) {
  const allSelected =
    pageRows.length > 0 &&
    pageRows.every((row) => Boolean(rowSelection[row.jobKey]));
  const someSelected = pageRows.some((row) =>
    Boolean(rowSelection[row.jobKey]),
  );
  return (
    <span
      className="row-check-hitbox"
      onClick={(event: MouseEvent<HTMLSpanElement>) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) {
          updateSelectedRows(
            rowSelection,
            onRowSelectionChange,
            pageRows,
            !allSelected,
          );
        }
      }}
    >
      <input
        type="checkbox"
        aria-label="Select all rows on this page"
        checked={allSelected}
        ref={(node) => {
          if (node) {
            node.indeterminate = someSelected && !allSelected;
          }
        }}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          updateSelectedRows(
            rowSelection,
            onRowSelectionChange,
            pageRows,
            event.target.checked,
          )
        }
        onClick={(event: MouseEvent) => event.stopPropagation()}
      />
    </span>
  );
}

interface RowSelectionControlProps {
  context: DataGridCellContext<JobSummary>;
  options: JobColumnsOptions;
  row: JobSummary;
}

function RowSelectionControl({
  context,
  options,
  row,
}: RowSelectionControlProps) {
  const shiftKeyRef = useRef(false);
  const checked = Boolean(options.rowSelection[row.jobKey]);
  const updateRow = (nextChecked: boolean, shiftKey: boolean) =>
    updateSelectedRow(options, row, nextChecked, shiftKey, context.pageRows);

  return (
    <span
      className="row-check-hitbox"
      onClick={(event: MouseEvent<HTMLSpanElement>) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) {
          updateRow(!checked, event.shiftKey);
        }
      }}
    >
      <input
        type="checkbox"
        aria-label={`Select ${row.title}`}
        checked={checked}
        onPointerDown={(event) => {
          shiftKeyRef.current = event.shiftKey;
        }}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "Enter") {
            shiftKeyRef.current = event.shiftKey;
          }
        }}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          updateRow(event.target.checked, shiftKeyRef.current);
          shiftKeyRef.current = false;
        }}
        onClick={(event: MouseEvent) => event.stopPropagation()}
      />
    </span>
  );
}

export function jobColumns(
  options: JobColumnsOptions,
): Array<DataGridColumn<JobSummary>> {
  return [
    {
      id: "select",
      label: "Select",
      header: (context) => selectHeader(options, context),
      className: "row-check",
      headerClassName: "row-check",
      reorderable: false,
      render: (row, context) => (
        <RowSelectionControl context={context} options={options} row={row} />
      ),
    },
    {
      id: "fit_score",
      label: "Fit",
      sortable: true,
      getFilterValue: (row) => String(row.fitScore ?? "unscored"),
      render: (row) => (
        <div className="score-cell">
          <ScoreBadge score={row.fitScore} />
          <ScoreStalenessBadge staleness={row.scoreStaleness} />
        </div>
      ),
    },
    {
      id: "title",
      label: "Title",
      sortable: true,
      rowHeader: true,
      getFilterValue: (row) => row.title,
      render: (row) => (
        <TitleStack
          primary={row.title}
          secondary={postingLifecycleLabel(row.activeState)}
        />
      ),
    },
    {
      id: "company",
      label: "Company",
      sortable: true,
      getFilterValue: (row) => row.company || "-",
      render: (row) => <span className="muted-cell">{row.company || "-"}</span>,
    },
    {
      id: "source",
      label: "Sources",
      sortable: true,
      getSortValue: sourceSortValue,
      getFilterValue: (row) =>
        row.postingSource || row.discoverySource || row.source || "-",
      getFilterSearchValue: (row) =>
        [row.postingSource, row.discoverySource, row.source]
          .filter(Boolean)
          .join(" "),
      render: (row) => (
        <TitleStack
          primary={row.postingSource ? `posting ${row.postingSource}` : "-"}
          secondary={
            row.discoverySource ? `discovered via ${row.discoverySource}` : null
          }
        />
      ),
    },
    {
      id: "compensation_min_eur",
      label: "Salary min (€ / year)",
      sortable: true,
      getSortValue: (row) => salaryAmountSortValue(row, "min"),
      className: "job-compensation-column",
      headerClassName: "job-compensation-column",
      width: 156,
      minWidth: 144,
      maxWidth: 200,
      getFilterValue: (row) =>
        salaryAmountLabel(row.compensationSummary, "min", row.salary),
      getFilterSearchValue: (row) =>
        salaryAmountLabel(row.compensationSummary, "min", row.salary),
      render: (row) => (
        <SalaryAmountCell summary={row.compensationSummary} bound="min" />
      ),
    },
    {
      id: "compensation_max_eur",
      label: "Salary max (€ / year)",
      sortable: true,
      getSortValue: (row) => salaryAmountSortValue(row, "max"),
      className: "job-compensation-column",
      headerClassName: "job-compensation-column",
      width: 156,
      minWidth: 144,
      maxWidth: 200,
      getFilterValue: (row) =>
        salaryAmountLabel(row.compensationSummary, "max", row.salary),
      getFilterSearchValue: (row) =>
        salaryAmountLabel(row.compensationSummary, "max", row.salary),
      render: (row) => (
        <SalaryAmountCell summary={row.compensationSummary} bound="max" />
      ),
    },
    {
      id: "compensation_market",
      label: "Market (€ / year)",
      sortable: true,
      getSortValue: marketCompensationSortValue,
      className: "job-compensation-column",
      headerClassName: "job-compensation-column",
      width: 176,
      minWidth: 156,
      maxWidth: 280,
      getFilterValue: (row) => marketCompensationLabel(row.compensationSummary),
      getFilterSearchValue: (row) =>
        marketCompensationLabel(row.compensationSummary),
      render: (row) => (
        <MarketCompensationCell summary={row.compensationSummary} />
      ),
    },
    {
      id: "compensation_confidence",
      label: "Confidence",
      sortable: true,
      getSortValue: marketConfidenceSortValue,
      className: "job-compensation-confidence-column",
      headerClassName: "job-compensation-confidence-column",
      width: 118,
      minWidth: 104,
      maxWidth: 160,
      getFilterValue: (row) =>
        confidenceValueLabel(row.compensationSummary?.market),
      getFilterSearchValue: (row) =>
        confidenceValueLabel(row.compensationSummary?.market),
      render: (row) => (
        <MarketConfidenceCell summary={row.compensationSummary} />
      ),
    },
    {
      id: "compensation_warnings",
      label: "Warnings",
      sortable: true,
      getSortValue: (row) => row.compensationSummary?.warningCount ?? 0,
      className: "job-compensation-warnings-column",
      headerClassName: "job-compensation-warnings-column",
      width: 112,
      minWidth: 96,
      maxWidth: 180,
      getFilterValue: (row) => {
        const warningCount = row.compensationSummary?.warningCount ?? 0;
        return warningCount
          ? pluralize(warningCount, "warning")
          : "No warnings";
      },
      getFilterSearchValue: (row) => {
        const warningCount = row.compensationSummary?.warningCount ?? 0;
        return warningCount
          ? pluralize(warningCount, "warning")
          : "No warnings";
      },
      render: (row) => (
        <CompensationWarningsCell summary={row.compensationSummary} />
      ),
    },
    {
      id: "location",
      label: "Location",
      sortable: true,
      getFilterValue: (row) => row.location || "-",
      render: (row) => <span>{row.location || "-"}</span>,
    },
    {
      id: "current_stage",
      label: "Stage",
      sortable: true,
      getFilterValue: (row) => row.currentStage,
      filterValues: JOB_TABLE_STAGE_FILTERS,
      render: (row) => <UserFacingStageBadge stage={row.currentStage} />,
    },
    {
      id: "current_state",
      label: "State",
      sortable: true,
      getFilterValue: (row) => row.currentState,
      getFilterSearchValue: (row) =>
        `${row.currentSubstage} ${row.currentState}`,
      filterValues: STAGE_STATES,
      render: (row) => (
        <TitleStack
          primary={<StageBadge state={row.currentState} />}
          secondary={`${row.currentSubstage} stage`}
        />
      ),
    },
    {
      id: "resume_template",
      label: "Template",
      sortable: true,
      getFilterValue: (row) => row.resumeTemplate?.state ?? "no template",
      getFilterSearchValue: (row) =>
        row.resumeTemplate?.effective.templateName ?? "no template",
      render: (row) => <ResumeTemplateStatusBadge state={row.resumeTemplate} />,
    },
    {
      id: "discovered_at",
      label: "Discovered",
      sortable: true,
      getFilterValue: (row) => row.discoveredAt || "-",
      render: (row) => <RelativeTime value={row.discoveredAt} />,
    },
    {
      id: "apply_status",
      label: "Apply",
      sortable: true,
      getSortValue: (row) => row.applyStatus ?? "",
      getFilterValue: (row) => row.applyStatus ?? "not applied",
      filterValues: ["applied"],
      render: (row) => {
        const status = row.applyStatus;
        if (!status || !isApplyRunStatus(status)) {
          return null;
        }
        return <ApplyRunBadge result={status} />;
      },
    },
  ];
}
