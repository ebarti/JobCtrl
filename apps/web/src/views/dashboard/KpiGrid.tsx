import { useNavigate } from "@tanstack/react-router";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";

export type KpiTarget = "all" | "failed" | "blocked" | "ready";

const KPI_BASE: JobsSearch = {
  q: "",
  stage: "all",
  state: "all",
  deleted: "active",
  sort: "discovered_at",
  dir: "desc",
  page: 1,
  pageSize: 50,
};

export function kpiSearchFor(target: KpiTarget): JobsSearch {
  if (target === "failed") {
    return { ...KPI_BASE, state: "failed", stage: "all" };
  }
  if (target === "blocked") {
    return { ...KPI_BASE, state: "blocked", stage: "all" };
  }
  if (target === "ready") {
    return { ...KPI_BASE, stage: "apply", state: "pending" };
  }
  return { ...KPI_BASE, stage: "all", state: "all" };
}

const ITEMS: ReadonlyArray<{
  readonly label: string;
  readonly key: keyof DashboardSummary["totals"];
  readonly caption: (summary: DashboardSummary) => string;
  readonly target: KpiTarget;
  readonly tone: string;
}> = [
  {
    label: "Jobs",
    key: "jobs",
    caption: (summary) => `+${summary.totals.jobsToday} today`,
    target: "all",
    tone: "",
  },
  {
    label: "Failures",
    key: "failures",
    caption: () => "needs retry",
    target: "failed",
    tone: "alert",
  },
  {
    label: "Blocked",
    key: "blocked",
    caption: () => "needs review",
    target: "blocked",
    tone: "warn",
  },
  {
    label: "Ready",
    key: "ready",
    caption: () => "ready queue",
    target: "ready",
    tone: "ok",
  },
  {
    label: "Applied",
    key: "applied",
    caption: (summary) => `+${summary.totals.appliedToday} today`,
    target: "all",
    tone: "",
  },
  {
    label: "Dry runs",
    key: "dryRuns",
    caption: () => "today excluded",
    target: "all",
    tone: "",
  },
];

export interface KpiGridProps {
  summary: DashboardSummary;
}

export function KpiGrid({ summary }: KpiGridProps) {
  const navigate = useNavigate();
  return (
    <section className="kpis">
      {ITEMS.map(({ label, key, caption, target, tone }) => (
        <button
          key={label}
          type="button"
          className={`kpi ${tone ? `tone-${tone}` : ""}`}
          onClick={() => void navigate({ to: "/jobs", search: kpiSearchFor(target) })}
        >
          <span className="kpi-lbl">{label}</span>
          <span className="kpi-val">{summary.totals[key]}</span>
          <span className="kpi-delta">{caption(summary)}</span>
        </button>
      ))}
    </section>
  );
}

export function KpiSkeleton() {
  return (
    <section className="kpis">
      {ITEMS.map(({ label }) => (
        <div className="kpi" key={label}>
          <span className="kpi-lbl">{label}</span>
          <span className="kpi-val">-</span>
          <span className="kpi-delta">waiting for API</span>
        </div>
      ))}
    </section>
  );
}
