import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { PreparationRunDetail, StageTriggerPanel, usePipelineTelemetry, usePreparationRuns } from "../../contexts/pipeline/index.js";
import { useActionRunSummary } from "../../contexts/runs/index.js";
import { Button } from "../../shared/ui/button.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/select.js";

/** Compose public run snapshots without inferring the state of unseen work. */
export function PipelinesView() {
  const runs = usePreparationRuns();
  const work = useActionRunSummary();
  const [selectedRunId, setSelectedRunId] = useState("");
  const selected = runs.data?.find((run) => run.runId === selectedRunId)
    ?? runs.data?.find((run) => run.status === "running") ?? runs.data?.[0];
  const telemetry = usePipelineTelemetry(selected?.runId);
  const observedCohort = telemetry.data?.cohorts.runs.find((run) => run.runId === selected?.runId);
  const stages = new Map<string, Map<string, number>>();
  for (const step of selected?.steps ?? []) {
    const counts = stages.get(step.stage) ?? new Map<string, number>();
    counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
    stages.set(step.stage, counts);
  }

  return <div className="grid gap-4">
    <PageHead eyebrow="Pipeline" title="Pipelines" subtitle="Start and monitor preparation work." />
    <section className="card" aria-labelledby="pipeline-active-work">
      <h2 id="pipeline-active-work">Active work</h2>
      {work.isPending ? <p>Loading recorded action status…</p> : null}
      {work.error ? <p role="alert">Action status could not be refreshed: {work.error.message}{work.data ? " The last loaded counts remain below." : ""}</p> : null}
      {work.data ? <p>{work.data.counts.running ?? 0} running · {work.data.counts.queued ?? 0} queued · {work.data.counts.pending ?? 0} pending · {work.data.pendingCancellation} cancellation requests pending · {work.data.total} recorded actions</p> : null}
      <p>These counts include all action types, not just preparation.</p>
      <Link to="/runs">Inspect action runs</Link>
    </section>
    <section className="card" aria-labelledby="pipeline-capacity">
      <h2 id="pipeline-capacity">Worker and model capacity</h2>
      {telemetry.isPending ? <p>Loading capacity observations…</p> : null}
      {telemetry.error ? <p role="alert">Pipeline telemetry could not be refreshed: {telemetry.error.message}{telemetry.data ? " The last observation remains below." : ""} <Button type="button" variant="outline" onClick={() => void telemetry.refetch()}>Check again</Button></p> : null}
      {telemetry.data ? <>
        <p>Observed {telemetry.data.observedAt}. Sources can change independently between observations.</p>
        <h3>Worker</h3>
        {telemetry.data.worker.available ? <>
          <p>Readiness: {telemetry.data.worker.readiness ?? "unknown"} · Last heartbeat: {telemetry.data.worker.heartbeatAt ?? "unknown"}</p>
          <p>Configured activity slots: {telemetry.data.worker.configuredActivitySlots ?? "unknown"} · Active slots: {telemetry.data.worker.activeActivitySlots ?? "unknown"} · Available slots: {telemetry.data.worker.availableActivitySlots ?? "unknown"}</p>
        </> : <p>Worker observation unavailable.</p>}
        <Caveats items={telemetry.data.worker.caveats} />
        <h3>Model lanes</h3>
        {telemetry.data.modelLanes.available ? <>
          <p>Observed {telemetry.data.modelLanes.observedAt} · Default configured lane capacity: {telemetry.data.modelLanes.defaultCapacity}.</p>
          {telemetry.data.modelLanes.lanes.length ? <ul>{telemetry.data.modelLanes.lanes.map((lane) => <li key={lane.lane}>
            <strong>{lane.lane}</strong>: {lane.active} active · {lane.capacity} configured · {lane.availableCapacity ?? "unknown"} available · {lane.unresolved} unresolved
          </li>)}</ul> : <p>No configured or active lane-specific records. Other lanes use the displayed default.</p>}
          <p>Monetary serialization: {telemetry.data.modelLanes.monetarySerialization ? "enabled" : "disabled"}{telemetry.data.modelLanes.budgetBusy ? " · a model call is currently settling" : ""}.</p>
        </> : <p>Model-lane observation unavailable ({telemetry.data.modelLanes.errorCode}).</p>}
        <Caveats items={telemetry.data.modelLanes.caveats} />
      </> : null}
    </section>
    <section className="card" aria-labelledby="pipeline-cohort">
      <h2 id="pipeline-cohort">Preparation cohort</h2>
      <p>Inspect the recorded targets and stage outcomes for one of the most recent 100 preparation runs. Unrecorded stages and work outside this cohort are not counted.</p>
      {runs.isPending ? <p>Loading preparation runs…</p> : null}
      {runs.error ? <p role="alert">Preparation runs could not be refreshed: {runs.error.message}{runs.data ? " The last loaded runs remain below." : ""} <Button type="button" variant="outline" onClick={() => void runs.refetch()}>Check again</Button></p> : null}
      {runs.data && !runs.data.length ? <p>No preparation runs have been recorded.</p> : null}
      {selected ? <>
        <label htmlFor="pipeline-selected-run">Run</label>
        <Select value={selected.runId} onValueChange={(value) => { if (value) setSelectedRunId(value); }}>
          <SelectTrigger id="pipeline-selected-run"><SelectValue>{selected.recipe} · {selected.status} · {selected.runId}</SelectValue></SelectTrigger>
          <SelectContent>{runs.data?.map((run) => <SelectItem key={run.runId} value={run.runId}>{run.recipe} · {run.status} · {run.runId}</SelectItem>)}</SelectContent>
        </Select>
        <p>Recorded status: {selected.status} · Created {selected.createdAt} · Last updated {selected.updatedAt}</p>
        <p>Recorded target job IDs: {selected.jobIds.length || "none recorded"}{observedCohort && !observedCohort.cohortFrozen ? " · target selection is not yet frozen" : ""}. {selected.parentRunId ? <>Retry of <Link to="/runs/$runId" params={{ runId: selected.parentRunId }}>run {selected.parentRunId}</Link>.</> : null}</p>
        <Link to="/runs/$runId" params={{ runId: selected.runId }}>Inspect this action run</Link>
        {selected.jobIds.length ? <details><summary>Inspect target jobs</summary><ul>
          {selected.jobIds.map((jobId) => <li key={jobId}><Link to="/jobs/$jobId" params={{ jobId }}>{jobId}</Link></li>)}
        </ul></details> : null}
        <h3>Recorded stage outcomes</h3>
        {observedCohort ? <>
          {observedCohort.stages.length ? <ul>{observedCohort.stages.map((stage) => <li key={`${stage.scope}:${stage.stage}`}>
            <strong>{stage.stage}</strong> ({stage.scope}): {stage.recordedCount} recorded of {stage.expectedCount ?? "unknown"} expected · {stage.unrecordedCount ?? "unknown"} without checkpoints
            <p>{Object.entries(stage.statusCounts).filter(([, count]) => count > 0).map(([status, count]) => `${count} ${status}`).join(" · ") || "No recorded status"}</p>
            {stage.running.length ? <ul>{stage.running.map((item) => <li key={item.jobId ?? "run"}>
              {item.jobId ? `Job ${item.jobId}` : "Run"}: {duration(item.secondsSinceRecordedStart)} since the recorded start{item.unclosedPreviousStart ? " · earlier attempt timing is unresolved" : ""}{item.startEventId ? <> · <Link to="/activity/$eventId" params={{ eventId: item.startEventId }}>start event</Link></> : " · start event unavailable"}. Recorded status does not establish worker-slot occupancy.
            </li>)}</ul> : null}
            <details><summary>Timing evidence ({stage.duration.sampleCount} matching samples)</summary>
              <p>Observed duration: {duration(stage.duration.minimumSeconds)} minimum · {duration(stage.duration.medianSeconds)} median · {duration(stage.duration.maximumSeconds)} maximum.</p>
              {stage.duration.samples.length ? <ul>{stage.duration.samples.map((sample) => <li key={`${sample.startEventId}:${sample.endEventId}`}>
                {duration(sample.seconds)} · run {sample.runId}{sample.jobId ? ` · job ${sample.jobId}` : ""} · <Link to="/activity/$eventId" params={{ eventId: sample.startEventId }}>start event</Link> · <Link to="/activity/$eventId" params={{ eventId: sample.endEventId }}>end event</Link>
              </li>)}</ul> : null}<Caveats items={stage.duration.caveats} />
            </details>
          </li>)}</ul> : <p>No stage plan or outcomes have been recorded for this run yet.</p>}
          <Caveats items={observedCohort.caveats} />
          <h3>Completion estimate</h3>
          {observedCohort.eta.available ? <p>{observedCohort.eta.basis === "recorded_completed_cohort" ? "Recorded cohort completed" : `Historical range: ${duration(observedCohort.eta.lowerSeconds)} – ${duration(observedCohort.eta.upperSeconds)}`} · {observedCohort.eta.sampleCount} matching samples.</p> : <p>Unavailable · {observedCohort.eta.sampleCount} matching samples.</p>}
          <Caveats items={observedCohort.eta.caveats} />
          {telemetry.data ? <p>{telemetry.data.history.available ? `Timing history: ${telemetry.data.history.eventCount} events, ${telemetry.data.history.since} to ${telemetry.data.history.until} · ${telemetry.data.history.complete ? "complete for this window" : "bounded or incomplete"}.` : "Timing history unavailable."}</p> : null}
        </> : <>
          {stages.size ? <ul>{Array.from(stages, ([stage, counts]) => <li key={stage}>
            <strong>{stage}</strong>: {Array.from(counts, ([status, count]) => `${count} ${status}`).join(" · ")}
          </li>)}</ul> : <p>No stage outcomes have been recorded for this run yet.</p>}
          <p>Completion estimate: {telemetry.isPending ? "loading" : "unavailable"}.</p>
        </>}
        <details><summary>Inspect stage outcomes and run controls</summary><PreparationRunDetail runId={selected.runId} /></details>
      </> : null}
    </section>
    {telemetry.data ? <section className="card" aria-labelledby="pipeline-discovery">
      <h2 id="pipeline-discovery">Discovery source progress</h2>
      {telemetry.data.discovery.available ? <>
        <p>Observed {telemetry.data.discovery.observedAt}; counts cover recorded units only and are not proof of worker liveness.</p>
        {telemetry.data.discovery.runs.length ? <details><summary>Inspect recent discovery runs ({telemetry.data.discovery.runs.length})</summary>
          {telemetry.data.discovery.runs.map((run) => <article key={run.runId}>
            <h3>{run.runId} · {run.status}</h3>
            <p>{run.completedUnitCount} completed of {run.knownUnitCount} recorded units; the eventual total may change.</p>
            {run.families.length ? <ul>{run.families.map((family) => <li key={family.sourceFamily}>{family.sourceFamily}: {family.knownUnitCount} recorded · {Object.entries(family.statusCounts).map(([status, count]) => `${count} ${status}`).join(" · ")}</li>)}</ul> : <p>No source-family units recorded.</p>}
          </article>)}
        </details> : <p>No discovery runs recorded in the recent history.</p>}
        <Caveats items={telemetry.data.discovery.caveats} />
      </> : <p>Discovery progress unavailable ({telemetry.data.discovery.errorCode}).</p>}
    </section> : null}
    <section className="card" aria-labelledby="pipeline-start-work">
      <h2 id="pipeline-start-work">Start preparation</h2>
      <StageTriggerPanel />
    </section>
  </div>;
}

function duration(value: number | null): string {
  if (value === null) return "unknown";
  if (value < 60) return `${Math.round(value * 10) / 10} sec`;
  return `${Math.round(value / 6) / 10} min`;
}

function Caveats({ items }: { readonly items: readonly string[] }) {
  return items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : null;
}
