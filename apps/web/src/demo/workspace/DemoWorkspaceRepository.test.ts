import { describe, expect, it, vi } from "vitest";

import { createJobUpdated, LOCAL_TENANT } from "@jobctrl/domain-types";

import { DEMO_SEED } from "../seed.js";
import type {
  DemoWorkspaceChannel,
  DemoWorkspaceChannelFactory,
} from "./channel.js";
import type {
  DemoWorkspaceClock,
  DemoWorkspaceNotification,
  DemoWorkspaceSnapshot,
} from "./contracts.js";
import { DemoWorkspaceEventStreamAdapter } from "./DemoWorkspaceEventStreamAdapter.js";
import {
  DemoWorkspaceRepository,
  DemoWorkspaceStaleEpochError,
} from "./DemoWorkspaceRepository.js";
import {
  DemoWorkspaceStorageError,
  InMemoryDemoWorkspaceStore,
  type DemoWorkspaceStore,
  type DemoWorkspaceTransaction,
} from "./storage.js";

const fixedClock: DemoWorkspaceClock = {
  now: () => new Date("2026-07-11T12:00:00.000Z"),
};

class SharedPersistentStore implements DemoWorkspaceStore {
  readonly storageMode = "indexeddb" as const;
  failNext: DemoWorkspaceStorageError | null = null;

  constructor(readonly memory = new InMemoryDemoWorkspaceStore()) {}

  readSnapshot(): Promise<DemoWorkspaceSnapshot | null> {
    return this.memory.readSnapshot();
  }

  readBlob(blobId: string): Promise<Blob | null> {
    return this.memory.readBlob(blobId);
  }

  readAllBlobs(): Promise<ReadonlyMap<string, Blob>> {
    return this.memory.readAllBlobs();
  }

  transact<TResult>(
    operation: (
      current: DemoWorkspaceSnapshot | null,
      transaction: DemoWorkspaceTransaction,
    ) => TResult,
  ): Promise<TResult> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    return this.memory.transact(operation);
  }
}

class DeferredPersistentStore extends SharedPersistentStore {
  private resolveGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.resolveGate = resolve;
  });

  release(): void {
    this.resolveGate();
  }

  override async transact<TResult>(
    operation: (
      current: DemoWorkspaceSnapshot | null,
      transaction: DemoWorkspaceTransaction,
    ) => TResult,
  ): Promise<TResult> {
    await this.gate;
    return super.transact(operation);
  }
}

class ChannelHub {
  private readonly endpoints = new Set<HubEndpoint>();

  createFactory(): DemoWorkspaceChannelFactory {
    return { create: () => new HubEndpoint(this) };
  }

  connect(endpoint: HubEndpoint): void {
    this.endpoints.add(endpoint);
  }

  disconnect(endpoint: HubEndpoint): void {
    this.endpoints.delete(endpoint);
  }

  publish(sender: HubEndpoint, notification: DemoWorkspaceNotification): void {
    for (const endpoint of this.endpoints) {
      if (endpoint !== sender) {
        endpoint.deliver(notification);
      }
    }
  }

  send(notification: DemoWorkspaceNotification): void {
    for (const endpoint of this.endpoints) {
      endpoint.deliver(notification);
    }
  }
}

class HubEndpoint implements DemoWorkspaceChannel {
  private readonly listeners = new Set<
    (event: MessageEvent<DemoWorkspaceNotification>) => void
  >();

  constructor(private readonly hub: ChannelHub) {
    hub.connect(this);
  }

  postMessage(notification: DemoWorkspaceNotification): void {
    this.hub.publish(this, notification);
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<DemoWorkspaceNotification>) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<DemoWorkspaceNotification>) => void,
  ): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.hub.disconnect(this);
    this.listeners.clear();
  }

  deliver(notification: DemoWorkspaceNotification): void {
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener({
          data: notification,
        } as MessageEvent<DemoWorkspaceNotification>);
      }
    });
  }
}

