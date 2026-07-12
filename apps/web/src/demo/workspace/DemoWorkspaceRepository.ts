import {
  DOMAIN_EVENT_TYPES,
  LOCAL_TENANT,
  type DomainEventUnion,
} from "@jobctrl/domain-types";

import { materializeDemoSeed } from "../clock.js";
import { DEMO_SEED } from "../seed.js";
import {
  DEMO_WORKSPACE_DATABASE_VERSION,
  DEMO_WORKSPACE_EVENT_LOG_LIMIT,
  DEMO_WORKSPACE_SCHEMA_VERSION,
  systemDemoWorkspaceClock,
  type DemoPendingScenario,
  type DemoWorkspaceClock,
  type DemoWorkspaceCommit,
  type DemoWorkspaceEventRecord,
  type DemoWorkspaceInitialization,
  type DemoWorkspaceMutationOptions,
  type DemoWorkspaceNotification,
  type DemoWorkspaceReady,
  type DemoWorkspaceRuntimeSnapshot,
  type DemoWorkspaceSnapshot,
  type DemoWorkspaceUpgradeRequired,
  type DemoWorkspaceWarning,
} from "./contracts.js";
import {
  browserDemoWorkspaceChannelFactory,
  type DemoWorkspaceChannel,
  type DemoWorkspaceChannelFactory,
} from "./channel.js";
import {
  DemoWorkspaceStorageError,
  InMemoryDemoWorkspaceStore,
  type DemoWorkspaceStore,
  type DemoWorkspaceTransaction,
} from "./storage.js";

const KNOWN_DOMAIN_EVENT_TYPES = new Set<string>(DOMAIN_EVENT_TYPES);

export class DemoWorkspaceUpgradeRequiredError extends Error {
  constructor(readonly upgrade: DemoWorkspaceUpgradeRequired) {
    super(upgrade.message);
    this.name = "DemoWorkspaceUpgradeRequiredError";
  }
}

export class DemoWorkspaceStaleEpochError extends Error {
  readonly code = "demo_workspace_stale_epoch" as const;

  constructor(
    readonly expectedResetEpoch: number,
    readonly actualResetEpoch: number,
  ) {
    super(
      `Demo workspace reset epoch changed from ${expectedResetEpoch} to ${actualResetEpoch}.`,
    );
    this.name = "DemoWorkspaceStaleEpochError";
  }
}

export interface DemoWorkspaceMutationContext {
  putBlob(blobId: string, value: Blob): void;
  deleteBlob(blobId: string): void;
  appendDomainEvent(event: DomainEventUnion): void;
}

export interface DemoWorkspaceRepositoryOptions {
  readonly store: DemoWorkspaceStore;
  readonly fallbackStore?: DemoWorkspaceStore;
  readonly clock?: DemoWorkspaceClock;
  readonly createWorkspaceId?: () => string;
  readonly channelFactory?: DemoWorkspaceChannelFactory;
}

type DraftMutation = (
  draft: DemoWorkspaceSnapshot,
  context: DemoWorkspaceMutationContext,
) => void;

interface NotificationWatermark {
  readonly workspaceId: string;
  readonly revision: number;
  readonly resetEpoch: number;
  readonly lastEventSequence: number;
}

export type DemoWorkspaceEventRead =
  | { readonly kind: "events"; readonly events: readonly DomainEventUnion[] }
  | { readonly kind: "event_log_lost" };

/**
 * IndexedDB is the sole workspace authority. BroadcastChannel messages carry
 * only post-commit watermarks; every accepted external message is followed by
 * an authoritative IDB reread before subscribers can observe it.
 */
export class DemoWorkspaceRepository {
  private store: DemoWorkspaceStore;
  private readonly fallbackStore: DemoWorkspaceStore;
  private readonly clock: DemoWorkspaceClock;
  private readonly createWorkspaceId: () => string;
  private readonly channelFactory: DemoWorkspaceChannelFactory;
  private channel: DemoWorkspaceChannel | null = null;
  private authoritativeSnapshot: DemoWorkspaceSnapshot | null = null;
  private notificationWatermark: NotificationWatermark | null = null;
  private initialization: DemoWorkspaceInitialization | null = null;
  private warning: DemoWorkspaceWarning | undefined;
  private runtimeSnapshot: DemoWorkspaceRuntimeSnapshot;
  private readonly notificationListeners = new Set<
    (notification: DemoWorkspaceNotification) => void
  >();
  private readonly runtimeListeners = new Set<() => void>();
  private broadcastQueue = Promise.resolve();

