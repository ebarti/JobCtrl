import { useForm } from "@tanstack/react-form";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { z } from "zod";

import { Button } from "../../../shared/ui/button.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { getApiCapabilityAvailability } from "../../../shared/lib/apiCapabilityAvailability.js";
import { useRuntimeHealth } from "../../runtime/index.js";
import { recipeSchema, type PreparationRecipe, type PreparationRequest, type PreparationResumeMode, usePreparationCommands, usePreparationExecution, usePreparationRun, usePreparationRuns } from "../client.js";

const labels: Record<PreparationRecipe, string> = {
  run: "Run Discovery and preparation", discover: "Discover", enrich: "Enrich postings",
  analyze: "Analyze postings", score: "Assess fit", tailor: "Re-tailor resumes", prepare: "Prepare resumes",
};
const formSchema = z.object({ recipe: recipeSchema, limit: z.coerce.number().int().min(1).max(1000),
  minFitScore: z.union([z.literal(""), z.coerce.number().int().min(1).max(10)]), force: z.boolean(), override: z.boolean() });

type PreparationCommands = ReturnType<typeof usePreparationCommands>;

function PreparationRecoveryNotice({ recovery }: { readonly recovery: PreparationCommands["recovery"] }) {
  if (!recovery.ready) return <p role="alert">{recovery.error ? "Preparation recovery storage is unavailable or invalid. Restore it before starting work." : "Checking preparation recovery storage…"}</p>;
  return <>
    {recovery.record ? <div role="alert">
      <p>A previous preparation request needs review. {recovery.status ? `Recorded status: ${recovery.status.status}.` : "Its admission has not been confirmed."} Check it before starting different work. If the exact request can be retried, re-enter the same inputs; request contents are not stored.</p>
      <details><summary>Recovery identity</summary><p>Request {recovery.record.requestId}{recovery.status ? ` · run ${recovery.status.runId}` : ""}.</p></details>
      <Button type="button" variant="outline" disabled={recovery.checking} onClick={() => void recovery.check()}>Check previous preparation</Button>
      {recovery.statusError ? <p>Its current status could not be confirmed. Only the exact previous command may be retried when reconciliation permits.</p> : null}
    </div> : null}
    {recovery.message ? <p role="status">{recovery.message}</p> : null}
  </>;
}

export function PreparationRunDetail({ runId }: { readonly runId: string }) {
  const run = usePreparationRun(runId);
  const { submit, cancel, recovery } = usePreparationCommands();
  if (run.isLoading && !run.data) return <p>Loading preparation outcomes…</p>;
  if (!run.data) return run.isError
    ? <p role="alert">{run.error.message} <Button type="button" variant="outline" onClick={() => void run.refetch()}>Retry</Button></p>
    : <p>Preparation details have not been recorded yet. <Button type="button" variant="outline" onClick={() => void run.refetch()}>Check again</Button></p>;
  return <section aria-label="Preparation outcomes" className="grid gap-2">
    <PreparationRecoveryNotice recovery={recovery} />
    {run.isError ? <p role="alert">{run.error.message} Showing the last recorded outcomes. <Button type="button" variant="outline" onClick={() => void run.refetch()}>Check again</Button></p> : null}
    <h3>{labels[run.data.recipe]} · {run.data.status}</h3>
    {run.data.steps.length ? <ul>{run.data.steps.map((step, index) => <li key={`${step.jobId ?? "run"}:${step.stage}:${index}`}>
      {step.jobId ? `${step.jobId} · ` : ""}{step.stage}: {step.status}{step.errorCode ? ` (${step.errorCode})` : ""}
      {step.result?.score !== undefined ? ` · fit ${String(step.result.score)}` : ""}
      {step.result?.review_status ? ` · review ${String(step.result.review_status)}` : ""}
      {step.result?.skip ? ` · ${String(step.result.skip)}` : ""}
    </li>)}</ul> : <p>Waiting for the worker to record a stage.</p>}
    {["running", "queued", "pending"].includes(run.data.status) ? <Button type="button" variant="outline" disabled={cancel.isPending || run.isError} onClick={() => cancel.mutate(runId)}>Cancel run</Button> : null}
    {["failed", "partial", "cancelled"].includes(run.data.status) ? <Button type="button" variant="outline" disabled={submit.isPending || run.isError || !recovery.permits("preparation.retry")} onClick={() => submit.mutate({ action: "preparation.retry", body: { run_id: runId } })}>Retry all unfinished jobs</Button> : null}
    {submit.isError ? <p role="alert">{submit.error.message} Retry unchanged to reconcile an uncertain acknowledgement.</p> : null}
    {submit.isSuccess ? <p role="status">Queued retry {submit.data.runId}.</p> : null}
    {cancel.isError ? <p role="alert">{cancel.error.message}</p> : null}
  </section>;
}

