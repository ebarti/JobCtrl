import type {
  DemoPendingScenario,
  DemoScenarioInvocation,
  DemoWorkspaceCommit,
  DemoWorkspaceSnapshot,
} from "./contracts.js";
import { isDemoScenarioInvocation } from "./contracts.js";
import {
  DemoWorkspaceRepository,
  DemoWorkspaceStaleEpochError,
  type DemoWorkspaceMutationContext,
} from "./DemoWorkspaceRepository.js";

export interface DemoSchedulerClock {
  now(): number;
  setTimeout(
    handler: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export type DemoWorkspaceDeadlineHandler = (
  pending: DemoPendingScenario,
  draft: DemoWorkspaceSnapshot,
  context: DemoWorkspaceMutationContext,
) => DemoPendingScenario | null | void;

export type DemoWorkspaceScenarioEnqueueHandler = (
  pending: DemoScenarioInvocation,
  draft: DemoWorkspaceSnapshot,
  context: DemoWorkspaceMutationContext,
) => void;

export type DemoWorkspaceInvocationScheduleResult =
  | {
      readonly kind: "scheduled";
      readonly pending: DemoScenarioInvocation;
      readonly commit: DemoWorkspaceCommit;
    }
  | {
      readonly kind: "active";
      readonly pending: DemoScenarioInvocation;
    }
  | {
      readonly kind: "persistence_warning";
      readonly pending: DemoScenarioInvocation;
      readonly commit: Extract<DemoWorkspaceCommit, { kind: "persistence_warning" }>;
    };

class DemoWorkspaceActiveInvocation extends Error {
  constructor(readonly pending: DemoScenarioInvocation) {
    super(`Demo scenario ${pending.dedupeKey} is already active.`);
    this.name = "DemoWorkspaceActiveInvocation";
  }
}

/** Aborts an IDB transaction for a stale callback without writing a revision. */
class DemoWorkspaceBenignDeadlineAbort extends Error {
  constructor() {
    super("The demo deadline is no longer authoritative.");
    this.name = "DemoWorkspaceBenignDeadlineAbort";
  }
}

const browserSchedulerClock: DemoSchedulerClock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * P1 persists deterministic deadline metadata only. Deadline handlers run as
 * synchronous, epoch-fenced workspace mutations; P3 owns their outcome data.
 */
export class DemoWorkspaceScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly registrations = new Map<
    string,
    {
      readonly pending: DemoPendingScenario;
      readonly onDeadline: DemoWorkspaceDeadlineHandler;
    }
  >();
  private recoveryHandler: DemoWorkspaceDeadlineHandler | null = null;
  private reconcileQueue = Promise.resolve();
  private reconcileGeneration = 0;
  private disposed = false;
  private readonly stop: () => void;

  constructor(
    private readonly workspace: DemoWorkspaceRepository,
    private readonly clock: DemoSchedulerClock = browserSchedulerClock,
  ) {
    this.stop = workspace.subscribe((notification) => {
      if (notification.kind === "reset") {
        this.reconcileGeneration += 1;
        this.clearTimersAndRegistrations();
      } else {
        this.clearTimers();
        this.queueReconcile(++this.reconcileGeneration);
      }
    });
  }

  async schedule(
    pending: DemoPendingScenario,
    onDeadline: DemoWorkspaceDeadlineHandler,
  ): Promise<void> {
    const result = await this.workspace.queueScenario(pending);
    if (result.kind === "persistence_warning") {
      return;
    }
    this.arm(pending, onDeadline);
  }

  /**
   * Persists the invocation and its initial queued projection in one fenced
   * transaction. Concurrent calls with the same dedupe key reuse the active
   * invocation instead of creating another workflow.
   */
  async scheduleInvocation(
    pending: DemoScenarioInvocation,
    onEnqueue: DemoWorkspaceScenarioEnqueueHandler,
    onDeadline: DemoWorkspaceDeadlineHandler,
  ): Promise<DemoWorkspaceInvocationScheduleResult> {
    const enqueue = () =>
      this.workspace.mutate(
        (draft, context) => {
          const active = draft.pendingScenarios.find(
            (candidate): candidate is DemoScenarioInvocation =>
              isDemoScenarioInvocation(candidate) &&
              candidate.dedupeKey === pending.dedupeKey,
          );
          if (active) {
            throw new DemoWorkspaceActiveInvocation(active);
          }
          if (
            draft.pendingScenarios.some(
              (candidate) => candidate.scenarioId === pending.scenarioId,
            )
          ) {
            throw new Error(
              `Demo scenario ${pending.scenarioId} is already pending.`,
            );
          }
          onEnqueue(pending, draft, context);
          (draft.pendingScenarios as DemoPendingScenario[]).push(pending);
        },
        { expectedResetEpoch: pending.resetEpoch },
      );
    try {
      let commit = await enqueue();
      // A quota transition switches the repository to its confirmed in-memory
      // authority. Retry the same fenced CAS once before reporting queued.
      if (commit.kind === "persistence_warning") {
        commit = await enqueue();
        if (commit.kind === "persistence_warning") {
          return { kind: "persistence_warning", pending, commit };
        }
      }
      this.arm(pending, onDeadline);
      return { kind: "scheduled", pending, commit };
    } catch (error) {
      if (!(error instanceof DemoWorkspaceActiveInvocation)) {
        throw error;
      }
      this.arm(error.pending, onDeadline);
      return { kind: "active", pending: error.pending };
    }
  }

  async recover(onDeadline: DemoWorkspaceDeadlineHandler): Promise<void> {
    this.recoveryHandler = onDeadline;
    await this.reconcile(++this.reconcileGeneration);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.reconcileGeneration += 1;
    this.clearTimersAndRegistrations();
    this.recoveryHandler = null;
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      this.clock.clearTimeout(timer);
    }
    this.timers.clear();
  }