  constructor(options: DemoWorkspaceRepositoryOptions) {
    this.store = options.store;
    this.fallbackStore =
      options.fallbackStore ?? new InMemoryDemoWorkspaceStore();
    this.clock = options.clock ?? systemDemoWorkspaceClock;
    this.createWorkspaceId = options.createWorkspaceId ?? defaultWorkspaceId;
    this.channelFactory =
      options.channelFactory ?? browserDemoWorkspaceChannelFactory;
    this.runtimeSnapshot = {
      status: "initializing",
      storageMode: options.store.storageMode,
      warning: null,
    };
  }

  async initialize(): Promise<DemoWorkspaceInitialization> {
    if (this.initialization) {
      return this.initialization;
    }
    let knownSnapshot: DemoWorkspaceSnapshot | null = null;
    try {
      const current = await this.store.readSnapshot();
      knownSnapshot = current;
      if (!current) {
        return this.setReady(await this.seed());
      }
      const upgrade = workspaceUpgrade(current);
      if (upgrade) {
        return this.setUpgrade(upgrade);
      }
      const migrated =
        current.schemaVersion < DEMO_WORKSPACE_SCHEMA_VERSION
          ? await this.migrate(current)
          : current;
      this.adoptAuthoritativeSnapshot(migrated, true);
      return this.setReady(migrated);
    } catch (error) {
      const upgrade = upgradeFromError(error);
      if (upgrade) {
        return this.setUpgrade(upgrade);
      }
      if (isQuotaExceeded(error)) {
        return this.fallbackFromQuota(knownSnapshot);
      }
      if (!isStorageUnavailable(error)) {
        throw error;
      }
      return this.fallbackFromUnavailable(knownSnapshot);
    }
  }

  async snapshot(): Promise<DemoWorkspaceSnapshot> {
    this.requireReady();
    try {
      return await this.readAuthoritativeSnapshot();
    } catch (error) {
      if (error instanceof DemoWorkspaceUpgradeRequiredError) {
        throw error;
      }
      if (!isStorageUnavailable(error)) {
        throw error;
      }
      const ready = await this.fallbackFromUnavailable(
        this.authoritativeSnapshot,
      );
      return ready.snapshot;
    }
  }

  /**
   * Synchronous view of the repository's last authoritative adoption. This is
   * available only after initialization and is cloned so synchronous ports can
   * never mutate the workspace authority.
   */
  snapshotNow(): DemoWorkspaceSnapshot {
    this.requireReady();
    if (!this.authoritativeSnapshot) {
      throw new Error("Demo workspace has no authoritative snapshot.");
    }
    return clone(this.authoritativeSnapshot);
  }

