import {
  ApplyJobRequestSchema,
  MarkJobActionRequestSchema,
  type ActionRunResponse,
  type ArtifactOpenResponse,
  type StageSummary,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
} from "@jobctrl/contracts";
import {
  LOCAL_TENANT,
  createApplyRunEventRecorded,
  createApplyRunStarted,
  createStageCompleted,
} from "@jobctrl/domain-types";

import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import { isDemoArtifactUrl } from "./artifacts.js";
import type { ApiClientResponse } from "./contracts.js";
import { recomputeDemoOperationalProjections, recomputeDemoOutcomeProjections } from "./purgeDemoJobProjections.js";
import type {
  DemoWorkspaceMutationContext,
  DemoWorkspaceRepository,
} from "./workspace/DemoWorkspaceRepository.js";
import type {
  DemoWorkspaceReceipt,
  DemoWorkspaceSnapshot,
} from "./workspace/contracts.js";

export const DEMO_INITIAL_EXTERNAL_REHEARSAL_OPERATIONS = [
  "openArtifact",
  "applyJob",
  "markApplied",
] as const satisfies readonly (keyof ApiClientPort)[];

export type DemoInitialExternalRehearsalOperation =
  (typeof DEMO_INITIAL_EXTERNAL_REHEARSAL_OPERATIONS)[number];

type ExternalHandlers = {
  [TOperation in DemoInitialExternalRehearsalOperation]: (
    ...args: Parameters<ApiClientPort[TOperation]>
  ) => Promise<ApiClientResponse<TOperation>>;
};

export interface DemoArtifactPreviewHandle {
  close(): void;
}

export type DemoArtifactPreviewOpener = (
  previewUrl: `/demo/${string}`,
) => DemoArtifactPreviewHandle | null;

export interface DemoExternalRehearsalExecutorOptions {
  readonly opener: DemoArtifactPreviewOpener;
  readonly clock?: { now(): Date };
  readonly createId?: (prefix: string) => string;
}

export class DemoExternalResourceNotFoundError extends Error {
  readonly status = 404 as const;

  constructor(
    readonly code: string,
    readonly resourceId: string,
  ) {
    super(`The requested demo ${code.replace(/_not_found$/, "")} was not found.`);
    this.name = "DemoExternalResourceNotFoundError";
  }
}

export class DemoArtifactPreviewError extends Error {
  constructor(
    readonly code: "demo_preview_blocked" | "demo_preview_rejected",
    readonly previewUrl: `/demo/${string}` | null,
  ) {
    super(
      code === "demo_preview_blocked"
        ? "The browser blocked the new tab. Use the embedded same-origin preview instead."
        : "The artifact does not have a safe bundled preview.",
    );
    this.name = "DemoArtifactPreviewError";
  }
}

export class DemoExternalRehearsalPersistenceError extends Error {
  readonly code = "demo_external_rehearsal_not_persisted" as const;

  constructor() {
    super("The demo rehearsal could not be saved in this browser.");
    this.name = "DemoExternalRehearsalPersistenceError";
  }
}

const systemClock = { now: () => new Date() };

/** Browser-local, no-effect rehearsals for the first isolated external slice. */
export class DemoExternalRehearsalExecutor {
  private readonly clock: { now(): Date };
  private readonly createId: (prefix: string) => string;
  private readonly opener: DemoArtifactPreviewOpener;

  private readonly handlers: ExternalHandlers = {
    openArtifact: (artifactId) => this.openArtifact(artifactId),
    applyJob: (jobKey, body) => this.applyJob(jobKey, body),
    markApplied: (jobKey, body) => this.markApplied(jobKey, body),
  };

  constructor(
    private readonly workspace: DemoWorkspaceRepository,
    options: DemoExternalRehearsalExecutorOptions,
  ) {
    this.opener = options.opener;
    this.clock = options.clock ?? systemClock;
    this.createId = options.createId ?? defaultId;
  }