function PreparationRunListContent({ jobIds, commands }: { readonly jobIds?: readonly string[]; readonly commands: PreparationCommands }) {
  const runs = usePreparationRuns();
  const { submit, cancel, recovery } = commands;
  const visible = (runs.data ?? []).filter(run => !jobIds || run.jobIds.some(id => jobIds.includes(id)));
  return <section aria-label="Preparation runs" className="grid gap-3">
    <h3>Preparation runs</h3>
    {runs.isLoading ? <p>Loading preparation runs…</p> : null}
    {runs.isError ? <p role="alert">{runs.error.message} <Button type="button" variant="outline" onClick={() => void runs.refetch()}>Retry</Button></p> : null}
    {!runs.isLoading && !runs.isError && visible.length === 0 ? <p>No preparation runs recorded.</p> : null}
    {visible.map(run => <article key={run.runId} className="rounded border p-3">
      <div><strong>{labels[run.recipe]}</strong> · {run.status} · <time dateTime={run.updatedAt}>{new Date(run.updatedAt).toLocaleString()}</time></div>
      <details><summary>Show job and stage outcomes</summary>
        {run.steps.length ? <ul>{run.steps.map((step, index) => <li key={`${step.jobId ?? "run"}:${step.stage}:${index}`}>
          {step.jobId ? `${step.jobId} · ` : ""}{step.stage}: {step.status}{step.errorCode ? ` (${step.errorCode})` : ""}
          {step.result?.score !== undefined ? ` · fit ${String(step.result.score)}` : ""}
          {step.result?.review_status ? ` · review ${String(step.result.review_status)}` : ""}
          {step.result?.skip ? ` · ${String(step.result.skip)}` : ""}
        </li>)}</ul> : <p>Waiting for the worker to record a stage.</p>}
      </details>
      {["running", "queued", "pending"].includes(run.status) ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(run.runId)}>Cancel run</Button> : null}
      {["failed", "partial", "cancelled"].includes(run.status) ? <Button type="button" variant="outline" disabled={submit.isPending || !recovery.permits("preparation.retry")} onClick={() => submit.mutate({ action: "preparation.retry", body: { run_id: run.runId } })}>Retry all unfinished jobs</Button> : null}
    </article>)}
    {submit.isError ? <p role="alert">{submit.error.message} Retry the same action to reconcile an uncertain acknowledgement.</p> : null}
    {cancel.isError ? <p role="alert">{cancel.error.message}</p> : null}
  </section>;
}

export function PreparationRunList({ jobIds }: { readonly jobIds?: readonly string[] }) {
  const commands = usePreparationCommands();
  return <><PreparationRecoveryNotice recovery={commands.recovery} /><PreparationRunListContent {...(jobIds ? { jobIds } : {})} commands={commands} /></>;
}

