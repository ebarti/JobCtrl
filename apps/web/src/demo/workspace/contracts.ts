import type { DomainEventUnion } from "@jobctrl/domain-types";

import type { MaterializedDemoSeed } from "../clock.js";
import type { DemoReadModel } from "../contracts.js";

export const DEMO_WORKSPACE_DATABASE = "jobctrl-demo";
export const DEMO_WORKSPACE_DATABASE_VERSION = 1;
export const DEMO_WORKSPACE_STORE = "workspace";
export const DEMO_BLOBS_STORE = "blobs";
export const DEMO_WORKSPACE_SCHEMA_VERSION = 2;
export const DEMO_WORKSPACE_EVENT_LOG_LIMIT = 128;

export interface DemoPendingScenario {
  readonly scenarioId: string;
  readonly deadlineAt: string;
  readonly resetEpoch: number;
}

export interface DemoWorkspaceEventRecord {
  readonly sequence: number;
  readonly revision: number;
  readonly resetEpoch: number;
  readonly event: DomainEventUnion;
}

/**
 * The complete mutable browser-local aggregate. Its `state` is the sole
 * canonical copy of the P0 projection seed; Query is deliberately a cache,
 * never a second persistence authority.
 */
export interface DemoWorkspaceSnapshot {
  readonly schemaVersion: number;
  readonly seedVersion: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resetCount: number;
  readonly revision: number;
  readonly resetEpoch: number;
  readonly lastEventSequence: number;
  readonly eventLog: readonly DemoWorkspaceEventRecord[];
  /**
   * Durable blob identifiers owned by this snapshot. Keeping the manifest in
   * the aggregate lets a memory fallback continue reading confirmed blobs
   * without resurrecting blobs deleted by a later local mutation or reset.
   */
  readonly blobIds: readonly string[];
  readonly state: {
    readonly title: string;
    readonly generatedAt: string;
    readonly artifacts: MaterializedDemoSeed["artifacts"];
    readonly readModel: DemoReadModel;
    readonly routeData: MaterializedDemoSeed["routeData"];
    readonly receipts: MaterializedDemoSeed["receipts"];
  };
  readonly pendingScenarios: readonly DemoPendingScenario[];
}

export type DemoWorkspaceStorageMode = "indexeddb" | "memory";

export type DemoWorkspaceWarning =
  | {
      readonly code: "indexeddb_unavailable";
      readonly message: "Browser storage is unavailable; this tab will not share or retain demo changes.";
    }
  | {
      readonly code: "quota_exceeded";
      readonly message: "Browser storage is full; this tab preserved the last confirmed demo state in memory only.";
    };

export interface DemoWorkspaceReady {
  readonly kind: "ready";
  readonly snapshot: DemoWorkspaceSnapshot;
  readonly storageMode: DemoWorkspaceStorageMode;
  readonly warning?: DemoWorkspaceWarning;
}

export type DemoWorkspaceUpgradeRequired =
  | {
      readonly kind: "upgrade_required";
      readonly scope: "workspace_schema";
      readonly foundSchemaVersion: number;
      readonly supportedSchemaVersion: number;
      readonly message: "This demo workspace was created by a newer version. Reload after updating the demo.";
    }
  | {
      readonly kind: "upgrade_required";
      readonly scope: "database_version";
      readonly foundDatabaseVersion: number;
      readonly supportedDatabaseVersion: number;
      readonly message: "This browser database was created by a newer demo version. Reload after updating the demo.";
    };

export type DemoWorkspaceInitialization =
  | DemoWorkspaceReady
  | DemoWorkspaceUpgradeRequired;

export type DemoWorkspaceCommit =
  | {
      readonly kind: "committed";
      readonly snapshot: DemoWorkspaceSnapshot;
    }
  | {
      readonly kind: "persistence_warning";
      readonly snapshot: DemoWorkspaceSnapshot;
      readonly warning: DemoWorkspaceWarning;
    };

export interface DemoWorkspaceNotification {
  readonly source: "local" | "broadcast";
  readonly kind: "commit" | "reset" | "resync";
  readonly workspaceId: string;
  readonly revision: number;
  readonly resetEpoch: number;
  readonly lastEventSequence: number;
}

export interface DemoWorkspaceMutationOptions {
  readonly expectedResetEpoch?: number;
}

export type DemoWorkspaceRuntimeSnapshot =
  | {
      readonly status: "initializing";
      readonly storageMode: DemoWorkspaceStorageMode;
      readonly warning: null;
    }
  | {
      readonly status: "ready";
      readonly storageMode: DemoWorkspaceStorageMode;
      readonly warning: DemoWorkspaceWarning | null;
    }
  | {
      readonly status: "upgrade_required";
      readonly storageMode: "indexeddb";
      readonly warning: null;
      readonly upgrade: DemoWorkspaceUpgradeRequired;
    };

export interface DemoWorkspaceClock {
  now(): Date;
}

export const systemDemoWorkspaceClock: DemoWorkspaceClock = {
  now: () => new Date(),
};