  execute<TOperation extends DemoInitialExternalRehearsalOperation>(
    operation: TOperation,
    args: Parameters<ApiClientPort[TOperation]>,
  ): Promise<ApiClientResponse<TOperation>> {
    const handler = this.handlers[operation];
    return handler(...args);
  }

  private async openArtifact(artifactId: string): Promise<ArtifactOpenResponse> {
    const initial = this.workspace.snapshotNow();
    const artifact = requireArtifact(initial, artifactId);
    const previewUrl = safePreviewUrl(initial, artifact.localPath);
    let handle: DemoArtifactPreviewHandle | null;
    try {
      handle = this.opener(previewUrl);
    } catch {
      throw new DemoArtifactPreviewError("demo_preview_blocked", previewUrl);
    }
    if (!handle) {
      throw new DemoArtifactPreviewError("demo_preview_blocked", previewUrl);
    }

    const receipt = this.receipt({
      kind: "os_open",
      operation: "openArtifact",
      entityType: "artifact",
      entityId: artifactId,
      wouldHaveDone: "Opened the generated artifact in a local desktop application.",
      didNotDo: "No host OS opener or local path was used; a same-origin browser preview was opened.",
    });
    try {
      await this.commit((draft) => {
        const current = requireArtifact(draft, artifactId);
        const currentUrl = safePreviewUrl(draft, current.localPath);
        if (currentUrl !== previewUrl) {
          throw new DemoArtifactPreviewError("demo_preview_rejected", null);
        }
        appendReceipt(draft, receipt);
      });
    } catch (error) {
      try {
        handle.close();
      } catch {
        // The preview is already isolated; persistence failure remains primary.
      }
      throw error;
    }

    return { ok: true, artifact: structuredClone(artifact), opened: true, path: previewUrl };
  }

  private async applyJob(
    jobKey: string,
    body?: Parameters<ApiClientPort["applyJob"]>[1],
  ): Promise<ActionRunResponse> {
    const request = ApplyJobRequestSchema.parse(body ?? {});
    const now = this.clock.now().toISOString();
    const runId = this.createId("apply-run");
    const actionId = this.createId("apply-action");
    const receipt = this.receipt({
      kind: "application",
      operation: "applyJob",
      entityType: "job",
      entityId: jobKey,
      runId,
      wouldHaveDone: "Run application automation against the selected job.",
      didNotDo: "No browser automation, ATS, form, account, employer, or application destination was accessed; only a simulated dry-run was recorded.",
    });

    await this.commit((draft, context) => {
      const job = requireJob(draft, jobKey);
      appendWorkflowRun(draft, {
        workflowId: runId,
        runId,
        workflowType: "ApplyWorkflow",
        jobKey,
        title: job.title,
        company: job.company,
        status: "dry_run_complete",
        result: "dry_run",
        dryRun: true,
        model: "simulated",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
      }, {
        errorCode: null,
        errorMessage: null,
        retryable: false,
        inputSummary: { simulated: true, operation: "applyJob", dryRun: true },
        temporalRunId: null,
        events: [
          { eventType: "ApplyRunStarted", occurredAt: now, status: "in_progress", message: "Application rehearsal started." },
          { eventType: "ApplyRunEventRecorded", occurredAt: now, status: "dry_run_complete", message: "No application was submitted." },
        ],
      });

      const queueItem = draft.state.readModel.apply.queue.items.find((item) => item.jobKey === jobKey);
      if (queueItem) {
        queueItem.latestApplyRun = {
          runId,
          status: "dry_run_complete",
          result: "dry_run",
          dryRun: true,
          startedAt: now,
          finishedAt: now,
        };
        queueItem.approvalGate.dryRunEvidence = {
          runId,
          coverage: "full",
          finishedAt: now,
          blockedChannels: [],
        };
      }
      const applyRuns = draft.state.readModel.dashboard.summary.applyRuns;
      applyRuns.unshift({
        runId,
        jobKey,
        title: job.title,
        company: job.company,
        status: "dry_run_complete",
        dryRun: true,
        startedAt: now,
        events: [
          { at: now, type: "dry_run", level: "info", message: "No application submitted." },
        ],
      });
      appendReceipt(draft, receipt);
      context.appendDomainEvent({
        ...createApplyRunStarted(LOCAL_TENANT, {
          jobId: jobKey,
          runId,
          workerId: "demo-rehearsal",
          model: "simulated",
          dryRun: true,
          startedAt: now,
        }),
        occurredAt: now,
      });
      context.appendDomainEvent({
        ...createApplyRunEventRecorded(LOCAL_TENANT, {
          runId,
          event: {
            type: "dry_run_complete",
            level: "info",
            simulated: true,
            externalEffectOccurred: false,
          },
        }),
        occurredAt: now,
      });
      recomputeDemoOperationalProjections(draft);
    });

    return {
      ok: true,
      runId,
      workflowId: runId,
      actionId,
      action: "apply",
      status: "dry_run_complete",
      jobKey,
      command: {
        action: "apply",
        jobKey,
        dryRun: true,
        headless: false,
        limit: request.limit,
        model: "simulated",
        runId,
      },
      result: { simulated: true, externalEffectOccurred: false, result: "dry_run" },
      eventCursor: null,
      message: "Dry-run rehearsal completed; no application was submitted.",
    };
  }