function RecipeButtons({ jobIds, commands }: { readonly jobIds: readonly string[]; readonly commands: PreparationCommands }) {
  const { submit, cancel, recovery } = commands;
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "runJobStage");
  const [allowBelow, setAllowBelow] = useState(false);
  const recipes: PreparationRecipe[] = ["prepare", "enrich", "analyze", "score", "tailor"];
  return <div role="group" aria-label="Preparation actions" className="flex flex-wrap gap-2">
    {recipes.map(recipe => <Button key={recipe} type="button" variant="outline" size="sm" disabled={!availability.available || !jobIds.length || submit.isPending || !recovery.permits("preparation.run")}
      onClick={() => submit.mutate({ action: "preparation.run", body: { recipe, job_ids: jobIds, scope: "selected", force: recipe === "tailor", allow_below_threshold: allowBelow } })}>
      {labels[recipe]}
    </Button>)}
    {!availability.available ? <p>{availability.reason}</p> : null}
    <label><input type="checkbox" checked={allowBelow} disabled={submit.isPending} onChange={event => setAllowBelow(event.target.checked)} /> Prepare selected jobs below the saved fit threshold</label>
    {submit.isError ? <p role="alert">{submit.error.message} Retry the same action to reconcile an uncertain acknowledgement.</p> : null}
    {submit.isSuccess ? <p role="status">Queued preparation run {submit.data.runId}. <Button type="button" variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(submit.data.runId)}>Cancel queued run</Button></p> : null}
    {cancel.isError ? <p role="alert">{cancel.error.message}</p> : null}
  </div>;
}

