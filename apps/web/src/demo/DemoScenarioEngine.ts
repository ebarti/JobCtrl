import type {
  ActionRunResponse,
  EnsureCurrentResumeMaterialsResponse,
  OutreachThreadResponse,
  PipelineStageRunResponse,
  ResumeReviewDraftRenderResponse,
  Stage,
  WorkflowRunDetail,
} from "@jobctrl/contracts";
import {
  LOCAL_TENANT,
  createDiscoveryRunCompleted,
  createDiscoveryRunFailed,
  createJobScored,
  createInterviewPrepFailed,
  createInterviewPrepGenerated,
  createOutreachDraftGenerated,
  createOutreachDraftRevised,
  createPdfRendered,
  createPreparationWorkItemCompleted,
  createPreparationWorkItemFailed,
  createPreparationWorkItemQueued,
  createPreparationWorkItemStarted,
  createResumeApproved,
  createResumeFailed,
  createScoreRescoreRequested,
  createStageCompleted,
  createStageFailed,
  createStageStarted,
  createTailorRetailorRequested,
  createTailoredArtifactsSuppressed,
  createWorkflowCompleted,
  createWorkflowFailed,
  createWorkflowStarted,
  type DomainEventUnion,
} from "@jobctrl/domain-types";

import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import {
  DEMO_SIMULATED_ASYNC_OPERATIONS,
  type ApiClientResponse,
  type DemoSimulatedAsyncOperation,
} from "./contracts.js";
import { DemoCommandPersistenceError } from "./DemoLocalCommandExecutor.js";
import { recomputeDemoOperationalProjections } from "./purgeDemoJobProjections.js";
import {
  DemoWorkspaceScheduler,
  isDemoScenarioInvocation,
  type DemoScenarioInvocation,
  type DemoPendingScenario,
  type DemoWorkspaceMutationContext,
  type DemoWorkspaceSnapshot,
} from "./workspace/index.js";
import type { DemoWorkspaceRepository } from "./workspace/DemoWorkspaceRepository.js";

type ScenarioCommand = {
  [TOperation in DemoSimulatedAsyncOperation]: {
    readonly operation: TOperation;
    readonly args: Parameters<ApiClientPort[TOperation]>;
  };
}[DemoSimulatedAsyncOperation];

type Mutable<TValue> = TValue extends (...args: never[]) => unknown
  ? TValue
  : TValue extends readonly (infer TItem)[]
    ? Mutable<TItem>[]
    : TValue extends object
      ? { -readonly [TKey in keyof TValue]: Mutable<TValue[TKey]> }
      : TValue;

interface ScenarioSpec {
  readonly stage: Stage | null;
  readonly action: ActionRunResponse["action"];
  readonly queuedMessage: string;
  readonly runningMessage: string;
  readonly successMessage: string;
  readonly terminalDelayMs: number;
  readonly awaitTerminal: boolean;
}

const SCENARIO_SPECS = {
  renderResumeReviewDraft: scenario("tailor", "generate_materials", "Resume render queued.", "Rendering the review draft.", "Resume render completed.", 600, true),
  ensureCurrentResumeMaterials: scenario("tailor", "generate_materials", "Material refresh queued.", "Checking the current template.", "Current materials are ready.", 750, true),
  retryFailedJobs: scenario("discover", "retry_stage", "Failed preparation retry queued.", "Retrying failed preparation.", "Failed preparation retry completed.", 650),
  runPendingPreparation: scenario("discover", "run_stage", "Pending preparation queued.", "Running pending preparation.", "Pending preparation completed.", 700),
  rescoreJob: scenario("score", "rescore_job", "Score refresh queued.", "Evaluating grounded evidence.", "Synthetic score refresh completed.", 550),
  rescoreJobsNotOnCurrentScoringPolicy: scenario("score", "rescore_jobs_not_on_current_scoring_policy", "Policy rescore queued.", "Rescoring stale jobs.", "Policy rescore completed.", 700),
  retailorJob: scenario("tailor", "retailor_job", "Re-tailoring queued.", "Checking artifact grounding.", "Re-tailoring completed.", 850),
  tailorJob: scenario("tailor", "tailor_job", "Tailoring queued.", "Checking artifact grounding.", "Tailoring completed.", 850),
  retailorCurrentPolicy: scenario("tailor", "retailor_current_policy", "Policy re-tailoring queued.", "Refreshing policy-stale materials.", "Policy re-tailoring completed.", 900),
  runPipelineStages: scenario("discover", "run_stage", "Discover queued.", "Preparing bundled source results.", "Discover succeeded.", 650),
  generateOutreachDraft: scenario(null, "generate_materials", "Outreach draft queued.", "Checking draft provenance.", "Outreach draft is ready for review.", 700, true),
  reviseOutreachDraft: scenario(null, "generate_materials", "Outreach revision queued.", "Checking revised draft provenance.", "Outreach revision is ready for review.", 700, true),
  retryStage: scenario(null, "retry_stage", "Stage retry queued.", "Retrying the selected stage.", "Stage retry completed.", 650),
  runJobStage: scenario(null, "run_stage", "Current stage queued.", "Running the selected stage.", "Current stage completed.", 650),
  generateMaterials: scenario("tailor", "generate_materials", "Material generation queued.", "Generating grounded materials.", "Material generation completed.", 850),
  generateInterviewPrep: scenario(null, "generate_interview_prep", "Interview preparation queued.", "Generating grounded interview preparation.", "Interview preparation completed.", 800),
} as const satisfies Record<DemoSimulatedAsyncOperation, ScenarioSpec>;

if (Object.keys(SCENARIO_SPECS).length !== DEMO_SIMULATED_ASYNC_OPERATIONS.length) {
  throw new Error("Demo scenario table is not exhaustive.");
}

export interface DemoScenarioClock {
  now(): Date;
}

export interface DemoScenarioEngineOptions {
  readonly scheduler?: DemoWorkspaceScheduler;
  readonly clock?: DemoScenarioClock;
  readonly createId?: (prefix: string) => string;
}

const systemClock: DemoScenarioClock = { now: () => new Date() };

const EVENT_BUILDERS = {
  DiscoveryRunCompleted: createDiscoveryRunCompleted,
  DiscoveryRunFailed: createDiscoveryRunFailed,
  JobScored: createJobScored,
  InterviewPrepFailed: createInterviewPrepFailed,
  InterviewPrepGenerated: createInterviewPrepGenerated,
  OutreachDraftGenerated: createOutreachDraftGenerated,
  OutreachDraftRevised: createOutreachDraftRevised,
  PdfRendered: createPdfRendered,
  PreparationWorkItemCompleted: createPreparationWorkItemCompleted,
  PreparationWorkItemFailed: createPreparationWorkItemFailed,
  PreparationWorkItemQueued: createPreparationWorkItemQueued,
  PreparationWorkItemStarted: createPreparationWorkItemStarted,
  ResumeApproved: createResumeApproved,
  ResumeFailed: createResumeFailed,
  ScoreRescoreRequested: createScoreRescoreRequested,
  StageCompleted: createStageCompleted,
  StageFailed: createStageFailed,
  StageStarted: createStageStarted,
  TailorRetailorRequested: createTailorRetailorRequested,
  TailoredArtifactsSuppressed: createTailoredArtifactsSuppressed,
  WorkflowCompleted: createWorkflowCompleted,
  WorkflowFailed: createWorkflowFailed,
  WorkflowStarted: createWorkflowStarted,
} as const;

/** Deterministic, browser-local implementation of every simulated-async capability. */
export class DemoScenarioEngine {
  private readonly scheduler: DemoWorkspaceScheduler;
  private readonly ownsScheduler: boolean;
  private readonly clock: DemoScenarioClock;
  private readonly createId: (prefix: string) => string;
  private recovery: Promise<void> | null = null;

