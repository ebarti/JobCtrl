import { useForm } from "@tanstack/react-form";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { IconChevronDown } from "@tabler/icons-react";
import { z } from "zod";

import { canRequestStop } from "../../../shared/lib/actionStop.js";
import { Button } from "../../../shared/ui/button.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../shared/ui/tabs.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { getApiCapabilityAvailability } from "../../../shared/lib/apiCapabilityAvailability.js";
import { useRuntimeHealth } from "../../runtime/index.js";
import { recipeSchema, type PreparationRecipe, type PreparationRequest, type PreparationResumeMode, type PreparationRun, usePreparationCommands, usePreparationExecution, usePreparationRun, usePreparationRuns, usePreviousPreparationRetry } from "../client.js";
import "../../../styles/jobs-selection.css";

const labels: Record<PreparationRecipe, string> = {
  run: "Run Discovery and preparation", discover: "Discover", enrich: "Enrich postings",
  analyze: "Analyze postings", score: "Assess fit", tailor: "Re-tailor resumes", prepare: "Prepare resumes",
};
const runLabels: Record<PreparationRun["recipe"], string> = { ...labels, search: "Search and assess fit", assess: "Assess selected jobs" };
const formSchema = z.object({ recipe: recipeSchema, limit: z.coerce.number().int().min(1).max(1000),
  minFitScore: z.union([z.literal(""), z.coerce.number().int().min(1).max(10)]), force: z.boolean(), override: z.boolean() });

type PreparationCommands = ReturnType<typeof usePreparationCommands>;

function PreparationStatus({ status }: { readonly status: string }) {
  const tone = status === "failed" || status === "blocked" ? "danger" : status === "partial" ? "warn"
    : status === "succeeded" ? "ok" : ["running", "queued", "pending"].includes(status) ? "info" : "muted";
  const label = status.replaceAll("_", " ");
  return <StatusBadge tone={tone}>{label.charAt(0).toUpperCase() + label.slice(1)}</StatusBadge>;
}

function PreparationRunOutcomes({ run }: { readonly run: PreparationRun }) {
  return <div className="preparation-run-outcomes">
    {run.steps.length ? <ul className="preparation-run-outcomes__steps">{run.steps.map((step, index) => {
      const jobIndex = step.jobId ? run.jobIds.indexOf(step.jobId) : -1;
      return <li key={`${step.jobId ?? "run"}:${step.stage}:${index}`}>
        <div className="preparation-run-outcomes__stage">
          <span data-typography="label">{step.stage.replaceAll("_", " ")}</span>
          <PreparationStatus status={step.status} />
        </div>
        <p data-typography="metadata">{step.jobId ? jobIndex < 0 ? "Job outcome" : `Job ${jobIndex + 1}` : "Run outcome"}
          {step.result?.score !== undefined ? ` · fit ${String(step.result.score)}` : ""}
          {step.result?.review_status ? ` · review ${String(step.result.review_status).replaceAll("_", " ")}` : ""}
          {step.result?.skip ? ` · ${String(step.result.skip).replaceAll("_", " ")}` : ""}
        </p>
        {step.errorCode ? <p className="preparation-run-outcomes__error" data-typography="body">{step.errorCode.replaceAll("_", " ")}</p> : null}
      </li>;
    })}</ul> : <p>Waiting for the worker to record a stage.</p>}
    <details className="preparation-run-outcomes__identity"><summary>Technical details</summary>
      <dl><div><dt>Run</dt><dd>{run.runId}</dd></div>
        {run.parentRunId ? <div><dt>Previous run</dt><dd>{run.parentRunId}</dd></div> : null}
        {run.jobIds.map((jobId, index) => <div key={jobId}><dt>Job {index + 1}</dt><dd><Link to="/jobs/$jobId" params={{ jobId }} search={(previous) => previous}>{jobId}</Link></dd></div>)}
      </dl>
    </details>
  </div>;
}