export function PipelineBulkActions({ jobIds }: { readonly jobIds: readonly string[] }) {
  const commands = usePreparationCommands();
  return <section aria-label="Selected jobs preparation"><PreparationRecoveryNotice recovery={commands.recovery} /><RecipeButtons jobIds={jobIds} commands={commands} /><PreparationRunListContent jobIds={jobIds} commands={commands} /></section>;
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
  const execution = usePreparationExecution(startedRunId);
  const revealed = useRef<string | null>(null);
  const mode = choice ?? defaultMode;
  const localBaseline = mode === "baseline" && baselineCapability.isDemo && baselineCapability.available;
  const ready = localBaseline || Boolean(runtime.data?.worker.healthy);
  const jobRuns = (runs.data ?? []).filter((run) => run.jobIds.includes(jobId));
  const active = jobRuns.find((run) => ["running", "queued", "pending"].includes(run.status));
  const current = startedRunId ? jobRuns.find((run) => run.runId === startedRunId) : active ?? jobRuns[0];
  const waiting = Boolean(startedRunId && !jobRuns.some((run) => run.runId === startedRunId)
    && !["succeeded", "failed", "cancelled"].includes(execution.data?.status ?? ""));
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
  const retryable = current && (incomplete || (current.status === "cancelled" && !hasResume));
  return <section aria-label="Prepare resume" className="job-preparation-task">
    <div className="job-preparation-task__controls">
      <label data-typography="label">Resume to prepare<select data-typography="body" aria-label="Resume to prepare" value={mode ?? ""} disabled={busy || Boolean(recovery.record && !recovery.canRetry)} onChange={(event) => {
        const next = event.currentTarget.value === "baseline" ? "baseline" : "tailored";
        setChoice(next);
        onModeChange?.(next);
      }}>
        {mode === null ? <option value="" disabled>Choose a resume</option> : null}
        <option value="tailored">Tailored resume</option><option value="baseline">Full baseline</option>
      </select></label>
      <Button type="button" disabled={busy || blockedByDraft || profileVersion === null || mode === null || (mode === "tailored" && !tailoring.available)
        || !ready || !recovery.permits("preparation.run")} onClick={() => {
        if (!mode) return;
        submit.mutate({ action: "preparation.run", body: { recipe: "prepare", job_ids: [jobId], scope: "selected", limit: 1, resume_mode: mode, allow_below_threshold: allowBelow } }, {
          onSuccess: (receipt) => { setStartedRunId(receipt.runId); cancel.reset(); },
        });
      }}>{submit.isPending ? "Starting preparation…" : busy ? "Preparing resume…" : recovery.record?.operation === "preparation.run" ? "Retry same preparation" : localBaseline ? "Prepare resume locally" : "Prepare resume"}</Button>
      {active || waiting ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => { const runId = active?.runId ?? startedRunId; if (runId) cancel.mutate(runId); }}>{active && active.jobIds.length > 1 ? `Stop preparation for ${active.jobIds.length} jobs` : "Request stop"}</Button> : null}
      {current && retryable && ["failed", "partial", "cancelled"].includes(current.status) ? <Button type="button" variant="outline" disabled={busy || blockedByDraft || !recovery.permits("preparation.retry")} onClick={() => submit.mutate({ action: "preparation.retry", body: { run_id: current.runId, job_ids: [jobId] } }, { onSuccess: (receipt) => { setStartedRunId(receipt.runId); cancel.reset(); } })}>Continue unfinished preparation</Button> : null}
    </div>
    {profileVersion === null ? <p role="status">Save your profile before preparing a resume. {renderProfileSetup?.(mode) ?? <Link to="/profile">Open My profile</Link>}</p> : null}
    {blockedByDraft ? <p role="status">Save your unsaved resume edits before preparing another version. <Button type="button" variant="link" onClick={() => onReviewReady?.()}>Review unsaved edits</Button></p> : null}
    {mode === "tailored" && !tailoring.available ? <p role="status">{tailoring.reason}</p> : null}
    {!ready ? <p role="status">{runtime.isPending ? "Checking preparation readiness…" : runtime.error ? "Preparation readiness could not be checked." : "Preparation is unavailable while the worker reconnects."} <Link to="/settings">Review connections</Link></p> : null}
    {localBaseline ? <p role="status">{baselineCapability.reason}</p> : null}
    <p className="job-preparation-task__scope" data-typography="metadata">{mode === "baseline" ? "Copy the complete saved profile and render it for review. No model calls are needed." : "Assess requirements and fit, compose approved wording, review coherence and render using your saved model and spending limits."} You review and accept the result.</p>
    {busy ? <p role="status">{waiting ? `Preparation ${execution.error ? "status unavailable" : execution.data?.status ?? "queued"}.` : current ? `Preparation ${current.status}${jobSteps.find((step) => step.status === "running") ? ` · ${jobSteps.find((step) => step.status === "running")?.stage.replaceAll("_", " ")}` : ""}.` : "Starting preparation."}</p> : current ? <p role="status">Preparation {current.status === "succeeded" ? hasResume ? "ready for review" : "complete" : current.status}.{incomplete ? ` ${incomplete.errorCode?.replaceAll("_", " ") ?? "A step needs attention"}.` : ""}</p> : execution.data ? <p role="status">Preparation {execution.data.status}{execution.data.errorCode ? ` · ${execution.data.errorCode.replaceAll("_", " ")}` : ""}.</p> : null}
    {belowThreshold ? <p role="status">This job is below your saved fit threshold. Choose the explicit exception below to prepare it.</p> : null}
    {(cancel.isSuccess || execution.data?.cancellationRequested) && busy ? <p role="status">Stop requested. Preparation remains active until it settles.</p> : null}
    {submit.error || cancel.error ? <p role="alert">{(submit.error ?? cancel.error)?.message} Previously accepted resumes remain available.</p> : null}
    <PreparationRecoveryNotice recovery={recovery} />
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
    <PreparationRecoveryNotice recovery={recovery} />
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
    {submit.isError ? <p role="alert">{submit.error.message} Retry unchanged to reconcile an uncertain acknowledgement.</p> : null}
    {submit.isSuccess ? <p role="status">Queued preparation run {submit.data.runId}. <Button type="button" variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(submit.data.runId)}>Cancel queued run</Button></p> : null}
    {cancel.isError ? <p role="alert">{cancel.error.message}</p> : null}
    <PreparationRunListContent commands={commands} />
  </section>;
}