  constructor(
    private readonly workspace: DemoWorkspaceRepository,
    options: DemoScenarioEngineOptions = {},
  ) {
    this.scheduler = options.scheduler ?? new DemoWorkspaceScheduler(workspace);
    this.ownsScheduler = !options.scheduler;
    this.clock = options.clock ?? systemClock;
    this.createId = options.createId ?? defaultId;
  }

  initialize(): Promise<void> {
    this.recovery ??= this.scheduler.recover(this.onDeadline);
    return this.recovery;
  }

  dispose(): void {
    if (this.ownsScheduler) this.scheduler.dispose();
  }

  async execute<TOperation extends DemoSimulatedAsyncOperation>(
    operation: TOperation,
    args: Parameters<ApiClientPort[TOperation]>,
  ): Promise<ApiClientResponse<TOperation>> {
    await this.initialize();
    const current = await this.workspace.snapshot();
    const command = { operation, args } as ScenarioCommand;
    const immediate = await this.tryImmediate(command, current);
    if (immediate.handled) {
      return immediate.response as ApiClientResponse<TOperation>;
    }
    const invocation = this.buildInvocation(command, current);
    const result = await this.scheduler.scheduleInvocation(
      invocation,
      (pending, draft, context) => this.applyQueued(pending, draft, context),
      this.onDeadline,
    );
    if (result.kind === "persistence_warning") {
      throw new DemoCommandPersistenceError();
    }
    const active = result.pending;
    if (SCENARIO_SPECS[operation].awaitTerminal) {
      return this.waitForTerminal(operation, active);
    }
    return this.immediateResponse(operation, active) as ApiClientResponse<TOperation>;
  }

  private async tryImmediate(
    command: ScenarioCommand,
    snapshot: DemoWorkspaceSnapshot,
  ): Promise<{ readonly handled: false } | { readonly handled: true; readonly response: unknown }> {
    const first = command.args[0];
    const second = command.args[1];
    const body = record(typeof first === "string" ? second : first);
    if (command.operation === "retailorJob") {
      const jobKey = String(first);
      const hasAcceptedSource = snapshot.state.readModel.materials.list.items.some(
        (artifact) =>
          artifact.jobKey === jobKey && artifact.status === "accepted",
      );
      if (!hasAcceptedSource) {
        const pending = this.buildInvocation(command, snapshot);
        return {
          handled: true,
          response: {
            ...actionResponse(pending),
            status: "blocked",
            message: "Re-tailoring requires an accepted source artifact in the demo workspace.",
          },
        };
      }
    }
    if (command.operation === "ensureCurrentResumeMaterials" && body.force !== true) {
      const jobKey = String(first);
      const accepted = snapshot.state.readModel.materials.list.items.some(
        (artifact) => artifact.jobKey === jobKey && artifact.status === "accepted",
      );
      if (accepted) {
        const queueItem = snapshot.state.readModel.apply.queue.items.find(
          (item) => item.jobKey === jobKey,
        );
        return {
          handled: true,
          response: {
            ok: true,
            jobKey,
            status: "not_required",
            templateState: queueItem?.materialsPreview.resumeTemplate ?? null,
            attempt: queueItem?.materialsPreview.resumeTemplate?.lastRefreshAttempt ?? null,
            generation: queueItem?.materialsPreview.materialsGeneration ?? nextMaterialGeneration(snapshot, jobKey) - 1,
            message: "Accepted materials are already current in the demo workspace.",
          } satisfies EnsureCurrentResumeMaterialsResponse,
        };
      }
    }
    if (command.operation === "retryFailedJobs" && body.runAfter !== true) {
      const selected = eligibleBulkJobKeys(snapshot, command.operation, body);
      await this.persistImmediate((draft) => {
        for (const jobKey of selected) {
          const detail = draft.state.readModel.jobs.details[jobKey];
          for (const stage of detail?.stages ?? []) {
            if (stage.state === "failed" || stage.state === "exhausted") {
              stage.state = "pending";
              stage.errorCode = null;
              stage.errorMessage = null;
              stage.retryable = false;
              stage.nextAction = null;
            }
          }
          updateJobCopies(draft, jobKey, (job) => {
            job.currentState = "pending";
            job.errorCode = null;
            job.errorMessage = null;
            job.nextAction = null;
          });
        }
        recomputeDemoOperationalProjections(draft);
      }, snapshot.resetEpoch);
      return {
        handled: true,
        response: {
          ok: true,
          count: selected.length,
          jobKeys: selected,
          status: "reset",
          runAfter: false,
          stageCounts: stageCounts(snapshot, selected),
          actions: [],
        },
      };
    }
    if (command.operation === "retryStage" && body.runAfter !== true) {
      const jobKey = String(first);
      const stageName = stageValue(body.stage);
      if (!stageName) throw new TypeError("A valid retry stage is required.");
      await this.persistImmediate((draft) => {
        const stage = draft.state.readModel.jobs.details[jobKey]?.stages.find(
          (candidate) => candidate.stage === stageName,
        );
        if (stage) {
          stage.state = "pending";
          stage.attemptCount = body.resetAttempts === true ? 0 : stage.attemptCount;
          stage.errorCode = null;
          stage.errorMessage = null;
          stage.retryable = false;
          stage.nextAction = null;
        }
        updateJobCopies(draft, jobKey, (job) => {
          job.currentState = "pending";
          job.errorCode = null;
          job.errorMessage = null;
          job.nextAction = null;
        });
        recomputeDemoOperationalProjections(draft);
      }, snapshot.resetEpoch);
      const pending = this.buildInvocation(command, snapshot);
      return {
        handled: true,
        response: { ...actionResponse(pending), status: "reset", message: "Stage reset in the demo workspace." },
      };
    }
    if (command.operation === "retryStage" && body.runAfter === true) {
      const jobKey = String(first);
      const stageName = stageValue(body.stage);
      const stage = snapshot.state.readModel.jobs.details[jobKey]?.stages.find(
        (candidate) => candidate.stage === stageName,
      );
      if (
        !stage ||
        !stage.retryable ||
        (stage.state !== "failed" && stage.state !== "exhausted")
      ) {
        const pending = this.buildInvocation(command, snapshot);
        return {
          handled: true,
          response: {
            ...actionResponse(pending),
            status: "blocked",
            message: "Only a retryable failed stage can be retried in the demo workspace.",
          },
        };
      }
    }
    if (command.operation === "runJobStage") {
      const jobKey = String(first);
      const stageName = stageValue(body.stage);
      const stage = snapshot.state.readModel.jobs.details[jobKey]?.stages.find(
        (candidate) => candidate.stage === stageName,
      );
      if (stage && (stage.state === "blocked" || stage.state === "exhausted") && !stage.retryable) {
        const pending = this.buildInvocation(command, snapshot);
        return {
          handled: true,
          response: { ...actionResponse(pending), status: "blocked", message: "This stage is not eligible to run in the demo workspace." },
        };
      }
    }
    if (
      (command.operation === "retryFailedJobs" || command.operation === "runPendingPreparation") &&
      eligibleBulkJobKeys(snapshot, command.operation, body).length === 0
    ) {
      return {
        handled: true,
        response: {
          ok: true,
          count: 0,
          jobKeys: [],
          status: "not_required",
          ...(command.operation === "retryFailedJobs" ? { runAfter: body.runAfter === true } : {}),
          stageCounts: {},
          actions: [],
          message: "No eligible demo jobs matched this request.",
        },
      };
    }
    return { handled: false };
  }

  private async persistImmediate(
    mutation: (draft: DemoWorkspaceSnapshot) => void,
    resetEpoch: number,
  ): Promise<void> {
    let commit = await this.workspace.mutate((draft) => mutation(draft), {
      expectedResetEpoch: resetEpoch,
    });
    if (commit.kind === "persistence_warning") {
      commit = await this.workspace.mutate((draft) => mutation(draft), {
        expectedResetEpoch: resetEpoch,
      });
    }
    if (commit.kind === "persistence_warning") {
      throw new DemoCommandPersistenceError();
    }
  }