function PreviousPreparationRetry({ record, submit, jobId }: {
  readonly record: NonNullable<PreparationCommands["recovery"]["record"]>;
  readonly submit: PreparationCommands["submit"];
  readonly jobId?: string | undefined;
}) {
  const earlier = usePreviousPreparationRetry(record, jobId);
  const body = earlier.data;
  if (body) return <Button type="button" variant="outline" disabled={submit.isPending}
    onClick={() => submit.mutate({ action: "preparation.retry", body })}>Recover earlier retry</Button>;
  if (earlier.isPending) return null;
  return <p>Open the job you originally retried to try it again.</p>;
}

function PreparationRecoveryNotice({ commands, jobId }: { readonly commands: PreparationCommands; readonly jobId?: string }) {
  const { recovery, submit } = commands;
  if (!recovery.ready) return recovery.error ? <p role="alert">{recovery.error.message}</p> : null;
  const status = recovery.status;
  const retrying = recovery.record?.operation === "preparation.retry";
  return <>
    {recovery.record && !submit.isPending ? <div role="alert">
      <p>{recovery.summary}</p>
      {recovery.canRetry && !retrying ? <p>To retry, use the same selections as before.</p> : null}
      {recovery.canRetry && retrying
        ? <PreviousPreparationRetry record={recovery.record} submit={submit} jobId={jobId} /> : null}
      <Button type="button" variant="outline" disabled={recovery.checking} onClick={() => void recovery.check()}>Check previous request</Button>
      <details><summary>Request details</summary><p>Request {recovery.record.requestId}{status ? ` · run ${status.runId}` : ""}.</p></details>
    </div> : null}
    {recovery.message ? <p role="status">{recovery.message}</p> : null}
  </>;
}

export function PreparationRunDetail({ runId, showStop = true }: { readonly runId: string; readonly showStop?: boolean }) {
  const run = usePreparationRun(runId);
  const active = showStop && ["running", "queued", "pending"].includes(run.data?.status ?? "");
  const execution = usePreparationExecution(active ? runId : null);
  const commands = usePreparationCommands();
  const { submit, cancel, recovery } = commands;
  if (run.isLoading && !run.data) return <p>Loading preparation outcomes…</p>;
  if (!run.data) return run.isError
    ? <p role="alert">{run.error.message} <Button type="button" variant="outline" onClick={() => void run.refetch()}>Retry</Button></p>
    : <p>Preparation details have not been recorded yet. <Button type="button" variant="outline" onClick={() => void run.refetch()}>Check again</Button></p>;
  return <section aria-label="Preparation outcomes" className="preparation-run-detail">
    <PreparationRecoveryNotice commands={commands} />
    {run.isError ? <p role="alert">{run.error.message} Showing the last recorded outcomes. <Button type="button" variant="outline" onClick={() => void run.refetch()}>Check again</Button></p> : null}
    <div className="preparation-run-detail__heading"><h3>{runLabels[run.data.recipe]}</h3><PreparationStatus status={run.data.status} /></div>
    <PreparationRunOutcomes run={run.data} />
    {active && execution.data?.cancellationRequested ? <p role="status">Stop requested. {execution.data.cancellationDelivery === "pending"
      ? "The workflow service has not confirmed receipt." : "Waiting for this run to settle."}</p> : null}
    {active && (!execution.data || canRequestStop(execution.data)) ? <Button type="button" variant="outline" disabled={cancel.isPending || run.isError}
      onClick={() => cancel.mutate(runId)}>{execution.data?.cancellationDelivery === "pending" ? "Retry stop" : "Cancel run"}</Button> : null}
    {["failed", "partial", "cancelled"].includes(run.data.status) ? <Button type="button" variant="outline" disabled={submit.isPending || run.isError || !recovery.permits("preparation.retry")} onClick={() => submit.mutate({ action: "preparation.retry", body: { run_id: runId } })}>Retry all unfinished jobs</Button> : null}
    {submit.isError ? <p role="alert">{submit.error.message}</p> : null}
    {submit.isSuccess ? <p role="status">Retry queued. Follow its progress in preparation history.</p> : null}
    {cancel.isError ? <p role="alert">{cancel.error.message}</p> : null}
  </section>;
}

