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

function labelForModel(model: string): string {
  return `${model.charAt(0).toUpperCase()}${model.slice(1)}`;
}

function numberValue(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stageRunStatusLine(status: string, count: number): string {
  return `${status} ${count} ${count === 1 ? "stage action" : "stage actions"}`;
}

const APPLY_MODEL_OPTIONS = ["haiku", "sonnet", "opus"] as const;

interface StageControlSet {
  limit: boolean;
  workers: boolean;
  minScore: boolean;
  validationMode: boolean;
  rescore: boolean;
  retailor: boolean;
  applyModel: boolean;
  headless: boolean;
  continuous: boolean;
}

const BASE_CONTROLS: StageControlSet = {
  limit: false,
  workers: false,
  minScore: false,
  validationMode: false,
  rescore: false,
  retailor: false,
  applyModel: false,
  headless: false,
  continuous: false,
};

const STAGE_CONTROLS: Record<Stage, StageControlSet> = {
  discover: { ...BASE_CONTROLS, workers: true },
  enrich: { ...BASE_CONTROLS, workers: true },
  score: { ...BASE_CONTROLS, limit: true, workers: true, rescore: true },
  tailor: {
    ...BASE_CONTROLS,
    limit: true,
    workers: true,
    minScore: true,
    validationMode: true,
    retailor: true,
  },
  cover: { ...BASE_CONTROLS, limit: true, minScore: true, validationMode: true },
  pdf: { ...BASE_CONTROLS, limit: true },
  apply: {
    ...BASE_CONTROLS,
    limit: true,
    workers: true,
    minScore: true,
    applyModel: true,
    headless: true,
    continuous: true,
  },
};

function applyModelValue(model: string): (typeof APPLY_MODEL_OPTIONS)[number] {
  const trimmed = model.trim();
  return APPLY_MODEL_OPTIONS.includes(trimmed as (typeof APPLY_MODEL_OPTIONS)[number])
    ? (trimmed as (typeof APPLY_MODEL_OPTIONS)[number])
    : "haiku";
}

export function StageTriggerPanel() {
  const runStages = useRunPipelineStagesMutation();
  const activeStage = useStageTriggerStore((state) => state.activeStage);
  const config = useStageTriggerStore((state) => state.configs[state.activeStage]);
  const setActiveStage = useStageTriggerStore((state) => state.setActiveStage);
  const patchStageConfig = useStageTriggerStore((state) => state.patchStageConfig);
  const controls = STAGE_CONTROLS[activeStage];
  const selectedApplyModel = applyModelValue(config.model);

  const patchConfig = (patch: Partial<StageTriggerConfig>) => {
    patchStageConfig(activeStage, patch);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runStages.mutate({
      stages: [activeStage],
      limit: controls.limit ? numberValue(config.limit, 25) : 25,
      workers: controls.workers ? numberValue(config.workers, 1) : 1,
      minScore: controls.minScore ? numberValue(config.minScore, 7) : 7,
      validationMode: controls.validationMode ? config.validationMode : "normal",
      dryRun: config.dryRun,
      rescore: controls.rescore ? config.rescore : false,
      retailor: controls.retailor ? config.retailor : false,
      headless: controls.headless ? config.headless : false,
      model: controls.applyModel ? selectedApplyModel : "haiku",
      continuous: controls.continuous ? config.continuous : false,
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
          {controls.limit ? (
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
          ) : null}
          {controls.workers ? (
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
          ) : null}
          {controls.minScore ? (
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
          ) : null}
          {controls.validationMode ? (
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
          ) : null}
          {controls.applyModel ? (
            <label className="field">
              <span>Apply model</span>
              <select value={selectedApplyModel} onChange={(event) => patchConfig({ model: event.target.value })}>
                {APPLY_MODEL_OPTIONS.map((model) => (
                  <option key={model} value={model}>
                    {labelForModel(model)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
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
          {controls.rescore ? (
            <label className="stage-trigger-check">
              <input
                type="checkbox"
                checked={config.rescore}
                onChange={(event) => patchConfig({ rescore: event.currentTarget.checked })}
              />
              <span>Rescore</span>
            </label>
          ) : null}
          {controls.retailor ? (
            <label className="stage-trigger-check">
              <input
                type="checkbox"
                checked={config.retailor}
                onChange={(event) => patchConfig({ retailor: event.currentTarget.checked })}
              />
              <span>Retailor</span>
            </label>
          ) : null}
          {controls.headless ? (
            <label className="stage-trigger-check">
              <input
                type="checkbox"
                checked={config.headless}
                onChange={(event) => patchConfig({ headless: event.currentTarget.checked })}
              />
              <span>Headless browser</span>
            </label>
          ) : null}
          {controls.continuous ? (
            <label className="stage-trigger-check">
              <input
                type="checkbox"
                checked={config.continuous}
                onChange={(event) => patchConfig({ continuous: event.currentTarget.checked })}
              />
              <span>Continuous</span>
            </label>
          ) : null}
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