  private readonly onDeadline = (
    pending: DemoPendingScenario,
    draft: DemoWorkspaceSnapshot,
    context: DemoWorkspaceMutationContext,
  ) => {
    if (!isDemoScenarioInvocation(pending)) return undefined;
    const now = this.clock.now();
    if (pending.phase === "queued") {
      this.applyRunning(pending, draft, context, now.toISOString());
      return {
        ...pending,
        phase: "running" as const,
        deadlineAt: new Date(
          now.getTime() + pending.definition.terminalDelayMs,
        ).toISOString(),
      };
    }
    this.applyTerminal(pending, draft, context, now.toISOString());
    return null;
  };

  private buildInvocation(
    command: ScenarioCommand,
    snapshot: DemoWorkspaceSnapshot,
  ): DemoScenarioInvocation {
    const spec = SCENARIO_SPECS[command.operation];
    const targetRefs = targetRefsFor(command, snapshot);
    const stage = targetRefs.stage ?? spec.stage;
    const attempt = scenarioAttempt(snapshot, command.operation, targetRefs.jobKey, stage);
    const failFirst =
      targetRefs.jobKey === "job-contoso-reliability" &&
      stage === "tailor" &&
      attempt === 1 &&
      isTailoringOperation(command.operation);
    const requestedAt = this.clock.now();
    const runId = this.createId("run");
    const baseSafeCommand = safeCommandFor(command, stage);
    const safeCommand = isTailoringOperation(command.operation) && targetRefs.jobKey
      ? {
          ...baseSafeCommand,
          generation: nextMaterialGeneration(snapshot, targetRefs.jobKey),
        }
      : baseSafeCommand;
    return {
      invocationVersion: 1,
      scenarioId: this.createId("scenario"),
      operation: command.operation,
      phase: "queued",
      dedupeKey: `${command.operation}:${targetRefs.jobKey ?? targetRefs.draftId ?? targetRefs.threadId ?? "workspace"}:${stage ?? "workflow"}`,
      runId,
      actionId: this.createId("action"),
      attempt,
      targetRefs,
      safeCommand,
      requestedAt: requestedAt.toISOString(),
      deadlineAt: new Date(requestedAt.getTime() + 150).toISOString(),
      resetEpoch: snapshot.resetEpoch,
      definition: {
        queuedMessage: spec.queuedMessage,
        runningMessage: spec.runningMessage,
        runningDelayMs: 150,
        terminalDelayMs: spec.terminalDelayMs,
        outcome: failFirst
          ? {
              state: "failed",
              errorCode: "demo_grounding_gate",
              retryable: true,
              summary:
                "The synthetic quality gate stopped this attempt; the accepted artifact remains.",
            }
          : { state: "succeeded", summary: spec.successMessage },
      },
      recoveryInput: recoveryInputFor(command),
    };
  }

  private applyQueued(
    pending: DemoScenarioInvocation,
    draft: DemoWorkspaceSnapshot,
    context: DemoWorkspaceMutationContext,
  ): void {
    const job = jobForInvocation(draft, pending);
    const summary = {
      workflowId: pending.runId,
      runId: pending.runId,
      workflowType: workflowType(pending),
      jobKey: pending.targetRefs.jobKey ?? "pipeline",
      title: job?.title ?? "Demo pipeline",
      company: job?.company ?? "Bundled fixtures",
      status: "starting",
      result: null,
      dryRun: pending.operation === "runPipelineStages",
      model: "simulated",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    };
    const list = draft.state.readModel.runs.list;
    (list.items as unknown[]).unshift(summary);
    list.pagination.total += 1;
    list.pagination.pages = Math.max(
      1,
      Math.ceil(list.pagination.total / list.pagination.pageSize),
    );
    (draft.state.readModel.runs.details as Record<string, unknown>)[pending.runId] = {
      ...summary,
      status: "starting",
      errorCode: null,
      errorMessage: null,
      retryable: false,
      inputSummary: {
        simulated: true,
        operation: pending.operation,
        stage: pending.targetRefs.stage,
        attempt: pending.attempt,
      },
      temporalRunId: null,
      events: [
        {
          eventType: "WorkflowQueued",
          occurredAt: pending.requestedAt,
          status: "starting",
          message: pending.definition.queuedMessage,
        },
      ],
    };
    updateJobCopies(draft, pending.targetRefs.jobKey, (value) => {
      value.currentStage = (pending.targetRefs.stage ?? value.currentStage) as typeof value.currentStage;
      value.currentState = "queued";
      value.errorCode = null;
      value.errorMessage = null;
      value.nextAction = null;
    });
    updateStageProjection(draft, pending, "queued", pending.requestedAt);
    appendRequestedEvents(pending, context, pending.requestedAt);
    appendWorkflowActivity(
      draft,
      pending,
      "WorkflowQueued",
      "info",
      pending.definition.queuedMessage,
      pending.requestedAt,
    );
  }

  private applyRunning(
    pending: DemoScenarioInvocation,
    draft: DemoWorkspaceSnapshot,
    context: DemoWorkspaceMutationContext,
    now: string,
  ): void {
    const run = runDetail(draft, pending.runId);
    run.status = "in_progress";
    run.startedAt = now;
    run.events.push({
      eventType: "WorkflowStarted",
      occurredAt: now,
      status: "in_progress",
      message: pending.definition.runningMessage,
    });
    updateRunSummary(draft, pending.runId, {
      status: "in_progress",
      startedAt: now,
    });
    updateJobCopies(draft, pending.targetRefs.jobKey, (value) => {
      value.currentState = "running";
    });
    updateStageProjection(draft, pending, "running", now);
    appendEvent(context, "WorkflowStarted", {
      workflowId: pending.runId,
      workflowType: workflowType(pending),
      status: "in_progress",
      inputSummary: {
        simulated: true,
        operation: pending.operation,
        stage: pending.targetRefs.stage,
      },
      startedAt: now,
      temporalRunId: null,
    }, now);
    appendWorkflowActivity(
      draft,
      pending,
      "WorkflowStarted",
      "info",
      pending.definition.runningMessage,
      now,
    );
    if (pending.targetRefs.stage) {
      appendEvent(context, "StageStarted", {
        jobId: pending.targetRefs.jobKey ?? "pipeline",
        stage: pending.targetRefs.stage,
        attemptNumber: pending.attempt,
        startedAt: now,
      }, now);
    }
    if (isTailoringInvocation(pending)) {
      appendEvent(context, "PreparationWorkItemStarted", {
        workItemId: pending.actionId,
        jobId: pending.targetRefs.jobKey ?? "pipeline",
        kind: "tailor_resume",
        workerId: "demo-scenario-engine",
        startedAt: now,
      }, now);
    }
  }

