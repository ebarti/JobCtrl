import {
  type ArtifactSortField,
  type ArtifactSummary,
  createJobHunterApiClient,
  type DashboardSummary,
  type JobDetail,
  type JobSummary,
  type JobSortField,
  type PaginatedResponse,
  type ProfileConfigResponse,
  type SettingsResponse,
  type Stage,
  type StageState,
  STAGES,
} from "@jobhunter/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type View = "dashboard" | "jobs" | "artifacts" | "profile";
type Direction = "asc" | "desc";
type LoadState = "idle" | "loading" | "ready" | "error";

const api = createJobHunterApiClient(import.meta.env.VITE_JOBHUNTER_API_BASE_URL ?? "");

const jobSortFields = [
  ["discovered_at", "Discovered"],
  ["title", "Title"],
  ["company", "Company"],
  ["fit_score", "Fit score"],
  ["current_stage", "Stage"],
  ["current_state", "State"],
] as const;

const artifactSortFields = [
  ["created_at", "Created"],
  ["title", "Title"],
  ["company", "Company"],
  ["type", "Type"],
  ["status", "Status"],
  ["size_bytes", "Size"],
] as const;

export function App(): JSX.Element {
  const [view, setView] = useState<View>("dashboard");
  const [density, setDensity] = useState("regular");
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [selectedJobKey, setSelectedJobKey] = useState("");

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

  const selectKpi = (target: "all" | "failed" | "blocked" | "ready") => {
    setView("jobs");
    window.dispatchEvent(new CustomEvent("jobhunter:set-jobs-filter", { detail: target }));
  };

  return (
    <div className="app" data-density={density}>
      <header className="topbar">
        <button className="brand" onClick={() => setView("dashboard")} type="button">
          <span className="brand-mark">jh</span>
          <span>jobhunter</span>
        </button>
        <nav className="nav" aria-label="Main navigation">
          {(["dashboard", "jobs", "artifacts", "profile"] as const).map((item) => (
            <button className={view === item ? "on" : ""} key={item} onClick={() => setView(item)} type="button">
              {item}
            </button>
          ))}
        </nav>
        <select aria-label="Row density" className="select" value={density} onChange={(event) => setDensity(event.target.value)}>
          <option value="compact">compact</option>
          <option value="regular">regular</option>
          <option value="comfy">comfy</option>
        </select>
        <button className="tab" onClick={() => void refreshSummary()} type="button">
          refresh
        </button>
        <span className={`pulse ${connected ? "" : "offline"}`}>{connected ? "live" : "offline"}</span>
      </header>

      {summary ? <Kpis summary={summary} onSelect={selectKpi} /> : <KpiSkeleton />}

      {error ? <div className="banner">{error}</div> : null}

      <main className="main">
        {view === "dashboard" ? (
          <Dashboard summary={summary} status={status} onOpenJobs={selectKpi} />
        ) : view === "jobs" ? (
          <JobsView onOpenJob={setSelectedJobKey} />
        ) : view === "artifacts" ? (
          <ArtifactsView onOpenJob={setSelectedJobKey} />
        ) : (
          <ProfileView />
        )}
      </main>

      {selectedJobKey ? <JobDrawer jobKey={selectedJobKey} onClose={() => setSelectedJobKey("")} /> : null}
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
  onOpenJobs,
}: {
  summary: DashboardSummary | null;
  status: LoadState;
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
              <div className="mini-row" key={run.runId}>
                <StatusDot state={run.status === "running" ? "running" : run.status === "failed" ? "failed" : "succeeded"} />
                <span className="title-stack">
                  <b>{run.title}</b>
                  <span>{run.company}</span>
                </span>
                {run.dryRun ? <span className="tag info">dry-run</span> : null}
              </div>
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
              <div className="activity-row" key={`${activity.at}-${index}`}>
                <span className={`tag ${activity.level === "error" ? "danger" : "muted"}`}>{activity.level}</span>
                <span className="stage-pill">{activity.stage}</span>
                <span>{activity.message}</span>
              </div>
            ))
          ) : (
            <Empty title="No activity yet." />
          )}
        </div>
      </section>
    </div>
  );
}

function JobsView({ onOpenJob }: { onOpenJob: (jobKey: string) => void }): JSX.Element {
  const [data, setData] = useState<PaginatedResponse<JobSummary> | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<Stage | "all">("all");
  const [state, setState] = useState<StageState | "all">("all");
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
        q: query,
        sort,
        dir,
        stage: stage === "all" ? undefined : stage,
        state: state === "all" ? undefined : state,
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
  }, [dir, page, pageSize, query, sort, stage, state]);

  useEffect(() => {
    void load();
  }, [load]);

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
    };
    window.addEventListener("jobhunter:set-jobs-filter", listener);
    return () => window.removeEventListener("jobhunter:set-jobs-filter", listener);
  }, []);

  return (
    <section className="card full">
      <CardHeader title="Jobs" meta={data ? `${data.pagination.total} total` : "loading"} />
      {error ? <div className="banner inline">{error}</div> : null}
      <div className="toolbar">
        <input
          aria-label="Search jobs"
          placeholder="Filter jobs, companies, errors..."
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
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
          {["all", "pending", "running", "succeeded", "failed", "blocked", "exhausted", "stale"].map((item) => (
            <option key={item} value={item}>
              {item} states
            </option>
          ))}
        </select>
        <SelectPairs
          options={jobSortFields}
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
        {loading && !data ? <Empty title="Loading jobs." /> : null}
        {data?.items.map((job) => (
          <button className="data-row job" key={job.jobKey} onClick={() => onOpenJob(job.jobKey)} type="button">
            <span className={`fit ${scoreTier(job.fitScore)}`}>{job.fitScore ?? "-"}</span>
            <span className="title-stack">
              <b>{job.title}</b>
              <span>{job.company}</span>
            </span>
            <span>{job.location || "-"}</span>
            <span>
              <span className="stage-pill">{job.currentStage}</span> <span className={`tag ${stateTone(job.currentState)}`}>{job.currentState}</span>
            </span>
            <span className="mono">{job.discoveredAt ? new Date(job.discoveredAt).toLocaleDateString() : "-"}</span>
          </button>
        ))}
        {data && data.items.length === 0 ? <Empty title="No jobs match." /> : null}
      </div>
      <Pager pagination={data?.pagination} page={page} onPage={setPage} />
    </section>
  );
}