function PreparationRunListContent({ jobIds, commands }: { readonly jobIds?: readonly string[]; readonly commands: PreparationCommands }) {
  const runs = usePreparationRuns();
  const id = useId();
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const { submit, cancel, recovery } = commands;
  const history = runs.data ?? [];
  const visible = history.filter(run => !jobIds || run.jobIds.some(id => jobIds.includes(id)));
  const resumedRunIds = new Set(history.map(run => run.parentRunId));
  return <section aria-label="Preparation runs" className="preparation-run-list">
    <h3>Preparation runs</h3>
    {runs.isLoading ? <p>Loading preparation runs…</p> : null}
    {runs.isError ? <p role="alert">{runs.error.message} <Button type="button" variant="outline" onClick={() => void runs.refetch()}>Retry</Button></p> : null}
    {!runs.isLoading && !runs.isError && visible.length === 0 ? <p>No preparation runs recorded.</p> : null}
    <div className="preparation-run-list__rows">{visible.map((run, index) => {
      const expanded = expandedRunId === run.runId;
      const outcomesId = `${id}-outcomes-${index}`;
      const stop = cancel.data?.runId === run.runId ? cancel.data : undefined;
      return <article key={run.runId} className="preparation-run-row">
        <div className="preparation-run-row__summary">
          <Button type="button" variant="ghost" size="content" className="preparation-run-row__toggle" aria-expanded={expanded} aria-controls={expanded ? outcomesId : undefined}
            onClick={() => setExpandedRunId(expanded ? null : run.runId)}>
            <span className="preparation-run-row__name"><span data-typography="label">{runLabels[run.recipe]}</span>
              <span className="preparation-run-row__metadata" data-typography="metadata">{run.jobIds.length} {run.jobIds.length === 1 ? "job" : "jobs"} · <time dateTime={run.updatedAt}>{new Date(run.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></span>
            </span>
            <IconChevronDown aria-hidden="true" data-icon="inline-end" />
          </Button>
          <PreparationStatus status={run.status} />
          {["running", "queued", "pending"].includes(run.status) && (!stop || canRequestStop(stop))
            ? <Button type="button" variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(run.runId)}>{stop?.cancellationDelivery === "pending" ? "Retry stop" : "Cancel run"}</Button> : null}
          {["failed", "partial", "cancelled"].includes(run.status) && !(run.executionPolicy?.version === "search-cohort-v1" && resumedRunIds.has(run.runId))
            ? <Button type="button" variant="outline" size="sm" disabled={submit.isPending || !recovery.permits("preparation.retry")} onClick={() => submit.mutate({ action: "preparation.retry", body: { run_id: run.runId } })}>Retry unfinished</Button> : null}
        </div>
        {expanded ? <div id={outcomesId} className="preparation-run-row__outcomes"><PreparationRunOutcomes run={run} /><Link to="/runs/$runId" params={{ runId: run.runId }}>View run details</Link></div> : null}
      </article>;
    })}</div>
  </section>;
}

export function PreparationRunList({ jobIds }: { readonly jobIds?: readonly string[] }) {
  const commands = usePreparationCommands();
  const error = commands.submit.error ?? commands.cancel.error;
  return <><PreparationRecoveryNotice commands={commands} />
    <PreparationRunListContent {...(jobIds ? { jobIds } : {})} commands={commands} />
    {error ? <p role="alert">{error.message}</p> : null}
  </>;
}

function RecipeButtons({ jobIds, commands }: { readonly jobIds: readonly string[]; readonly commands: PreparationCommands }) {
  const { submit, cancel, recovery } = commands;
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "runJobStage");
  const [allowBelow, setAllowBelow] = useState(false);
  const recipes: PreparationRecipe[] = ["prepare", "enrich", "analyze", "score", "tailor"];
  return <div className="preparation-actions">
    <div role="group" aria-label="Preparation actions" className="preparation-actions__buttons">
      {recipes.map(recipe => <Button key={recipe} type="button" variant="outline" size="sm" disabled={!availability.available || !jobIds.length || submit.isPending || !recovery.permits("preparation.run")}
        onClick={() => submit.mutate({ action: "preparation.run", body: { recipe, job_ids: jobIds, scope: "selected", force: recipe === "tailor", allow_below_threshold: allowBelow } })}>
        {labels[recipe]}
      </Button>)}
    </div>
    {!availability.available ? <p>{availability.reason}</p> : null}
    <label className="preparation-actions__option"><input type="checkbox" checked={allowBelow} disabled={submit.isPending} onChange={event => setAllowBelow(event.target.checked)} /> Prepare selected jobs below the saved fit threshold</label>
    {submit.isSuccess ? <p role="status">Preparation queued. Follow its progress in history. <Button type="button" variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(submit.data.runId)}>Cancel queued run</Button></p> : null}
  </div>;
}