  private applyTerminal(
    pending: DemoScenarioInvocation,
    draft: DemoWorkspaceSnapshot,
    context: DemoWorkspaceMutationContext,
    now: string,
  ): void {
    const run = runDetail(draft, pending.runId);
    const failed = pending.definition.outcome.state === "failed";
    const durationMs = Math.max(0, Date.parse(now) - Date.parse(run.startedAt ?? now));
    if (!failed) {
      applySuccessfulProjection(pending, draft, now);
    }
    run.status = failed ? "failed" : "succeeded";
    run.result = failed ? null : terminalResult(pending);
    run.errorCode = failed ? pending.definition.outcome.errorCode : null;
    run.errorMessage = failed ? pending.definition.outcome.summary : null;
    run.retryable = failed;
    run.finishedAt = now;
    run.durationMs = durationMs;
    run.events.push({
      eventType: failed ? "WorkflowFailed" : "WorkflowCompleted",
      occurredAt: now,
      status: failed ? "failed" : "succeeded",
      message: pending.definition.outcome.summary,
    });
    updateRunSummary(draft, pending.runId, {
      status: failed ? "failed" : "succeeded",
      result: failed ? null : terminalResult(pending),
      finishedAt: now,
      durationMs,
    });
    updateJobCopies(draft, pending.targetRefs.jobKey, (value) => {
      value.currentState = failed ? "failed" : "succeeded";
      value.errorCode = failed ? pending.definition.outcome.errorCode : null;
      value.errorMessage = failed ? pending.definition.outcome.summary : null;
      value.nextAction = failed ? "Retry the synthetic tailoring quality gate." : null;
    });
    updateStageProjection(draft, pending, failed ? "failed" : "succeeded", now);
    appendEvent(context, failed ? "WorkflowFailed" : "WorkflowCompleted", failed
      ? {
          workflowId: pending.runId,
          workflowType: workflowType(pending),
          status: "failed",
          errorCode: pending.definition.outcome.errorCode,
          errorMessage: pending.definition.outcome.summary,
          retryable: true,
          finishedAt: now,
          durationMs,
          temporalRunId: null,
        }
      : {
          workflowId: pending.runId,
          workflowType: workflowType(pending),
          status: "succeeded",
          finishedAt: now,
          durationMs,
          temporalRunId: null,
        }, now);
    appendWorkflowActivity(
      draft,
      pending,
      failed ? "WorkflowFailed" : "WorkflowCompleted",
      failed ? "error" : "info",
      pending.definition.outcome.summary,
      now,
    );
    if (pending.targetRefs.stage) {
      appendEvent(context, failed ? "StageFailed" : "StageCompleted", failed
        ? {
            jobId: pending.targetRefs.jobKey ?? "pipeline",
            stage: pending.targetRefs.stage,
            errorCode: pending.definition.outcome.errorCode,
            errorMessage: pending.definition.outcome.summary,
            retryable: true,
            attemptNumber: pending.attempt,
          }
        : {
            jobId: pending.targetRefs.jobKey ?? "pipeline",
            stage: pending.targetRefs.stage,
            finishedAt: now,
            durationMs,
          }, now);
    }
    appendTerminalEvents(pending, draft, context, now, durationMs);
    recomputeDemoOperationalProjections(draft);
  }

  private immediateResponse(
    operation: DemoSimulatedAsyncOperation,
    pending: DemoScenarioInvocation,
  ): unknown {
    const action = actionResponse(pending);
    if (operation === "retryFailedJobs") {
      const actions = pending.targetRefs.jobKeys.map((jobKey, index) =>
        actionForTarget(action, jobKey, pending.targetRefs.stage, index),
      );
      return {
        ok: true,
        count: pending.targetRefs.jobKeys.length,
        jobKeys: pending.targetRefs.jobKeys,
        status: "queued",
        runAfter: pending.safeCommand.force,
        stageCounts: { [pending.targetRefs.stage ?? "tailor"]: pending.targetRefs.jobKeys.length },
        actions,
        message: pending.definition.queuedMessage,
      };
    }
    if (operation === "runPendingPreparation") {
      const actions = pending.targetRefs.jobKeys.map((jobKey, index) =>
        actionForTarget(action, jobKey, pending.targetRefs.stage, index),
      );
      return {
        ok: true,
        count: pending.targetRefs.jobKeys.length,
        jobKeys: pending.targetRefs.jobKeys,
        status: "queued",
        stageCounts: { [pending.targetRefs.stage ?? "tailor"]: pending.targetRefs.jobKeys.length },
        actions,
        message: pending.definition.queuedMessage,
      };
    }
    if (operation === "runPipelineStages") {
      const actions = pending.safeCommand.stages.map((stage, index) =>
        actionForTarget(action, "pipeline", stage, index),
      );
      return {
        ok: true,
        action: "run_stage",
        status: "queued",
        jobKey: "pipeline",
        count: actions.length,
        command: action.command as unknown as PipelineStageRunResponse["command"],
        actions,
        message: pending.definition.queuedMessage,
      } satisfies PipelineStageRunResponse;
    }
    return action;
  }

  private waitForTerminal<TOperation extends DemoSimulatedAsyncOperation>(
    operation: TOperation,
    pending: DemoScenarioInvocation,
  ): Promise<ApiClientResponse<TOperation>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const check = () => {
        if (settled) return;
        const snapshot = this.workspace.snapshotNow();
        if (
          snapshot.pendingScenarios.some(
            (candidate) => candidate.scenarioId === pending.scenarioId,
          )
        ) {
          return;
        }
        const run = snapshot.state.readModel.runs.details[pending.runId];
        if (!run) {
          settled = true;
          unsubscribe();
          reject(new Error("The demo scenario was reset before completion."));
          return;
        }
        settled = true;
        unsubscribe();
        resolve(
          terminalResponse(operation, pending, snapshot) as ApiClientResponse<TOperation>,
        );
      };
      const unsubscribe = this.workspace.subscribe(() => check());
      check();
    });
  }
}

function appendWorkflowActivity(
  draft: DemoWorkspaceSnapshot,
  pending: DemoScenarioInvocation,
  eventType: "WorkflowQueued" | "WorkflowStarted" | "WorkflowCompleted" | "WorkflowFailed",
  level: "info" | "error",
  message: string,
  at: string,
): void {
  const job = jobForInvocation(draft, pending);
  const event = {
    eventId: `activity-${pending.runId}-${eventType.toLowerCase()}`,
    eventType,
    workflowId: pending.runId,
    jobKey: pending.targetRefs.jobKey,
    title: job?.title ?? null,
    company: job?.company ?? null,
    stage: pending.targetRefs.stage ?? "workflow",
    level,
    message,
    at,
  };
  const dashboard = draft.state.readModel.dashboard;
  const activityEvents = dashboard.activityEvents as Mutable<
    typeof dashboard.activityEvents
  >;
  if (activityEvents[event.eventId]) return;
  dashboard.summary.activity.unshift(event);
  dashboard.activity.items.unshift(event);
  dashboard.activity.pagination.total = dashboard.activity.items.length;
  dashboard.activity.pagination.pages = Math.max(
    1,
    Math.ceil(
      dashboard.activity.pagination.total /
        dashboard.activity.pagination.pageSize,
    ),
  );
  activityEvents[event.eventId] = { ok: true, event };
}

function actionForTarget(
  base: ActionRunResponse,
  jobKey: string,
  stage: Stage | null,
  index: number,
): ActionRunResponse {
  return {
    ...base,
    actionId: `${base.actionId}:${index + 1}`,
    jobKey,
    command: {
      ...base.command,
      jobKey,
      ...(stage ? { stage, stages: [stage] } : {}),
    },
  };
}

function applySuccessfulProjection(
  pending: DemoScenarioInvocation,
  draft: DemoWorkspaceSnapshot,
  now: string,
): void {
  switch (pending.operation) {
    case "rescoreJob":
    case "rescoreJobsNotOnCurrentScoringPolicy":
      applyRescoreProjection(pending, draft, now);
      return;
    case "runPipelineStages":
      applyDiscoverProjection(pending, draft, now);
      return;
    case "generateOutreachDraft":
    case "reviseOutreachDraft":
      applyOutreachProjection(pending, draft, now);
      return;
    case "renderResumeReviewDraft":
      applyResumeRenderProjection(pending, draft, now);
      return;
    case "generateInterviewPrep":
      applyInterviewProjection(pending, draft, now);
      return;
    case "ensureCurrentResumeMaterials":
    case "retailorJob":
    case "tailorJob":
    case "retailorCurrentPolicy":
    case "generateMaterials":
    case "retryStage":
    case "runJobStage":
    case "retryFailedJobs":
    case "runPendingPreparation":
      return;
  }
}

