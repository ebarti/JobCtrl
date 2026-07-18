import {
  DEFAULT_PIPELINE_LLM_MODEL,
  MIN_TAILORING_FIT_SCORE,
  PIPELINE_RUN_STAGES,
  PIPELINE_VALIDATION_MODES,
  type ActionRunResponse,
  type PipelineRunStage,
  type PipelineStageRunResponse,
  type PipelineValidationMode,
  type Stage,
} from "@jobctrl/contracts";
import { IconPlayerPlay } from "@tabler/icons-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import {
  getApiCapabilityAvailability,
  LOCAL_INSTALL_GUIDE_URL,
} from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../shared/ui/card.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../shared/ui/tabs.js";
import { useDashboardSummaryQuery } from "../../operations/hooks/useDashboardSummaryQuery.js";
import { useSourceRegistryQuery } from "../../operations/hooks/useDiscoveryProductControlsQuery.js";
import { useHealthQuery } from "../../operations/hooks/useHealthQuery.js";
import type {
  DashboardSummary,
  SourceRegistryEntrySummary,
} from "../../operations/types.js";
import { CancelWorkflowRunButton } from "./CancelWorkflowRunButton.js";
import { useRunPipelineStagesMutation } from "../hooks/useRunPipelineStagesMutation.js";
import {
  useStageTriggerStore,
  type StageTriggerConfig,
} from "../stores/stage-trigger-store.js";

type StageActivity = DashboardSummary["activity"][number];
type StageProgress = DashboardSummary["progress"][number];

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