  private async markApplied(
    jobKey: string,
    body?: Parameters<ApiClientPort["markApplied"]>[1],
  ): Promise<ActionRunResponse> {
    MarkJobActionRequestSchema.parse(body ?? {});
    const now = this.clock.now().toISOString();
    const runId = this.createId("mark-applied-run");
    const actionId = this.createId("mark-applied-action");
    const receipt = this.receipt({
      kind: "application",
      operation: "markApplied",
      entityType: "job",
      entityId: jobKey,
      runId,
      wouldHaveDone: "Record the job as applied after a real submission.",
      didNotDo: "No application was submitted; only this demo workspace was marked simulated-applied.",
    });

    await this.commit((draft, context) => {
      const job = requireJob(draft, jobKey);
      const detail = draft.state.readModel.jobs.details[jobKey];
      if (!detail) throw new DemoExternalResourceNotFoundError("job_not_found", jobKey);
      for (const value of [job, detail.job]) {
        value.applyStatus = "applied";
        value.appliedAt = now;
        value.currentStage = "apply";
        value.currentSubstage = "apply";
        value.currentState = "succeeded";
        value.errorCode = null;
        value.errorMessage = null;
        value.nextAction = null;
      }
      upsertCompletedApplyStage(detail.stages, now);
      detail.auditHistory.unshift({
        id: runId,
        category: "apply",
        tone: "info",
        title: "Simulated applied state recorded",
        description: "This browser-local demo state is not proof that an application was submitted.",
        occurredAt: now,
        actor: "demo_rehearsal",
        details: [{ label: "External effect", value: "None" }],
      });
      draft.state.readModel.apply.queue.items = draft.state.readModel.apply.queue.items.filter(
        (item) => item.jobKey !== jobKey,
      );
      appendReceipt(draft, receipt);
      context.appendDomainEvent({
        ...createStageCompleted(LOCAL_TENANT, {
          jobId: jobKey,
          stage: "apply",
          finishedAt: now,
          durationMs: 0,
        }),
        occurredAt: now,
      });
      recomputeDemoOutcomeProjections(draft);
    });

    return {
      ok: true,
      runId,
      actionId,
      action: "mark_applied",
      status: "succeeded",
      jobKey,
      command: { action: "mark_applied", jobKey, runId },
      result: { simulated: true, externalEffectOccurred: false, result: "simulated_applied" },
      eventCursor: null,
      message: "Simulated applied state recorded; no application was submitted.",
    };
  }