function applyRescoreProjection(
  pending: DemoScenarioInvocation,
  draft: DemoWorkspaceSnapshot,
  now: string,
): void {
  const selected = pending.targetRefs.jobKeys.length > 0
    ? pending.targetRefs.jobKeys
    : pending.targetRefs.jobKey
      ? [pending.targetRefs.jobKey]
      : [];
  for (const jobKey of selected) {
    updateJobCopies(draft, jobKey, (job) => {
      job.scoreVersion = (job.scoreVersion ?? 0) + 1;
      job.scoredAt = now;
      job.scoreStaleness = {
        isStale: false,
        staleReason: null,
        currentPolicyVersion: 3,
        targetPolicyVersion: 3,
        markedAt: null,
        pendingExplicitRescore: false,
      };
      if (job.scoreTrace) {
        job.scoreTrace.scoringPolicyVersion = 3;
        job.scoreTrace.criteriaVersion = "demo-policy-3";
      }
    });
    const apply = draft.state.readModel.apply.queue.items.find(
      (item) => item.jobKey === jobKey,
    );
    const source = draft.state.readModel.jobs.list.items.find(
      (job) => job.jobKey === jobKey,
    );
    if (apply && source) {
      apply.fitScore = source.fitScore;
      apply.scoreBreakdown = source.scoreBreakdown;
      apply.scoreKeywords = source.scoreKeywords;
      apply.scoreReasoning = source.scoreReasoning;
      apply.scoreVersion = source.scoreVersion;
      apply.scoredAt = source.scoredAt;
      apply.scoreCriteria = source.scoreCriteria;
      apply.scoreTrace = source.scoreTrace;
    }
  }
}

function applyDiscoverProjection(
  pending: DemoScenarioInvocation,
  draft: DemoWorkspaceSnapshot,
  now: string,
): void {
  for (const source of draft.state.readModel.discovery.sources.sources) {
    source.lastRunId = pending.runId;
    source.lastRunCompletedAt = now;
    source.lastErrorClass = null;
    source.consecutiveFailures = 0;
  }
  for (const preview of Object.values(
    draft.state.readModel.discovery.sourcePreviews,
  )) {
    preview.generatedAt = now;
  }
}

function applyOutreachProjection(
  pending: DemoScenarioInvocation,
  draft: DemoWorkspaceSnapshot,
  now: string,
): void {
  const response = draft.state.readModel.outreach.thread;
  const thread = response.thread;
  if (!thread) throw new Error("The bundled outreach thread is missing.");
  const template = thread.drafts.at(-1) ?? thread.drafts[0];
  if (!template) throw new Error("The bundled outreach draft is missing.");
  const generation = thread.latestGeneration + 1;
  const recovery = pending.recoveryInput;
  const bodyText = recovery.kind === "outreach_revise"
    ? recovery.editedBodyText
    : "Bundled synthetic outreach draft generated without a provider call.";
  const kind = recovery.kind === "outreach_generate"
    ? recovery.draftKind
    : recovery.kind === "outreach_revise" && recovery.draftKind
      ? recovery.draftKind
      : template.kind;
  thread.drafts.push({
    ...structuredClone(template),
    draftId: `demo-draft-${pending.runId}`,
    generation,
    kind,
    status: "candidate",
    bodyText,
    createdAt: now,
    approvedAt: null,
    rejectedAt: null,
    reason: "",
  });
  thread.draftCount = thread.drafts.length;
  thread.latestGeneration = generation;
  thread.latestStatus = "candidate";
  thread.updatedAt = now;
}

function applyResumeRenderProjection(
  pending: DemoScenarioInvocation,
  draft: DemoWorkspaceSnapshot,
  now: string,
): void {
  const response = Object.values(
    draft.state.readModel.materials.resumeReviewDrafts,
  ).find((value) => value.draft.draftId === pending.targetRefs.draftId);
  if (!response) throw new Error("Demo resume review draft was not found.");
  response.draft.state = "rendered";
  response.draft.updatedAt = now;
  if (pending.recoveryInput.kind === "resume_render") {
    response.draft.rendererFormat = pending.recoveryInput.renderFormat === "text"
      ? "text"
      : "html_pdf";
  }
}

function applyInterviewProjection(
  pending: DemoScenarioInvocation,
  draft: DemoWorkspaceSnapshot,
  now: string,
): void {
  const jobKey = pending.targetRefs.jobKey;
  if (!jobKey) return;
  const target = draft.state.readModel.jobs.details[jobKey];
  if (!target) return;
  const template = Object.values(draft.state.readModel.jobs.details)
    .map((detail) => detail.interviewPrep)
    .find((value) => value !== null);
  if (!template) return;
  target.interviewPrep = {
    ...structuredClone(template),
    jobId: jobKey,
    generation: (target.interviewPrep?.generation ?? 0) + 1,
    generatedAt: now,
    model: "simulated",
  };
}

function recoveryInputFor(
  command: ScenarioCommand,
): DemoScenarioInvocation["recoveryInput"] {
  const first = command.args[0];
  const body = record(typeof first === "string" ? command.args[1] : first);
  if (command.operation === "renderResumeReviewDraft") {
    return {
      kind: "resume_render",
      renderFormat: body.renderFormat === "text" ? "text" : "html_pdf",
    };
  }
  if (command.operation === "generateOutreachDraft") {
    return {
      kind: "outreach_generate",
      draftKind: body.kind === "follow_up" ? "follow_up" : "intro_request",
      applicationRole: stringValue(body.applicationRole),
    };
  }
  if (command.operation === "reviseOutreachDraft") {
    return {
      kind: "outreach_revise",
      editedBodyText: stringValue(body.editedBodyText) ?? "Bundled synthetic revised outreach draft.",
      draftKind: body.kind === "follow_up" || body.kind === "intro_request" ? body.kind : null,
      applicationRole: stringValue(body.applicationRole),
    };
  }
  return { kind: "none" };
}

function scenario(
  stage: Stage | null,
  action: ActionRunResponse["action"],
  queuedMessage: string,
  runningMessage: string,
  successMessage: string,
  terminalDelayMs: number,
  awaitTerminal = false,
): ScenarioSpec {
  return { stage, action, queuedMessage, runningMessage, successMessage, terminalDelayMs, awaitTerminal };
}

function targetRefsFor(
  command: ScenarioCommand,
  snapshot: DemoWorkspaceSnapshot,
): DemoScenarioInvocation["targetRefs"] {
  const first = command.args[0];
  const second = command.args[1];
  const body = record(typeof first === "string" ? second : first);
  let jobKey = typeof first === "string" && command.operation !== "renderResumeReviewDraft" && command.operation !== "reviseOutreachDraft"
    ? first
    : stringValue(body.jobKey) ?? stringValue(body.jobId);
  let draftId = command.operation === "renderResumeReviewDraft" && typeof first === "string" ? first : null;
  let contactId = command.operation === "generateOutreachDraft" && typeof first === "string" ? first : null;
  let threadId = command.operation === "reviseOutreachDraft" && typeof first === "string" ? first : null;
  if (draftId) {
    jobKey = Object.values(snapshot.state.readModel.materials.resumeReviewDrafts)
      .find((value) => value.draft.draftId === draftId)?.draft.jobKey ?? null;
  }
  if (threadId || contactId) {
    const thread = snapshot.state.readModel.outreach.thread.thread;
    if (thread && (!threadId || thread.threadId === threadId) && (!contactId || thread.contactId === contactId)) {
      threadId = thread.threadId;
      contactId = thread.contactId;
      jobKey = thread.jobId;
    }
  }
  const explicitJobKeys = arrayValue(body.jobKeys).map(String);
  const allMatching = body.allMatching === true;
  let jobKeys = explicitJobKeys.length > 0
    ? explicitJobKeys
    : allMatching || command.operation === "retryFailedJobs" || command.operation === "runPendingPreparation"
      ? snapshot.state.readModel.jobs.list.items.map((job) => job.jobKey)
      : jobKey
        ? [jobKey]
        : [];
  if (command.operation === "retryFailedJobs" || command.operation === "runPendingPreparation") {
    jobKeys = eligibleBulkJobKeys(snapshot, command.operation, {
      ...body,
      jobKeys,
      allMatching: explicitJobKeys.length === 0,
    });
  }
  const stage = stageValue(body.stage) ?? arrayValue(body.stages).map(stageValue).find((value): value is Stage => value !== null) ?? SCENARIO_SPECS[command.operation].stage;
  if (!jobKey && command.operation === "runPipelineStages") {
    jobKey = null;
  }
  return {
    jobKey: jobKey ?? null,
    jobKeys,
    draftId,
    artifactId: null,
    contactId,
    taskId: null,
    threadId,
    stage,
  };
}