  private clearTimersAndRegistrations(): void {
    this.clearTimers();
    this.registrations.clear();
  }

  private queueReconcile(generation: number): void {
    this.reconcileQueue = this.reconcileQueue
      .then(() => this.reconcile(generation))
      .catch(() => {
        // A later workspace notification or explicit recovery can retry. The
        // safe failure mode is to leave no unfenced deadline callback armed.
        if (!this.disposed && generation === this.reconcileGeneration) {
          this.clearTimers();
        }
      });
  }

  private async reconcile(generation: number): Promise<void> {
    const snapshot = await this.workspace.snapshot();
    if (this.disposed || generation !== this.reconcileGeneration) {
      return;
    }
    const persisted = new Map(
      snapshot.pendingScenarios.map((pending) => [pending.scenarioId, pending]),
    );

    for (const [scenarioId, registration] of this.registrations) {
      const current = persisted.get(scenarioId);
      if (
        !current ||
        current.resetEpoch !== snapshot.resetEpoch ||
        current.resetEpoch !== registration.pending.resetEpoch
      ) {
        this.disarm(scenarioId);
        continue;
      }
      this.arm(current, registration.onDeadline);
      persisted.delete(scenarioId);
    }

    if (this.recoveryHandler) {
      for (const pending of persisted.values()) {
        if (pending.resetEpoch === snapshot.resetEpoch) {
          this.arm(pending, this.recoveryHandler);
        }
      }
    }
  }

  private disarm(scenarioId: string): void {
    const timer = this.timers.get(scenarioId);
    if (timer) {
      this.clock.clearTimeout(timer);
    }
    this.timers.delete(scenarioId);
    this.registrations.delete(scenarioId);
  }

  private arm(
    pending: DemoPendingScenario,
    onDeadline: DemoWorkspaceDeadlineHandler,
  ): void {
    if (this.disposed) {
      return;
    }
    const previous = this.timers.get(pending.scenarioId);
    if (previous) {
      this.clock.clearTimeout(previous);
    }
    const deadline = Date.parse(pending.deadlineAt);
    if (!Number.isFinite(deadline)) {
      throw new TypeError(
        `Demo scenario ${pending.scenarioId} has an invalid deadline.`,
      );
    }
    const timer = this.clock.setTimeout(
      () => {
        void this.fireIfCurrent(pending, onDeadline);
      },
      Math.max(0, deadline - this.clock.now()),
    );
    this.timers.set(pending.scenarioId, timer);
    this.registrations.set(pending.scenarioId, { pending, onDeadline });
  }

  private async fireIfCurrent(
    pending: DemoPendingScenario,
    onDeadline: DemoWorkspaceDeadlineHandler,
  ): Promise<void> {
    this.timers.delete(pending.scenarioId);
    this.registrations.delete(pending.scenarioId);
    if (this.disposed) {
      return;
    }
    try {
      let nextPending: DemoPendingScenario | null | void = undefined;
      const advance = () => {
        nextPending = undefined;
        return this.workspace.mutate(
          (draft, context) => {
            if (this.disposed) {
              throw new DemoWorkspaceBenignDeadlineAbort();
            }
            const index = draft.pendingScenarios.findIndex(
              (candidate) => candidate.scenarioId === pending.scenarioId,
            );
            const persisted = draft.pendingScenarios[index];
            if (!persisted || !sameDeadlineRegistration(persisted, pending)) {
              throw new DemoWorkspaceBenignDeadlineAbort();
            }
            nextPending = onDeadline(persisted, draft, context);
            if (nextPending === null) {
              (draft.pendingScenarios as DemoPendingScenario[]).splice(index, 1);
            } else if (nextPending !== undefined) {
              assertValidTransition(persisted, nextPending);
              (draft.pendingScenarios as DemoPendingScenario[])[index] =
                nextPending;
            }
          },
          { expectedResetEpoch: pending.resetEpoch },
        );
      };
      let commit = await advance();
      if (commit.kind === "persistence_warning") {
        commit = await advance();
      }
      if (commit.kind === "committed" && nextPending) {
        this.arm(nextPending, onDeadline);
      }
    } catch (error) {
      if (
        !(error instanceof DemoWorkspaceStaleEpochError) &&
        !(error instanceof DemoWorkspaceBenignDeadlineAbort)
      ) {
        throw error;
      }
    }
  }
}

function sameDeadlineRegistration(
  persisted: DemoPendingScenario,
  armed: DemoPendingScenario,
): boolean {
  if (
    persisted.deadlineAt !== armed.deadlineAt ||
    persisted.resetEpoch !== armed.resetEpoch
  ) {
    return false;
  }
  if (isDemoScenarioInvocation(persisted) !== isDemoScenarioInvocation(armed)) {
    return false;
  }
  return !isDemoScenarioInvocation(persisted) ||
    !isDemoScenarioInvocation(armed)
    ? true
    : persisted.phase === armed.phase &&
        persisted.dedupeKey === armed.dedupeKey;
}

function assertValidTransition(
  current: DemoPendingScenario,
  next: DemoPendingScenario,
): void {
  if (
    current.scenarioId !== next.scenarioId ||
    current.resetEpoch !== next.resetEpoch ||
    !Number.isFinite(Date.parse(next.deadlineAt))
  ) {
    throw new TypeError("A demo deadline transition changed its durable identity.");
  }
}