async function settleBroadcast(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function buildRepository(
  store: DemoWorkspaceStore,
  channelFactory?: DemoWorkspaceChannelFactory,
): DemoWorkspaceRepository {
  let index = 0;
  return new DemoWorkspaceRepository({
    store,
    clock: fixedClock,
    ...(channelFactory ? { channelFactory } : {}),
    createWorkspaceId: () => `workspace-${++index}`,
  });
}

describe("DemoWorkspaceRepository", () => {
  it("exposes a stable receipt snapshot and notifies after authoritative adoption", async () => {
    const repository = buildRepository(new SharedPersistentStore());
    await repository.initialize();
    const initial = repository.getReceiptsSnapshot();
    expect(repository.getReceiptsSnapshot()).toBe(initial);
    const listener = vi.fn();
    const unsubscribe = repository.subscribeReceipts(listener);

    await repository.mutate((draft) => {
      (
        draft.state.receipts as Array<(typeof draft.state.receipts)[number]>
      ).push({
        receiptId: "receipt-live-open",
        kind: "os_open",
        simulated: true,
        externalEffectOccurred: false,
        recordedAt: "2026-07-11T12:00:00.000Z",
        wouldHaveDone: "Opened an artifact preview.",
        didNotDo: "No host OS process was invoked.",
        operation: "openArtifact",
        entityType: "artifact",
        entityId: "artifact-tailored-resume",
      });
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(repository.getReceiptsSnapshot()).not.toBe(initial);
    expect(repository.getReceiptsSnapshot().at(-1)).toMatchObject({
      receiptId: "receipt-live-open",
      operation: "openArtifact",
    });
    unsubscribe();
  });
  it("exposes an immutable synchronous clone only after initialization", async () => {
    const repository = buildRepository(new SharedPersistentStore());
    expect(() => repository.snapshotNow()).toThrow(
      "DemoWorkspaceRepository must initialize before use.",
    );
    await repository.initialize();

    const clone = repository.snapshotNow();
    (clone.state as { title: string }).title = "caller mutation";
    expect(repository.snapshotNow().state.title).toBe("JobCtrl product tour");

    await repository.mutate((draft) => {
      (draft.state as { title: string }).title = "authoritative mutation";
    });
    expect(repository.snapshotNow().state.title).toBe("authoritative mutation");
  });

  it.each([
    ["newer", "2026-07-13.1"],
    ["unknown", "future-seed"],
  ] as const)(
    "preserves a %s seed and requires an upgrade",
    async (_description, seedVersion) => {
      const baselineRepository = buildRepository(
        new InMemoryDemoWorkspaceStore(),
      );
      const baseline = await baselineRepository.initialize();
      expect(baseline.kind).toBe("ready");
      if (baseline.kind !== "ready") return;
      const protectedSnapshot: DemoWorkspaceSnapshot = {
        ...baseline.snapshot,
        seedVersion,
        workspaceId: `workspace-${seedVersion}-seed`,
        blobIds: ["protected-preview"],
        state: {
          ...baseline.snapshot.state,
          title: "Protected newer demo workspace",
        },
      };
      const store = new InMemoryDemoWorkspaceStore(protectedSnapshot);
      await store.transact((_current, transaction) => {
        transaction.putBlob("protected-preview", new Blob(["protected"]));
      });

      const initialization = await buildRepository(store).initialize();

      expect(initialization).toMatchObject({
        kind: "upgrade_required",
        scope: "seed_version",
        foundSeedVersion: seedVersion,
        supportedSeedVersion: DEMO_SEED.seedVersion,
      });
      expect(await store.readSnapshot()).toMatchObject({
        seedVersion,
        workspaceId: `workspace-${seedVersion}-seed`,
        blobIds: ["protected-preview"],
        state: { title: "Protected newer demo workspace" },
      });
      expect(await store.readBlob("protected-preview")).toEqual(
        expect.objectContaining({ size: 9 }),
      );
    },
  );

  it("refuses a manual reset after a newer seed replaces the active snapshot", async () => {
    const store = new SharedPersistentStore();
    const repository = buildRepository(store);
    await repository.initialize();
    const current = await repository.snapshot();
    await store.memory.transact((_stored, transaction) => {
      transaction.putBlob("newer-preview", new Blob(["protected"]));
      transaction.putSnapshot({
        ...current,
        seedVersion: "2026-07-13.1",
        workspaceId: "workspace-newer-manual-reset",
        revision: current.revision + 1,
        blobIds: ["newer-preview"],
        state: {
          ...current.state,
          title: "Newer durable workspace",
        },
      });
    });

    await expect(repository.reset()).rejects.toMatchObject({
      name: "DemoWorkspaceUpgradeRequiredError",
      upgrade: {
        scope: "seed_version",
        foundSeedVersion: "2026-07-13.1",
      },
    });
    expect(await store.readSnapshot()).toMatchObject({
      seedVersion: "2026-07-13.1",
      workspaceId: "workspace-newer-manual-reset",
      revision: current.revision + 1,
      blobIds: ["newer-preview"],
      state: { title: "Newer durable workspace" },
    });
    expect(await store.readBlob("newer-preview")).toEqual(
      expect.objectContaining({ size: 9 }),
    );
  });

  it("does not let a newer cross-tab reset downgrade the durable workspace", async () => {
    const hub = new ChannelHub();
    const store = new SharedPersistentStore();
    const olderTab = buildRepository(store, hub.createFactory());
    await olderTab.initialize();
    const current = await olderTab.snapshot();
    const newerSnapshot = {
      ...current,
      seedVersion: "2026-07-13.1",
      workspaceId: "workspace-newer-cross-tab",
      resetCount: current.resetCount + 1,
      resetEpoch: current.resetEpoch + 1,
      revision: current.revision + 1,
      blobIds: ["newer-cross-tab-preview"],
      state: {
        ...current.state,
        title: "Newer cross-tab workspace",
      },
    };
    await store.memory.transact((_stored, transaction) => {
      transaction.putBlob("newer-cross-tab-preview", new Blob(["protected"]));
      transaction.putSnapshot(newerSnapshot);
    });

    hub.send({
      source: "local",
      kind: "reset",
      workspaceId: newerSnapshot.workspaceId,
      revision: newerSnapshot.revision,
      resetEpoch: newerSnapshot.resetEpoch,
      lastEventSequence: newerSnapshot.lastEventSequence,
    });
    await settleBroadcast();

    expect(olderTab.getRuntimeSnapshot()).toMatchObject({
      status: "upgrade_required",
      upgrade: {
        scope: "seed_version",
        foundSeedVersion: "2026-07-13.1",
      },
    });
    expect(await store.readSnapshot()).toMatchObject({
      seedVersion: "2026-07-13.1",
      workspaceId: "workspace-newer-cross-tab",
      blobIds: ["newer-cross-tab-preview"],
      state: { title: "Newer cross-tab workspace" },
    });
    expect(await store.readBlob("newer-cross-tab-preview")).toEqual(
      expect.objectContaining({ size: 9 }),
    );
  });

  it("fences a P6 reset before it can downgrade a P7 workspace", async () => {
    const p6WorkspaceSchemaVersion = 3;
    const hub = new ChannelHub();
    const store = new SharedPersistentStore();
    const p7Tab = buildRepository(store, hub.createFactory());
    await p7Tab.initialize();
    await p7Tab.putBlob("p7-preview", new Blob(["P7 generated preview"]));
    const p7Snapshot = await p7Tab.snapshot();
    const notifications: DemoWorkspaceNotification[] = [];
    p7Tab.subscribe((notification) => notifications.push(notification));
    const p6Channel = hub.createFactory().create();
    if (!p6Channel) throw new Error("missing P6 channel fixture");

    const p6CompatibleReset = async (): Promise<DemoWorkspaceSnapshot> => {
      const committed = await store.transact((stored, transaction) => {
        if (!stored) {
          throw new Error("Demo workspace disappeared during P6 reset.");
        }
        if (stored.schemaVersion > p6WorkspaceSchemaVersion) {
          throw new Error(
            "This demo workspace was created by a newer version. Reload after updating the demo.",
          );
        }
        const downgraded: DemoWorkspaceSnapshot = {
          ...stored,
          schemaVersion: p6WorkspaceSchemaVersion,
          seedVersion: "2026-07-11.1",
          workspaceId: "workspace-p6-reset",
          revision: stored.revision + 1,
          resetEpoch: stored.resetEpoch + 1,
          resetCount: stored.resetCount + 1,
          blobIds: [],
        };
        transaction.clearBlobs();
        transaction.putSnapshot(downgraded);
        return downgraded;
      });
      p6Channel.postMessage({
        source: "local",
        kind: "reset",
        workspaceId: committed.workspaceId,
        revision: committed.revision,
        resetEpoch: committed.resetEpoch,
        lastEventSequence: committed.lastEventSequence,
      });
      return committed;
    };

    await expect(p6CompatibleReset()).rejects.toThrow(
      "This demo workspace was created by a newer version.",
    );
    await settleBroadcast();

    expect(notifications).toEqual([]);
    expect(p7Tab.getRuntimeSnapshot()).toMatchObject({ status: "ready" });
    expect(p7Tab.snapshotNow()).toEqual(p7Snapshot);
    expect(await store.readSnapshot()).toEqual(p7Snapshot);
    expect(await store.readBlob("p7-preview")).toEqual(
      expect.objectContaining({ size: 20 }),
    );
    p6Channel.close();
  });

  it("loads the current seed in memory when durable seed refresh hits quota", async () => {
    const builder = buildRepository(new InMemoryDemoWorkspaceStore());
    await builder.initialize();
    const staleSnapshot: DemoWorkspaceSnapshot = {
      ...(await builder.snapshot()),
      schemaVersion: 3,
      seedVersion: "2026-07-11.1",
      workspaceId: "workspace-stale-quota-seed",
    };
    const store = new SharedPersistentStore(
      new InMemoryDemoWorkspaceStore(staleSnapshot),
    );
    store.failNext = new DemoWorkspaceStorageError("quota");
    const repository = new DemoWorkspaceRepository({
      store,
      clock: fixedClock,
      createWorkspaceId: () => "workspace-memory-seed",
    });

    await expect(repository.initialize()).resolves.toMatchObject({
      kind: "ready",
      storageMode: "memory",
      warning: {
        code: "quota_exceeded",
        message: expect.stringContaining("current synthetic examples"),
      },
      snapshot: {
        seedVersion: DEMO_SEED.seedVersion,
        workspaceId: "workspace-memory-seed",
        resetCount: 1,
        resetEpoch: 1,
        revision: 1,
        state: { title: "JobCtrl product tour" },
      },
    });
    expect((await store.readSnapshot())?.seedVersion).toBe("2026-07-11.1");
  });

  it("broadcasts an automatic seed refresh as a reset to existing tabs", async () => {
    const hub = new ChannelHub();
    const store = new SharedPersistentStore();
    const first = buildRepository(store, hub.createFactory());
    await first.initialize();
    const current = await first.snapshot();
    await store.memory.transact((_stored, transaction) => {
      transaction.putSnapshot({
        ...current,
        schemaVersion: 3,
        seedVersion: "2026-07-11.1",
        state: {
          ...current.state,
          title: "Mutated previous synthetic seed",
        },
      });
    });
    const notifications: DemoWorkspaceNotification[] = [];
    first.subscribe((notification) => notifications.push(notification));
    const second = new DemoWorkspaceRepository({
      store,
      clock: fixedClock,
      channelFactory: hub.createFactory(),
      createWorkspaceId: () => "workspace-refreshed-broadcast",
    });

    await expect(second.initialize()).resolves.toMatchObject({
      kind: "ready",
      snapshot: {
        seedVersion: DEMO_SEED.seedVersion,
        workspaceId: "workspace-refreshed-broadcast",
        resetEpoch: 1,
      },
    });
    await settleBroadcast();

    expect(notifications).toContainEqual(
      expect.objectContaining({
        source: "broadcast",
        kind: "reset",
        workspaceId: "workspace-refreshed-broadcast",
        revision: 1,
        resetEpoch: 1,
      }),
    );
    expect(await first.snapshot()).toMatchObject({
      seedVersion: DEMO_SEED.seedVersion,
      workspaceId: "workspace-refreshed-broadcast",
      state: { title: "JobCtrl product tour" },
    });
  });

  it("keeps notification watermarks separate and rereads IDB before exposing a contiguous external revision", async () => {
    const hub = new ChannelHub();
    const store = new SharedPersistentStore();
    const first = buildRepository(store, hub.createFactory());
    const second = buildRepository(store, hub.createFactory());
    await Promise.all([first.initialize(), second.initialize()]);
    const observedTitles: string[] = [];
    second.subscribe((notification) => {
      if (notification.source === "broadcast") {
        void second.snapshot().then((snapshot) => {
          observedTitles.push(snapshot.state.title);
        });
      }
    });

    await first.mutate((draft) => {
      (draft.state as { title: string }).title = "Authoritative IDB title";
    });
    await settleBroadcast();

    expect(observedTitles).toEqual(["Authoritative IDB title"]);
    expect((await second.snapshot()).state.title).toBe(
      "Authoritative IDB title",
    );
  });

  it("ignores duplicate/old revisions and rereads broadly on a gap or remote reset", async () => {
    const hub = new ChannelHub();
    const store = new SharedPersistentStore();
    const first = buildRepository(store, hub.createFactory());
    const second = buildRepository(store, hub.createFactory());
    await Promise.all([first.initialize(), second.initialize()]);
    const notifications: DemoWorkspaceNotification[] = [];
    second.subscribe((notification) => notifications.push(notification));
    const eventStream = new DemoWorkspaceEventStreamAdapter(second);
    const subscription = eventStream.subscribe({ tenantId: LOCAL_TENANT });
    const statuses: string[] = [];
    subscription.onStatusChange((status) => statuses.push(status));
    await settleBroadcast();
    statuses.length = 0;
    const initial = await first.snapshot();

    await store.memory.transact((current, transaction) => {
      if (!current) throw new Error("missing fixture workspace");
      transaction.putSnapshot({ ...current, revision: 3 });
    });
    hub.send({
      source: "local",
      kind: "commit",
      workspaceId: initial.workspaceId,
      revision: 0,
      resetEpoch: 0,
      lastEventSequence: 0,
    });
    await settleBroadcast();
    expect(notifications).toHaveLength(0);

    hub.send({
      source: "local",
      kind: "commit",
      workspaceId: initial.workspaceId,
      revision: 3,
      resetEpoch: 0,
      lastEventSequence: 0,
    });
    await settleBroadcast();
    expect(notifications).toContainEqual(
      expect.objectContaining({ kind: "resync" }),
    );
    expect(statuses).toEqual(["closed", "open"]);

    statuses.length = 0;
    await first.reset();
    await settleBroadcast();
    expect(notifications).toContainEqual(
      expect.objectContaining({ kind: "reset", resetEpoch: 1 }),
    );
    const reset = await second.snapshot();
    expect(reset).toMatchObject({
      resetEpoch: 1,
      resetCount: 1,
      workspaceId: "workspace-2",
    });
    expect(statuses).toEqual(["closed", "open"]);
    subscription.close();
  });

  it("resyncs through the authoritative revision when only an older broadcast watermark arrives", async () => {
    const hub = new ChannelHub();
    const store = new SharedPersistentStore();
    const repository = buildRepository(store, hub.createFactory());
    await repository.initialize();
    const current = await repository.snapshot();
    const notifications: DemoWorkspaceNotification[] = [];
    repository.subscribe((notification) => notifications.push(notification));

    await store.memory.transact((_stored, transaction) => {
      transaction.putSnapshot({
        ...current,
        revision: 2,
        state: { ...current.state, title: "Authoritative revision two" },
      });
    });
    hub.send({
      source: "local",
      kind: "commit",
      workspaceId: current.workspaceId,
      revision: 1,
      resetEpoch: current.resetEpoch,
      lastEventSequence: current.lastEventSequence,
    });
    await settleBroadcast();

    expect(notifications).toEqual([
      expect.objectContaining({ kind: "resync", revision: 2 }),
    ]);
    expect((await repository.snapshot()).state.title).toBe(
      "Authoritative revision two",
    );
  });

  it("does not emit a local or broadcast event before the committing transaction completes", async () => {
    const store = new DeferredPersistentStore();
    const repository = buildRepository(store);
    const notices: DemoWorkspaceNotification[] = [];
    repository.subscribe((notice) => notices.push(notice));
    const starting = repository.initialize();
    await settleBroadcast();
    expect(notices).toHaveLength(0);
    store.release();
    await starting;
    expect(notices).toHaveLength(1);
  });

  it("preserves future-schema data and returns a typed upgrade-required result", async () => {
    const seedStore = new SharedPersistentStore();
    const builder = buildRepository(seedStore);
    await builder.initialize();
    const future = {
      ...(await builder.snapshot()),
      schemaVersion: 6,
      workspaceId: "future-workspace",
    };
    const store = new InMemoryDemoWorkspaceStore(future);
    const repository = buildRepository(store);

    await expect(repository.initialize()).resolves.toMatchObject({
      kind: "upgrade_required",
      scope: "workspace_schema",
      foundSchemaVersion: 6,
      supportedSchemaVersion: 5,
    });
    expect((await store.readSnapshot())?.workspaceId).toBe("future-workspace");
  });

  it("revalidates a future snapshot reached through a cross-tab notification", async () => {
    const hub = new ChannelHub();
    const store = new SharedPersistentStore();
    const repository = buildRepository(store, hub.createFactory());
    await repository.initialize();
    const current = await repository.snapshot();
    await store.memory.transact((_stored, transaction) => {
      transaction.putSnapshot({
        ...current,
        schemaVersion: 6,
        revision: 1,
      });
    });

    hub.send({
      source: "local",
      kind: "commit",
      workspaceId: current.workspaceId,
      revision: 1,
      resetEpoch: 0,
      lastEventSequence: 0,
    });
    await settleBroadcast();

    expect(repository.getRuntimeSnapshot()).toMatchObject({
      status: "upgrade_required",
      upgrade: {
        scope: "workspace_schema",
        foundSchemaVersion: 6,
      },
    });
  });

  it("migrates an older schema atomically without resetting its workspace", async () => {
    const seedStore = new SharedPersistentStore();
    const builder = buildRepository(seedStore);
    await builder.initialize();
    await builder.putBlob("legacy-preview", new Blob(["legacy preview"]));
    const current = await builder.snapshot();
    const { blobIds: _omittedLegacyManifest, ...withoutBlobManifest } = current;
    const legacy = {
      ...withoutBlobManifest,
      schemaVersion: 1,
      workspaceId: "legacy-workspace",
    } as DemoWorkspaceSnapshot;
    const store = new InMemoryDemoWorkspaceStore(legacy);
    await store.transact((_stored, transaction) => {
      transaction.putBlob("legacy-preview", new Blob(["legacy preview"]));
    });
    const repository = buildRepository(store);
    const ready = await repository.initialize();
    expect(ready).toMatchObject({
      kind: "ready",
      snapshot: {
        schemaVersion: 5,
        workspaceId: "legacy-workspace",
        revision: 2,
        blobIds: ["legacy-preview"],
      },
    });
    expect(await repository.blob("legacy-preview")).toEqual(
      expect.objectContaining({ size: 14 }),
    );
  });

  it("normalizes a legacy snapshot and its blobs when migration falls back on quota", async () => {
    const seedStore = new SharedPersistentStore();
    const builder = buildRepository(seedStore);
    await builder.initialize();
    const current = await builder.snapshot();
    const { blobIds: _omittedLegacyManifest, ...withoutBlobManifest } = current;
    const legacy = {
      ...withoutBlobManifest,
      schemaVersion: 1,
      workspaceId: "legacy-quota-workspace",
    } as DemoWorkspaceSnapshot;
    const memory = new InMemoryDemoWorkspaceStore(legacy);
    await memory.transact((_stored, transaction) => {
      transaction.putBlob("legacy-quota-preview", new Blob(["quota legacy"]));
    });
    const store = new SharedPersistentStore(memory);
    store.failNext = new DemoWorkspaceStorageError("quota");
    const repository = buildRepository(store);

    await expect(repository.initialize()).resolves.toMatchObject({
      kind: "ready",
      storageMode: "memory",
      snapshot: {
        schemaVersion: 5,
        workspaceId: "legacy-quota-workspace",
        blobIds: ["legacy-quota-preview"],
      },
    });
    expect(await repository.blob("legacy-quota-preview")).toEqual(
      expect.objectContaining({ size: 12 }),
    );
  });

  it("falls back fresh to tab-local memory when IndexedDB is denied", async () => {
    const unavailable: DemoWorkspaceStore = {
      storageMode: "indexeddb",
      readSnapshot: async () =>
        Promise.reject(new DemoWorkspaceStorageError("unavailable")),
      readBlob: async () =>
        Promise.reject(new DemoWorkspaceStorageError("unavailable")),
      readAllBlobs: async () =>
        Promise.reject(new DemoWorkspaceStorageError("unavailable")),
      transact: async () =>
        Promise.reject(new DemoWorkspaceStorageError("unavailable")),
    };
    const repository = buildRepository(unavailable);
    const result = await repository.initialize();
    expect(result).toMatchObject({
      kind: "ready",
      storageMode: "memory",
      warning: { code: "indexeddb_unavailable" },
    });
  });

  it("returns typed upgrade-required for a newer browser database without memory fallback", async () => {
    const futureDatabase: DemoWorkspaceStore = {
      storageMode: "indexeddb",
      readSnapshot: async () =>
        Promise.reject(
          new DemoWorkspaceStorageError("upgrade_required", undefined, 2),
        ),
      readBlob: async () => null,
      readAllBlobs: async () => new Map(),
      transact: async () =>
        Promise.reject(
          new DemoWorkspaceStorageError("upgrade_required", undefined, 2),
        ),
    };
    const repository = buildRepository(futureDatabase);
    await expect(repository.initialize()).resolves.toMatchObject({
      kind: "upgrade_required",
      scope: "database_version",
      foundDatabaseVersion: 2,
      supportedDatabaseVersion: 1,
    });
    expect(repository.getRuntimeSnapshot()).toMatchObject({
      status: "upgrade_required",
      storageMode: "indexeddb",
    });
  });

  it("keeps confirmed durable blobs readable after a later quota fallback", async () => {
    const store = new SharedPersistentStore();
    const repository = buildRepository(store);
    await repository.initialize();
    await repository.putBlob("confirmed-preview", new Blob(["preview body"]));
    expect((await repository.snapshot()).blobIds).toEqual([
      "confirmed-preview",
    ]);

    store.failNext = new DemoWorkspaceStorageError("quota");
    await expect(
      repository.mutate((draft) => {
        (draft.state as { title: string }).title = "uncommitted";
      }),
    ).resolves.toMatchObject({
      kind: "persistence_warning",
      warning: { code: "quota_exceeded" },
    });

    expect(await repository.blob("confirmed-preview")).toEqual(
      expect.objectContaining({ size: 12 }),
    );
    await store.memory.transact((current, transaction) => {
      if (!current) throw new Error("missing durable fixture workspace");
      transaction.putBlob("confirmed-preview", new Blob(["replacement"]));
      transaction.putSnapshot({ ...current, revision: current.revision + 1 });
    });
    expect(await repository.blob("confirmed-preview")).toEqual(
      expect.objectContaining({ size: 12 }),
    );
    await store.memory.transact((current, transaction) => {
      if (!current) throw new Error("missing durable fixture workspace");
      transaction.clearBlobs();
      transaction.putSnapshot({
        ...current,
        revision: current.revision + 1,
        resetEpoch: current.resetEpoch + 1,
        blobIds: [],
      });
    });
    expect(await repository.blob("confirmed-preview")).toEqual(
      expect.objectContaining({ size: 12 }),
    );
    await repository.deleteBlob("confirmed-preview");
    expect(await repository.blob("confirmed-preview")).toBeNull();
  });

  it("preserves another tab's newest durable commit when quota aborts the local write", async () => {
    class QuotaRaceStore extends SharedPersistentStore {
      failWithExternalCommit = false;

      override async transact<TResult>(
        operation: (
          current: DemoWorkspaceSnapshot | null,
          transaction: DemoWorkspaceTransaction,
        ) => TResult,
      ): Promise<TResult> {
        if (!this.failWithExternalCommit) {
          return super.transact(operation);
        }
        this.failWithExternalCommit = false;
        await this.memory.transact((current, transaction) => {
          if (!current) throw new Error("missing fixture workspace");
          transaction.putSnapshot({
            ...current,
            revision: current.revision + 1,
            state: { ...current.state, title: "Committed by another tab" },
          });
        });
        throw new DemoWorkspaceStorageError("quota");
      }
    }

    const store = new QuotaRaceStore();
    const repository = buildRepository(store);
    await repository.initialize();
    store.failWithExternalCommit = true;
    const result = await repository.mutate((draft) => {
      (draft.state as { title: string }).title = "Uncommitted local title";
    });

    expect(result).toMatchObject({
      kind: "persistence_warning",
      snapshot: {
        revision: 1,
        state: { title: "Committed by another tab" },
      },
    });
    expect(await repository.snapshot()).toMatchObject({
      revision: 1,
      state: { title: "Committed by another tab" },
    });
  });

  it("delivers only persisted valid domain events through EventStreamPort", async () => {
    const repository = buildRepository(new SharedPersistentStore());
    await repository.initialize();
    const adapter = new DemoWorkspaceEventStreamAdapter(repository);
    const subscription = adapter.subscribe({ tenantId: LOCAL_TENANT });
    const events: unknown[] = [];
    subscription.on((event) => events.push(event));
    await repository.mutate((_draft, context) => {
      context.appendDomainEvent(
        createJobUpdated(LOCAL_TENANT, {
          jobId: "job-demo-northwind-platform",
          changedFields: { title: "Updated title" },
        }),
      );
    });
    await settleBroadcast();
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "JobUpdated",
        payload: expect.objectContaining({
          jobId: "job-demo-northwind-platform",
        }),
      }),
    ]);
    subscription.close();
  });

  it("rejects malformed events before they can enter the committed event log", async () => {
    const repository = buildRepository(new SharedPersistentStore());
    await repository.initialize();

    await expect(
      repository.mutate((_draft, context) => {
        context.appendDomainEvent({
          eventType: "NotADomainEvent",
          tenantId: LOCAL_TENANT,
          occurredAt: fixedClock.now().toISOString(),
          payload: {},
        } as never);
      }),
    ).rejects.toThrow("valid local domain events");
    expect(await repository.snapshot()).toMatchObject({
      revision: 0,
      lastEventSequence: 0,
      eventLog: [],
    });
  });
});