function safeCommandFor(
  command: ScenarioCommand,
  stage: Stage | null,
): DemoScenarioInvocation["safeCommand"] {
  const first = command.args[0];
  const body = record(typeof first === "string" ? command.args[1] : first);
  return {
    stages: arrayValue(body.stages).map(stageValue).filter((value): value is Stage => value !== null).length > 0
      ? arrayValue(body.stages).map(stageValue).filter((value): value is Stage => value !== null)
      : stage
        ? [stage]
        : [],
    dryRun: body.dryRun === true || command.operation === "runPipelineStages",
    force: body.force === true || body.runAfter === true,
    allMatching: body.allMatching === true,
    limit: numberValue(body.limit),
    generation: numberValue(body.generation),
    kind: stringValue(body.kind),
  };
}

function eligibleBulkJobKeys(
  snapshot: DemoWorkspaceSnapshot,
  operation: "retryFailedJobs" | "runPendingPreparation",
  body: Record<string, unknown>,
): string[] {
  const explicit = arrayValue(body.jobKeys).map(String);
  const candidates = explicit.length > 0
    ? explicit
    : snapshot.state.readModel.jobs.list.items.map((job) => job.jobKey);
  return candidates.filter((jobKey) => {
    const detail = snapshot.state.readModel.jobs.details[jobKey];
    const states = new Set(detail?.stages.map((stage) => stage.state) ?? []);
    return operation === "retryFailedJobs"
      ? states.has("failed") || states.has("exhausted")
      : states.has("pending") || states.has("queued");
  });
}

function stageCounts(
  snapshot: DemoWorkspaceSnapshot,
  jobKeys: readonly string[],
): Partial<Record<Stage, number>> {
  const counts: Partial<Record<Stage, number>> = {};
  for (const jobKey of jobKeys) {
    for (const stage of snapshot.state.readModel.jobs.details[jobKey]?.stages ?? []) {
      if (stage.state === "failed" || stage.state === "exhausted") {
        counts[stage.stage] = (counts[stage.stage] ?? 0) + 1;
      }
    }
  }
  return counts;
}

function actionResponse(pending: DemoScenarioInvocation): ActionRunResponse {
  const spec = SCENARIO_SPECS[pending.operation];
  const jobKey = pending.targetRefs.jobKey ?? "pipeline";
  const command = {
    action: spec.action,
    jobKey,
    ...(pending.targetRefs.stage ? { stage: pending.targetRefs.stage } : {}),
    stages: [...pending.safeCommand.stages],
    dryRun: pending.safeCommand.dryRun,
    jobIds: [...pending.targetRefs.jobKeys],
    ...(pending.safeCommand.limit === null ? {} : { limit: pending.safeCommand.limit }),
    runId: pending.runId,
  } as ActionRunResponse["command"];
  return {
    ok: true,
    runId: pending.runId,
    workflowId: pending.runId,
    actionId: pending.actionId,
    action: spec.action,
    status: "queued",
    jobKey,
    command,
    message: pending.definition.queuedMessage,
  };
}

function terminalResponse(
  operation: DemoSimulatedAsyncOperation,
  pending: DemoScenarioInvocation,
  snapshot: DemoWorkspaceSnapshot,
): ResumeReviewDraftRenderResponse | EnsureCurrentResumeMaterialsResponse | OutreachThreadResponse {
  if (operation === "renderResumeReviewDraft") {
    const response = Object.values(snapshot.state.readModel.materials.resumeReviewDrafts)
      .find((value) => value.draft.draftId === pending.targetRefs.draftId);
    if (!response) throw new Error("Demo resume review draft was not found.");
    return {
      ok: true,
      draft: response.draft,
      validation: { passed: true, errors: [], warnings: [] },
      artifacts: {
        resumeText: {
          artifactId: response.draft.baseResumeTextArtifactId ?? "artifact-tailored-resume-html",
          artifactType: "tailored_resume",
          generation: response.draft.baseGeneration,
          renderFormat: "text",
        },
        resumePdf: {
          artifactId: response.draft.baseResumePdfArtifactId ?? "artifact-tailored-resume",
          artifactType: "resume_pdf",
          generation: response.draft.baseGeneration,
          renderFormat: "html_pdf",
        },
      },
      layoutBoxCount: 0,
    };
  }
  if (operation === "ensureCurrentResumeMaterials") {
    const queueItem = snapshot.state.readModel.apply.queue.items.find(
      (item) => item.jobKey === pending.targetRefs.jobKey,
    );
    const failed = snapshot.state.readModel.runs.details[pending.runId]?.status === "failed";
    return {
      ok: true,
      jobKey: pending.targetRefs.jobKey ?? "pipeline",
      status: failed ? "failed" : "completed",
      templateState: queueItem?.materialsPreview.resumeTemplate ?? null,
      attempt: queueItem?.materialsPreview.resumeTemplate?.lastRefreshAttempt ?? null,
      generation: queueItem?.materialsPreview.materialsGeneration ?? null,
      message: failed ? pending.definition.outcome.summary : pending.definition.outcome.summary,
    };
  }
  return snapshot.state.readModel.outreach.thread;
}

function appendRequestedEvents(
  pending: DemoScenarioInvocation,
  context: DemoWorkspaceMutationContext,
  now: string,
): void {
  if (pending.operation === "rescoreJob" || pending.operation === "rescoreJobsNotOnCurrentScoringPolicy") {
    appendEvent(context, "ScoreRescoreRequested", {
      jobId: pending.targetRefs.jobKey ?? "pipeline",
      staleReason: "demo_explicit_rescore",
      oldPolicyVersion: 2,
      newPolicyVersion: 3,
      nextAction: "demo score rehearsal",
    }, now);
  }
  if (isTailoringInvocation(pending)) {
    appendEvent(context, "TailorRetailorRequested", {
      requestId: pending.actionId,
      jobId: pending.targetRefs.jobKey ?? "pipeline",
      requestKind: pending.operation === "retailorCurrentPolicy" ? "bulk_current_policy" : "single_job",
      currentPolicyVersion: 3,
      latestArtifactPolicyVersion: pending.attempt > 1 ? 2 : null,
      reason: "browser-local demo rehearsal",
      requestedAt: now,
    }, now);
    appendEvent(context, "PreparationWorkItemQueued", {
      workItemId: pending.actionId,
      jobId: pending.targetRefs.jobKey ?? "pipeline",
      kind: "tailor_resume",
      reason: "browser-local demo rehearsal",
      targetVersion: 3,
      sourceEventId: pending.actionId,
      queuedAt: now,
    }, now);
  }
}