function stageMinScore(stage: PipelineRunStage, value: string): number {
  const parsed = numberValue(value, 7);
  return stage === "tailor"
    ? Math.max(MIN_TAILORING_FIT_SCORE, parsed)
    : parsed;
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

const SOURCE_KIND_LABELS: Record<string, string> = {
  ats_api: "ATS API",
  employer_careers_page: "Employer careers",
  official_api: "Official API",
  licensed_feed: "Licensed feed",
  niche_board: "Niche board",
  broad_board: "Broad board",
  smart_extract: "Smart extract",
  user_mediated_capture: "User capture",
};

function actionReference(action: ActionRunResponse | undefined): string | null {
  return action?.runId ?? action?.actionId ?? null;
}

function latestWorkflowRunId(
  response: PipelineStageRunResponse | undefined,
): string | null {
  const action =
    response?.actions.find((item) => item.workflowId || item.runId) ??
    response?.actions[0];
  return action?.workflowId ?? action?.runId ?? null;
}

function progressWorkflowRunId(progress: StageProgress | null): string | null {
  return progress?.status === "running" ? (progress.workflowId ?? null) : null;
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function pendingStageStatusLine(stage: Stage): string {
  return `Starting ${labelForStage(stage)}... waiting for local worker response.`;
}

function pipelineRunStatusLine(
  stage: Stage,
  response: PipelineStageRunResponse,
): string {
  const stageLabel = labelForStage(stage);
  const firstAction = response.actions[0];
  const failedAction =
    response.actions.find((action) => action.status === "failed") ??
    firstAction;
  const firstActionReference = actionReference(firstAction);

  if (response.status === "queued") {
    return firstActionReference
      ? `${stageLabel} queued successfully (run ${firstActionReference}).`
      : `${stageLabel} queued successfully.`;
  }
  if (response.status === "failed") {
    const message = failedAction?.message ?? response.message;
    return message
      ? `${stageLabel} failed to start: ${message}`
      : `${stageLabel} failed to start.`;
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

function sourceKindLabel(kind: string): string {
  const known = SOURCE_KIND_LABELS[kind];
  if (known) return known;
  return kind
    .split(/[_:-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function sourceOptionLabel(source: SourceRegistryEntrySummary): string {
  return `${source.displayName} · ${sourceKindLabel(source.kind)} · ${source.state}`;
}

function selectableDiscoverySources(
  sources: readonly SourceRegistryEntrySummary[],
): SourceRegistryEntrySummary[] {
  return [...sources]
    .filter((source) => source.state !== "disabled")
    .sort((left, right) =>
      sourceOptionLabel(left).localeCompare(sourceOptionLabel(right)),
    );
}

function pipelineRequestErrorLine(stage: Stage, error: Error): string {
  return `${labelForStage(stage)} failed to start: ${error.message}`;
}

function latestStageActivity(
  summary: DashboardSummary | undefined,
  stage: Stage,
): StageActivity | null {
  return summary?.activity.find((activity) => activity.stage === stage) ?? null;
}

function latestStageProgress(
  summary: DashboardSummary | undefined,
  stage: Stage,
): StageProgress | null {
  return summary?.progress.find((progress) => progress.stage === stage) ?? null;
}

function isActivityAfter(
  activity: StageActivity,
  timestamp: number | null,
): boolean {
  if (timestamp === null || activity.at === null) return true;
  const occurredAt = Date.parse(activity.at);
  return Number.isNaN(occurredAt) || occurredAt >= timestamp - 5000;
}

function isProgressAfter(
  progress: StageProgress,
  timestamp: number | null,
): boolean {
  if (timestamp === null || progress.updatedAt === null) return true;
  const updatedAt = Date.parse(progress.updatedAt);
  return Number.isNaN(updatedAt) || updatedAt >= timestamp - 5000;
}

function isRunningActivity(activity: StageActivity): boolean {
  return (
    activity.eventType === "ActionStarted" ||
    activity.eventType === "StageStarted"
  );
}

function isFailedActivity(activity: StageActivity): boolean {
  return (
    activity.level === "error" ||
    activity.eventType === "ActionFailed" ||
    activity.eventType === "StageFailed"
  );
}

function stageActivityStatusLine(
  stage: Stage,
  activity: StageActivity,
): string {
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

function sentenceDetail(detail: string): string {
  return /[.!?]$/.test(detail) ? detail : `${detail}.`;
}

function formatProgressNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");
}

const DISCOVERY_SOURCE_LABELS: Record<string, string> = {
  jobspy: "JobSpy",
  workday: "Workday",
  smartextract: "Smart extract",
};

function discoverySourceLabel(source: string): string {
  const normalized = source.trim().toLowerCase();
  const known = DISCOVERY_SOURCE_LABELS[normalized];
  if (known) return known;
  return normalized
    .split(/[_:-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function userFacingProgressDetail(
  stage: Stage,
  progress: StageProgress,
): string {
  const detail =
    progress.message || progress.currentStep || "stage progress updated";
  if (
    progress.status === "partial" &&
    stage === "discover" &&
    /^(?:discover\s+)?stage partial$|^preparation complete$|^stage completed with warnings$/i.test(
      detail.trim(),
    )
  ) {
    return (
      "Discovery finished with warnings. Recoverable scoring and tailoring work is retried automatically; " +
      "items that exhaust retry attempts need attention from the job details."
    );
  }
  const orphanedDiscoveryMatch = detail.match(
    /^Discovery source\s+(\S+)\s+was left running by a prior worker(?:\s+and has been marked failed for retry)?\.?$/i,
  );
  if (orphanedDiscoveryMatch?.[1]) {
    return `${discoverySourceLabel(orphanedDiscoveryMatch[1])} is ready to run again.`;
  }
  if (
    /^Discovery run was left running by a prior worker(?:\s+and has been marked failed for retry)?\.?$/i.test(
      detail,
    )
  ) {
    return "Discover is ready to run again.";
  }
  return detail;
}

function sourceProgressStatusDetail(progress: StageProgress): string | null {
  const source = progress.sourceProgress;
  if (!source) return null;
  const unit = source.unit || "items";
  const currentStep = progress.currentStep ? `${progress.currentStep} ` : "";
  const count = `${formatProgressNumber(source.completed)}/${formatProgressNumber(source.total)}`;
  const searchLabel =
    source.currentQuery && source.currentLocation
      ? `: ${source.currentQuery} in ${source.currentLocation}`
      : source.currentQuery
        ? `: ${source.currentQuery}`
        : "";
  const counters: string[] = [];
  if (source.newJobs != null)
    counters.push(`${formatProgressNumber(source.newJobs)} new`);
  if (source.existingJobs != null)
    counters.push(`${formatProgressNumber(source.existingJobs)} dupes`);
  if (source.filteredJobs != null)
    counters.push(`${formatProgressNumber(source.filteredJobs)} filtered`);
  if (source.errorCount != null)
    counters.push(`${formatProgressNumber(source.errorCount)} errors`);
  if (source.rawTotal != null)
    counters.push(`${formatProgressNumber(source.rawTotal)} found`);
  const counterText = counters.length > 0 ? `; ${counters.join(", ")}` : "";
  return `${currentStep}${count} ${unit} done${searchLabel}${counterText}`;
}

function stageProgressStatusLine(
  stage: Stage,
  progress: StageProgress,
): string {
  const stageLabel = labelForStage(stage);
  const percent = progress.percent === null ? null : `${progress.percent}%`;
  const count = `${progress.completed}/${progress.total}`;
  const detail =
    sourceProgressStatusDetail(progress) ??
    userFacingProgressDetail(stage, progress);
  const detailSentence = sentenceDetail(detail);
  const showStageCount = progress.sourceProgress === undefined;

  if (progress.status === "failed") {
    if (!showStageCount) {
      return percent
        ? `${stageLabel} not running. Last progress ${percent}: ${detailSentence}`
        : `${stageLabel} not running. Last progress: ${detailSentence}`;
    }
    return percent
      ? `${stageLabel} not running. Last progress ${percent} (${count}): ${detailSentence}`
      : `${stageLabel} not running. Last progress ${count}: ${detailSentence}`;
  }
  if (progress.status === "partial") {
    if (!showStageCount) {
      return percent
        ? `${stageLabel} ${percent} complete with warnings: ${detailSentence}`
        : `${stageLabel} progress with warnings: ${detailSentence}`;
    }
    return percent
      ? `${stageLabel} ${percent} complete with warnings (${count}): ${detailSentence}`
      : `${stageLabel} progress with warnings (${count}): ${detailSentence}`;
  }
  if (progress.status === "succeeded" || progress.percent === 100) {
    if (!showStageCount) {
      return `${stageLabel} 100% complete: ${detailSentence}`;
    }
    return `${stageLabel} 100% complete (${count}): ${detailSentence}`;
  }
  if (!showStageCount) {
    return percent
      ? `${stageLabel} ${percent} complete: ${detailSentence}`
      : `${stageLabel} progress: ${detailSentence}`;
  }
  return percent
    ? `${stageLabel} ${percent} complete (${count}): ${detailSentence}`
    : `${stageLabel} progress (${count}): ${detailSentence}`;
}

function StageProgressLine({
  stage,
  progress,
}: {
  readonly stage: Stage;
  readonly progress: StageProgress;
}) {
  const progressValue = progress.percent ?? undefined;
  return (
    <span
      className={
        progress.status === "failed"
          ? "status-line stage-progress-line danger-action"
          : "status-line stage-progress-line"
      }
      role="status"
    >
      <span data-typography="metadata">
        {stageProgressStatusLine(stage, progress)}
      </span>
      <progress
        aria-label={`${labelForStage(stage)} progress`}
        className="stage-progress-meter"
        max={100}
        value={progressValue}
      />
    </span>
  );
}

const APPLY_MODEL_OPTIONS = ["default", "opus", "sonnet"] as const;
const USER_FACING_PIPELINE_STAGES = [
  "discover",
  "apply",
] as const satisfies readonly PipelineRunStage[];
const USER_FACING_PIPELINE_STAGE_SET: ReadonlySet<PipelineRunStage> = new Set(
  USER_FACING_PIPELINE_STAGES,
);

interface StageControlSet {
  limit: boolean;
  workers: boolean;
  minScore: boolean;
  validationMode: boolean;
  rescore: boolean;
  retailor: boolean;
  tailorModels: boolean;
  applyModel: boolean;
  discoverySource: boolean;
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
  discoverySource: false,
  headless: false,
  continuous: false,
};

const STAGE_CONTROLS: Record<PipelineRunStage, StageControlSet> = {
  discover: {
    ...BASE_CONTROLS,
    limit: true,
    workers: true,
    discoverySource: true,
  },
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
  cover: {
    ...BASE_CONTROLS,
    limit: true,
    minScore: true,
    validationMode: true,
  },
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
  return APPLY_MODEL_OPTIONS.includes(
    trimmed as (typeof APPLY_MODEL_OPTIONS)[number],
  )
    ? (trimmed as (typeof APPLY_MODEL_OPTIONS)[number])
    : "default";
}

export interface StageTriggerPanelProps {
  readonly stagePanels?: Partial<Record<PipelineRunStage, ReactNode>>;
}

export function StageTriggerPanel({
  stagePanels = {},
}: StageTriggerPanelProps = {}) {
  const { featureFlags } = usePorts();
  const runAvailability = getApiCapabilityAvailability(
    featureFlags,
    "runPipelineStages",
  );
  const unavailableReasonId = useId();
  const runStages = useRunPipelineStagesMutation();
  const [submittedStage, setSubmittedStage] = useState<Stage | null>(null);
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  const dashboardSummary = useDashboardSummaryQuery();
  const health = useHealthQuery();
  const persistedActiveStage = useStageTriggerStore(
    (state) => state.activeStage,
  );
  const activeStage: PipelineRunStage = USER_FACING_PIPELINE_STAGE_SET.has(
    persistedActiveStage,
  )
    ? persistedActiveStage
    : "discover";
  const config = useStageTriggerStore((state) => state.configs[activeStage]);
  const setActiveStage = useStageTriggerStore((state) => state.setActiveStage);
  const patchStageConfig = useStageTriggerStore(
    (state) => state.patchStageConfig,
  );
  const controls = STAGE_CONTROLS[activeStage];
  const sourceRegistry = useSourceRegistryQuery({
    enabled: controls.discoverySource,
  });
  const discoverySources = controls.discoverySource
    ? selectableDiscoverySources(sourceRegistry.data?.sources ?? [])
    : [];
  const selectedDiscoverySourceId = config.discoverySourceId.trim();
  const selectedDiscoverySourceAvailable =
    !selectedDiscoverySourceId ||
    discoverySources.some(
      (source) => source.sourceId === selectedDiscoverySourceId,
    );
  const selectedApplyModel = applyModelValue(config.model);
  const statusStage = submittedStage ?? activeStage;
  const stageActivity = latestStageActivity(dashboardSummary.data, statusStage);
  const stageProgress = latestStageProgress(dashboardSummary.data, statusStage);
  const relevantPendingActivity =
    runStages.isPending &&
    stageActivity &&
    isActivityAfter(stageActivity, submittedAt)
      ? stageActivity
      : null;
  const visibleStageActivity =
    relevantPendingActivity ?? (!runStages.isPending ? stageActivity : null);
  const visibleStageProgress =
    stageProgress && isProgressAfter(stageProgress, submittedAt)
      ? stageProgress
      : null;
  const cancelableRunId =
    latestWorkflowRunId(runStages.data) ??
    progressWorkflowRunId(visibleStageProgress);
  const headerMeta = runStages.isPending
    ? "starting"
    : (runStages.data?.status ?? (runStages.error ? "failed" : "ready"));
  const activeStagePanel = stagePanels[activeStage] ?? null;
  const workerUnhealthy =
    health.isPending ||
    health.isError ||
    health.data?.worker.status !== "healthy";
  const workerHealthMessage = health.isPending
    ? "Checking JobCtrl automation worker runtime..."
    : health.isError
      ? `JobCtrl automation worker health check failed: ${health.error.message}`
      : (health.data?.worker.message ??
        "JobCtrl automation worker health is unavailable.");

  const patchConfig = (patch: Partial<StageTriggerConfig>) => {
    patchStageConfig(activeStage, patch);
  };
  const fieldId = (name: string) => `stage-trigger-${activeStage}-${name}`;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!runAvailability.available) return;
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
      minScore: controls.minScore
        ? stageMinScore(activeStage, config.minScore)
        : 7,
      validationMode: controls.validationMode
        ? config.validationMode
        : "normal",
      dryRun: config.dryRun,
      rescore: controls.rescore ? config.rescore : false,
      retailor: controls.retailor ? config.retailor : false,
      llmModel: DEFAULT_PIPELINE_LLM_MODEL,
      tailorModels: controls.tailorModels
        ? modelSpecList(config.tailorModels)
        : [],
      tailorJudgeModel: controls.tailorModels
        ? config.tailorJudgeModel.trim() || undefined
        : undefined,
      ...(tailorJudgeMinScore === undefined ? {} : { tailorJudgeMinScore }),
      headless: controls.headless ? config.headless : false,
      model: controls.applyModel ? selectedApplyModel : "default",
      continuous: controls.continuous ? config.continuous : false,
      ...(controls.discoverySource && selectedDiscoverySourceId
        ? { sourceIds: [selectedDiscoverySourceId] }
        : {}),
    });
  };

  const stageForm = (
    <form className="stage-trigger-form" onSubmit={submit}>
      <div className="stage-trigger-active">
        <span className="muted" data-typography="metadata">Configuring</span>
        <strong>{labelForStage(activeStage)}</strong>
      </div>

      <div className="stage-trigger-grid">
        {controls.limit ? (
          <Field className="field">
            <FieldLabel htmlFor={fieldId("limit")}>Limit</FieldLabel>
            <Input
              id={fieldId("limit")}
              name="limit"
              min={1}
              max={1000}
              type="number"
              value={config.limit}
              onChange={(event) => patchConfig({ limit: event.target.value })}
            />
          </Field>
        ) : null}
        {controls.workers ? (
          <Field className="field">
            <FieldLabel htmlFor={fieldId("workers")}>
              Internal concurrency
            </FieldLabel>
            <Input
              id={fieldId("workers")}
              name="workers"
              min={1}
              max={16}
              type="number"
              value={config.workers}
              onChange={(event) => patchConfig({ workers: event.target.value })}
            />
          </Field>
        ) : null}
        {controls.discoverySource ? (
          <Field className="field stage-trigger-source-field">
            <FieldLabel htmlFor={fieldId("source")}>Source</FieldLabel>
            <Select
              items={[
                { label: "All runnable sources", value: null },
                ...(sourceRegistry.isLoading
                  ? [{ label: "Loading sources", value: "__loading" }]
                  : []),
                ...(sourceRegistry.isError
                  ? [{ label: "Source list unavailable", value: "__error" }]
                  : []),
                ...(!selectedDiscoverySourceAvailable
                  ? [
                      {
                        label: "Selected source unavailable",
                        value: selectedDiscoverySourceId,
                      },
                    ]
                  : []),
                ...discoverySources.map((source) => ({
                  label: sourceOptionLabel(source),
                  value: source.sourceId,
                })),
              ]}
              value={selectedDiscoverySourceId || null}
              onValueChange={(value) =>
                patchConfig({ discoverySourceId: value ?? "" })
              }
            >
              <SelectTrigger
                id={fieldId("source")}
                aria-label="Source"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={null}>All runnable sources</SelectItem>
                  {sourceRegistry.isLoading ? (
                    <SelectItem disabled value="__loading">
                      Loading sources
                    </SelectItem>
                  ) : null}
                  {sourceRegistry.isError ? (
                    <SelectItem disabled value="__error">
                      Source list unavailable
                    </SelectItem>
                  ) : null}
                  {!selectedDiscoverySourceAvailable ? (
                    <SelectItem value={selectedDiscoverySourceId}>
                      Selected source unavailable
                    </SelectItem>
                  ) : null}
                  {discoverySources.map((source) => (
                    <SelectItem key={source.sourceId} value={source.sourceId}>
                      {sourceOptionLabel(source)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        {controls.minScore ? (
          <Field className="field">
            <FieldLabel htmlFor={fieldId("min-score")}>
              Minimum score
            </FieldLabel>
            <Input
              id={fieldId("min-score")}
              name="min-score"
              min={activeStage === "tailor" ? MIN_TAILORING_FIT_SCORE : 0}
              max={10}
              type="number"
              value={config.minScore}
              onChange={(event) =>
                patchConfig({ minScore: event.target.value })
              }
            />
          </Field>
        ) : null}
        {controls.validationMode ? (
          <Field className="field">
            <FieldLabel htmlFor={fieldId("validation-mode")}>
              Validation mode
            </FieldLabel>
            <Select
              items={PIPELINE_VALIDATION_MODES.map((mode) => ({
                label: mode,
                value: mode,
              }))}
              value={config.validationMode}
              onValueChange={(value) => {
                if (value !== null) {
                  patchConfig({
                    validationMode: value as PipelineValidationMode,
                  });
                }
              }}
            >
              <SelectTrigger
                id={fieldId("validation-mode")}
                aria-label="Validation mode"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PIPELINE_VALIDATION_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {mode}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        {controls.applyModel ? (
          <Field className="field">
            <FieldLabel htmlFor={fieldId("apply-model")}>
              Apply model
            </FieldLabel>
            <Select
              items={APPLY_MODEL_OPTIONS.map((model) => ({
                label: labelForModel(model),
                value: model,
              }))}
              value={selectedApplyModel}
              onValueChange={(value) => {
                if (value !== null) patchConfig({ model: value });
              }}
            >
              <SelectTrigger
                id={fieldId("apply-model")}
                aria-label="Apply model"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {APPLY_MODEL_OPTIONS.map((model) => (
                    <SelectItem key={model} value={model}>
                      {labelForModel(model)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        {controls.tailorModels ? (
          <>
            <Field className="field">
              <FieldLabel htmlFor={fieldId("tailor-models")}>
                Tailor models
              </FieldLabel>
              <Input
                id={fieldId("tailor-models")}
                name="tailor-models"
                placeholder={DEFAULT_PIPELINE_LLM_MODEL}
                value={config.tailorModels}
                onChange={(event) =>
                  patchConfig({ tailorModels: event.target.value })
                }
              />
            </Field>
            <Field className="field">
              <FieldLabel htmlFor={fieldId("tailor-judge-model")}>
                Judge model
              </FieldLabel>
              <Input
                id={fieldId("tailor-judge-model")}
                name="tailor-judge-model"
                placeholder={DEFAULT_PIPELINE_LLM_MODEL}
                value={config.tailorJudgeModel}
                onChange={(event) =>
                  patchConfig({ tailorJudgeModel: event.target.value })
                }
              />
            </Field>
            <Field className="field">
              <FieldLabel htmlFor={fieldId("tailor-judge-min-score")}>
                Minimum judge score
              </FieldLabel>
              <Input
                id={fieldId("tailor-judge-min-score")}
                name="tailor-judge-min-score"
                min={0}
                max={1}
                step={0.01}
                type="number"
                placeholder="env/default"
                value={config.tailorJudgeMinScore}
                onChange={(event) =>
                  patchConfig({ tailorJudgeMinScore: event.target.value })
                }
              />
            </Field>
          </>
        ) : null}
      </div>

      <div className="stage-trigger-options">
        <Field className="stage-trigger-check" orientation="horizontal">
          <Checkbox
            id={fieldId("dry-run")}
            name="dry-run"
            checked={config.dryRun}
            onCheckedChange={(checked) => patchConfig({ dryRun: checked })}
          />
          <FieldLabel htmlFor={fieldId("dry-run")}>Dry run</FieldLabel>
        </Field>
        {controls.rescore ? (
          <Field className="stage-trigger-check" orientation="horizontal">
            <Checkbox
              id={fieldId("rescore")}
              name="rescore"
              checked={config.rescore}
              onCheckedChange={(checked) => patchConfig({ rescore: checked })}
            />
            <FieldLabel htmlFor={fieldId("rescore")}>Rescore</FieldLabel>
          </Field>
        ) : null}
        {controls.retailor ? (
          <Field className="stage-trigger-check" orientation="horizontal">
            <Checkbox
              id={fieldId("retailor")}
              name="retailor"
              checked={config.retailor}
              onCheckedChange={(checked) => patchConfig({ retailor: checked })}
            />
            <FieldLabel htmlFor={fieldId("retailor")}>Re-tailor</FieldLabel>
          </Field>
        ) : null}
        {controls.headless ? (
          <Field className="stage-trigger-check" orientation="horizontal">
            <Checkbox
              id={fieldId("headless")}
              name="headless"
              checked={config.headless}
              onCheckedChange={(checked) => patchConfig({ headless: checked })}
            />
            <FieldLabel htmlFor={fieldId("headless")}>
              Headless browser
            </FieldLabel>
          </Field>
        ) : null}
        {controls.continuous ? (
          <Field className="stage-trigger-check" orientation="horizontal">
            <Checkbox
              id={fieldId("continuous")}
              name="continuous"
              checked={config.continuous}
              onCheckedChange={(checked) => patchConfig({ continuous: checked })}
            />
            <FieldLabel htmlFor={fieldId("continuous")}>
              Continuous
            </FieldLabel>
          </Field>
        ) : null}
      </div>

      <div className="stage-trigger-actions">
        <Button
          aria-describedby={
            runAvailability.available ? undefined : unavailableReasonId
          }
          disabled={
            runStages.isPending || workerUnhealthy || !runAvailability.available
          }
          type="submit"
        >
          <IconPlayerPlay aria-hidden="true" data-icon="inline-start" />
          {!runAvailability.available
            ? "Run in local app"
            : workerUnhealthy
            ? health.isPending
              ? "Checking worker"
              : "Worker unavailable"
            : runStages.isPending
              ? `Starting ${labelForStage(statusStage)}`
              : `Run ${labelForStage(activeStage)}`}
        </Button>
        {cancelableRunId &&
        (runStages.data?.status === "queued" ||
          runStages.data?.status === "accepted" ||
          visibleStageProgress?.status === "running") ? (
          <CancelWorkflowRunButton
            runId={cancelableRunId}
            label={`Stop ${labelForStage(statusStage)}`}
            ariaLabel={`Stop ${labelForStage(statusStage)} run`}
          />
        ) : null}
        {!runAvailability.available ? (
          <span className="status-line" id={unavailableReasonId} role="status">
            Pipeline runs require the local app. <a href="/runs">Review bundled runs</a>
            {" or "}
            <a href={LOCAL_INSTALL_GUIDE_URL}>install JobCtrl</a>.
          </span>
        ) : workerUnhealthy ? (
          <span className="status-line danger-action" role="alert">
            {workerHealthMessage}
          </span>
        ) : runStages.isPending ? (
          visibleStageProgress ? (
            <StageProgressLine
              stage={statusStage}
              progress={visibleStageProgress}
            />
          ) : (
            <span className="status-line" role="status">
              {relevantPendingActivity
                ? stageActivityStatusLine(statusStage, relevantPendingActivity)
                : pendingStageStatusLine(statusStage)}
            </span>
          )
        ) : visibleStageProgress ? (
          <StageProgressLine
            stage={statusStage}
            progress={visibleStageProgress}
          />
        ) : runStages.data ? (
          <span
            className={
              runStages.data.status === "failed"
                ? "status-line danger-action"
                : "status-line"
            }
            role="status"
          >
            {pipelineRunStatusLine(statusStage, runStages.data)}
          </span>
        ) : runStages.error ? (
          <span className="status-line danger-action" role="status">
            {pipelineRequestErrorLine(statusStage, runStages.error)}
          </span>
        ) : visibleStageActivity ? (
          <span
            className={
              isFailedActivity(visibleStageActivity)
                ? "status-line danger-action"
                : "status-line"
            }
            role="status"
          >
            {stageActivityStatusLine(statusStage, visibleStageActivity)}
          </span>
        ) : null}
      </div>
    </form>
  );

  return (
    <>
      <Card className="pipeline-card stage-trigger-panel">
        <CardHeader className="pipeline-card__header">
          <CardTitle>
            <h2 data-typography="component-title">Pipeline actions</h2>
          </CardTitle>
          <CardDescription>{headerMeta}</CardDescription>
        </CardHeader>
        <CardContent className="pipeline-card__content">
          <Tabs
            className="stage-trigger-tabs"
            value={activeStage}
            onValueChange={(value) => {
              if (
                USER_FACING_PIPELINE_STAGE_SET.has(value as PipelineRunStage)
              ) {
                setActiveStage(value as PipelineRunStage);
              }
            }}
          >
            <TabsList
              aria-label="Pipeline stages"
              className="stage-trigger-tab-list"
            >
              {USER_FACING_PIPELINE_STAGES.map((stage) => (
                <TabsTrigger key={stage} value={stage}>
                  {labelForStage(stage)}
                </TabsTrigger>
              ))}
            </TabsList>
            {USER_FACING_PIPELINE_STAGES.map((stage) => (
              <TabsContent
                key={stage}
                forceMount
                value={stage}
                className="stage-trigger-tab-panel"
              >
                {stage === activeStage ? stageForm : null}
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
      {activeStagePanel}
    </>
  );
}
