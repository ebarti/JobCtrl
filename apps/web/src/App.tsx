import {
  type ArtifactSortField,
  type ArtifactSummary,
  type BulkJobMutationRequest,
  type CredentialKey,
  CredentialKeys,
  type CredentialsResponse,
  type DashboardSummary,
  type DashboardSettings,
  type JobDetail,
  type JobFacetsResponse,
  type JobSummary,
  type JobSortField,
  type PaginatedResponse,
  type ProfileConfigResponse,
  type SettingsResponse,
  type Stage,
  type StageState,
  STAGES,
} from "@jobhunter/contracts";
import { createJobHunterApiClient } from "@jobhunter/api-client";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

type View = "dashboard" | "jobs" | "artifacts" | "config" | "profile";
type Direction = "asc" | "desc";
type LoadState = "idle" | "loading" | "ready" | "error";
type Theme = "light" | "dark";
type ActivityEvent = DashboardSummary["activity"][number];
type ApplyRunSummary = DashboardSummary["applyRuns"][number];
type JobSortColumn = Extract<JobSortField, "discovered_at" | "title" | "company" | "location" | "fit_score" | "current_stage" | "current_state">;
type ArtifactGroup = {
  groupKey: string;
  jobKey: string;
  title: string;
  company: string;
  artifacts: ArtifactSummary[];
};

const api = createJobHunterApiClient(import.meta.env.VITE_JOBHUNTER_API_BASE_URL ?? "");

const jobTableColumns: Array<{ field: JobSortColumn; label: string }> = [
  { field: "fit_score", label: "Fit score" },
  { field: "title", label: "Title" },
  { field: "company", label: "Company" },
  { field: "location", label: "Location" },
  { field: "current_stage", label: "Stage" },
  { field: "current_state", label: "State" },
  { field: "discovered_at", label: "Discovered" },
];

const artifactSortFields = [
  ["created_at", "Created"],
  ["title", "Title"],
  ["company", "Company"],
  ["type", "Type"],
  ["status", "Status"],
  ["size_bytes", "Size"],
] as const;

const currentStateOptions: Array<readonly [StageState | "all", string]> = [
  ["all", "all current states"],
  ["pending", "pending"],
  ["queued", "queued"],
  ["running", "running"],
  ["failed", "failed"],
  ["blocked", "blocked"],
  ["exhausted", "exhausted"],
  ["stale", "stale"],
  ["canceled", "canceled"],
  ["skipped", "skipped"],
];

export function App(): JSX.Element {
  const [view, setView] = useState<View>("dashboard");
  const [density, setDensity] = useState("regular");
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("jobhunter-theme");
    return saved === "dark" ? "dark" : "light";
  });
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [globalQuery, setGlobalQuery] = useState("");
  const [selectedJobKey, setSelectedJobKey] = useState("");
  const [selectedActivity, setSelectedActivity] = useState<ActivityEvent | null>(null);
  const [selectedApplyRun, setSelectedApplyRun] = useState<ApplyRunSummary | null>(null);

  const refreshSummary = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      await api.health();
      setConnected(true);
      setSummary(await api.dashboardSummary());
      setStatus("ready");
    } catch (requestError) {
      setConnected(false);
      setStatus("error");
      setError(requestError instanceof Error ? requestError.message : "Unable to reach JobHunter API.");
    }
  }, []);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("jobhunter-theme", theme);
  }, [theme]);

  const selectKpi = (target: "all" | "failed" | "blocked" | "ready") => {
    setView("jobs");
    window.dispatchEvent(new CustomEvent("jobhunter:set-jobs-filter", { detail: target }));
  };
  const openJob = (jobKey: string) => {
    setSelectedActivity(null);
    setSelectedApplyRun(null);
    setSelectedJobKey(jobKey);
  };
  const openActivity = (activity: ActivityEvent) => {
    if (activity.jobKey) {
      openJob(activity.jobKey);
      return;
    }
    setSelectedApplyRun(null);
    setSelectedActivity(activity);
  };
  const openApplyRun = (run: ApplyRunSummary) => {
    setSelectedActivity(null);
    setSelectedJobKey("");
    setSelectedApplyRun(run);
  };

  return (
    <div className="app" data-density={density}>
      <header className="topbar">
        <button className="brand" onClick={() => setView("dashboard")} type="button">
          <span className="brand-mark">jh</span>
          <span>jobhunter</span>
        </button>
        <nav className="nav" aria-label="Main navigation">
          {(["dashboard", "jobs", "artifacts", "config", "profile"] as const).map((item) => (
            <button className={view === item ? "on" : ""} key={item} onClick={() => setView(item)} type="button">
              {item}
            </button>
          ))}
        </nav>
        <input
          aria-label="Global search"
          className="global-search"
          placeholder="Filter jobs, errors, companies..."
          value={globalQuery}
          onChange={(event) => setGlobalQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && globalQuery.trim()) {
              setView("jobs");
            }
          }}
        />
        <select aria-label="Row density" className="select" value={density} onChange={(event) => setDensity(event.target.value)}>
          <option value="compact">compact</option>
          <option value="regular">regular</option>
          <option value="comfy">comfy</option>
        </select>
        <button
          aria-label="Reload dashboard data from the local API"
          className="tab"
          onClick={() => void refreshSummary()}
          type="button"
        >
          {status === "loading" ? "syncing local data" : "sync local data"}
        </button>
        <button
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          className="tab"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          type="button"
        >
          theme
        </button>
        <span className={`pulse ${connected ? "" : "offline"}`}>{connected ? "local API live" : "local API offline"}</span>
      </header>

      {summary ? <Kpis summary={summary} onSelect={selectKpi} /> : <KpiSkeleton />}

      {error ? <div className="banner">{error}</div> : null}

      <main className="main">
        {view === "dashboard" ? (
          <Dashboard
            summary={summary}
            status={status}
            onOpenActivity={openActivity}
            onOpenApplyRun={openApplyRun}
            onOpenJobs={selectKpi}
          />
        ) : view === "jobs" ? (
          <JobsView globalQuery={globalQuery} onJobsChanged={refreshSummary} onOpenJob={openJob} />
        ) : view === "artifacts" ? (
          <ArtifactsView globalQuery={globalQuery} onOpenJob={openJob} />
        ) : view === "config" ? (
          <ConfigView />
        ) : (
          <ProfileView />
        )}
      </main>

      {selectedJobKey ? <JobDrawer jobKey={selectedJobKey} onClose={() => setSelectedJobKey("")} /> : null}
      {selectedApplyRun ? (
        <ApplyRunDrawer
          run={selectedApplyRun}
          onClose={() => setSelectedApplyRun(null)}
          onOpenJob={(jobKey) => {
            setSelectedApplyRun(null);
            openJob(jobKey);
          }}
        />
      ) : null}
      {selectedActivity ? <ActivityDetailDrawer activity={selectedActivity} onClose={() => setSelectedActivity(null)} /> : null}
    </div>
  );
}

function Kpis({
  summary,
  onSelect,
}: {
  summary: DashboardSummary;
  onSelect: (target: "all" | "failed" | "blocked" | "ready") => void;
}): JSX.Element {
  const items = [
    ["Jobs", summary.totals.jobs, "+0 today", "all", ""],
    ["Failures", summary.totals.failures, "needs retry", "failed", "alert"],
    ["Blocked", summary.totals.blocked, "upstream missing", "blocked", "warn"],
    ["Ready", summary.totals.ready, "ready queue", "ready", "ok"],
    ["Applied", summary.totals.applied, "+0 today", "all", ""],
    ["Dry runs", summary.totals.dryRuns, "today excluded", "all", ""],
  ] as const;
  return (
    <section className="kpis">
      {items.map(([label, value, caption, target, tone]) => (
        <button className={`kpi ${tone ? `tone-${tone}` : ""}`} key={label} onClick={() => onSelect(target)} type="button">
          <span className="kpi-lbl">{label}</span>
          <span className="kpi-val">{value}</span>
          <span className="kpi-delta">{caption}</span>
        </button>
      ))}
    </section>
  );
}

function KpiSkeleton(): JSX.Element {
  return (
    <section className="kpis">
      {["Jobs", "Failures", "Blocked", "Ready", "Applied", "Dry runs"].map((label) => (
        <div className="kpi" key={label}>
          <span className="kpi-lbl">{label}</span>
          <span className="kpi-val">-</span>
          <span className="kpi-delta">waiting for API</span>
        </div>
      ))}
    </section>
  );
}