function appendTerminalEvents(
  pending: DemoScenarioInvocation,
  draft: DemoWorkspaceSnapshot,
  context: DemoWorkspaceMutationContext,
  now: string,
  durationMs: number,
): void {
  const failed = pending.definition.outcome.state === "failed";
  const jobKey = pending.targetRefs.jobKey ?? "pipeline";
  if (pending.operation === "rescoreJob" || pending.operation === "rescoreJobsNotOnCurrentScoringPolicy") {
    const job = jobForInvocation(draft, pending);
    if (!failed && job) {
      appendEvent(context, "JobScored", {
        jobId: jobKey,
        fitScore: job.fitScore ?? 7,
        breakdown: job.scoreBreakdown ? { ...job.scoreBreakdown } : {},
        keywords: job.scoreKeywords,
        version: job.scoreVersion ?? 1,
        scoredAt: now,
      }, now);
    }
  }
  if (isTailoringInvocation(pending)) {
    const acceptedIds = acceptedArtifactIds(pending);
    if (failed) {
      appendEvent(context, "ResumeFailed", {
        jobId: jobKey,
        validationErrors: [pending.definition.outcome.summary],
        attemptNumber: pending.attempt,
      }, now);
    } else {
      appendEvent(context, "ResumeApproved", {
        jobId: jobKey,
        generation: pending.safeCommand.generation ?? pending.attempt,
        artifactId: acceptedIds.text,
        approvedAt: now,
      }, now);
    }
    appendEvent(context, failed ? "PreparationWorkItemFailed" : "PreparationWorkItemCompleted", failed
      ? {
          workItemId: pending.actionId,
          jobId: jobKey,
          kind: "tailor_resume",
          errorCode: pending.definition.outcome.errorCode,
          retryable: true,
          failedAt: now,
        }
      : {
          workItemId: pending.actionId,
          jobId: jobKey,
          kind: "tailor_resume",
          completedAt: now,
          durationMs,
        }, now);
    if (!failed) {
      createAcceptedMaterialGeneration(draft, pending, acceptedIds, context, now);
      appendEvent(context, "PdfRendered", {
        jobId: jobKey,
        artifactType: "resume_pdf",
        artifactId: acceptedIds.pdf,
        renderedAt: now,
      }, now);
    }
  }
  if (pending.operation === "runPipelineStages") {
    if (failed) {
      appendEvent(context, "DiscoveryRunFailed", {
        runId: pending.runId,
        sourceId: "demo-source:northwind",
        errorClass: pending.definition.outcome.errorCode,
        retryable: true,
        failedAt: now,
      }, now);
    } else {
      appendEvent(context, "DiscoveryRunCompleted", {
        runId: pending.runId,
        counts: {
          total: 3,
          newJobs: 0,
          existingJobs: 3,
          observedJobs: 3,
          duplicateJobs: 0,
          rejectedDuplicates: 0,
        },
        errorClasses: [],
        completedAt: now,
      }, now);
    }
  }
  if (pending.operation === "generateOutreachDraft" || pending.operation === "reviseOutreachDraft") {
    const createdDraft = draft.state.readModel.outreach.thread.thread?.drafts.find(
      (candidate) => candidate.draftId === `demo-draft-${pending.runId}`,
    );
    const generation = createdDraft?.generation ?? pending.attempt;
    if (pending.operation === "generateOutreachDraft") {
      appendEvent(context, "OutreachDraftGenerated", {
        threadId: pending.targetRefs.threadId ?? "demo-outreach-thread",
        contactId: pending.targetRefs.contactId ?? "demo-contact",
        jobId: pending.targetRefs.jobKey,
        draftId: `demo-draft-${pending.runId}`,
        generation,
        kind: createdDraft?.kind ?? "intro_request",
        generatedAt: now,
      }, now);
    } else {
      appendEvent(context, "OutreachDraftRevised", {
        threadId: pending.targetRefs.threadId ?? "demo-outreach-thread",
        draftId: `demo-draft-${pending.runId}`,
        generation,
        revisedAt: now,
      }, now);
    }
    addReceipt(draft, {
      receiptId: `receipt-${pending.runId}`,
      kind: "llm",
      operation: pending.operation,
      scenarioId: pending.scenarioId,
      runId: pending.runId,
      entityType: "outreach_thread",
      entityId: pending.targetRefs.threadId ?? "demo-outreach-thread",
      recordedAt: now,
      wouldHaveDone: "Generated a reviewable outreach draft.",
      didNotDo: "No model provider was called.",
    });
  }
  if (pending.operation === "generateInterviewPrep") {
    const prep = pending.targetRefs.jobKey
      ? draft.state.readModel.jobs.details[pending.targetRefs.jobKey]?.interviewPrep
      : null;
    if (failed) {
      appendEvent(context, "InterviewPrepFailed", {
        jobId: jobKey,
        generation: (prep?.generation ?? 0) + 1,
        failedAt: now,
        reasonCount: 1,
      }, now);
    } else if (prep) {
      appendEvent(context, "InterviewPrepGenerated", {
        jobId: jobKey,
        generation: prep.generation,
        itemCount: prep.items.length,
        generatedAt: now,
      }, now);
    }
  }
}

function createAcceptedMaterialGeneration(
  draft: DemoWorkspaceSnapshot,
  pending: DemoScenarioInvocation,
  ids: { readonly text: string; readonly pdf: string },
  context: DemoWorkspaceMutationContext,
  now: string,
): void {
  const jobKey = pending.targetRefs.jobKey;
  if (!jobKey || draft.state.readModel.materials.details[ids.text]) return;
  const accepted = draft.state.readModel.materials.list.items.filter(
    (artifact) => artifact.jobKey === jobKey && artifact.status === "accepted",
  );
  const sourceText = accepted.find((artifact) => artifact.type === "tailored_resume");
  const sourcePdf = accepted.find((artifact) => artifact.type === "resume_pdf");
  if (!sourceText || !sourcePdf) return;
  const sourceTextDetail = draft.state.readModel.materials.details[sourceText.artifactId];
  const sourcePdfDetail = draft.state.readModel.materials.details[sourcePdf.artifactId];
  if (!sourceTextDetail || !sourcePdfDetail) return;
  const text = {
    ...structuredClone(sourceText),
    artifactId: ids.text,
    status: "accepted" as const,
    createdAt: now,
  };
  const pdf = {
    ...structuredClone(sourcePdf),
    artifactId: ids.pdf,
    status: "accepted" as const,
    createdAt: now,
  };
  draft.state.readModel.materials.list.items.unshift(pdf, text);
  draft.state.readModel.materials.list.pagination.total += 2;
  draft.state.readModel.materials.list.pagination.pages = Math.max(
    1,
    Math.ceil(
      draft.state.readModel.materials.list.pagination.total /
        draft.state.readModel.materials.list.pagination.pageSize,
    ),
  );
  (draft.state.readModel.materials.details as Record<string, typeof sourceTextDetail>)[ids.text] = {
    ...structuredClone(sourceTextDetail),
    artifact: text,
  };
  (draft.state.readModel.materials.details as Record<string, typeof sourcePdfDetail>)[ids.pdf] = {
    ...structuredClone(sourcePdfDetail),
    artifact: pdf,
  };
  const jobDetail = draft.state.readModel.jobs.details[jobKey];
  if (jobDetail) jobDetail.artifacts.unshift(pdf, text);
  const queueItem = draft.state.readModel.apply.queue.items.find(
    (item) => item.jobKey === jobKey,
  );
  if (queueItem) {
    queueItem.materials.hasResume = true;
    queueItem.materials.hasPdf = true;
    queueItem.materials.ready = true;
    queueItem.materialsPreview.materialsGeneration = pending.safeCommand.generation;
    queueItem.materialsPreview.resumeTextArtifactId = ids.text;
    queueItem.materialsPreview.resumePdfArtifactId = ids.pdf;
  }
  const replacedIds = accepted.map((artifact) => artifact.artifactId);
  for (const artifact of draft.state.readModel.materials.list.items) {
    if (replacedIds.includes(artifact.artifactId)) artifact.status = "suppressed";
  }
  for (const artifactId of replacedIds) {
    const detail = draft.state.readModel.materials.details[artifactId];
    if (detail) detail.artifact.status = "suppressed";
  }
  if (jobDetail) {
    for (const artifact of jobDetail.artifacts) {
      if (replacedIds.includes(artifact.artifactId)) artifact.status = "suppressed";
    }
  }
  updateJobCopies(draft, jobKey, (job) => {
    job.artifactCount = 2;
  });
  appendEvent(context, "TailoredArtifactsSuppressed", {
    jobId: jobKey,
    artifactIds: replacedIds,
    suppressionReason: "replacement_generation_accepted",
    suppressedAt: now,
    currentTailoringPolicyVersion: 3,
  }, now);
}

