import {
  PIPELINE_VALIDATION_MODES,
  STAGES,
  type PipelineValidationMode,
  type Stage,
} from "@jobhunter/contracts";
import { Play } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Button } from "../../../shared/ui/button.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { useRunPipelineStagesMutation } from "../hooks/useRunPipelineStagesMutation.js";

function labelForStage(stage: Stage): string {
  return stage === "pdf" ? "PDF" : `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
}

function numberValue(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stageRunStatusLine(status: string, count: number): string {
  return `${status} ${count} ${count === 1 ? "stage action" : "stage actions"}`;
}

export function StageTriggerPanel() {
  const runStages = useRunPipelineStagesMutation();
  const [selectedStages, setSelectedStages] = useState<Stage[]>([]);
  const [limit, setLimit] = useState("25");
  const [workers, setWorkers] = useState("1");
  const [minScore, setMinScore] = useState("7");
  const [validationMode, setValidationMode] = useState<PipelineValidationMode>("normal");
  const [dryRun, setDryRun] = useState(true);
  const [rescore, setRescore] = useState(false);
  const [retailor, setRetailor] = useState(false);
  const [headless, setHeadless] = useState(false);
  const [model, setModel] = useState("haiku");
  const [continuous, setContinuous] = useState(false);

  const toggleStage = (stage: Stage, checked: boolean) => {
    const next = new Set(selectedStages);
    if (checked) {
      next.add(stage);
    } else {
      next.delete(stage);
    }
    setSelectedStages(STAGES.filter((item) => next.has(item)));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedStages.length === 0) {
      return;
    }
    runStages.mutate({
      stages: selectedStages,
      limit: numberValue(limit, 25),
      workers: numberValue(workers, 1),
      minScore: numberValue(minScore, 7),
      validationMode,
      dryRun,
      rescore,
      retailor,
      headless,
      model: model.trim() || "haiku",
      continuous,
    });
  };

  return (
    <section className="card full stage-trigger-panel">
      <CardHeader title="Pipeline actions" meta={runStages.data?.status ?? "ready"} />
      <form className="stage-trigger-form" onSubmit={submit}>
        <fieldset className="stage-trigger-stages">
          <legend>Stages</legend>
          {STAGES.map((stage) => (
            <label className="stage-trigger-check" key={stage}>
              <input
                type="checkbox"
                checked={selectedStages.includes(stage)}
                onChange={(event) => toggleStage(stage, event.currentTarget.checked)}
              />
              <span>{labelForStage(stage)}</span>
            </label>
          ))}
        </fieldset>

        <div className="stage-trigger-grid">
          <label className="field">
            <span>Limit</span>
            <input min={1} max={500} type="number" value={limit} onChange={(event) => setLimit(event.target.value)} />
          </label>
          <label className="field">
            <span>Workers</span>
            <input
              min={1}
              max={16}
              type="number"
              value={workers}
              onChange={(event) => setWorkers(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Minimum score</span>
            <input
              min={0}
              max={10}
              type="number"
              value={minScore}
              onChange={(event) => setMinScore(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Validation mode</span>
            <select
              value={validationMode}
              onChange={(event) => setValidationMode(event.target.value as PipelineValidationMode)}
            >
              {PIPELINE_VALIDATION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Apply model</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} />
          </label>
        </div>

        <div className="stage-trigger-options">
          <label className="stage-trigger-check">
            <input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.currentTarget.checked)} />
            <span>Dry run</span>
          </label>
          <label className="stage-trigger-check">
            <input type="checkbox" checked={rescore} onChange={(event) => setRescore(event.currentTarget.checked)} />
            <span>Rescore</span>
          </label>
          <label className="stage-trigger-check">
            <input type="checkbox" checked={retailor} onChange={(event) => setRetailor(event.currentTarget.checked)} />
            <span>Retailor</span>
          </label>
          <label className="stage-trigger-check">
            <input type="checkbox" checked={headless} onChange={(event) => setHeadless(event.currentTarget.checked)} />
            <span>Headless browser</span>
          </label>
          <label className="stage-trigger-check">
            <input
              type="checkbox"
              checked={continuous}
              onChange={(event) => setContinuous(event.currentTarget.checked)}
            />
            <span>Continuous</span>
          </label>
        </div>

        <div className="stage-trigger-actions">
          <Button disabled={selectedStages.length === 0 || runStages.isPending} type="submit">
            <Play aria-hidden="true" size={16} />
            {runStages.isPending ? "Starting" : "Run selected stages"}
          </Button>
          {runStages.data ? (
            <span className="status-line">{stageRunStatusLine(runStages.data.status, runStages.data.count)}</span>
          ) : null}
          {runStages.error ? <span className="status-line danger-action">{runStages.error.message}</span> : null}
        </div>
      </form>
    </section>
  );
}