function Dashboard({
  summary,
  status,
  onOpenActivity,
  onOpenApplyRun,
  onOpenJobs,
}: {
  summary: DashboardSummary | null;
  status: LoadState;
  onOpenActivity: (activity: ActivityEvent) => void;
  onOpenApplyRun: (run: ApplyRunSummary) => void;
  onOpenJobs: (target: "all" | "failed" | "blocked" | "ready") => void;
}): JSX.Element {
  if (!summary) {
    return <Empty title={status === "loading" ? "Loading dashboard." : "No dashboard data."} />;
  }
  return (
    <div className="dashboard-grid">
      <section className="card span-2">
        <CardHeader title="Pipeline" meta={`${summary.totals.jobs} jobs`} />
        <div className="funnel">
          {summary.funnel.map((stage, index) => (
            <button className="funnel-row" key={stage.stage} onClick={() => onOpenJobs("all")} type="button">
              <span className="funnel-stage">
                <span className="funnel-num">{String(index + 1).padStart(2, "0")}</span> {stage.stage}
              </span>
              <SegmentBar
                total={stage.total}
                values={[
                  ["done", stage.succeeded],
                  ["failed", stage.failed],
                  ["blocked", stage.blocked],
                  ["running", stage.running],
                  ["pending", stage.pending],
                ]}
              />
              <span className="legend">
                {stage.failed ? <span className="danger">{stage.failed} failed</span> : null}
                {stage.blocked ? <span className="warn">{stage.blocked} blocked</span> : null}
                {stage.running ? <span>{stage.running} running</span> : null}
                <span>{stage.pending} pending</span>
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        <CardHeader title="Apply runs" meta={`${summary.applyRuns.length} recent`} />
        <div className="rows">
          {summary.applyRuns.length ? (
            summary.applyRuns.map((run) => (
              <button className="mini-row clickable-row" key={run.runId} onClick={() => onOpenApplyRun(run)} type="button">
                <StatusDot state={run.status === "running" ? "running" : run.status === "failed" ? "failed" : "succeeded"} />
              <span className="title-stack">
                <b>{run.title}</b>
                <span>{run.company} · {formatDateTime(run.startedAt)}</span>
                </span>
                {run.dryRun ? <span className="tag info">dry-run</span> : null}
              </button>
            ))
          ) : (
            <Empty title="No apply runs." />
          )}
        </div>
      </section>
      <section className="card">
        <CardHeader title="Recent activity" meta={`${summary.activity.length} events`} />
        <div className="rows">
          {summary.activity.length ? (
            summary.activity.map((activity, index) => (
              <button
                className="activity-row clickable-row"
                key={`${activity.eventId}-${activity.at}-${index}`}
                onClick={() => onOpenActivity(activity)}
                type="button"
              >
                <span className={`tag ${activity.level === "error" ? "danger" : "muted"}`}>{activity.level}</span>
                <span className="stage-pill">{activity.stage}</span>
                <span className="activity-main">
                  <b>{activity.message}</b>
                  <span>{activity.title ? `${activity.title} · ${activity.company ?? "Unknown"}` : activity.jobKey ?? `event ${activity.eventId}`}</span>
                </span>
                <span className="mono" title={`${formatDateTime(activity.at)} #${activity.eventId}`}>
                  {formatDateTime(activity.at)} #{activity.eventId}
                </span>
              </button>
            ))
          ) : (
            <Empty title="No activity yet." />
          )}
        </div>
      </section>
    </div>
  );
}

function JobsView({
  globalQuery,
  onJobsChanged,
  onOpenJob,
}: {
  globalQuery: string;
  onJobsChanged: () => Promise<void>;
  onOpenJob: (jobKey: string) => void;
}): JSX.Element {
  const [data, setData] = useState<PaginatedResponse<JobSummary> | null>(null);
  const [facets, setFacets] = useState<JobFacetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<Stage | "all">("all");
  const [state, setState] = useState<StageState | "all">("all");
  const [locationFilter, setLocationFilter] = useState<string[]>([]);
  const [companyFilter, setCompanyFilter] = useState<string[]>([]);
  const [titleFilter, setTitleFilter] = useState<string[]>([]);
  const [discoveredFrom, setDiscoveredFrom] = useState("");
  const [discoveredTo, setDiscoveredTo] = useState("");
  const [minFitScore, setMinFitScore] = useState("");
  const [maxFitScore, setMaxFitScore] = useState("");
  const [deleted, setDeleted] = useState<"active" | "deleted">("active");
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(() => new Set());
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [sort, setSort] = useState<JobSortField>("discovered_at");
  const [dir, setDir] = useState<Direction>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [error, setError] = useState("");
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    setLoading(true);
    setError("");
    try {
      const nextData = await api.jobs({
        page,
        pageSize,
        q: globalQuery,
        sort,
        dir,
        deleted,
        stage: stage === "all" ? undefined : stage,
        state: state === "all" ? undefined : state,
        location: locationFilter,
        companies: companyFilter,
        title: titleFilter,
        discoveredFrom,
        discoveredTo,
        minFitScore: scoreFilterValue(minFitScore),
        maxFitScore: scoreFilterValue(maxFitScore),
      });
      if (requestId === requestSeq.current) {
        setData(nextData);
      }
    } catch (requestError) {
      if (requestId === requestSeq.current) {
        setData(null);
        setError(requestError instanceof Error ? requestError.message : "Unable to load jobs.");
      }
    } finally {
      if (requestId === requestSeq.current) {
        setLoading(false);
      }
    }
  }, [
    companyFilter,
    deleted,
    dir,
    discoveredFrom,
    discoveredTo,
    globalQuery,
    locationFilter,
    maxFitScore,
    minFitScore,
    page,
    pageSize,
    sort,
    stage,
    state,
    titleFilter,
  ]);

  const loadFacets = useCallback(async () => {
    try {
      setFacets(await api.jobFacets({ deleted }));
    } catch {
      setFacets(null);
    }
  }, [deleted]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadFacets();
  }, [loadFacets]);

  useEffect(() => {
    const listener = (event: Event) => {
      const target = (event as CustomEvent<string>).detail;
      setPage(1);
      if (target === "failed") {
        setState("failed");
        setStage("all");
      } else if (target === "blocked") {
        setState("blocked");
        setStage("all");
      } else if (target === "ready") {
        setStage("apply");
        setState("pending");
      } else {
        setStage("all");
        setState("all");
      }
      setDeleted("active");
    };
    window.addEventListener("jobhunter:set-jobs-filter", listener);
    return () => window.removeEventListener("jobhunter:set-jobs-filter", listener);
  }, []);

  useEffect(() => {
    setPage(1);
  }, [companyFilter, discoveredFrom, discoveredTo, globalQuery, locationFilter, maxFitScore, minFitScore, titleFilter]);

  useEffect(() => {
    setSelectedJobs(new Set());
    setAllMatchingSelected(false);
  }, [
    companyFilter,
    deleted,
    dir,
    discoveredFrom,
    discoveredTo,
    globalQuery,
    locationFilter,
    maxFitScore,
    minFitScore,
    page,
    pageSize,
    sort,
    stage,
    state,
    titleFilter,
  ]);

  const toggleSelection = (jobKey: string, selected: boolean) => {
    setAllMatchingSelected(false);
    setSelectedJobs((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(jobKey);
      } else {
        next.delete(jobKey);
      }
      return next;
    });
  };

  const selectPage = () => {
    setAllMatchingSelected(false);
    setSelectedJobs(new Set(data?.items.map((job) => job.jobKey) ?? []));
  };

  const selectAllMatching = () => {
    setSelectedJobs(new Set());
    setAllMatchingSelected(Boolean(data?.pagination.total));
  };

  const clearSelection = () => {
    setSelectedJobs(new Set());
    setAllMatchingSelected(false);
  };

  const currentJobFilter = (): NonNullable<BulkJobMutationRequest["filter"]> => {
    const filter: NonNullable<BulkJobMutationRequest["filter"]> = {
      q: globalQuery,
      deleted,
      source: "",
      company: "",
      location: locationFilter,
      companies: companyFilter,
      title: titleFilter,
      discoveredFrom,
      discoveredTo,
    };
    const parsedMinFitScore = scoreFilterValue(minFitScore);
    const parsedMaxFitScore = scoreFilterValue(maxFitScore);
    if (parsedMinFitScore !== undefined) {
      filter.minFitScore = parsedMinFitScore;
    }
    if (parsedMaxFitScore !== undefined) {
      filter.maxFitScore = parsedMaxFitScore;
    }
    if (stage !== "all") {
      filter.stage = stage;
    }
    if (state !== "all") {
      filter.state = state;
    }
    return filter;
  };

  const changeSort = (field: JobSortColumn) => {
    if (sort === field) {
      setDir((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setDir(field === "discovered_at" || field === "fit_score" ? "desc" : "asc");
    }
    setPage(1);
  };

  const mutateSelected = async () => {
    const jobKeys = Array.from(selectedJobs);
    const count = allMatchingSelected ? data?.pagination.total ?? 0 : jobKeys.length;
    if (!count) {
      return;
    }
    const restoring = deleted === "deleted";
    const action = restoring ? "restore" : "delete";
    if (!window.confirm(`${restoring ? "Restore" : "Soft delete"} ${count} selected job${count === 1 ? "" : "s"}?`)) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const payload: BulkJobMutationRequest = allMatchingSelected
        ? { allMatching: true, filter: currentJobFilter(), jobKeys: [] }
        : { allMatching: false, jobKeys };
      if (restoring) {
        await api.restoreJobs(payload);
      } else {
        await api.deleteJobs(payload);
      }
      clearSelection();
      await Promise.all([load(), loadFacets(), onJobsChanged()]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `Unable to ${action} selected jobs.`);
    } finally {
      setLoading(false);
    }
  };

  const selectedCount = allMatchingSelected ? data?.pagination.total ?? 0 : selectedJobs.size;
  const filtersActive = Boolean(
    locationFilter.length
      || companyFilter.length
      || titleFilter.length
      || discoveredFrom
      || discoveredTo
      || minFitScore
      || maxFitScore,
  );
  const clearFilters = () => {
    setLocationFilter([]);
    setCompanyFilter([]);
    setTitleFilter([]);
    setDiscoveredFrom("");
    setDiscoveredTo("");
    setMinFitScore("");
    setMaxFitScore("");
    setPage(1);
  };

  return (
    <section className="card full">
      <CardHeader title="Jobs" meta={data ? `${data.pagination.total} total` : "loading"} />
      {error ? <div className="banner inline">{error}</div> : null}
      <div className="toolbar">
        <select
          value={stage}
          onChange={(event) => {
            setStage(event.target.value as Stage | "all");
            setPage(1);
          }}
        >
          <option value="all">all stages</option>
          {STAGES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select
          value={state}
          onChange={(event) => {
            setState(event.target.value as StageState | "all");
            setPage(1);
          }}
        >
          {currentStateOptions.map(([item, label]) => (
            <option key={item} value={item}>
              {label}
            </option>
          ))}
        </select>
        <MultiSelectFilter
          label="location"
          options={facets?.locations ?? []}
          values={locationFilter}
          onChange={(values) => setLocationFilter(values)}
        />
        <MultiSelectFilter
          label="company"
          options={facets?.companies ?? []}
          values={companyFilter}
          onChange={(values) => setCompanyFilter(values)}
        />
        <MultiSelectFilter
          label="job"
          options={facets?.titles ?? []}
          values={titleFilter}
          onChange={(values) => setTitleFilter(values)}
        />
        <label className="inline-field">
          <span>discovered from</span>
          <input type="date" value={discoveredFrom} onChange={(event) => setDiscoveredFrom(event.target.value)} />
        </label>
        <label className="inline-field">
          <span>to</span>
          <input type="date" value={discoveredTo} onChange={(event) => setDiscoveredTo(event.target.value)} />
        </label>
        <label className="inline-field score-range-field">
          <span>fit</span>
          <input
            aria-label="Minimum fit score"
            inputMode="numeric"
            max={10}
            min={0}
            placeholder="0"
            type="number"
            value={minFitScore}
            onChange={(event) => setMinFitScore(clampScoreInput(event.target.value))}
          />
        </label>
        <label className="inline-field score-range-field">
          <span>to</span>
          <input
            aria-label="Maximum fit score"
            inputMode="numeric"
            max={10}
            min={0}
            placeholder="10"
            type="number"
            value={maxFitScore}
            onChange={(event) => setMaxFitScore(clampScoreInput(event.target.value))}
          />
        </label>
        <PageSize
          value={pageSize}
          onChange={(value) => {
            setPageSize(value);
            setPage(1);
          }}
        />
        <button className="tab" onClick={() => void load()} type="button">
          refresh
        </button>
        <button className="tab" disabled={!filtersActive} onClick={clearFilters} type="button">
          clear filters
        </button>
      </div>
      <div className="bulk-bar">
        <div className="tabs">
          <button className={`tab ${deleted === "active" ? "on" : ""}`} onClick={() => setDeleted("active")} type="button">
            active jobs
          </button>
          <button className={`tab ${deleted === "deleted" ? "on" : ""}`} onClick={() => setDeleted("deleted")} type="button">
            deleted jobs
          </button>
        </div>
        <span className="meta">{selectedCount ? `${selectedCount} selected` : "select jobs to manage"}</span>
        <button className="tab" disabled={!data?.items.length} onClick={selectPage} type="button">
          select page
        </button>
        <button className="tab" disabled={!data?.pagination.total} onClick={selectAllMatching} type="button">
          select all matching
        </button>
        <button className="tab" disabled={!selectedCount} onClick={clearSelection} type="button">
          clear selected
        </button>
        <button
          className={`tab ${deleted === "deleted" ? "on" : "danger-action"}`}
          disabled={!selectedCount || loading}
          onClick={() => void mutateSelected()}
          type="button"
        >
          {deleted === "deleted" ? "restore selected" : "delete selected"}
        </button>
      </div>
      <div className="table">
        <div className="data-row job job-header" role="row">
          <span aria-hidden="true" />
          {jobTableColumns.map((column) => (
            <button
              aria-sort={sort === column.field ? (dir === "asc" ? "ascending" : "descending") : "none"}
              className={sort === column.field ? "sort-head active" : "sort-head"}
              key={column.field}
              onClick={() => changeSort(column.field)}
              type="button"
            >
              {column.label}
              {sort === column.field ? <span aria-hidden="true">{dir === "asc" ? " ↑" : " ↓"}</span> : null}
            </button>
          ))}
        </div>
        {loading && !data ? <Empty title="Loading jobs." /> : null}
        {data?.items.map((job) => (
          <div
            className="data-row job"
            key={job.jobKey}
            role="button"
            tabIndex={0}
            onClick={() => onOpenJob(job.jobKey)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpenJob(job.jobKey);
              }
            }}
          >
            <span className="row-check">
              <input
                aria-label={`Select ${job.title}`}
                checked={allMatchingSelected || selectedJobs.has(job.jobKey)}
                type="checkbox"
                onChange={(event) => toggleSelection(job.jobKey, event.target.checked)}
                onClick={(event) => event.stopPropagation()}
              />
            </span>
            <span className={`fit ${scoreTier(job.fitScore)}`}>{job.fitScore ?? "-"}</span>
            <span className="title-stack">
              <b>{job.title}</b>
            </span>
            <span className="muted-cell">{formatCompanySource(job.company, job.source)}</span>
            <span>{job.location || "-"}</span>
            <span className="stage-pill">{job.currentStage}</span>
            <span className={`tag ${stateTone(job.currentState)}`}>{job.currentState}</span>
            <span className="mono">{job.discoveredAt ? new Date(job.discoveredAt).toLocaleDateString() : "-"}</span>
          </div>
        ))}
        {data && data.items.length === 0 ? <Empty title="No jobs match." /> : null}
      </div>
      <Pager pagination={data?.pagination} page={page} onPage={setPage} />
    </section>
  );
}

