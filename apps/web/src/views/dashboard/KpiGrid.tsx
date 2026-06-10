import { useNavigate } from "@tanstack/react-router";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";

export type KpiTarget = "all" | "failed" | "blocked" | "ready" | "applied";
type KpiTone = "alert" | "warn" | "ok";

const KPI_BASE: JobsSearch = {
  q: "",
  stage: "all",
  state: "all",
  applyStatus: "all",
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
  if (target === "applied") {
    return { ...KPI_BASE, applyStatus: "applied" };
  }
  return { ...KPI_BASE, stage: "all", state: "all" };
}

export function kpiHrefFor(target: KpiTarget): string {
  const search = kpiSearchFor(target);
  const params = new URLSearchParams();
  params.set("q", search.q);
  params.set("stage", search.stage);
  params.set("state", search.state);
  params.set("applyStatus", search.applyStatus);
  params.set("deleted", search.deleted);
  params.set("sort", search.sort);
  params.set("dir", search.dir);
  params.set("page", String(search.page));
  params.set("pageSize", String(search.pageSize));
  return `/jobs?${params.toString()}`;
}

const ITEMS: ReadonlyArray<{
  readonly label: string;
  readonly key: keyof DashboardSummary["totals"];
  readonly caption: (summary: DashboardSummary) => string;
  readonly target: KpiTarget;
  readonly tone: KpiTone | null;
}> = [
  {
    label: "Jobs",
    key: "jobs",
    caption: (summary) => `+${summary.totals.jobsToday} today`,
    target: "all",
    tone: null,
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
    target: "applied",
    tone: null,
  },
  {
    label: "Dry runs",
    key: "dryRuns",
    caption: () => "today excluded",
    target: "all",
    tone: null,
  },
];

export interface KpiGridProps {
  summary: DashboardSummary;
}

export function KpiGrid({ summary }: KpiGridProps) {
  const navigate = useNavigate();
  return (
    <section className="kpis">
      {ITEMS.map(({ label, key, caption, target, tone }) => {
        const search = kpiSearchFor(target);
        return (
          <a
            key={label}
            className={`kpi ${tone ? `tone-${tone}` : ""}`}
            href={kpiHrefFor(target)}
            onClick={(event) => {
              if (
                event.defaultPrevented
                || event.button !== 0
                || event.metaKey
                || event.altKey
                || event.ctrlKey
                || event.shiftKey
              ) {
                return;
              }
              event.preventDefault();
              void navigate({ to: "/jobs", search });
            }}
          >
            <span className="kpi-lbl">{label}</span>
            <span className="kpi-val">{summary.totals[key]}</span>
            <span className="kpi-delta">{caption(summary)}</span>
          </a>
        );
      })}
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
