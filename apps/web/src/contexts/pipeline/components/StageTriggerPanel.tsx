import {
  PIPELINE_VALIDATION_MODES,
  STAGES,
  type PipelineValidationMode,
  type Stage,
} from "@jobhunter/contracts";
import { Play } from "lucide-react";
import { type FormEvent } from "react";

import { Button } from "../../../shared/ui/button.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Tabs, TabsList, TabsTrigger } from "../../../shared/ui/tabs.js";
import { useRunPipelineStagesMutation } from "../hooks/useRunPipelineStagesMutation.js";
import { useStageTriggerStore, type StageTriggerConfig } from "../stores/stage-trigger-store.js";

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
  const activeStage = useStageTriggerStore((state) => state.activeStage);
  const config = useStageTriggerStore((state) => state.configs[state.activeStage]);
  const setActiveStage = useStageTriggerStore((state) => state.setActiveStage);
  const patchStageConfig = useStageTriggerStore((state) => state.patchStageConfig);

  const patchConfig = (patch: Partial<StageTriggerConfig>) => {
    patchStageConfig(activeStage, patch);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runStages.mutate({
      stages: [activeStage],
      limit: numberValue(config.limit, 25),
      workers: numberValue(config.workers, 1),
      minScore: numberValue(config.minScore, 7),
      validationMode: config.validationMode,
      dryRun: config.dryRun,
      rescore: config.rescore,
      retailor: config.retailor,
      headless: config.headless,
      model: config.model.trim() || "haiku",
      continuous: config.continuous,
    });
  };

  return (
    <section className="card full stage-trigger-panel">
      <CardHeader title="Pipeline actions" meta={runStages.data?.status ?? "ready"} />
      <Tabs
        className="stage-trigger-tabs"
        value={activeStage}
        onValueChange={(value) => {
          if (STAGES.includes(value as Stage)) {
            setActiveStage(value as Stage);
          }
        }}
      >
        <TabsList aria-label="Pipeline stages" className="stage-trigger-tab-list">
          {STAGES.map((stage) => (
            <TabsTrigger key={stage} value={stage}>
              {labelForStage(stage)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <form className="stage-trigger-form" onSubmit={submit}>
        <div className="stage-trigger-active">
          <span className="muted">Configuring</span>
          <strong>{labelForStage(activeStage)}</strong>
        </div>

        <div className="stage-trigger-grid">
          <label className="field">
            <span>Limit</span>
            <input
              min={1}
              max={500}
              type="number"
              value={config.limit}
              onChange={(event) => patchConfig({ limit: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Workers</span>
            <input
              min={1}
              max={16}
              type="number"
              value={config.workers}
              onChange={(event) => patchConfig({ workers: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Minimum score</span>
            <input
              min={0}
              max={10}
              type="number"
              value={config.minScore}
              onChange={(event) => patchConfig({ minScore: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Validation mode</span>
            <select
              value={config.validationMode}
              onChange={(event) => patchConfig({ validationMode: event.target.value as PipelineValidationMode })}
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
            <input value={config.model} onChange={(event) => patchConfig({ model: event.target.value })} />
          </label>
        </div>

        <div className="stage-trigger-options">
          <label className="stage-trigger-check">
            <input
              type="checkbox"
              checked={config.dryRun}
              onChange={(event) => patchConfig({ dryRun: event.currentTarget.checked })}
            />
            <span>Dry run</span>
          </label>
          <label className="stage-trigger-check">
            <input
              type="checkbox"
              checked={config.rescore}
              onChange={(event) => patchConfig({ rescore: event.currentTarget.checked })}
            />
            <span>Rescore</span>
          </label>
          <label className="stage-trigger-check">
            <input
              type="checkbox"
              checked={config.retailor}
              onChange={(event) => patchConfig({ retailor: event.currentTarget.checked })}
            />
            <span>Retailor</span>
          </label>
          <label className="stage-trigger-check">
            <input
              type="checkbox"
              checked={config.headless}
              onChange={(event) => patchConfig({ headless: event.currentTarget.checked })}
            />
            <span>Headless browser</span>
          </label>
          <label className="stage-trigger-check">
            <input
              type="checkbox"
              checked={config.continuous}
              onChange={(event) => patchConfig({ continuous: event.currentTarget.checked })}
            />
            <span>Continuous</span>
          </label>
        </div>

        <div className="stage-trigger-actions">
          <Button disabled={runStages.isPending} type="submit">
            <Play aria-hidden="true" size={16} />
            {runStages.isPending ? "Starting" : `Run ${labelForStage(activeStage)}`}
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
