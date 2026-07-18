import { useMemo, useState } from "react";

import type { DataGridColumn } from "../../shared/ui/filterable-data-grid.js";
import {
  FilterableDataGrid,
  type DataGridSortState,
} from "../../shared/ui/filterable-data-grid.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";
import type { StatusTagTone } from "../../shared/ui/status-tokens.js";

export interface OutcomeRateRow {
  readonly id: string;
  readonly dimension: string;
  readonly label: string;
  readonly badgeTone: StatusTagTone;
  readonly applied: number;
  readonly reply: number;
  readonly interview: number;
  readonly offer: number;
  readonly rejection: number;
  readonly replyRate: number | null;
  readonly interviewRate: number | null;
  readonly offerRate: number | null;
  readonly rejectionRate: number | null;
  readonly minSample: number;
}

type RateKey = "replyRate" | "interviewRate" | "offerRate" | "rejectionRate";
type CountKey = "reply" | "interview" | "offer" | "rejection";

const RATE_COUNTS: Record<RateKey, { count: CountKey; label: string }> = {
  replyRate: { count: "reply", label: "replies" },
  interviewRate: { count: "interview", label: "interviews" },
  offerRate: { count: "offer", label: "offers" },
  rejectionRate: { count: "rejection", label: "rejections" },
};

function formatPercent(rate: number | null): string {
  return rate === null ? "" : `${Math.round(rate * 100)}%`;
}

function formatRateCell(row: OutcomeRateRow, rateKey: RateKey): string {
  const rate = row[rateKey];
  if (row.applied === 0) return "no applications yet";
  const metadata = RATE_COUNTS[rateKey];
  if (rate === null) return `${row[metadata.count]} ${metadata.label} · n=${row.applied} · too few to rate`;
  return `${formatPercent(rate)} · n=${row.applied}`;
}

function countLabel(row: OutcomeRateRow): string {
  if (row.applied === 0) return "no applications yet";
  return `${row.applied} applied`;
}

const outcomeRateColumns: Array<DataGridColumn<OutcomeRateRow>> = [
  {
    id: "group",
    label: "Group",
    rowHeader: true,
    sortable: true,
    getSortValue: (row) => row.label,
    getFilterValue: (row) => row.label,
    render: (row) => (
      <span className="title-stack analytics-group-cell">
        <b>{row.label}</b>
        <span className="analytics-group-meta">
          <StatusBadge icon={false} tone={row.badgeTone}>
            {row.dimension}
          </StatusBadge>
          <span data-typography="metadata">{countLabel(row)}</span>
        </span>
      </span>
    ),
    className: "analytics-group-column",
    headerClassName: "analytics-group-column",
  },
  {
    id: "applied",
    label: "Applied",
    sortable: true,
    getSortValue: (row) => row.applied,
    render: (row) => <span className="mono">{row.applied}</span>,
    className: "analytics-applied-column",
    headerClassName: "analytics-applied-column",
  },
  {
    id: "reply",
    label: "Reply rate",
    sortable: true,
    getSortValue: (row) => (row.replyRate === null ? -1 : row.replyRate),
    render: (row) => (
      <span className={row.replyRate === null && row.applied > 0 ? "analytics-rate suppressed" : "analytics-rate"}>
        <b>{formatRateCell(row, "replyRate")}</b>
        <span data-typography="metadata">{row.reply} replies</span>
      </span>
    ),
    className: "analytics-rate-column",
    headerClassName: "analytics-rate-column",
  },
  {
    id: "interview",
    label: "Interview rate",
    sortable: true,
    getSortValue: (row) => (row.interviewRate === null ? -1 : row.interviewRate),
    render: (row) => (
      <span className={row.interviewRate === null && row.applied > 0 ? "analytics-rate suppressed" : "analytics-rate"}>
        <b>{formatRateCell(row, "interviewRate")}</b>
        <span data-typography="metadata">{row.interview} interviews</span>
      </span>
    ),
    className: "analytics-rate-column",
    headerClassName: "analytics-rate-column",
  },
  {
    id: "offer",
    label: "Offer rate",
    sortable: true,
    getSortValue: (row) => (row.offerRate === null ? -1 : row.offerRate),
    render: (row) => (
      <span className={row.offerRate === null && row.applied > 0 ? "analytics-rate suppressed" : "analytics-rate"}>
        <b>{formatRateCell(row, "offerRate")}</b>
        <span data-typography="metadata">{row.offer} offers</span>
      </span>
    ),
    className: "analytics-rate-column",
    headerClassName: "analytics-rate-column",
  },
  {
    id: "rejection",
    label: "Rejection rate",
    sortable: true,
    getSortValue: (row) => (row.rejectionRate === null ? -1 : row.rejectionRate),
    render: (row) => (
      <span className={row.rejectionRate === null && row.applied > 0 ? "analytics-rate suppressed" : "analytics-rate"}>
        <b>{formatRateCell(row, "rejectionRate")}</b>
        <span data-typography="metadata">{row.rejection} rejections</span>
      </span>
    ),
    className: "analytics-rate-column",
    headerClassName: "analytics-rate-column",
  },
];

function compareValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function sortableValue(row: OutcomeRateRow, columnId: string): string | number {
  switch (columnId) {
    case "group":
      return row.label;
    case "applied":
      return row.applied;
    case "reply":
      return row.replyRate ?? -1;
    case "interview":
      return row.interviewRate ?? -1;
    case "offer":
      return row.offerRate ?? -1;
    case "rejection":
      return row.rejectionRate ?? -1;
    default:
      return row.applied;
  }
}

function sortRows(rows: readonly OutcomeRateRow[], sort: DataGridSortState): OutcomeRateRow[] {
  return [...rows].sort((left, right) => {
    const leftSuppressed = left.applied > 0 && left.applied < left.minSample;
    const rightSuppressed = right.applied > 0 && right.applied < right.minSample;
    if (leftSuppressed !== rightSuppressed && sort.columnId !== "applied") {
      return leftSuppressed ? 1 : -1;
    }
    const compared = compareValues(sortableValue(left, sort.columnId), sortableValue(right, sort.columnId));
    return sort.direction === "asc" ? compared : compared * -1;
  });
}

export interface OutcomeRateTableProps {
  readonly rows: readonly OutcomeRateRow[];
  readonly loading: boolean;
  readonly title?: string;
}

export function OutcomeRateTable({
  rows,
  loading,
  title = "Outcome analytics table",
}: OutcomeRateTableProps) {
  const [sort, setSort] = useState<DataGridSortState>({ columnId: "applied", direction: "desc" });
  const sortedRows = useMemo(() => sortRows(rows, sort), [rows, sort]);
  return (
    <FilterableDataGrid<OutcomeRateRow>
      title={title}
      data={sortedRows}
      columns={outcomeRateColumns}
      getRowId={(row) => row.id}
      loading={loading}
      loadingMessage="Loading outcome analytics."
      emptyMessage="No application outcomes recorded."
      initialSort={{ columnId: "applied", direction: "desc" }}
      sort={sort}
      onSortChange={setSort}
      manualSorting
      tableClassName="analytics-data-grid-table"
      rowClassName={(row) => (row.applied > 0 && row.applied < row.minSample ? "analytics-row-small" : undefined)}
    />
  );
}