function acceptedArtifactIds(pending: DemoScenarioInvocation): {
  readonly text: string;
  readonly pdf: string;
} {
  if (
    pending.targetRefs.jobKey === "job-contoso-reliability" &&
    (pending.safeCommand.generation ?? pending.attempt) === 2
  ) {
    return {
      text: "artifact-contoso-resume-g2",
      pdf: "artifact-contoso-resume-pdf-g2",
    };
  }
  const jobKey = pending.targetRefs.jobKey ?? "pipeline";
  const generation = pending.safeCommand.generation ?? pending.attempt;
  return {
    text: `artifact-${jobKey}-resume-g${generation}`,
    pdf: `artifact-${jobKey}-resume-pdf-g${generation}`,
  };
}

function addReceipt(
  draft: DemoWorkspaceSnapshot,
  receipt: Omit<DemoWorkspaceSnapshot["state"]["receipts"][number], "simulated" | "externalEffectOccurred">,
): void {
  (draft.state.receipts as DemoWorkspaceSnapshot["state"]["receipts"][number][]).push({
    ...receipt,
    simulated: true,
    externalEffectOccurred: false,
  });
}

function appendEvent<TEventType extends keyof typeof EVENT_BUILDERS>(
  context: DemoWorkspaceMutationContext,
  eventType: TEventType,
  payload: Parameters<(typeof EVENT_BUILDERS)[TEventType]>[1],
  occurredAt: string,
): void {
  const build = EVENT_BUILDERS[eventType] as (
    tenantId: typeof LOCAL_TENANT,
    value: Parameters<(typeof EVENT_BUILDERS)[TEventType]>[1],
  ) => DomainEventUnion;
  const event = build(LOCAL_TENANT, payload);
  context.appendDomainEvent({ ...event, occurredAt });
}

function updateJobCopies(
  draft: DemoWorkspaceSnapshot,
  jobKey: string | null,
  update: (job: DemoWorkspaceSnapshot["state"]["readModel"]["jobs"]["list"]["items"][number]) => void,
): void {
  if (!jobKey) return;
  const summary = draft.state.readModel.jobs.list.items.find((job) => job.jobKey === jobKey);
  if (summary) update(summary);
  const detail = draft.state.readModel.jobs.details[jobKey];
  if (detail) update(detail.job);
  const apply = draft.state.readModel.apply.queue.items.find((job) => job.jobKey === jobKey);
  if (apply) {
    apply.currentStage = summary?.currentStage ?? apply.currentStage;
    apply.currentState = summary?.currentState ?? apply.currentState;
  }
}

function updateStageProjection(
  draft: DemoWorkspaceSnapshot,
  pending: DemoScenarioInvocation,
  state: "queued" | "running" | "failed" | "succeeded",
  now: string,
): void {
  const jobKey = pending.targetRefs.jobKey;
  const stageName = pending.targetRefs.stage;
  if (!jobKey || !stageName) return;
  const detail = draft.state.readModel.jobs.details[jobKey];
  if (!detail) return;
  let stage = detail.stages.find((candidate) => candidate.stage === stageName);
  if (!stage) {
    stage = {
      stage: stageName,
      state: "pending",
      attemptCount: 0,
      maxAttempts: 3,
      startedAt: null,
      updatedAt: null,
      finishedAt: null,
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      blockedBy: [],
      nextAction: null,
    };
    detail.stages.push(stage);
  }
  stage.state = state;
  stage.attemptCount = pending.attempt;
  stage.updatedAt = now;
  stage.blockedBy = [];
  if (state === "queued") {
    stage.startedAt = null;
    stage.finishedAt = null;
    stage.durationMs = null;
    stage.errorCode = null;
    stage.errorMessage = null;
    stage.retryable = false;
    stage.nextAction = null;
  } else if (state === "running") {
    stage.startedAt = now;
    stage.finishedAt = null;
    stage.durationMs = null;
    stage.errorCode = null;
    stage.errorMessage = null;
    stage.retryable = false;
    stage.nextAction = null;
  } else {
    stage.finishedAt = now;
    stage.durationMs = Math.max(
      0,
      Date.parse(now) - Date.parse(stage.startedAt ?? now),
    );
    stage.errorCode = state === "failed" ? pending.definition.outcome.state === "failed" ? pending.definition.outcome.errorCode : "demo_scenario_failed" : null;
    stage.errorMessage = state === "failed" ? pending.definition.outcome.summary : null;
    stage.retryable = state === "failed";
    stage.nextAction = state === "failed" ? "Retry this stage." : null;
  }
}

function runDetail(
  draft: DemoWorkspaceSnapshot,
  runId: string,
): Mutable<WorkflowRunDetail> {
  const run = draft.state.readModel.runs.details[runId];
  if (!run) throw new Error(`Demo workflow ${runId} was not found.`);
  return run as Mutable<WorkflowRunDetail>;
}

function updateRunSummary(
  draft: DemoWorkspaceSnapshot,
  runId: string,
  values: Record<string, unknown>,
): void {
  const summary = draft.state.readModel.runs.list.items.find((run) => run.runId === runId);
  if (summary) Object.assign(summary, values);
}

function jobForInvocation(
  draft: DemoWorkspaceSnapshot,
  pending: DemoScenarioInvocation,
) {
  return pending.targetRefs.jobKey
    ? draft.state.readModel.jobs.list.items.find((job) => job.jobKey === pending.targetRefs.jobKey)
    : undefined;
}

function workflowType(pending: DemoScenarioInvocation): string {
  return pending.operation === "runPipelineStages" ? "DiscoveryWorkflow" : "JobPipelineWorkflow";
}

function terminalResult(pending: DemoScenarioInvocation): string {
  if (pending.operation === "runPipelineStages") return "discovered";
  if (pending.operation === "rescoreJob" || pending.operation === "rescoreJobsNotOnCurrentScoringPolicy") return "scored";
  if (isTailoringInvocation(pending)) return "materials_ready";
  return "completed";
}

function scenarioAttempt(
  snapshot: DemoWorkspaceSnapshot,
  operation: DemoSimulatedAsyncOperation,
  jobKey: string | null,
  stage: Stage | null,
): number {
  const relevant = Object.values(snapshot.state.readModel.runs.details).filter((run) => {
    const input = record(run.inputSummary);
    return run.jobKey === (jobKey ?? "pipeline") &&
      (input.operation === operation || (stage === "tailor" && isTailoringOperation(String(input.operation)))) &&
      input.simulated === true;
  });
  return relevant.length + 1;
}

function nextMaterialGeneration(
  snapshot: DemoWorkspaceSnapshot,
  jobKey: string,
): number {
  const queueGeneration = snapshot.state.readModel.apply.queue.items.find(
    (item) => item.jobKey === jobKey,
  )?.materialsPreview.materialsGeneration;
  const idGenerations = snapshot.state.readModel.materials.list.items
    .filter(
      (artifact) => artifact.jobKey === jobKey && artifact.status === "accepted",
    )
    .map((artifact) => /-g(\d+)$/.exec(artifact.artifactId)?.[1])
    .map((value) => (value ? Number(value) : 1))
    .filter(Number.isFinite);
  return Math.max(queueGeneration ?? 0, ...idGenerations, 0) + 1;
}

function isTailoringInvocation(pending: DemoScenarioInvocation): boolean {
  return pending.targetRefs.stage === "tailor" && isTailoringOperation(pending.operation);
}

function isTailoringOperation(value: string): boolean {
  return [
    "ensureCurrentResumeMaterials",
    "retailorJob",
    "tailorJob",
    "retailorCurrentPolicy",
    "retryStage",
    "runJobStage",
    "generateMaterials",
  ].includes(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stageValue(value: unknown): Stage | null {
  return typeof value === "string" && ["discover", "enrich", "score", "tailor", "cover", "apply"].includes(value)
    ? (value as Stage)
    : null;
}

function defaultId(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `demo-${prefix}-${suffix}`;
}
