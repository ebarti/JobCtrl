import {
  PIPELINE_RUN_STAGES,
  PIPELINE_VALIDATION_MODES,
  type ActionRunResponse,
  type PipelineRunStage,
  type PipelineStageRunResponse,
  type PipelineValidationMode,
  type Stage,
} from "@jobhunter/contracts";
import { Play } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import { Button } from "../../../shared/ui/button.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../shared/ui/tabs.js";
import { useDashboardSummaryQuery } from "../../operations/hooks/useDashboardSummaryQuery.js";
import { useHealthQuery } from "../../operations/hooks/useHealthQuery.js";
import type { DashboardSummary } from "../../operations/types.js";
import { useRunPipelineStagesMutation } from "../hooks/useRunPipelineStagesMutation.js";
import { useStageTriggerStore, type StageTriggerConfig } from "../stores/stage-trigger-store.js";

type StageActivity = DashboardSummary["activity"][number];

function labelForStage(stage: Stage): string {
  return `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
}

function labelForModel(model: string): string {
  if (model === "default") {
    return "Local default";
  }
  return `${model.charAt(0).toUpperCase()}${model.slice(1)}`;
}

function numberValue(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decimalValue(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function modelSpecList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function stageActionCountLabel(count: number): string {
  return `${count} ${count === 1 ? "stage action" : "stage actions"}`;
}

function actionReference(action: ActionRunResponse | undefined): string | null {
  return action?.runId ?? action?.actionId ?? null;
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function pendingStageStatusLine(stage: Stage): string {
  return `Starting ${labelForStage(stage)}... waiting for local worker response.`;
}

function pipelineRunStatusLine(stage: Stage, response: PipelineStageRunResponse): string {
  const stageLabel = labelForStage(stage);
  const firstAction = response.actions[0];
  const failedAction = response.actions.find((action) => action.status === "failed") ?? firstAction;
  const firstActionReference = actionReference(firstAction);

  if (response.status === "queued") {
    return firstActionReference
      ? `${stageLabel} queued successfully (run ${firstActionReference}).`
      : `${stageLabel} queued successfully.`;
  }
  if (response.status === "failed") {
    const message = failedAction?.message ?? response.message;
    return message ? `${stageLabel} failed to start: ${message}` : `${stageLabel} failed to start.`;
  }
  if (response.status === "succeeded") {
    return `${stageLabel} completed successfully (${stageActionCountLabel(response.count)}).`;
  }
  if (response.status === "dry_run") {
    return `${stageLabel} dry run completed (${stageActionCountLabel(response.count)}).`;
  }
  if (response.status === "accepted") {
    return `${stageLabel} request accepted (${stageActionCountLabel(response.count)}).`;
  }

  return `${stageLabel} ${statusLabel(response.status)} (${stageActionCountLabel(response.count)}).`;
}

function pipelineRequestErrorLine(stage: Stage, error: Error): string {
  return `${labelForStage(stage)} failed to start: ${error.message}`;
}

function latestStageActivity(summary: DashboardSummary | undefined, stage: Stage): StageActivity | null {
  return summary?.activity.find((activity) => activity.stage === stage) ?? null;
}

function isActivityAfter(activity: StageActivity, timestamp: number | null): boolean {
  if (timestamp === null || activity.at === null) return true;
  const occurredAt = Date.parse(activity.at);
  return Number.isNaN(occurredAt) || occurredAt >= timestamp - 5000;
}

function isRunningActivity(activity: StageActivity): boolean {
  return activity.eventType === "ActionStarted" || activity.eventType === "StageStarted";
}

function isFailedActivity(activity: StageActivity): boolean {
  return activity.level === "error" || activity.eventType === "ActionFailed" || activity.eventType === "StageFailed";
}

function stageActivityStatusLine(stage: Stage, activity: StageActivity): string {
  const stageLabel = labelForStage(stage);
  const eventReference = activity.eventId ? ` (#${activity.eventId})` : "";

  if (isRunningActivity(activity)) {
    return `${stageLabel} in progress: ${activity.message}${eventReference}.`;
  }
  if (isFailedActivity(activity)) {
    return `${stageLabel} latest failure: ${activity.message}${eventReference}.`;
  }
  return `${stageLabel} latest event: ${activity.message}${eventReference}.`;
}

const APPLY_MODEL_OPTIONS = ["default", "opus", "sonnet"] as const;

interface StageControlSet {
  limit: boolean;
  workers: boolean;
  minScore: boolean;
  validationMode: boolean;
  rescore: boolean;
  retailor: boolean;
  tailorModels: boolean;
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
  tailorModels: false,
  applyModel: false,
  headless: false,
  continuous: false,
};

const STAGE_CONTROLS: Record<PipelineRunStage, StageControlSet> = {
  discover: { ...BASE_CONTROLS, limit: true, workers: true },
  score: { ...BASE_CONTROLS, limit: true, workers: true, rescore: true },
  tailor: {
    ...BASE_CONTROLS,
    limit: true,
    workers: true,
    minScore: true,
    validationMode: true,
    retailor: true,
    tailorModels: true,
  },
  cover: { ...BASE_CONTROLS, limit: true, minScore: true, validationMode: true },
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
    : "default";
}

export interface StageTriggerPanelProps {
  readonly stagePanels?: Partial<Record<PipelineRunStage, ReactNode>>;
}

export function StageTriggerPanel({ stagePanels = {} }: StageTriggerPanelProps = {}) {
  const runStages = useRunPipelineStagesMutation();
  const [submittedStage, setSubmittedStage] = useState<Stage | null>(null);
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  const dashboardSummary = useDashboardSummaryQuery();
  const health = useHealthQuery();
  const activeStage = useStageTriggerStore((state) => state.activeStage);
  const config = useStageTriggerStore((state) => state.configs[state.activeStage]);
  const setActiveStage = useStageTriggerStore((state) => state.setActiveStage);
  const patchStageConfig = useStageTriggerStore((state) => state.patchStageConfig);
  const controls = STAGE_CONTROLS[activeStage];
  const selectedApplyModel = applyModelValue(config.model);
  const statusStage = submittedStage ?? activeStage;
  const stageActivity = latestStageActivity(dashboardSummary.data, statusStage);
  const relevantPendingActivity =
    runStages.isPending && stageActivity && isActivityAfter(stageActivity, submittedAt) ? stageActivity : null;
  const visibleStageActivity = relevantPendingActivity ?? (!runStages.isPending ? stageActivity : null);
  const headerMeta = runStages.isPending ? "starting" : (runStages.data?.status ?? (runStages.error ? "failed" : "ready"));
  const activeStagePanel = stagePanels[activeStage] ?? null;
  const workerUnhealthy =
    health.isPending || health.isError || health.data?.worker.status !== "healthy";
  const workerHealthMessage = health.isPending
    ? "Checking Temporal worker runtime..."
    : health.isError
      ? `Temporal worker health check failed: ${health.error.message}`
      : (health.data?.worker.message ?? "Temporal worker health is unavailable.");

  const patchConfig = (patch: Partial<StageTriggerConfig>) => {
    patchStageConfig(activeStage, patch);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const workerSnapshot = await health.refetch();
    if (workerSnapshot.data?.worker.status !== "healthy") return;
    setSubmittedStage(activeStage);
    setSubmittedAt(Date.now());
    const tailorJudgeMinScore =
      controls.tailorModels && config.tailorJudgeMinScore.trim()
        ? decimalValue(config.tailorJudgeMinScore, 0.82)
        : undefined;
    runStages.mutate({
      stages: [activeStage],
      limit: controls.limit ? numberValue(config.limit, 25) : 25,
      workers: controls.workers ? numberValue(config.workers, 1) : 1,
      minScore: controls.minScore ? numberValue(config.minScore, 7) : 7,
      validationMode: controls.validationMode ? config.validationMode : "normal",
      dryRun: config.dryRun,
      rescore: controls.rescore ? config.rescore : false,
      retailor: controls.retailor ? config.retailor : false,
      tailorModels: controls.tailorModels ? modelSpecList(config.tailorModels) : [],
      tailorJudgeModel: controls.tailorModels ? config.tailorJudgeModel.trim() || undefined : undefined,
      ...(tailorJudgeMinScore === undefined ? {} : { tailorJudgeMinScore }),
      headless: controls.headless ? config.headless : false,
      model: controls.applyModel ? selectedApplyModel : "default",
      continuous: controls.continuous ? config.continuous : false,
    });
  };

  const stageForm = (
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
              max={1000}
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
        {controls.tailorModels ? (
          <>
            <label className="field">
              <span>Tailor models</span>
              <input
                placeholder="default, gemini:gemini-3.5-flash"
                value={config.tailorModels}
                onChange={(event) => patchConfig({ tailorModels: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Judge model</span>
              <input
                placeholder="default"
                value={config.tailorJudgeModel}
                onChange={(event) => patchConfig({ tailorJudgeModel: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Minimum judge score</span>
              <input
                min={0}
                max={1}
                step={0.01}
                type="number"
                placeholder="env/default"
                value={config.tailorJudgeMinScore}
                onChange={(event) => patchConfig({ tailorJudgeMinScore: event.target.value })}
              />
            </label>
          </>
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
            <span>Re-tailor</span>
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
        <Button disabled={runStages.isPending || workerUnhealthy} type="submit">
          <Play aria-hidden="true" size={16} />
          {workerUnhealthy
            ? health.isPending
              ? "Checking worker"
              : "Worker unavailable"
            : runStages.isPending
              ? `Starting ${labelForStage(statusStage)}`
              : `Run ${labelForStage(activeStage)}`}
        </Button>
        {workerUnhealthy ? (
          <span className="status-line danger-action" role="alert">
            {workerHealthMessage}
          </span>
        ) : runStages.isPending ? (
          <span className="status-line" role="status">
            {relevantPendingActivity
              ? stageActivityStatusLine(statusStage, relevantPendingActivity)
              : pendingStageStatusLine(statusStage)}
          </span>
        ) : runStages.data ? (
          <span className={runStages.data.status === "failed" ? "status-line danger-action" : "status-line"} role="status">
            {pipelineRunStatusLine(statusStage, runStages.data)}
          </span>
        ) : runStages.error ? (
          <span className="status-line danger-action" role="status">
            {pipelineRequestErrorLine(statusStage, runStages.error)}
          </span>
        ) : visibleStageActivity ? (
          <span className={isFailedActivity(visibleStageActivity) ? "status-line danger-action" : "status-line"} role="status">
            {stageActivityStatusLine(statusStage, visibleStageActivity)}
          </span>
        ) : null}
      </div>
    </form>
  );

  return (
    <>
      <section className="card full stage-trigger-panel">
        <CardHeader title="Pipeline actions" meta={headerMeta} />
        <Tabs
          className="stage-trigger-tabs"
          value={activeStage}
          onValueChange={(value) => {
            if (PIPELINE_RUN_STAGES.includes(value as PipelineRunStage)) {
              setActiveStage(value as PipelineRunStage);
            }
          }}
        >
          <TabsList aria-label="Pipeline stages" className="stage-trigger-tab-list">
            {PIPELINE_RUN_STAGES.map((stage) => (
              <TabsTrigger key={stage} value={stage}>
                {labelForStage(stage)}
              </TabsTrigger>
            ))}
          </TabsList>
          {PIPELINE_RUN_STAGES.map((stage) => (
            <TabsContent key={stage} forceMount value={stage} className="stage-trigger-tab-panel">
              {stage === activeStage ? stageForm : null}
            </TabsContent>
          ))}
        </Tabs>
      </section>
      {activeStagePanel}
    </>
  );
}