  subscribe(
    listener: (notification: DemoWorkspaceNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  readonly subscribeRuntime = (listener: () => void): (() => void) => {
    this.runtimeListeners.add(listener);
    return () => this.runtimeListeners.delete(listener);
  };

  readonly getRuntimeSnapshot = (): DemoWorkspaceRuntimeSnapshot =>
    this.runtimeSnapshot;

  async mutate(
    mutation: DraftMutation,
    options: DemoWorkspaceMutationOptions = {},
  ): Promise<DemoWorkspaceCommit> {
    this.requireReady();
    const confirmed =
      this.authoritativeSnapshot ?? (await this.readAuthoritativeSnapshot());
    try {
      const committed = await this.store.transact((current, transaction) => {
        if (!current) {
          throw new Error("Demo workspace disappeared during a transaction.");
        }
        throwIfFutureWorkspace(current);
        if (
          options.expectedResetEpoch !== undefined &&
          current.resetEpoch !== options.expectedResetEpoch
        ) {
          throw new DemoWorkspaceStaleEpochError(
            options.expectedResetEpoch,
            current.resetEpoch,
          );
        }

        const draft = clone(current);
        const appendedEvents: DomainEventUnion[] = [];
        const context: DemoWorkspaceMutationContext = {
          putBlob: (blobId, value) => {
            transaction.putBlob(blobId, value);
            if (!draft.blobIds.includes(blobId)) {
              (draft as unknown as { blobIds: string[] }).blobIds = [
                ...draft.blobIds,
                blobId,
              ];
            }
          },
          deleteBlob: (blobId) => {
            transaction.deleteBlob(blobId);
            (draft as unknown as { blobIds: string[] }).blobIds =
              draft.blobIds.filter((candidate) => candidate !== blobId);
          },
          appendDomainEvent: (event) => {
            assertDemoDomainEvent(event);
            appendedEvents.push(clone(event));
          },
        };
        mutation(draft, context);

        const revision = current.revision + 1;
        const eventRecords = appendedEvents.map<DemoWorkspaceEventRecord>(
          (event, index) => ({
            sequence: current.lastEventSequence + index + 1,
            revision,
            resetEpoch: current.resetEpoch,
            event,
          }),
        );
        const nextEventLog = [
          ...(current.eventLog ?? []),
          ...eventRecords,
        ].slice(-DEMO_WORKSPACE_EVENT_LOG_LIMIT);
        const next: DemoWorkspaceSnapshot = {
          ...draft,
          revision,
          lastEventSequence: current.lastEventSequence + appendedEvents.length,
          eventLog: nextEventLog,
          updatedAt: this.clock.now().toISOString(),
        };
        transaction.putSnapshot(next);
        return next;
      });
      this.adoptAuthoritativeSnapshot(committed, true);
      this.setReady(committed);
      this.publishLocal("commit", committed);
      return { kind: "committed", snapshot: committed };
    } catch (error) {
      const upgrade = upgradeFromError(error);
      if (upgrade) {
        this.setUpgrade(upgrade);
        throw new DemoWorkspaceUpgradeRequiredError(upgrade);
      }
      return this.handleCommitStorageFailure(error, confirmed);
    }
  }

  async putBlob(
    blobId: string,
    value: Blob,
    options: DemoWorkspaceMutationOptions = {},
  ): Promise<DemoWorkspaceCommit> {
    return this.mutate(
      (_draft, context) => context.putBlob(blobId, value),
      options,
    );
  }

  async deleteBlob(
    blobId: string,
    options: DemoWorkspaceMutationOptions = {},
  ): Promise<DemoWorkspaceCommit> {
    return this.mutate(
      (_draft, context) => context.deleteBlob(blobId),
      options,
    );
  }

  async blob(blobId: string): Promise<Blob | null> {
    this.requireReady();
    if (!this.authoritativeSnapshot?.blobIds.includes(blobId)) {
      return null;
    }
    try {
      return await this.store.readBlob(blobId);
    } catch (error) {
      const upgrade = upgradeFromError(error);
      if (upgrade) {
        this.setUpgrade(upgrade);
        throw new DemoWorkspaceUpgradeRequiredError(upgrade);
      }
      if (!isStorageUnavailable(error)) {
        throw error;
      }
      await this.fallbackFromUnavailable(this.authoritativeSnapshot);
      return this.store.readBlob(blobId);
    }
  }

  async queueScenario(
    pending: DemoPendingScenario,
  ): Promise<DemoWorkspaceCommit> {
    return this.mutate(
      (draft) => {
        if (
          draft.pendingScenarios.some(
            (scenario) => scenario.scenarioId === pending.scenarioId,
          )
        ) {
          throw new Error(
            `Demo scenario ${pending.scenarioId} is already pending.`,
          );
        }
        (draft.pendingScenarios as DemoPendingScenario[]).push(pending);
      },
      { expectedResetEpoch: pending.resetEpoch },
    );
  }

  async reset(): Promise<DemoWorkspaceCommit> {
    this.requireReady();
    const confirmed =
      this.authoritativeSnapshot ?? (await this.readAuthoritativeSnapshot());
    try {
      const committed = await this.store.transact((stored, transaction) => {
        if (!stored) {
          throw new Error("Demo workspace disappeared during reset.");
        }
        throwIfFutureWorkspace(stored);
        const now = this.clock.now().toISOString();
        const next = this.makeSeedSnapshot({
          createdAt: now,
          resetCount: stored.resetCount + 1,
          resetEpoch: stored.resetEpoch + 1,
          revision: stored.revision + 1,
          lastEventSequence: stored.lastEventSequence,
        });
        transaction.clearBlobs();
        transaction.putSnapshot(next);
        return next;
      });
      this.adoptAuthoritativeSnapshot(committed, true);
      this.setReady(committed);
      this.publishLocal("reset", committed);
      return { kind: "committed", snapshot: committed };
    } catch (error) {
      const upgrade = upgradeFromError(error);
      if (upgrade) {
        this.setUpgrade(upgrade);
        throw new DemoWorkspaceUpgradeRequiredError(upgrade);
      }
      return this.handleCommitStorageFailure(error, confirmed);
    }
  }

  async readEventsForNotification(
    notification: DemoWorkspaceNotification,
    afterSequence: number,
  ): Promise<DemoWorkspaceEventRead> {
    const snapshot = await this.readAuthoritativeSnapshot();
    const throughSequence = notification.lastEventSequence;
    if (throughSequence <= afterSequence) {
      return { kind: "events", events: [] };
    }
    const records = snapshot.eventLog
      .filter(
        (record) =>
          record.sequence > afterSequence &&
          record.sequence <= throughSequence &&
          record.resetEpoch === notification.resetEpoch,
      )
      .sort((left, right) => left.sequence - right.sequence);
    let expectedSequence = afterSequence + 1;
    for (const record of records) {
      if (record.sequence !== expectedSequence) {
        return { kind: "event_log_lost" };
      }
      expectedSequence += 1;
    }
    if (expectedSequence - 1 !== throughSequence) {
      return { kind: "event_log_lost" };
    }
    const events = records.map((record) => {
      assertDemoDomainEvent(record.event);
      return record.event;
    });
    return { kind: "events", events };
  }

  async rereadAfterExternalChange(): Promise<DemoWorkspaceSnapshot> {
    return this.readAuthoritativeSnapshot();
  }

  dispose(): void {
    if (this.channel) {
      this.channel.removeEventListener("message", this.onChannelMessage);
      this.channel.close();
    }
    this.channel = null;
    this.store.close?.();
    this.notificationListeners.clear();
    this.runtimeListeners.clear();
  }

  private async seed(): Promise<DemoWorkspaceSnapshot> {
    const candidate = this.makeSeedSnapshot({
      createdAt: this.clock.now().toISOString(),
      resetCount: 0,
      resetEpoch: 0,
      revision: 0,
      lastEventSequence: 0,
    });
    const committed = await this.store.transact((current, transaction) => {
      if (current) {
        throwIfFutureWorkspace(current);
        return current;
      }
      transaction.putSnapshot(candidate);
      return candidate;
    });
    this.adoptAuthoritativeSnapshot(committed, true);
    if (committed.workspaceId === candidate.workspaceId) {
      this.publishLocal("commit", committed);
    }
    return committed;
  }

  private async migrate(
    original: DemoWorkspaceSnapshot,
  ): Promise<DemoWorkspaceSnapshot> {
    const originalBlobIds = optionalBlobIds(original);
    const migratedBlobIds = originalBlobIds ?? [
      ...(await this.store.readAllBlobs()).keys(),
    ];
    const committed = await this.store.transact((stored, transaction) => {
      if (!stored) {
        throw new Error("Demo workspace disappeared during migration.");
      }
      throwIfFutureWorkspace(stored);
      if (stored.schemaVersion >= DEMO_WORKSPACE_SCHEMA_VERSION) {
        return stored;
      }
      const migrated: DemoWorkspaceSnapshot = {
        ...stored,
        schemaVersion: DEMO_WORKSPACE_SCHEMA_VERSION,
        revision: stored.revision + 1,
        eventLog: stored.eventLog ?? [],
        blobIds: optionalBlobIds(stored) ?? migratedBlobIds,
        updatedAt: this.clock.now().toISOString(),
      };
      transaction.putSnapshot(migrated);
      return migrated;
    });
    this.adoptAuthoritativeSnapshot(committed, true);
    if (committed.revision > original.revision) {
      this.publishLocal("commit", committed);
    }
    return committed;
  }

  private async handleCommitStorageFailure(
    error: unknown,
    confirmed: DemoWorkspaceSnapshot,
  ): Promise<DemoWorkspaceCommit> {
    if (isQuotaExceeded(error)) {
      const warning: DemoWorkspaceWarning = {
        code: "quota_exceeded",
        message:
          "Browser storage is full; this tab preserved the last confirmed demo state in memory only.",
      };
      const newestDurable = await this.readNewestDurableSnapshot(confirmed);
      const memorySnapshot = await this.switchToMemory(
        newestDurable,
        warning,
        true,
      );
      return {
        kind: "persistence_warning",
        snapshot: memorySnapshot,
        warning,
      };
    }
    if (isStorageUnavailable(error)) {
      const ready = await this.fallbackFromUnavailable(confirmed);
      return {
        kind: "persistence_warning",
        snapshot: ready.snapshot,
        warning: ready.warning!,
      };
    }
    throw error;
  }

  private async readNewestDurableSnapshot(
    fallback: DemoWorkspaceSnapshot,
  ): Promise<DemoWorkspaceSnapshot> {
    try {
      const snapshot = await this.store.readSnapshot();
      if (!snapshot) {
        return fallback;
      }
      const upgrade = workspaceUpgrade(snapshot);
      if (upgrade) {
        this.setUpgrade(upgrade);
        throw new DemoWorkspaceUpgradeRequiredError(upgrade);
      }
      return snapshot;
    } catch (error) {
      if (error instanceof DemoWorkspaceUpgradeRequiredError) {
        throw error;
      }
      const upgrade = upgradeFromError(error);
      if (upgrade) {
        this.setUpgrade(upgrade);
        throw new DemoWorkspaceUpgradeRequiredError(upgrade);
      }
      return fallback;
    }
  }

  private async fallbackFromUnavailable(
    confirmed: DemoWorkspaceSnapshot | null,
  ): Promise<DemoWorkspaceReady> {
    const warning: DemoWorkspaceWarning = {
      code: "indexeddb_unavailable",
      message:
        "Browser storage is unavailable; this tab will not share or retain demo changes.",
    };
    const candidate =
      confirmed ??
      this.makeSeedSnapshot({
        createdAt: this.clock.now().toISOString(),
        resetCount: 0,
        resetEpoch: 0,
        revision: 0,
        lastEventSequence: 0,
      });
    const snapshot = await this.switchToMemory(candidate, warning, true);
    if (!confirmed) {
      this.publishLocal("commit", snapshot);
    }
    return this.setReady(snapshot);
  }

  private async fallbackFromQuota(
    confirmed: DemoWorkspaceSnapshot | null,
  ): Promise<DemoWorkspaceReady> {
    const warning: DemoWorkspaceWarning = {
      code: "quota_exceeded",
      message:
        "Browser storage is full; this tab preserved the last confirmed demo state in memory only.",
    };
    const candidate =
      confirmed ??
      this.makeSeedSnapshot({
        createdAt: this.clock.now().toISOString(),
        resetCount: 0,
        resetEpoch: 0,
        revision: 0,
        lastEventSequence: 0,
      });
    const snapshot = await this.switchToMemory(candidate, warning, true);
    if (!confirmed) {
      this.publishLocal("commit", snapshot);
    }
    return this.setReady(snapshot);
  }

  private async switchToMemory(
    snapshot: DemoWorkspaceSnapshot,
    warning: DemoWorkspaceWarning,
    copyDurableBlobs: boolean,
  ): Promise<DemoWorkspaceSnapshot> {
    const durableStore = this.store;
    let durableBlobs: ReadonlyMap<string, Blob> = new Map();
    if (copyDurableBlobs) {
      try {
        durableBlobs = await durableStore.readAllBlobs();
      } catch (error) {
        if (warning.code === "quota_exceeded") {
          throw error;
        }
      }
    }
    const declaredBlobIds = optionalBlobIds(snapshot) ?? [
      ...durableBlobs.keys(),
    ];
    const copiedBlobIds = declaredBlobIds.filter((blobId) =>
      durableBlobs.has(blobId),
    );
    const memorySnapshot: DemoWorkspaceSnapshot = {
      ...snapshot,
      schemaVersion: DEMO_WORKSPACE_SCHEMA_VERSION,
      eventLog: snapshot.eventLog ?? [],
      blobIds: copiedBlobIds,
    };
    if (this.channel) {
      this.channel.removeEventListener("message", this.onChannelMessage);
      this.channel.close();
    }
    this.channel = null;
    this.store = this.fallbackStore;
    this.warning = warning;
    await this.store.transact((_current, transaction) => {
      transaction.clearBlobs();
      for (const blobId of copiedBlobIds) {
        transaction.putBlob(blobId, durableBlobs.get(blobId)!);
      }
      transaction.putSnapshot(memorySnapshot);
    });
    durableStore.close?.();
    this.adoptAuthoritativeSnapshot(memorySnapshot, true);
    this.setReady(memorySnapshot);
    return memorySnapshot;
  }

  private async readAuthoritativeSnapshot(): Promise<DemoWorkspaceSnapshot> {
    const snapshot = await this.store.readSnapshot();
    if (!snapshot) {
      throw new Error("Demo workspace disappeared after initialization.");
    }
    const upgrade = workspaceUpgrade(snapshot);
    if (upgrade) {
      this.setUpgrade(upgrade);
      throw new DemoWorkspaceUpgradeRequiredError(upgrade);
    }
    this.adoptAuthoritativeSnapshot(snapshot, false);
    return snapshot;
  }

  private adoptAuthoritativeSnapshot(
    snapshot: DemoWorkspaceSnapshot,
    advanceWatermark: boolean,
  ): void {
    this.authoritativeSnapshot = snapshot;
    if (advanceWatermark) {
      this.notificationWatermark = watermarkFromSnapshot(snapshot);
    }
  }

  private installChannel(): void {
    if (this.store.storageMode !== "indexeddb" || this.channel) {
      return;
    }
    const channel = this.channelFactory.create();
    if (!channel) {
      return;
    }
    channel.addEventListener("message", this.onChannelMessage);
    this.channel = channel;
  }

  private readonly onChannelMessage = (
    event: MessageEvent<DemoWorkspaceNotification>,
  ): void => {
    const queued = this.broadcastQueue.then(() =>
      this.handleExternalNotification(event.data),
    );
    this.broadcastQueue = queued.catch(async (error: unknown) => {
      if (error instanceof DemoWorkspaceUpgradeRequiredError) {
        return;
      }
      if (isQuotaExceeded(error)) {
        await this.fallbackFromQuota(this.authoritativeSnapshot);
        return;
      }
      if (isStorageUnavailable(error)) {
        await this.fallbackFromUnavailable(this.authoritativeSnapshot);
      }
    });
  };

  private async handleExternalNotification(
    incoming: DemoWorkspaceNotification,
  ): Promise<void> {
    const watermark =
      this.notificationWatermark ??
      (this.authoritativeSnapshot
        ? watermarkFromSnapshot(this.authoritativeSnapshot)
        : watermarkFromSnapshot(await this.readAuthoritativeSnapshot()));

    if (incoming.resetEpoch < watermark.resetEpoch) {
      return;
    }
    const reset = incoming.resetEpoch > watermark.resetEpoch;
    if (
      !reset &&
      (incoming.workspaceId !== watermark.workspaceId ||
        incoming.revision <= watermark.revision)
    ) {
      return;
    }
    const gap = !reset && incoming.revision !== watermark.revision + 1;

    const authoritative = await this.readAuthoritativeSnapshot();
    if (
      authoritative.resetEpoch < incoming.resetEpoch ||
      authoritative.revision < incoming.revision
    ) {
      return;
    }

    if (
      authoritative.resetEpoch > incoming.resetEpoch ||
      authoritative.workspaceId !== incoming.workspaceId
    ) {
      this.notificationWatermark = watermarkFromSnapshot(authoritative);
      this.notify({
        source: "broadcast",
        kind: "reset",
        ...watermarkFromSnapshot(authoritative),
      });
      return;
    }

    if (
      authoritative.revision > incoming.revision ||
      authoritative.lastEventSequence > incoming.lastEventSequence
    ) {
      const authoritativeWatermark = watermarkFromSnapshot(authoritative);
      this.notificationWatermark = authoritativeWatermark;
      this.notify({
        source: "broadcast",
        kind: "resync",
        ...authoritativeWatermark,
      });
      return;
    }

    // Advance only the notification watermark. The authoritative snapshot was
    // replaced by the IDB reread above and is never synthesized from this data.
    this.notificationWatermark = {
      workspaceId: incoming.workspaceId,
      revision: incoming.revision,
      resetEpoch: incoming.resetEpoch,
      lastEventSequence: incoming.lastEventSequence,
    };
    this.notify({
      source: "broadcast",
      kind:
        reset || incoming.kind === "reset"
          ? "reset"
          : gap
            ? "resync"
            : "commit",
      workspaceId: incoming.workspaceId,
      revision: incoming.revision,
      resetEpoch: incoming.resetEpoch,
      lastEventSequence: incoming.lastEventSequence,
    });
  }

  private publishLocal(
    kind: "commit" | "reset",
    snapshot: DemoWorkspaceSnapshot,
  ): void {
    const notification: DemoWorkspaceNotification = {
      source: "local",
      kind,
      workspaceId: snapshot.workspaceId,
      revision: snapshot.revision,
      resetEpoch: snapshot.resetEpoch,
      lastEventSequence: snapshot.lastEventSequence,
    };
    this.notificationWatermark = watermarkFromSnapshot(snapshot);
    this.notify(notification);
    this.channel?.postMessage(notification);
  }

  private notify(notification: DemoWorkspaceNotification): void {
    for (const listener of this.notificationListeners) {
      listener(notification);
    }
  }

  private setReady(snapshot: DemoWorkspaceSnapshot): DemoWorkspaceReady {
    this.authoritativeSnapshot = snapshot;
    this.installChannel();
    const ready: DemoWorkspaceReady = {
      kind: "ready",
      snapshot,
      storageMode: this.store.storageMode,
      ...(this.warning ? { warning: this.warning } : {}),
    };
    this.initialization = ready;
    this.setRuntimeSnapshot({
      status: "ready",
      storageMode: this.store.storageMode,
      warning: this.warning ?? null,
    });
    return ready;
  }

  private setUpgrade(
    upgrade: DemoWorkspaceUpgradeRequired,
  ): DemoWorkspaceUpgradeRequired {
    this.initialization = upgrade;
    this.setRuntimeSnapshot({
      status: "upgrade_required",
      storageMode: "indexeddb",
      warning: null,
      upgrade,
    });
    return upgrade;
  }

  private setRuntimeSnapshot(next: DemoWorkspaceRuntimeSnapshot): void {
    const current = this.runtimeSnapshot;
    const unchanged =
      current.status === next.status &&
      current.storageMode === next.storageMode &&
      current.warning?.code === next.warning?.code &&
      (current.status !== "upgrade_required" ||
        next.status !== "upgrade_required" ||
        current.upgrade.message === next.upgrade.message);
    if (unchanged) {
      return;
    }
    this.runtimeSnapshot = next;
    for (const listener of this.runtimeListeners) {
      listener();
    }
  }

  private requireReady(): void {
    if (!this.initialization) {
      throw new Error("DemoWorkspaceRepository must initialize before use.");
    }
    if (this.initialization.kind === "upgrade_required") {
      throw new DemoWorkspaceUpgradeRequiredError(this.initialization);
    }
  }

  private makeSeedSnapshot(input: {
    readonly createdAt: string;
    readonly resetCount: number;
    readonly resetEpoch: number;
    readonly revision: number;
    readonly lastEventSequence: number;
  }): DemoWorkspaceSnapshot {
    const materialized = materializeDemoSeed(DEMO_SEED, {
      anchor: input.createdAt,
    });
    return {
      schemaVersion: DEMO_WORKSPACE_SCHEMA_VERSION,
      seedVersion: DEMO_SEED.seedVersion,
      workspaceId: this.createWorkspaceId(),
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      resetCount: input.resetCount,
      revision: input.revision,
      resetEpoch: input.resetEpoch,
      lastEventSequence: input.lastEventSequence,
      eventLog: [],
      blobIds: [],
      state: {
        title: materialized.title,
        generatedAt: materialized.generatedAt,
        artifacts: materialized.artifacts,
        readModel: materialized.readModel,
        routeData: materialized.routeData,
        receipts: materialized.receipts,
      },
      pendingScenarios: [],
    };
  }
}

export const DEMO_WORKSPACE_TENANT = LOCAL_TENANT;

function defaultWorkspaceId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `demo-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function workspaceUpgrade(
  snapshot: DemoWorkspaceSnapshot,
): DemoWorkspaceUpgradeRequired | null {
  return snapshot.schemaVersion > DEMO_WORKSPACE_SCHEMA_VERSION
    ? {
        kind: "upgrade_required",
        scope: "workspace_schema",
        foundSchemaVersion: snapshot.schemaVersion,
        supportedSchemaVersion: DEMO_WORKSPACE_SCHEMA_VERSION,
        message:
          "This demo workspace was created by a newer version. Reload after updating the demo.",
      }
    : null;
}

function throwIfFutureWorkspace(snapshot: DemoWorkspaceSnapshot): void {
  const upgrade = workspaceUpgrade(snapshot);
  if (upgrade) {
    throw new DemoWorkspaceUpgradeRequiredError(upgrade);
  }
}

function upgradeFromError(error: unknown): DemoWorkspaceUpgradeRequired | null {
  if (error instanceof DemoWorkspaceUpgradeRequiredError) {
    return error.upgrade;
  }
  if (
    error instanceof DemoWorkspaceStorageError &&
    error.kind === "upgrade_required" &&
    error.foundDatabaseVersion !== undefined
  ) {
    return {
      kind: "upgrade_required",
      scope: "database_version",
      foundDatabaseVersion: error.foundDatabaseVersion,
      supportedDatabaseVersion: DEMO_WORKSPACE_DATABASE_VERSION,
      message:
        "This browser database was created by a newer demo version. Reload after updating the demo.",
    };
  }
  return null;
}

function watermarkFromSnapshot(
  snapshot: DemoWorkspaceSnapshot,
): NotificationWatermark {
  return {
    workspaceId: snapshot.workspaceId,
    revision: snapshot.revision,
    resetEpoch: snapshot.resetEpoch,
    lastEventSequence: snapshot.lastEventSequence,
  };
}

function optionalBlobIds(
  snapshot: DemoWorkspaceSnapshot,
): readonly string[] | undefined {
  const candidate = snapshot as DemoWorkspaceSnapshot & {
    readonly blobIds?: readonly string[];
  };
  return Array.isArray(candidate.blobIds) ? candidate.blobIds : undefined;
}

function assertDemoDomainEvent(
  event: unknown,
): asserts event is DomainEventUnion {
  const candidate = event as Partial<{
    eventType: string;
    tenantId: string;
    occurredAt: string;
    payload: unknown;
  }>;
  if (
    typeof event !== "object" ||
    event === null ||
    typeof candidate.eventType !== "string" ||
    !KNOWN_DOMAIN_EVENT_TYPES.has(candidate.eventType) ||
    candidate.tenantId !== LOCAL_TENANT ||
    typeof candidate.occurredAt !== "string" ||
    candidate.occurredAt.length === 0 ||
    typeof candidate.payload !== "object" ||
    candidate.payload === null ||
    Array.isArray(candidate.payload)
  ) {
    throw new TypeError(
      "Demo workspace events must be valid local domain events.",
    );
  }
}

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DemoWorkspaceStorageError
    ? error.kind === "quota"
    : error instanceof DOMException && error.name === "QuotaExceededError";
}

function isStorageUnavailable(error: unknown): boolean {
  return error instanceof DemoWorkspaceStorageError
    ? error.kind === "unavailable"
    : error instanceof DOMException && error.name === "SecurityError";
}

function clone<TValue>(value: TValue): TValue {
  return structuredClone(value);
}
