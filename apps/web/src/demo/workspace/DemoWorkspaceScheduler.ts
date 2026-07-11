import type {
  DemoPendingScenario,
  DemoWorkspaceSnapshot,
} from "./contracts.js";
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
) => void;

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
      } else if (
        notification.kind === "resync" ||
        notification.source === "broadcast"
      ) {
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
    try {
      await this.workspace.mutate(
        (draft, context) => {
          const persisted = draft.pendingScenarios.find(
            (candidate) => candidate.scenarioId === pending.scenarioId,
          );
          if (!persisted || persisted.deadlineAt !== pending.deadlineAt) {
            return;
          }
          onDeadline(persisted, draft, context);
        },
        { expectedResetEpoch: pending.resetEpoch },
      );
    } catch (error) {
      if (!(error instanceof DemoWorkspaceStaleEpochError)) {
        throw error;
      }
    }
  }
}