  private receipt(input: {
    readonly kind: DemoWorkspaceReceipt["kind"];
    readonly operation: "openArtifact" | "applyJob" | "markApplied";
    readonly entityType: NonNullable<DemoWorkspaceReceipt["entityType"]>;
    readonly entityId: string;
    readonly runId?: string;
    readonly wouldHaveDone: string;
    readonly didNotDo: string;
  }): DemoWorkspaceReceipt {
    return {
      receiptId: this.createId("receipt"),
      kind: input.kind,
      operation: input.operation,
      ...(input.runId ? { runId: input.runId } : {}),
      entityType: input.entityType,
      entityId: input.entityId,
      simulated: true,
      externalEffectOccurred: false,
      recordedAt: this.clock.now().toISOString(),
      wouldHaveDone: input.wouldHaveDone,
      didNotDo: input.didNotDo,
    };
  }

  private async commit(
    mutation: (
      draft: DemoWorkspaceSnapshot,
      context: DemoWorkspaceMutationContext,
    ) => void,
  ): Promise<void> {
    let result = await this.workspace.mutate(mutation);
    if (result.kind === "persistence_warning") {
      result = await this.workspace.mutate(mutation);
    }
    if (result.kind === "persistence_warning") {
      throw new DemoExternalRehearsalPersistenceError();
    }
  }
}

function requireJob(
  draft: DemoWorkspaceSnapshot,
  jobKey: string,
): DemoWorkspaceSnapshot["state"]["readModel"]["jobs"]["list"]["items"][number] {
  const job = draft.state.readModel.jobs.list.items.find((item) => item.jobKey === jobKey);
  if (!job || !draft.state.readModel.jobs.details[jobKey]) {
    throw new DemoExternalResourceNotFoundError("job_not_found", jobKey);
  }
  return job;
}

function requireArtifact(
  draft: DemoWorkspaceSnapshot,
  artifactId: string,
) {
  const detail = draft.state.readModel.materials.details[artifactId];
  if (!detail) {
    throw new DemoExternalResourceNotFoundError("artifact_not_found", artifactId);
  }
  return detail.artifact;
}

function safePreviewUrl(
  draft: DemoWorkspaceSnapshot,
  path: string,
): `/demo/${string}` {
  if (
    !isDemoArtifactUrl(path) ||
    !Object.values(draft.state.artifacts).some((asset) => asset.url === path)
  ) {
    throw new DemoArtifactPreviewError("demo_preview_rejected", null);
  }
  return path;
}

function appendReceipt(
  draft: DemoWorkspaceSnapshot,
  receipt: DemoWorkspaceReceipt,
): void {
  (draft.state.receipts as DemoWorkspaceReceipt[]).push(receipt);
}

function appendWorkflowRun(
  draft: DemoWorkspaceSnapshot,
  summary: WorkflowRunSummary,
  detail: Pick<
    WorkflowRunDetail,
    "errorCode" | "errorMessage" | "retryable" | "inputSummary" | "temporalRunId" | "events"
  >,
): void {
  draft.state.readModel.runs.list.items.unshift(summary);
  draft.state.readModel.runs.list.pagination.total += 1;
  draft.state.readModel.runs.list.pagination.pages = Math.max(
    1,
    Math.ceil(
      draft.state.readModel.runs.list.pagination.total /
        draft.state.readModel.runs.list.pagination.pageSize,
    ),
  );
  (draft.state.readModel.runs.details as Record<string, WorkflowRunDetail>)[summary.runId] = {
    ...summary,
    ...detail,
  };
}

function upsertCompletedApplyStage(stages: StageSummary[], now: string): void {
  const current = stages.find((stage) => stage.stage === "apply");
  if (current) {
    current.state = "succeeded";
    current.attemptCount = Math.max(1, current.attemptCount);
    current.startedAt ??= now;
    current.updatedAt = now;
    current.finishedAt = now;
    current.durationMs = 0;
    current.errorCode = null;
    current.errorMessage = null;
    current.retryable = false;
    current.blockedBy = [];
    current.nextAction = null;
    return;
  }
  stages.push({
    stage: "apply",
    state: "succeeded",
    attemptCount: 1,
    maxAttempts: 1,
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    durationMs: 0,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    blockedBy: [],
    nextAction: null,
  });
}

function defaultId(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `demo-${prefix}-${suffix}`;
}