export function PipelineBulkActions({ jobIds }: { readonly jobIds: readonly string[] }) {
  const commands = usePreparationCommands();
  const error = commands.submit.error ?? commands.cancel.error;
  return <section aria-label="Selected jobs preparation" className="selected-job-preparation">
    <PreparationRecoveryNotice commands={commands} />
    {error ? <p role="alert">{error.message}</p> : null}
    <Tabs defaultValue="tools">
      <TabsList aria-label="Preparation workspace"><TabsTrigger value="tools">Tools</TabsTrigger><TabsTrigger value="history">History</TabsTrigger></TabsList>
      <TabsContent value="tools" forceMount><RecipeButtons jobIds={jobIds} commands={commands} /></TabsContent>
      <TabsContent value="history" forceMount><PreparationRunListContent jobIds={jobIds} commands={commands} /></TabsContent>
    </Tabs>
  </section>;
}

export function JobPreparationActions({ jobId, defaultMode = null, initialMode = null, onModeChange, renderProfileSetup, profileVersion = null, blockedByDraft = false, onReviewReady }: {
  readonly jobId: string;
  readonly defaultMode?: PreparationResumeMode | null;
  readonly initialMode?: PreparationResumeMode | null;
  readonly onModeChange?: (mode: PreparationResumeMode) => void;
  readonly renderProfileSetup?: (mode: PreparationResumeMode | null) => ReactNode;
  readonly profileVersion?: number | null;
  readonly blockedByDraft?: boolean;
  readonly onReviewReady?: (resumeId?: string, runId?: string) => void;
}) {
  const commands = usePreparationCommands();
  const { submit, cancel, recovery } = commands;
  const runs = usePreparationRuns();
  const runtime = useRuntimeHealth();
  const { featureFlags } = usePorts();
  const tailoring = getApiCapabilityAvailability(featureFlags, "tailorJob");
  const baselineCapability = getApiCapabilityAvailability(featureFlags, "prepareBaselineResume");
  const [choice, setChoice] = useState<PreparationResumeMode | null>(initialMode);
  // Keep same-job history/direct navigation consistent with the route-owned
  // task choice; local selection still updates immediately before navigation.
  useEffect(() => { setChoice(initialMode); }, [initialMode]);
  const [allowBelow, setAllowBelow] = useState(false);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const revealed = useRef<string | null>(null);
  const mode = choice ?? defaultMode;
  const localBaseline = mode === "baseline" && baselineCapability.isDemo && baselineCapability.available;
  const ready = localBaseline || Boolean(runtime.data?.worker.healthy);
  const jobRuns = (runs.data ?? []).filter((run) => run.jobIds.includes(jobId));
  const active = jobRuns.find((run) => ["running", "queued", "pending"].includes(run.status));
  const current = startedRunId ? jobRuns.find((run) => run.runId === startedRunId) : active ?? jobRuns[0];
  const missing = Boolean(startedRunId && !current);
  const execution = usePreparationExecution(missing ? startedRunId : active?.runId ?? startedRunId);
  const waiting = Boolean(missing
    && !["succeeded", "failed", "cancelled"].includes(execution.data?.status ?? ""));
  const stopRunId = active?.runId ?? (waiting ? startedRunId : null);
  const stop = execution.data?.runId === stopRunId ? execution.data : cancel.data?.runId === stopRunId ? cancel.data : undefined;
  const busy = submit.isPending || Boolean(active) || waiting;
  useEffect(() => {
    if (current && current.runId === startedRunId && ["succeeded", "partial", "failed"].includes(current.status)
        && current.steps.some((step) => step.jobId === jobId && step.stage === "compose" && step.result?.resume_id)
        && revealed.current !== current.runId) {
      revealed.current = current.runId;
      const composed = current.steps.find((step) => step.jobId === jobId && step.stage === "compose" && typeof step.result?.resume_id === "string");
      onReviewReady?.(typeof composed?.result?.resume_id === "string" ? composed.result.resume_id : undefined, current.runId);
    }
  }, [current, startedRunId, onReviewReady, jobId]);
  const jobSteps = current?.steps.filter((step) => step.jobId === jobId) ?? [];
  const incomplete = jobSteps.find((step) => ["failed", "blocked", "cancelled"].includes(step.status));
  const belowThreshold = jobSteps.some((step) => step.result?.skip === "below_fit_threshold");
  const hasResume = jobSteps.some((step) => step.stage === "compose" && step.result?.resume_id);
  const failedHandoff = current?.retryableJobIds?.includes(jobId) ?? false;
  const retryable = current && (failedHandoff || incomplete || (current.status === "cancelled" && !hasResume));
  const activeAssessment = active?.recipe === "search" || active?.recipe === "assess";
  const jobAssessmentComplete = activeAssessment && active?.steps.some((step) => step.jobId === jobId && step.stage === "fit" && step.status === "succeeded");
  const currentAssessment = current?.recipe === "search" || current?.recipe === "assess";
  const resumeSearch = current?.executionPolicy?.version === "search-cohort-v1";
  const retryLabel = resumeSearch ? "Continue fit assessment for all jobs" : currentAssessment ? "Retry fit assessment for this job" : "Continue unfinished preparation";
  const statusRun = active ?? current;
  const statusSteps = statusRun?.steps.filter((step) => step.jobId === jobId) ?? [];
  const statusTask = (statusRun?.recipe === "search" || statusRun?.recipe === "assess") ? "Fit assessment" : "Preparation";
  return <section aria-label={activeAssessment ? "Assess fit" : "Prepare resume"} className="job-preparation-task">
    <div className="job-preparation-task__controls">
      {!activeAssessment ? <label data-typography="label">Resume to prepare<select data-typography="body" aria-label="Resume to prepare" value={mode ?? ""} disabled={busy || Boolean(recovery.record && !recovery.canRetry)} onChange={(event) => {
        const next = event.currentTarget.value === "baseline" ? "baseline" : "tailored";
        setChoice(next);
        onModeChange?.(next);
      }}>
        {mode === null ? <option value="" disabled>Choose a resume</option> : null}
        <option value="tailored">Tailored resume</option><option value="baseline">Full baseline</option>
      </select></label> : null}
      <Button type="button" disabled={busy || blockedByDraft || profileVersion === null || mode === null || (mode === "tailored" && !tailoring.available)
        || !ready || !recovery.permits("preparation.run")} onClick={() => {
        if (!mode) return;
        submit.mutate({ action: "preparation.run", body: { recipe: "prepare", job_ids: [jobId], scope: "selected", limit: 1, resume_mode: mode, allow_below_threshold: allowBelow } }, {
          onSuccess: (receipt) => { setStartedRunId(receipt.runId); cancel.reset(); },
        });
      }}>{activeAssessment ? jobAssessmentComplete ? "Fit assessed for this job" : "Assessing fit…" : submit.isPending ? "Starting preparation…" : busy ? "Preparing resume…" : recovery.record?.operation === "preparation.run" ? "Retry same preparation" : localBaseline ? "Prepare resume locally" : "Prepare resume"}</Button>
      {stopRunId && (!stop || canRequestStop(stop)) ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(stopRunId)}>{stop?.cancellationDelivery === "pending" ? "Retry stop" : active && active.jobIds.length > 1 ? `Stop ${activeAssessment ? "fit assessment" : "preparation"} for ${active.jobIds.length} jobs` : "Request stop"}</Button> : null}
      {current && retryable && (failedHandoff || ["failed", "partial", "cancelled"].includes(current.status)) ? <Button type="button" variant="outline"
        disabled={submit.isPending || (busy && !failedHandoff) || blockedByDraft || !recovery.permits("preparation.retry")}
        onClick={() => submit.mutate({ action: "preparation.retry", body: { run_id: current.runId, ...(resumeSearch ? {} : { job_ids: [jobId] }) } }, {
          onSuccess: (receipt) => { setStartedRunId(receipt.runId); cancel.reset(); },
        })}>{retryLabel}</Button> : null}
    </div>
    {profileVersion === null ? <p role="status">Save your profile before preparing a resume. {renderProfileSetup?.(mode) ?? <Link to="/profile">Open My profile</Link>}</p> : null}
    {blockedByDraft ? <p role="status">Save your unsaved resume edits before preparing another version. <Button type="button" variant="link" onClick={() => onReviewReady?.()}>Review unsaved edits</Button></p> : null}
    {mode === "tailored" && !tailoring.available ? <p role="status">{tailoring.reason}</p> : null}
    {!ready ? <p role="status">{runtime.isPending ? "Checking preparation readiness…" : runtime.error ? "Preparation readiness could not be checked." : "Preparation is unavailable while the worker reconnects."} <Link to="/settings">Review connections</Link></p> : null}
    {localBaseline ? <p role="status">{baselineCapability.reason}</p> : null}
    <p className="job-preparation-task__scope" data-typography="metadata">{activeAssessment ? "Assess requirements and fit using your saved model and spending limits. No resume is generated by this task." : <>{mode === "baseline" ? "Copy the complete saved profile and render it for review. No model calls are needed." : "Compose and render approved wording. If requirements or Fit need assessment, JobCtrl uses your saved model and spending limits."} You review and accept the result.</>}</p>
    {busy ? <p role="status">{jobAssessmentComplete ? "This job’s fit assessment is complete. Other jobs in this run are still being assessed." : waiting ? `${statusTask} ${execution.error ? "status unavailable" : execution.data?.status ?? "queued"}.` : statusRun ? `${statusTask} ${statusRun.status}${statusSteps.find((step) => step.status === "running") ? ` · ${statusSteps.find((step) => step.status === "running")?.stage.replaceAll("_", " ")}` : ""}.` : "Starting preparation."}</p> : current ? <p role="status">{statusTask} {current.status === "succeeded" ? hasResume ? "ready for review" : "complete" : current.status}.{incomplete && incomplete.errorCode !== "action_cancelled" ? ` ${incomplete.errorCode?.replaceAll("_", " ") ?? "A step needs attention"}.` : ""}</p> : execution.data ? <p role="status">Preparation {execution.data.status}{execution.data.errorCode ? ` · ${execution.data.errorCode.replaceAll("_", " ")}` : ""}.</p> : null}
    {belowThreshold ? <p role="status">This job is below your saved fit threshold. Choose the explicit exception below to prepare it.</p> : null}
    {stop?.cancellationRequested && ["pending", "queued", "running"].includes(stop.status) ? <p role="status">Stop requested. {stop.cancellationDelivery === "pending"
      ? "The workflow service has not confirmed receipt." : "Waiting for this run to settle."}</p> : null}
    {submit.error || cancel.error ? <p role="alert">{(submit.error ?? cancel.error)?.message}</p> : null}
    <PreparationRecoveryNotice commands={commands} jobId={jobId} />
    <details className="job-preparation-inspection"><summary>Preparation options and history</summary>
      <label><input type="checkbox" checked={allowBelow} disabled={busy || Boolean(recovery.record && !recovery.canRetry)} onChange={(event) => setAllowBelow(event.currentTarget.checked)} /> Prepare this job below the saved fit threshold</label>
      <PreparationRunListContent jobIds={[jobId]} commands={commands} />
      <details><summary>Individual preparation tools</summary><RecipeButtons jobIds={[jobId]} commands={commands} /></details>
    </details>
  </section>;
}