function ArtifactsView({
  globalQuery,
  onOpenJob,
}: {
  globalQuery: string;
  onOpenJob: (jobKey: string) => void;
}): JSX.Element {
  const [data, setData] = useState<PaginatedResponse<ArtifactSummary> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openStatus, setOpenStatus] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<ArtifactSortField>("created_at");
  const [dir, setDir] = useState<Direction>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    setLoading(true);
    setError("");
    try {
      const nextData = await api.artifacts({
        page,
        pageSize,
        q: globalQuery,
        sort,
        dir,
        status: status === "all" ? "" : status,
      });
      if (requestId === requestSeq.current) {
        setData(nextData);
      }
    } catch (requestError) {
      if (requestId === requestSeq.current) {
        setData(null);
        setError(requestError instanceof Error ? requestError.message : "Unable to load artifacts.");
      }
    } finally {
      if (requestId === requestSeq.current) {
        setLoading(false);
      }
    }
  }, [dir, globalQuery, page, pageSize, sort, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [globalQuery]);

  const openArtifact = async (artifact: ArtifactSummary) => {
    setError("");
    setOpenStatus("");
    try {
      const response = await api.openArtifact(artifact.artifactId);
      setOpenStatus(`opened ${artifactDisplayLabel(response.artifact.type)}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to open artifact.");
    }
  };

  const artifactGroups = groupArtifacts(data?.items ?? []);

  return (
    <section className="card full">
      <CardHeader
        title="Artifacts"
        meta={data ? `${artifactGroups.length} jobs · ${data.pagination.total} artifacts` : "loading"}
      />
      {error ? <div className="banner inline">{error}</div> : null}
      {openStatus ? <div className="status-line">{openStatus}</div> : null}
      <div className="toolbar">
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          {["all", "active", "approved", "candidate", "stale", "missing"].map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <SelectPairs
          options={artifactSortFields}
          value={sort}
          onChange={(value) => {
            setSort(value);
            setPage(1);
          }}
        />
        <DirectionSelect
          value={dir}
          onChange={(value) => {
            setDir(value);
            setPage(1);
          }}
        />
        <PageSize
          value={pageSize}
          onChange={(value) => {
            setPageSize(value);
            setPage(1);
          }}
        />
        <button className="tab" onClick={() => void load()} type="button">
          refresh
        </button>
      </div>
      <div className="table">
        {loading && !data ? <Empty title="Loading artifacts." /> : null}
        {artifactGroups.map((group) => (
          <div className="data-row artifact-group" key={group.groupKey}>
            <span className="title-stack">
              <b>{group.title}</b>
              <span>{group.company}</span>
            </span>
            <span className="artifact-variants">
              {group.artifacts.map((artifact) => (
                <button
                  className="artifact-variant"
                  disabled={artifact.status === "missing"}
                  key={artifact.artifactId}
                  onClick={() => void openArtifact(artifact)}
                  title={artifact.status === "missing" ? "Local file is missing; regenerate this artifact before opening it." : artifact.localPath}
                  type="button"
                >
                  <span className={`tag ${artifactStatusTone(artifact.status)}`}>{artifactKind(artifact.type)}</span>
                  <span>{artifactDisplayLabel(artifact.type)}</span>
                  <span className="mono">{artifact.size}</span>
                </button>
              ))}
            </span>
            <span className="row-actions">
              <button className="tab" onClick={() => onOpenJob(group.jobKey)} type="button">
                job
              </button>
            </span>
          </div>
        ))}
        {data && artifactGroups.length === 0 ? <Empty title="No artifacts match." /> : null}
      </div>
      <Pager pagination={data?.pagination} page={page} onPage={setPage} />
    </section>
  );
}

function ConfigView(): JSX.Element {
  const [settings, setSettings] = useState<DashboardSettings | null>(null);
  const [originalSettings, setOriginalSettings] = useState<DashboardSettings | null>(null);
  const [credentials, setCredentials] = useState<CredentialsResponse["credentials"]>([]);
  const [credentialDrafts, setCredentialDrafts] = useState<Record<CredentialKey, string>>({
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    LLM_URL: "",
  });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState<CredentialKey | "">("");

  const load = useCallback(async () => {
    setError("");
    setStatus("");
    try {
      const [settingsResponse, credentialsResponse] = await Promise.all([api.settings(), api.credentials()]);
      setSettings(settingsResponse.settings);
      setOriginalSettings(settingsResponse.settings);
      setCredentials(credentialsResponse.credentials);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load settings.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = <K extends keyof DashboardSettings>(key: K, value: DashboardSettings[K]) => {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  };

  const dirty = Boolean(settings && originalSettings && JSON.stringify(settings) !== JSON.stringify(originalSettings));

  const save = async () => {
    if (!settings) {
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await api.updateSettings(settings);
      setSettings(response.settings);
      setOriginalSettings(response.settings);
      setStatus("settings saved");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to save settings.");
    } finally {
      setBusy(false);
    }
  };

  const saveCredential = async (key: CredentialKey) => {
    const value = credentialDrafts[key].trim();
    if (!value) {
      return;
    }
    setCredentialBusy(key);
    setError("");
    setStatus("");
    try {
      const response = await api.updateCredential({ key, value });
      setCredentials(response.credentials);
      setCredentialDrafts((current) => ({ ...current, [key]: "" }));
      setStatus(`${credentialLabel(key)} saved in Keychain`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `Unable to save ${credentialLabel(key)}.`);
    } finally {
      setCredentialBusy("");
    }
  };

  const removeCredential = async (key: CredentialKey) => {
    setCredentialBusy(key);
    setError("");
    setStatus("");
    try {
      const response = await api.deleteCredential(key);
      setCredentials(response.credentials);
      setCredentialDrafts((current) => ({ ...current, [key]: "" }));
      setStatus(`${credentialLabel(key)} removed from Keychain`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `Unable to remove ${credentialLabel(key)}.`);
    } finally {
      setCredentialBusy("");
    }
  };

  return (
    <div className="config-layout">
      <section className="card full">
        <CardHeader title="Config" meta="scoring and targeting" />
        {error ? <div className="banner inline">{error}</div> : null}
        {status ? <div className="status-line">{status}</div> : null}
        {settings ? (
          <form
            className="config-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="field">
              <span>Minimum fit score</span>
              <input
                max={10}
                min={0}
                step={1}
                type="number"
                value={settings.minFitScore}
                onChange={(event) => update("minFitScore", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Apply concurrency</span>
              <input
                max={16}
                min={1}
                step={1}
                type="number"
                value={settings.applyConcurrency}
                onChange={(event) => update("applyConcurrency", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Target role</span>
              <input value={settings.targetRole} onChange={(event) => update("targetRole", event.target.value)} />
            </label>
            <label className="field">
              <span>Location filter</span>
              <input value={settings.locationFilter} onChange={(event) => update("locationFilter", event.target.value)} />
            </label>
            <label className="field wide">
              <span>Score criteria</span>
              <textarea
                placeholder="Criteria the scoring step should use when ranking jobs."
                value={settings.scoreCriteria}
                onChange={(event) => update("scoreCriteria", event.target.value)}
              />
            </label>
            <label className="field wide">
              <span>Targeting criteria</span>
              <textarea
                placeholder="Role, company, location, seniority, and exclusion criteria for the search pipeline."
                value={settings.targetCriteria}
                onChange={(event) => update("targetCriteria", event.target.value)}
              />
            </label>
            <label className="field check">
              <input
                checked={settings.autoApply}
                type="checkbox"
                onChange={(event) => update("autoApply", event.target.checked)}
              />
              <span>Auto apply</span>
            </label>
            <div className="form-actions">
              <button className="tab on" disabled={!dirty || busy} type="submit">
                {busy ? "saving" : "save"}
              </button>
              <button
                className="tab"
                disabled={!dirty || busy || !originalSettings}
                onClick={() => originalSettings && setSettings(originalSettings)}
                type="button"
              >
                reset
              </button>
              <button className="tab" disabled={busy} onClick={() => void load()} type="button">
                reload
              </button>
            </div>
          </form>
        ) : (
          <Empty title="Loading config." />
        )}
      </section>
      <section className="card full">
        <CardHeader title="Credentials" meta="macOS Keychain" />
        <div className="credential-list">
          {CredentialKeys.map((key) => {
            const credential = credentials.find((item) => item.key === key);
            const configured = Boolean(credential?.configured);
            return (
              <div className="credential-row" key={key}>
                <span className={`tag ${configured ? "ok" : "muted"}`}>{configured ? "configured" : "missing"}</span>
                <span className="title-stack">
                  <b>{credential?.label ?? credentialLabel(key)}</b>
                  <span>{key}</span>
                </span>
                <input
                  aria-label={credential?.label ?? credentialLabel(key)}
                  placeholder={configured ? "Stored in Keychain" : "Paste value to store in Keychain"}
                  type="password"
                  value={credentialDrafts[key]}
                  onChange={(event) => setCredentialDrafts((current) => ({ ...current, [key]: event.target.value }))}
                />
                <span className="row-actions">
                  <button
                    className="tab on"
                    disabled={!credentialDrafts[key].trim() || credentialBusy === key}
                    onClick={() => void saveCredential(key)}
                    type="button"
                  >
                    save
                  </button>
                  <button
                    className="tab"
                    disabled={!configured || credentialBusy === key}
                    onClick={() => void removeCredential(key)}
                    type="button"
                  >
                    remove
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function credentialLabel(key: CredentialKey): string {
  if (key === "OPENAI_API_KEY") {
    return "OpenAI API key";
  }
  if (key === "GEMINI_API_KEY") {
    return "Gemini API key";
  }
  return "LLM endpoint";
}

function ProfileView(): JSX.Element {
  const [profile, setProfile] = useState<ProfileConfigResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [profileText, setProfileText] = useState("");
  const [styleText, setStyleText] = useState("");
  const [templateText, setTemplateText] = useState("");
  const [originalProfileText, setOriginalProfileText] = useState("");
  const [originalStyleText, setOriginalStyleText] = useState("");
  const [originalTemplateText, setOriginalTemplateText] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importProfile, setImportProfile] = useState(true);
  const [importStyle, setImportStyle] = useState(true);
  const [showImport, setShowImport] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [busy, setBusy] = useState("");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [profileMode, setProfileMode] = useState<"fields" | "source">("fields");

  const applyProfileResponse = useCallback((profileResponse: ProfileConfigResponse) => {
    const nextProfileText = JSON.stringify(profileResponse.profile, null, 2);
    const nextStyleText = JSON.stringify(profileResponse.style, null, 2);
    setProfile(profileResponse);
    setProfileText(nextProfileText);
    setStyleText(nextStyleText);
    setTemplateText(profileResponse.templateText);
    setOriginalProfileText(nextProfileText);
    setOriginalStyleText(nextStyleText);
    setOriginalTemplateText(profileResponse.templateText);
    setPreviewVersion((version) => version + 1);
  }, []);

  const load = useCallback(async () => {
    setLoadError("");
    setSaveStatus("");
    try {
      const [profileResponse, settingsResponse] = await Promise.all([api.profile(), api.settings()]);
      applyProfileResponse(profileResponse);
      setSettings(settingsResponse);
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "Unable to load profile.");
    }
  }, [applyProfileResponse]);

  useEffect(() => {
    void load();
  }, [load]);

  const profileDirty = profileText !== originalProfileText;
  const styleDirty = styleText !== originalStyleText;
  const templateDirty = templateText !== originalTemplateText;
  const anyDirty = profileDirty || styleDirty || templateDirty;

  const savePatch = async (label: string, patch: Parameters<typeof api.updateProfile>[0]) => {
    setBusy(label);
    setSaveStatus("");
    setLoadError("");
    try {
      const response = await api.updateProfile(patch);
      applyProfileResponse(response);
      setSaveStatus(`${label} saved`);
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : `Unable to save ${label}.`);
    } finally {
      setBusy("");
    }
  };

  const importResume = async () => {
    if (!selectedFile) {
      return;
    }
    setBusy("import");
    setSaveStatus("");
    setLoadError("");
    try {
      const imported = await api.importResume({
        filename: selectedFile.name,
        pdfBase64: await fileToBase64(selectedFile),
        importProfile,
        importStyle,
      });
      const nextProfile = imported.profile ?? profile?.profile ?? {};
      const nextStyle = imported.style ?? profile?.style ?? {};
      const nextTemplate = imported.templateText ?? templateText;
      if (imported.profile !== undefined) {
        setProfileText(JSON.stringify(imported.profile, null, 2));
      }
      if (imported.style !== undefined) {
        setStyleText(JSON.stringify(imported.style, null, 2));
      }
      if (imported.templateText !== undefined) {
        setTemplateText(imported.templateText);
      }
      setProfile({ ok: true, profile: nextProfile, style: nextStyle, templateText: nextTemplate });
      setSaveStatus(`import draft ${imported.action?.status ?? "ready"}`);
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "Unable to import resume.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="profile-layout">
      <section className="card">
        <CardHeader title="Profile" meta={settings ? `min fit ${settings.settings.minFitScore}` : "loading"} />
        {loadError ? <div className="banner inline">{loadError}</div> : null}
        {saveStatus ? <div className="status-line">{saveStatus}</div> : null}
        {showImport ? (
          <section className="import-panel">
            <label className="import-target">
              <span className="import-icon">PDF</span>
              <span>
                <b>Resume PDF</b>
                <small>{selectedFile?.name ?? "No file selected"}</small>
              </span>
              <input
                aria-label="Resume PDF"
                type="file"
                accept="application/pdf"
                onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              />
              <em>choose file</em>
            </label>
            <div className="import-options">
              <label>
                <input type="checkbox" checked={importProfile} onChange={(event) => setImportProfile(event.target.checked)} /> profile data
              </label>
              <label>
                <input type="checkbox" checked={importStyle} onChange={(event) => setImportStyle(event.target.checked)} /> style data
              </label>
              <button className="tab on" disabled={!selectedFile || busy === "import"} onClick={() => void importResume()} type="button">
                {busy === "import" ? "importing" : "import"}
              </button>
              <button className="tab" onClick={() => setShowImport(false)} type="button">
                hide
              </button>
            </div>
          </section>
        ) : (
          <button className="tab" onClick={() => setShowImport(true)} type="button">
            show import
          </button>
        )}
        <div className="editor-bulk-actions">
          <button
            className="tab on"
            disabled={!anyDirty || Boolean(busy)}
            onClick={() => void savePatch("profile files", { profileText, styleText, templateText })}
            type="button"
          >
            save all
          </button>
          <button
            className="tab"
            disabled={!anyDirty || Boolean(busy)}
            onClick={() => {
              setProfileText(originalProfileText);
              setStyleText(originalStyleText);
              setTemplateText(originalTemplateText);
            }}
            type="button"
          >
            discard all
          </button>
          <button className="tab" disabled={Boolean(busy)} onClick={() => void load()} type="button">
            reload
          </button>
        </div>
        <div className="profile-mode-tabs">
          <button className={`tab ${profileMode === "fields" ? "on" : ""}`} onClick={() => setProfileMode("fields")} type="button">
            fields
          </button>
          <button className={`tab ${profileMode === "source" ? "on" : ""}`} onClick={() => setProfileMode("source")} type="button">
            source
          </button>
        </div>
        {profileMode === "fields" ? (
          <StructuredProfileEditor
            profileText={profileText}
            styleText={styleText}
            onProfileTextChange={setProfileText}
            onStyleTextChange={setStyleText}
          />
        ) : (
          <>
            <Editor
              dirty={profileDirty}
              label="profile.json"
              saving={busy === "profile.json"}
              value={profileText}
              onChange={setProfileText}
              onDiscard={() => setProfileText(originalProfileText)}
              onSave={() => void savePatch("profile.json", { profileText })}
            />
            <Editor
              dirty={styleDirty}
              label="resume_style.json"
              saving={busy === "resume_style.json"}
              value={styleText}
              onChange={setStyleText}
              onDiscard={() => setStyleText(originalStyleText)}
              onSave={() => void savePatch("resume_style.json", { styleText })}
            />
            <Editor
              dirty={templateDirty}
              label="resume_template.tex"
              saving={busy === "resume_template.tex"}
              value={templateText}
              onChange={setTemplateText}
              onDiscard={() => setTemplateText(originalTemplateText)}
              onSave={() => void savePatch("resume_template.tex", { templateText })}
            />
          </>
        )}
      </section>
      <aside className="preview pdf-preview">
        <iframe
          className="pdf-preview-frame"
          key={previewVersion}
          src={api.profilePreviewPdfUrl(previewVersion)}
          title="Rendered resume PDF preview"
        />
      </aside>
    </div>
  );
}

type JsonRecord = Record<string, unknown>;

function StructuredProfileEditor({
  profileText,
  styleText,
  onProfileTextChange,
  onStyleTextChange,
}: {
  profileText: string;
  styleText: string;
  onProfileTextChange: (value: string) => void;
  onStyleTextChange: (value: string) => void;
}): JSX.Element {
  const profile = parseJsonRecord(profileText);
  const style = parseJsonRecord(styleText);

  if (!profile || !style) {
    return (
      <div className="banner inline">
        The structured editor needs valid JSON. Switch to source, fix the invalid file, then return to fields.
      </div>
    );
  }

  const updateProfileDraft = (updater: (draft: JsonRecord) => void) => {
    const draft = cloneJsonRecord(profile);
    updater(draft);
    onProfileTextChange(JSON.stringify(draft, null, 2));
  };

  const updateProfilePath = (path: string, value: unknown) => {
    updateProfileDraft((draft) => setPathValue(draft, path, value));
  };

  const updateStylePath = (path: string, value: unknown) => {
    const draft = cloneJsonRecord(style);
    setPathValue(draft, path, value);
    onStyleTextChange(JSON.stringify(draft, null, 2));
  };

  const setRequiredId = (path: string, id: string, checked: boolean) => {
    if (!id) {
      return;
    }
    updateProfileDraft((draft) => {
      const values = new Set(textArrayAt(draft, path));
      if (checked) {
        values.add(id);
      } else {
        values.delete(id);
      }
      setPathValue(draft, path, Array.from(values));
    });
  };

  const setRequiredBullet = (entryId: string, bullet: string, checked: boolean) => {
    if (!entryId || !bullet) {
      return;
    }
    updateProfileDraft((draft) => {
      const mapPath = "resume.tailoring_rules.required_bullets_by_experience_id";
      const existing = recordAt(draft, mapPath);
      const values = new Set(asTextArray(existing[entryId]));
      if (checked) {
        values.add(bullet);
      } else {
        values.delete(bullet);
      }
      setPathValue(draft, mapPath, { ...existing, [entryId]: Array.from(values) });
    });
  };

  const addRepeatItem = (path: string) => {
    updateProfileDraft((draft) => {
      const items = recordArrayAt(draft, path);
      setPathValue(draft, path, [...items, defaultRepeatItem(path)]);
    });
  };

  const removeRepeatItem = (path: string, index: number) => {
    updateProfileDraft((draft) => {
      const items = recordArrayAt(draft, path);
      setPathValue(
        draft,
        path,
        items.filter((_, itemIndex) => itemIndex !== index),
      );
    });
  };

  const addBullet = (entryIndex: number) => {
    updateProfileDraft((draft) => {
      const path = `resume.experience_entries.${entryIndex}.bullets`;
      setPathValue(draft, path, [...textArrayAt(draft, path), ""]);
    });
  };

  const removeBullet = (entryIndex: number, bulletIndex: number) => {
    updateProfileDraft((draft) => {
      const path = `resume.experience_entries.${entryIndex}.bullets`;
      setPathValue(
        draft,
        path,
        textArrayAt(draft, path).filter((_, index) => index !== bulletIndex),
      );
    });
  };

  const textField = (path: string, label: string, type = "text", attrs: Record<string, unknown> = {}) => (
    <label className="field">
      <span>{label}</span>
      <input
        {...attrs}
        type={type}
        value={textAt(profile, path)}
        onChange={(event) => updateProfilePath(path, type === "number" ? numberOrEmpty(event.target.value) : event.target.value)}
      />
    </label>
  );

  const selectField = (path: string, label: string, options: Array<[string, string]> | string[]) => (
    <label className="field">
      <span>{label}</span>
      <select value={textAt(profile, path)} onChange={(event) => updateProfilePath(path, event.target.value)}>
        {options.map((option) => {
          const value = Array.isArray(option) ? option[0] : option;
          const text = Array.isArray(option) ? option[1] : option;
          return (
            <option key={value} value={value}>
              {text}
            </option>
          );
        })}
      </select>
    </label>
  );

  const checkboxField = (path: string, label: string) => (
    <label className="field check">
      <input checked={Boolean(getPathValue(profile, path))} type="checkbox" onChange={(event) => updateProfilePath(path, event.target.checked)} />
      <span>{label}</span>
    </label>
  );

  const textareaField = (path: string, label: string, placeholder = "") => (
    <label className="field wide">
      <span>{label}</span>
      <textarea placeholder={placeholder} value={textAt(profile, path)} onChange={(event) => updateProfilePath(path, event.target.value)} />
    </label>
  );

  const listField = (path: string, label: string) => (
    <label className="field wide">
      <span>{label}</span>
      <textarea value={textArrayAt(profile, path).join("\n")} onChange={(event) => updateProfilePath(path, lines(event.target.value))} />
    </label>
  );

  const styleSelect = (path: string, label: string, options: Array<[string, string]>) => (
    <label className="field">
      <span>{label}</span>
      <select value={textAt(style, path)} onChange={(event) => updateStylePath(path, event.target.value)}>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );

  const styleNumber = (path: string, label: string, min: number, max: number, step: number) => (
    <label className="field">
      <span>{label}</span>
      <input
        max={max}
        min={min}
        step={step}
        type="number"
        value={textAt(style, path)}
        onChange={(event) => updateStylePath(path, numberOrEmpty(event.target.value))}
      />
    </label>
  );

  const experienceEntries = recordArrayAt(profile, "resume.experience_entries");
  const educationEntries = recordArrayAt(profile, "resume.education_entries");
  const skillCategories = recordArrayAt(profile, "resume.skill_categories");
  const requiredExperienceIds = new Set(textArrayAt(profile, "resume.tailoring_rules.required_experience_entry_ids"));
  const requiredEducationIds = new Set(textArrayAt(profile, "resume.tailoring_rules.required_education_entry_ids"));
  const requiredSkillIds = new Set(textArrayAt(profile, "resume.tailoring_rules.required_skill_category_ids"));

  return (
    <div className="profile-sections">
      <section className="form-section">
        <h3>Personal information</h3>
        <div className="field-grid">
          {textField("personal.full_name", "Full name", "text", { required: true })}
          {textField("personal.preferred_name", "Preferred name")}
          {textField("personal.email", "Email", "email", { required: true })}
          {textField("personal.password", "Application password", "password", { autoComplete: "new-password" })}
          {textField("personal.phone", "Phone", "tel")}
          {textField("personal.address", "Address")}
          {textField("personal.city", "City")}
          {textField("personal.province_state", "State / province")}
          {textField("personal.country", "Country")}
          {textField("personal.postal_code", "Postal code")}
          {textField("personal.linkedin_url", "LinkedIn URL", "url")}
          {textField("personal.github_url", "GitHub URL", "url")}
          {textField("personal.portfolio_url", "Portfolio URL", "url")}
          {textField("personal.website_url", "Website URL", "url")}
        </div>
      </section>

      <section className="form-section">
        <h3>Application defaults</h3>
        <div className="field-grid">
          {selectField("work_authorization.legally_authorized_to_work", "Legally authorized to work", ["Yes", "No"])}
          {selectField("work_authorization.require_sponsorship", "Requires sponsorship", ["No", "Yes"])}
          {textField("work_authorization.work_permit_type", "Work permit type")}
          {textField("availability.earliest_start_date", "Earliest start date", "date")}
          {selectField("availability.available_for_full_time", "Available full-time", ["Yes", "No"])}
          {selectField("availability.available_for_contract", "Available for contract", ["No", "Yes"])}
          {textField("compensation.salary_expectation", "Salary expectation", "number", { min: 0, step: 1000 })}
          {textField("compensation.salary_currency", "Salary currency")}
          {textField("compensation.salary_range_min", "Salary range min", "number", { min: 0, step: 1000 })}
          {textField("compensation.salary_range_max", "Salary range max", "number", { min: 0, step: 1000 })}
          {textField("compensation.currency_conversion_note", "Currency note")}
        </div>
      </section>

      <section className="form-section">
        <h3>Resume baseline</h3>
        <div className="field-grid">
          {textField("experience.years_of_experience_total", "Total years of experience", "number", { min: 0, step: 1 })}
          {textField("experience.education_level", "Education level")}
          {textField("experience.current_job_title", "Current job title")}
          {textField("experience.current_company", "Current company")}
          {textField("experience.target_role", "Target role")}
          {textField("resume.tailoring_rules.max_experience_bullets", "Max bullets per role", "number", { min: 1, max: 10, step: 1 })}
        </div>
        <div className="field-grid one">
          {listField("resume_constraints.real_metrics", "Real metrics the AI may reuse")}
          {textareaField("resume.executive_profile.baseline_text", "Executive profile baseline")}
        </div>
      </section>

      <section className="form-section">
        <h3>Tailoring controls</h3>
        <div className="field-grid">
          {selectField("resume.tailoring_rules.tailoring_policy.mode", "Tailoring mode", [
            ["strict", "Strict"],
            ["balanced", "Balanced"],
            ["aggressive", "Aggressive"],
          ])}
          {selectField("resume.tailoring_rules.writing_style.tone", "Writing tone", [
            ["direct", "Direct"],
            ["executive", "Executive"],
            ["technical", "Technical"],
            ["confident", "Confident"],
            ["warm", "Warm"],
          ])}
          {selectField("resume.tailoring_rules.writing_style.bullet_style", "Bullet style", [
            ["balanced", "Balanced"],
            ["impact", "Impact"],
            ["technical_depth", "Technical depth"],
            ["leadership", "Leadership"],
          ])}
          {selectField("resume.tailoring_rules.writing_style.verbosity", "Verbosity", [
            ["concise", "Concise"],
            ["balanced", "Balanced"],
            ["detailed", "Detailed"],
          ])}
          {selectField("resume.tailoring_rules.writing_style.keyword_density", "Keyword density", [
            ["natural", "Natural"],
            ["moderate", "Moderate"],
            ["high", "High"],
          ])}
          {checkboxField("resume.tailoring_rules.writing_style.avoid_first_person", "Avoid first-person language")}
          {checkboxField("resume.tailoring_rules.tailoring_policy.allow_summary_rewrite", "AI may rewrite the executive summary")}
          {checkboxField("resume.tailoring_rules.tailoring_policy.allow_title_reframing", "AI may reframe experience titles")}
          {checkboxField("resume.tailoring_rules.tailoring_policy.allow_achievement_rewriting", "AI may rewrite achievement bullets")}
          {checkboxField("resume.tailoring_rules.tailoring_policy.allow_skill_reordering", "AI may reorder or trim skill items")}
          {checkboxField("resume.tailoring_rules.tailoring_policy.allow_minor_inference", "AI may make minor inferred phrasing")}
        </div>
        <div className="field-grid one">
          {textareaField("resume.tailoring_rules.custom_tailoring_prompt", "Additional tailoring prompt", "Optional guidance injected into every resume tailoring prompt.")}
        </div>
      </section>

      <section className="form-section">
        <h3>Resume style</h3>
        <div className="field-grid">
          {styleSelect("document_font_size", "Text size", [
            ["10pt", "Small"],
            ["11pt", "Regular"],
            ["12pt", "Large"],
          ])}
          {styleSelect("font_family", "Text font", [
            ["sans", "Sans"],
            ["roman", "Serif"],
          ])}
          {styleSelect("body_alignment", "Body alignment", [
            ["justified", "Justified"],
            ["left", "Left aligned"],
          ])}
          {styleSelect("moderncv_style", "Template style", [
            ["banking", "Banking"],
            ["classic", "Classic"],
            ["casual", "Casual"],
            ["oldstyle", "Oldstyle"],
            ["fancy", "Fancy"],
          ])}
          {styleSelect("moderncv_color", "Accent color", [
            ["black", "Black"],
            ["blue", "Blue"],
            ["burgundy", "Burgundy"],
            ["green", "Green"],
            ["grey", "Grey"],
            ["orange", "Orange"],
            ["purple", "Purple"],
            ["red", "Red"],
          ])}
          {styleSelect("paper_size", "Paper", [
            ["a4paper", "A4"],
            ["letterpaper", "Letter"],
          ])}
          {styleNumber("page_scale", "Page scale", 0.7, 1, 0.01)}
          {styleNumber("hints_column_width_cm", "Date column width (cm)", 1.5, 5, 0.1)}
        </div>
      </section>

      <section className="form-section">
        <h3>Experience entries</h3>
        <div className="repeat-list">
          {experienceEntries.map((entry, index) => {
            const entryId = textFrom(entry.id);
            const bullets = asTextArray(entry.bullets);
            const requiredBullets = new Set(asTextArray(recordAt(profile, "resume.tailoring_rules.required_bullets_by_experience_id")[entryId]));
            return (
              <div className="repeat-card" key={`${entryId || "experience"}-${index}`}>
                <div className="repeat-hd">
                  <b>{textFrom(entry.title) || `Experience ${index + 1}`}</b>
                  <div className="repeat-controls">
                    <label className="choice">
                      <input
                        checked={requiredExperienceIds.has(entryId)}
                        disabled={!entryId}
                        type="checkbox"
                        onChange={(event) =>
                          setRequiredId("resume.tailoring_rules.required_experience_entry_ids", entryId, event.target.checked)
                        }
                      />
                      <span>must appear in final resume</span>
                    </label>
                    <button className="tab" onClick={() => removeRepeatItem("resume.experience_entries", index)} type="button">
                      remove experience
                    </button>
                  </div>
                </div>
                <div className="field-grid">
                  {textField(`resume.experience_entries.${index}.id`, "Entry ID")}
                  {textField(`resume.experience_entries.${index}.date_range`, "Date range")}
                  {textField(`resume.experience_entries.${index}.title`, "Title")}
                  {textField(`resume.experience_entries.${index}.company`, "Company")}
                  {textField(`resume.experience_entries.${index}.location`, "Location")}
                </div>
                <div className="bullet-list">
                  {bullets.map((bullet, bulletIndex) => (
                    <div className="bullet-row" key={`${entryId}-${bulletIndex}`}>
                      <label className="field">
                        <span>Bullet</span>
                        <textarea
                          value={bullet}
                          onChange={(event) =>
                            updateProfilePath(`resume.experience_entries.${index}.bullets.${bulletIndex}`, event.target.value)
                          }
                        />
                      </label>
                      <label className="choice">
                        <input
                          checked={requiredBullets.has(bullet)}
                          disabled={!entryId || !bullet}
                          type="checkbox"
                          onChange={(event) => setRequiredBullet(entryId, bullet, event.target.checked)}
                        />
                        <span>must appear</span>
                      </label>
                      <button className="tab" onClick={() => removeBullet(index, bulletIndex)} type="button">
                        remove bullet
                      </button>
                    </div>
                  ))}
                  <button className="tab" onClick={() => addBullet(index)} type="button">
                    add bullet
                  </button>
                </div>
              </div>
            );
          })}
          <button className="tab" onClick={() => addRepeatItem("resume.experience_entries")} type="button">
            add experience
          </button>
        </div>
      </section>

      <section className="form-section">
        <h3>Education</h3>
        <div className="repeat-list">
          {educationEntries.map((entry, index) => {
            const entryId = textFrom(entry.id);
            return (
              <div className="repeat-card" key={`${entryId || "education"}-${index}`}>
                <div className="repeat-hd">
                  <b>{textFrom(entry.degree) || `Education ${index + 1}`}</b>
                  <div className="repeat-controls">
                    <label className="choice">
                      <input
                        checked={requiredEducationIds.has(entryId)}
                        disabled={!entryId}
                        type="checkbox"
                        onChange={(event) =>
                          setRequiredId("resume.tailoring_rules.required_education_entry_ids", entryId, event.target.checked)
                        }
                      />
                      <span>must appear in final resume</span>
                    </label>
                    <button className="tab" onClick={() => removeRepeatItem("resume.education_entries", index)} type="button">
                      remove education
                    </button>
                  </div>
                </div>
                <div className="field-grid">
                  {textField(`resume.education_entries.${index}.id`, "Entry ID")}
                  {textField(`resume.education_entries.${index}.date`, "Completion month", "month")}
                  {textField(`resume.education_entries.${index}.degree`, "Degree")}
                  {textField(`resume.education_entries.${index}.institution`, "Institution")}
                  {textField(`resume.education_entries.${index}.location`, "Location")}
                </div>
              </div>
            );
          })}
          <button className="tab" onClick={() => addRepeatItem("resume.education_entries")} type="button">
            add education
          </button>
        </div>
      </section>

      <section className="form-section">
        <h3>Skill categories</h3>
        <div className="repeat-list">
          {skillCategories.map((entry, index) => {
            const entryId = textFrom(entry.id);
            return (
              <div className="repeat-card" key={`${entryId || "skills"}-${index}`}>
                <div className="repeat-hd">
                  <b>{textFrom(entry.label) || `Skill category ${index + 1}`}</b>
                  <div className="repeat-controls">
                    <label className="choice">
                      <input
                        checked={requiredSkillIds.has(entryId)}
                        disabled={!entryId}
                        type="checkbox"
                        onChange={(event) => setRequiredId("resume.tailoring_rules.required_skill_category_ids", entryId, event.target.checked)}
                      />
                      <span>must appear in final resume</span>
                    </label>
                    <button className="tab" onClick={() => removeRepeatItem("resume.skill_categories", index)} type="button">
                      remove skill category
                    </button>
                  </div>
                </div>
                <div className="field-grid">
                  {textField(`resume.skill_categories.${index}.id`, "Category ID")}
                  {textField(`resume.skill_categories.${index}.label`, "Label")}
                  {listField(`resume.skill_categories.${index}.items`, "Skills")}
                </div>
              </div>
            );
          })}
          <button className="tab" onClick={() => addRepeatItem("resume.skill_categories")} type="button">
            add skill category
          </button>
        </div>
      </section>

      <section className="form-section">
        <h3>Voluntary EEO</h3>
        <div className="field-grid">
          {textField("eeo_voluntary.gender", "Gender")}
          {textField("eeo_voluntary.race_ethnicity", "Race / ethnicity")}
          {textField("eeo_voluntary.veteran_status", "Veteran status")}
          {textField("eeo_voluntary.disability_status", "Disability status")}
        </div>
      </section>
    </div>
  );
}

function parseJsonRecord(text: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(text);
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cloneJsonRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getPathValue(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) {
      return undefined;
    }
    const key = /^\d+$/.test(segment) ? Number(segment) : segment;
    return (current as Record<string | number, unknown>)[key];
  }, source);
}

function setPathValue(source: JsonRecord, path: string, value: unknown): void {
  const segments = path.split(".");
  let current: Record<string | number, unknown> = source;
  segments.forEach((segment, index) => {
    const key = /^\d+$/.test(segment) ? Number(segment) : segment;
    if (index === segments.length - 1) {
      current[key] = value;
      return;
    }
    const nextSegment = segments[index + 1] ?? "";
    const nextIsArray = /^\d+$/.test(nextSegment);
    if (!current[key] || typeof current[key] !== "object") {
      current[key] = nextIsArray ? [] : {};
    }
    current = current[key] as Record<string | number, unknown>;
  });
}

function textAt(source: unknown, path: string): string {
  return textFrom(getPathValue(source, path));
}

function textFrom(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function textArrayAt(source: unknown, path: string): string[] {
  return asTextArray(getPathValue(source, path));
}

function asTextArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(textFrom).filter((item) => item.length > 0) : [];
}

function recordAt(source: unknown, path: string): JsonRecord {
  const value = getPathValue(source, path);
  return isJsonRecord(value) ? value : {};
}

function recordArrayAt(source: unknown, path: string): JsonRecord[] {
  const value = getPathValue(source, path);
  return Array.isArray(value) ? value.filter(isJsonRecord) : [];
}

function numberOrEmpty(value: string): number | string {
  return value.trim() ? Number(value) : "";
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function defaultRepeatItem(path: string): JsonRecord {
  if (path === "resume.experience_entries") {
    return { id: "", date_range: "", title: "", company: "", location: "", bullets: [""] };
  }
  if (path === "resume.education_entries") {
    return { id: "", date: "", degree: "", institution: "", location: "" };
  }
  if (path === "resume.skill_categories") {
    return { id: "", label: "", items: [""] };
  }
  return {};
}

function JobDrawer({ jobKey, onClose }: { jobKey: string; onClose: () => void }): JSX.Element {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [actionBusy, setActionBusy] = useState("");

  useEscapeKey(true, onClose);

  const loadDetail = useCallback(async () => {
    setDetail(null);
    setError("");
    try {
      setDetail(await api.job(jobKey));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load job.");
    }
  }, [jobKey]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const runAction = async (label: string, action: () => Promise<{ status: string }>) => {
    setActionBusy(label);
    setActionStatus("");
    setError("");
    try {
      const result = await action();
      setActionStatus(`${label} ${result.status}`);
      await loadDetail();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `Unable to ${label}.`);
    } finally {
      setActionBusy("");
    }
  };

  const openArtifact = async (artifact: ArtifactSummary) => {
    await runAction("open artifact", async () => {
      const result = await api.openArtifact(artifact.artifactId);
      return { status: result.opened ? "opened" : "failed" };
    });
  };

  return (
    <div className="drawer-backdrop">
      <aside className="drawer">
        <button aria-label="Close job details" className="drawer-close" onClick={onClose} type="button">
          x
        </button>
        {error ? <Empty title={error} /> : null}
        {!detail && !error ? <Empty title="Loading job." /> : null}
        {detail ? (
          <>
            <div className="drawer-head">
              <span className={`fit ${scoreTier(detail.job.fitScore)}`}>{detail.job.fitScore ?? "-"}</span>
              <span>
                <small>
                  {detail.job.company}
                  {detail.job.source && detail.job.source !== detail.job.company ? ` · source: ${detail.job.source}` : ""}
                </small>
                <h2>{detail.job.title}</h2>
                <p>{detail.job.location || "-"} · {detail.job.salary || "-"}</p>
                <a className="external-link" href={detail.job.url} rel="noreferrer" target="_blank">
                  open original posting
                </a>
              </span>
            </div>
            <div className="action-panel">
              <span>
                <b>{detail.job.nextAction || "Local actions"}</b>
                <small>
                  {detail.job.currentStage} · {detail.job.currentState}
                </small>
              </span>
              <button
                className="tab on"
                disabled={Boolean(actionBusy)}
                onClick={() =>
                  void runAction("retry stage", () =>
                    api.retryStage(detail.job.jobKey, {
                      stage: detail.job.currentStage,
                      resetAttempts: false,
                      runAfter: false,
                      dryRun: false,
                    }),
                  )
                }
                type="button"
              >
                retry
              </button>
              <button
                className="tab"
                disabled={Boolean(actionBusy)}
                onClick={() => void runAction("apply dry-run", () => api.applyJob(detail.job.jobKey, { dryRun: true }))}
                type="button"
              >
                dry-run
              </button>
              <button
                className="tab"
                disabled={Boolean(actionBusy)}
                onClick={() => void runAction("mark applied", () => api.markApplied(detail.job.jobKey))}
                type="button"
              >
                applied
              </button>
              <button
                className="tab"
                disabled={Boolean(actionBusy)}
                onClick={() => void runAction("mark skipped", () => api.markSkipped(detail.job.jobKey))}
                type="button"
              >
                skip
              </button>
            </div>
            {actionStatus ? <div className="status-line">{actionStatus}</div> : null}
            <div className="timeline">
              {detail.stages.map((stage) => (
                <div key={stage.stage}>
                  <StatusDot state={stage.state} />
                  <b>{stage.stage}</b>
                  <span>{stage.state}</span>
                </div>
              ))}
            </div>
            <Section title="Artifacts">
              {detail.artifacts.map((artifact) => (
                <div className="mini-row" key={artifact.artifactId}>
                  <span className={`tag ${artifactStatusTone(artifact.status)}`}>{artifact.status}</span>
                  <span>{artifact.type}</span>
                  <code>{artifact.localPath}</code>
                  <button
                    className="tab on"
                    disabled={Boolean(actionBusy) || artifact.status === "missing"}
                    title={artifact.status === "missing" ? "Local file is missing; regenerate this artifact before opening it." : undefined}
                    onClick={() => void openArtifact(artifact)}
                    type="button"
                  >
                    open
                  </button>
                </div>
              ))}
            </Section>
            <Section title="Score reasoning">
              <ScoreReasoning text={detail.job.scoreReasoning} fitScore={detail.job.fitScore} />
            </Section>
            <Section title="Description">
              <JobDescription text={detail.job.descriptionPreview} />
            </Section>
          </>
        ) : null}
      </aside>
    </div>
  );
}

function ApplyRunDrawer({
  run,
  onClose,
  onOpenJob,
}: {
  run: ApplyRunSummary;
  onClose: () => void;
  onOpenJob: (jobKey: string) => void;
}): JSX.Element {
  useEscapeKey(true, onClose);

  return (
    <div className="drawer-backdrop">
      <aside className="drawer detail-drawer">
        <button aria-label="Close apply run details" className="drawer-close" onClick={onClose} type="button">
          x
        </button>
        <div className="drawer-head">
          <StatusDot state={run.status === "running" ? "running" : run.status === "failed" ? "failed" : "succeeded"} />
          <span>
            <small>{run.company}</small>
            <h2>{run.title || "Apply run"}</h2>
            <p>{run.status} · {run.dryRun ? "dry-run" : "live run"}</p>
          </span>
        </div>
        <Section title="Run details">
          <dl className="detail-list">
            <div>
              <dt>Run id</dt>
              <dd className="mono">{run.runId}</dd>
            </div>
            <div>
              <dt>Job</dt>
              <dd>{run.title || run.jobKey}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{run.status}</dd>
            </div>
            <div>
              <dt>Dry-run</dt>
              <dd>{run.dryRun ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{formatDateTime(run.startedAt)}</dd>
            </div>
          </dl>
          <button className="tab on" disabled={!run.jobKey} onClick={() => onOpenJob(run.jobKey)} type="button">
            open related job
          </button>
        </Section>
      </aside>
    </div>
  );
}

function ActivityDetailDrawer({ activity, onClose }: { activity: ActivityEvent; onClose: () => void }): JSX.Element {
  useEscapeKey(true, onClose);

  return (
    <div className="drawer-backdrop">
      <aside className="drawer detail-drawer">
        <button aria-label="Close activity details" className="drawer-close" onClick={onClose} type="button">
          x
        </button>
        <div className="drawer-head">
          <span className={`tag ${activity.level === "error" ? "danger" : "muted"}`}>{activity.level}</span>
          <span>
            <small>{activity.stage}</small>
            <h2>{activity.message}</h2>
            <p>{formatDateTime(activity.at)}</p>
          </span>
        </div>
        <Section title="Event details">
          <dl className="detail-list">
            <div>
              <dt>Event id</dt>
              <dd className="mono">{activity.eventId}</dd>
            </div>
            <div>
              <dt>Stage</dt>
              <dd>{activity.stage}</dd>
            </div>
            <div>
              <dt>Level</dt>
              <dd>{activity.level}</dd>
            </div>
            <div>
              <dt>Timestamp</dt>
              <dd>{formatDateTime(activity.at)}</dd>
            </div>
            <div>
              <dt>Message</dt>
              <dd>{activity.message}</dd>
            </div>
          </dl>
        </Section>
      </aside>
    </div>
  );
}

function CardHeader({ title, meta }: { title: string; meta?: string }): JSX.Element {
  return (
    <header className="card-hd">
      <h2>{title}</h2>
      {meta ? <span className="meta">{meta}</span> : null}
    </header>
  );
}

function SegmentBar({ total, values }: { total: number; values: Array<[string, number]> }): JSX.Element {
  return (
    <span className="bar">
      {values.map(([name, value]) => (
        <span className={`seg-${name}`} key={name} style={{ width: `${total ? (value / total) * 100 : 0}%` }} />
      ))}
    </span>
  );
}

function Pager({
  pagination,
  page,
  onPage,
}: {
  pagination: PaginatedResponse<unknown>["pagination"] | undefined;
  page: number;
  onPage: (page: number) => void;
}): JSX.Element {
  return (
    <div className="pager">
      <button className="tab" disabled={page <= 1} onClick={() => onPage(page - 1)} type="button">
        previous
      </button>
      <span className="meta">
        page {pagination?.page ?? page} / {pagination?.pages ?? 1}
      </span>
      <button className="tab" disabled={page >= (pagination?.pages ?? 1)} onClick={() => onPage(page + 1)} type="button">
        next
      </button>
    </div>
  );
}

function Editor({
  dirty,
  label,
  saving,
  value,
  onChange,
  onDiscard,
  onSave,
}: {
  dirty: boolean;
  label: string;
  saving: boolean;
  value: string;
  onChange: (value: string) => void;
  onDiscard: () => void;
  onSave: () => void;
}): JSX.Element {
  return (
    <label className={`editor ${dirty ? "dirty" : ""}`}>
      <span>
        {label}
        {dirty ? (
          <span className="field-actions-inline">
            <button
              className="tab on"
              onClick={(event) => {
                event.preventDefault();
                onSave();
              }}
              disabled={saving}
              type="button"
            >
              {saving ? "saving" : "save"}
            </button>
            <button
              className="tab"
              onClick={(event) => {
                event.preventDefault();
                onDiscard();
              }}
              disabled={saving}
              type="button"
            >
              discard
            </button>
          </span>
        ) : null}
      </span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function ScoreReasoning({ text, fitScore }: { text: string; fitScore: number | null }): JSX.Element {
  const parsed = parseScoreReasoning(text);
  const keywordOnlyReason =
    parsed.reason && parsed.keywords.length
      ? parsed.reason.toLowerCase().replace(/\s+/g, " ") === parsed.keywords.join(", ").toLowerCase().replace(/\s+/g, " ")
      : false;
  return (
    <div className="score-explainer">
      <div className="score-line">
        <span className={`fit ${scoreTier(fitScore)}`}>{fitScore ?? parsed.score ?? "-"}</span>
        <span>
          <b>{fitScore ?? parsed.score ?? "-"} / 10 fit score</b>
          <small>Current scoring output. Feedback-based personalization is tracked as backlog work.</small>
        </span>
      </div>
      {parsed.reason && !keywordOnlyReason ? (
        <p>{parsed.reason}</p>
      ) : (
        <p className="muted">
          This stored score only includes keyword evidence. It does not yet explain weighting, missing signals, or why this
          landed at this exact value.
        </p>
      )}
      {parsed.keywords.length ? (
        <div className="keyword-list" aria-label="Tracked keywords">
          {parsed.keywords.map((keyword) => (
            <span className="tag info" key={keyword}>
              {keyword}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function JobDescription({ text }: { text: string }): JSX.Element {
  const blocks = descriptionBlocks(text);
  if (!blocks.length) {
    return <p className="muted">No description captured.</p>;
  }
  return (
    <div className="description-text">
      {blocks.map((block, index) => (
        <p key={`${block.slice(0, 40)}-${index}`}>{block}</p>
      ))}
    </div>
  );
}

function SelectPairs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as T)}>
      {options.map(([item, label]) => (
        <option key={item} value={item}>
          {label}
        </option>
      ))}
    </select>
  );
}

function MultiSelectFilter({
  label,
  options,
  values,
  onChange,
}: {
  label: string;
  options: string[];
  values: string[];
  onChange: (values: string[]) => void;
}): JSX.Element {
  const selected = new Set(values);
  const toggle = (value: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) {
      next.add(value);
    } else {
      next.delete(value);
    }
    onChange(options.filter((option) => next.has(option)));
  };
  return (
    <details className="multi-filter">
      <summary>{multiSelectSummary(label, values)}</summary>
      <div className="multi-filter-menu">
        <div className="multi-filter-head">
          <span className="meta">{options.length} available</span>
          <button className="tab" disabled={!values.length} onClick={() => onChange([])} type="button">
            clear
          </button>
        </div>
        <div className="multi-filter-options">
          {options.length ? (
            options.map((option) => (
              <label className="multi-filter-option" key={option}>
                <input checked={selected.has(option)} type="checkbox" onChange={(event) => toggle(option, event.target.checked)} />
                <span>{option}</span>
              </label>
            ))
          ) : (
            <span className="empty compact">No values.</span>
          )}
        </div>
      </div>
    </details>
  );
}

function DirectionSelect({ value, onChange }: { value: Direction; onChange: (value: Direction) => void }): JSX.Element {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as Direction)}>
      <option value="desc">desc</option>
      <option value="asc">asc</option>
    </select>
  );
}

function PageSize({ value, onChange }: { value: number; onChange: (value: number) => void }): JSX.Element {
  return (
    <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {[25, 50, 100, 200].map((item) => (
        <option key={item} value={item}>
          {item}/page
        </option>
      ))}
    </select>
  );
}

function multiSelectSummary(label: string, values: string[]): string {
  if (!values.length) {
    return `all ${pluralFilterLabel(label)}`;
  }
  if (values.length === 1) {
    return `${label}: ${values[0]}`;
  }
  return `${label}: ${values.length} selected`;
}

function pluralFilterLabel(label: string): string {
  if (label === "company") return "companies";
  if (label === "job") return "jobs";
  return `${label}s`;
}

function scoreFilterValue(value: string): number | undefined {
  if (value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampScoreInput(value: string): string {
  if (value === "") {
    return "";
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return String(Math.min(10, Math.max(0, Math.trunc(parsed))));
}

function StatusDot({ state }: { state: string }): JSX.Element {
  return <span className={`status-dot ${state}`} />;
}

function Empty({ title }: { title: string }): JSX.Element {
  return <div className="empty">{title}</div>;
}

function scoreTier(score: number | null): string {
  if ((score ?? 0) >= 8) {
    return "good";
  }
  if ((score ?? 0) >= 6) {
    return "mid";
  }
  return "none";
}

function stateTone(state: string): string {
  if (["failed", "exhausted"].includes(state)) {
    return "danger";
  }
  if (state === "blocked") {
    return "warn";
  }
  if (state === "succeeded") {
    return "ok";
  }
  return "muted";
}

function artifactStatusTone(status: string): string {
  if (status === "active" || status === "approved") {
    return "ok";
  }
  if (status === "missing" || status === "stale") {
    return "warn";
  }
  return "muted";
}

function useEscapeKey(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onEscape();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [active, onEscape]);
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function parseScoreReasoning(text: string): { keywords: string[]; reason: string; score: number | null } {
  const scoreMatch = text.match(/\bscore\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const keywordMatch = text.match(/\bkeywords\s*:\s*(.*)$/i);
  const score = scoreMatch ? Number.parseFloat(scoreMatch[1] ?? "") : null;
  const keywords = keywordMatch?.[1]
    ? keywordMatch[1]
        .split(",")
        .map((keyword) => keyword.trim())
        .filter(Boolean)
    : [];
  const cleanedText = text
    .replace(/\bscore\s*:\s*[0-9]+(?:\.[0-9]+)?/gi, "")
    .replace(/\bkeywords\s*:.*$/i, "")
    .trim();
  const lines = cleanedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const reason = lines
    .join("\n")
    .trim();
  return {
    keywords,
    reason,
    score: Number.isFinite(score) ? score : null,
  };
}

function descriptionBlocks(text: string): string[] {
  const explicitBlocks = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (explicitBlocks.length > 1) {
    return explicitBlocks;
  }
  const collapsed = explicitBlocks[0] ?? "";
  if (!collapsed) {
    return [];
  }
  const sentences = collapsed.split(/(?<=[.!?])\s+(?=[A-Z0-9*])/);
  const blocks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > 520 && current) {
      blocks.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current) {
    blocks.push(current);
  }
  return blocks;
}

function formatCompanySource(company: string, source: string): string {
  if (!source || source === "unknown" || source === company) {
    return company;
  }
  return `${company} · ${source}`;
}

function groupArtifacts(artifacts: ArtifactSummary[]): ArtifactGroup[] {
  const groups = new Map<string, ArtifactGroup>();
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    const artifactKey = `${artifact.jobKey}:${canonicalArtifactVariantType(artifact.type)}:${artifact.localPath}`;
    if (seen.has(artifactKey)) {
      continue;
    }
    seen.add(artifactKey);
    const groupKey = artifact.jobKey || `${artifact.title}:${artifact.company}`;
    const group = groups.get(groupKey) ?? {
      groupKey,
      jobKey: artifact.jobKey,
      title: artifact.title,
      company: artifact.company,
      artifacts: [],
    };
    group.artifacts.push(artifact);
    groups.set(groupKey, group);
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    artifacts: group.artifacts.slice().sort((left, right) => compareArtifactVersions(left, right)),
  }));
}

function compareArtifactVersions(left: ArtifactSummary, right: ArtifactSummary): number {
  const leftType = canonicalArtifactVariantType(left.type);
  const rightType = canonicalArtifactVariantType(right.type);
  return artifactVersionRank(leftType) - artifactVersionRank(rightType) || leftType.localeCompare(rightType);
}

function artifactVersionRank(type: string): number {
  if (type.includes("resume") && type.endsWith("_txt")) {
    return 10;
  }
  if (type.includes("resume") && type.endsWith("_pdf")) {
    return 20;
  }
  if (type.includes("cover") && type.endsWith("_txt")) {
    return 30;
  }
  if (type.includes("cover") && type.endsWith("_pdf")) {
    return 40;
  }
  return 50;
}

function artifactKind(type: string): string {
  return type.includes("cover") ? "cover" : type.includes("resume") ? "resume" : "artifact";
}

function artifactDisplayLabel(type: string): string {
  const normalized = canonicalArtifactVariantType(type);
  if (normalized === "tailored_resume_pdf") return "tailored resume PDF";
  if (normalized === "tailored_resume_txt") return "tailored resume text";
  if (normalized === "cover_letter_pdf") return "cover letter PDF";
  if (normalized === "cover_letter_txt") return "cover letter text";
  return normalized.replaceAll("_", " ");
}

function canonicalArtifactVariantType(type: string): string {
  if (type === "resume_pdf") return "tailored_resume_pdf";
  if (type === "tailored_resume") return "tailored_resume_txt";
  if (type === "cover_letter") return "cover_letter_txt";
  return type;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