function ArtifactsView({ onOpenJob }: { onOpenJob: (jobKey: string) => void }): JSX.Element {
  const [data, setData] = useState<PaginatedResponse<ArtifactSummary> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openStatus, setOpenStatus] = useState("");
  const [query, setQuery] = useState("");
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
        q: query,
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
  }, [dir, page, pageSize, query, sort, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const openArtifact = async (artifact: ArtifactSummary) => {
    setError("");
    setOpenStatus("");
    try {
      const response = await api.openArtifact(artifact.artifactId);
      setOpenStatus(`opened ${response.artifact.type}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to open artifact.");
    }
  };

  return (
    <section className="card full">
      <CardHeader title="Artifacts" meta={data ? `${data.pagination.total} total` : "loading"} />
      {error ? <div className="banner inline">{error}</div> : null}
      {openStatus ? <div className="status-line">{openStatus}</div> : null}
      <div className="toolbar">
        <input
          aria-label="Search artifacts"
          placeholder="Filter artifacts..."
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          {["all", "active", "approved", "candidate", "stale"].map((item) => (
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
        {data?.items.map((artifact) => (
          <div className="data-row artifact" key={artifact.artifactId}>
            <span className={`tag ${artifact.status === "active" ? "ok" : "muted"}`}>{artifact.status}</span>
            <span className="title-stack">
              <b>{artifact.title}</b>
              <span>{artifact.company}</span>
            </span>
            <span>{artifact.type}</span>
            <span className="path-cell">{artifact.localPath}</span>
            <span className="mono">{artifact.size}</span>
            <span className="row-actions">
              <button className="tab on" onClick={() => void openArtifact(artifact)} type="button">
                open
              </button>
              <button className="tab" onClick={() => onOpenJob(artifact.jobKey)} type="button">
                job
              </button>
            </span>
          </div>
        ))}
        {data && data.items.length === 0 ? <Empty title="No artifacts match." /> : null}
      </div>
      <Pager pagination={data?.pagination} page={page} onPage={setPage} />
    </section>
  );
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

  const profileName = useMemo(() => extractName(profile?.profile), [profile]);
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
      </section>
      <aside className="preview">
        <div className="preview-page">
          <h1>{profileName || "Profile preview"}</h1>
          <p className="muted">{extractContact(profile?.profile)}</p>
          <h2>Executive profile</h2>
          <p>{extractSummary(profile?.profile)}</p>
        </div>
      </aside>
    </div>
  );
}

function JobDrawer({ jobKey, onClose }: { jobKey: string; onClose: () => void }): JSX.Element {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [actionBusy, setActionBusy] = useState("");

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
                <small>{detail.job.company}</small>
                <h2>{detail.job.title}</h2>
                <p>{detail.job.location || "-"} · {detail.job.salary || "-"}</p>
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
                  <span className={`tag ${artifact.status === "active" ? "ok" : "muted"}`}>{artifact.status}</span>
                  <span>{artifact.type}</span>
                  <code>{artifact.localPath}</code>
                  <button className="tab on" disabled={Boolean(actionBusy)} onClick={() => void openArtifact(artifact)} type="button">
                    open
                  </button>
                </div>
              ))}
            </Section>
            <Section title="Score reasoning">
              <p>{detail.job.scoreReasoning || "-"}</p>
            </Section>
            <Section title="Description preview">
              <p>{detail.job.descriptionPreview || "-"}</p>
            </Section>
          </>
        ) : null}
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
  pagination?: PaginatedResponse<unknown>["pagination"];
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

function extractName(profile: unknown): string {
  return readString(profile, ["personal", "full_name"]);
}

function extractContact(profile: unknown): string {
  return [readString(profile, ["personal", "email"]), readString(profile, ["personal", "phone"]), readString(profile, ["personal", "city"])]
    .filter(Boolean)
    .join(" · ");
}

function extractSummary(profile: unknown): string {
  return readString(profile, ["resume", "executive_profile_baseline"]) || readString(profile, ["resume", "summary"]) || "-";
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  return btoa(binary);
}

function readString(source: unknown, path: string[]): string {
  let value = source;
  for (const part of path) {
    if (!value || typeof value !== "object" || !(part in value)) {
      return "";
    }
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : "";
}