export function PipelineRecipePanel({ stageRunBlockReasons = {} }: { readonly stageRunBlockReasons?: Partial<Record<PreparationRecipe, ReactNode>> }) {
  const id = useId();
  const commands = usePreparationCommands();
  const { submit, cancel, recovery } = commands;
  const form = useForm({
    defaultValues: { recipe: "discover" as PreparationRecipe, limit: "100", minFitScore: "", force: false, override: false },
    onSubmit: ({ value }) => {
      const parsed = formSchema.safeParse(value);
      if (!parsed.success || stageRunBlockReasons[parsed.data.recipe] || !recovery.permits("preparation.run")) return;
      const body: PreparationRequest = { recipe: parsed.data.recipe, scope: "pending", limit: parsed.data.limit,
        force: parsed.data.force || parsed.data.recipe === "tailor", allow_below_threshold: parsed.data.override,
        ...(parsed.data.minFitScore === "" ? {} : { min_fit_score: parsed.data.minFitScore }) };
      submit.mutate({ action: "preparation.run", body });
    },
  });
  return <section aria-label="Pipeline controls" className="grid gap-4">
    <PreparationRecoveryNotice commands={commands} />
    <form onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }} className="grid gap-3">
      <form.Field name="recipe">{field => <label htmlFor={`${id}-recipe`}>Work to run
        <select id={`${id}-recipe`} value={field.state.value} disabled={submit.isPending} onChange={event => field.handleChange(recipeSchema.parse(event.target.value))}>
          {(Object.keys(labels) as PreparationRecipe[]).map(recipe => <option key={recipe} value={recipe}>{labels[recipe]}</option>)}
        </select></label>}</form.Field>
      <form.Field name="limit" validators={{ onChange: ({ value }) => z.coerce.number().int().min(1).max(1000).safeParse(value).success ? undefined : "Enter 1–1000." }}>
        {field => <label htmlFor={`${id}-limit`}>Maximum jobs <input id={`${id}-limit`} type="number" min={1} max={1000} value={field.state.value} disabled={submit.isPending} onChange={event => field.handleChange(event.target.value)} />{field.state.meta.errors.map(String).join(", ")}</label>}
      </form.Field>
      <form.Field name="minFitScore" validators={{ onChange: ({ value }) => z.union([z.literal(""), z.coerce.number().int().min(1).max(10)]).safeParse(value).success ? undefined : "Enter 1–10 or leave blank." }}>
        {field => <label htmlFor={`${id}-fit`}>Minimum fit score (blank uses saved setting) <input id={`${id}-fit`} type="number" min={1} max={10} value={field.state.value} disabled={submit.isPending} onChange={event => field.handleChange(event.target.value)} />{field.state.meta.errors.map(String).join(", ")}</label>}
      </form.Field>
      <form.Field name="force">{field => <label><input type="checkbox" checked={field.state.value} disabled={submit.isPending} onChange={event => field.handleChange(event.target.checked)} /> Refresh existing results</label>}</form.Field>
      <form.Field name="override">{field => <label><input type="checkbox" checked={field.state.value} disabled={submit.isPending} onChange={event => field.handleChange(event.target.checked)} /> Prepare below the selected fit threshold</label>}</form.Field>
      <Button type="submit" disabled={submit.isPending || !recovery.permits("preparation.run")}>{submit.isPending ? "Starting…" : recovery.record ? "Retry the same request" : "Start work"}</Button>
    </form>
    {submit.isError ? <p role="alert">{submit.error.message}</p> : null}
    {submit.isSuccess ? <p role="status">Queued preparation run {submit.data.runId}. <Button type="button" variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(submit.data.runId)}>Cancel queued run</Button></p> : null}
    {cancel.isError ? <p role="alert">{cancel.error.message}</p> : null}
    <PreparationRunListContent commands={commands} />
  </section>;
}
