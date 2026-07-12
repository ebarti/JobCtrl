import type { DomainEventUnion } from "@jobctrl/domain-types";
import type { Stage } from "@jobctrl/contracts";

import type { MaterializedDemoSeed } from "../clock.js";
import type {
  DemoExternalRehearsalOperation,
  DemoReceipt,
  DemoReadModel,
  DemoSimulatedAsyncOperation,
} from "../contracts.js";

export const DEMO_WORKSPACE_DATABASE = "jobctrl-demo";
export const DEMO_WORKSPACE_DATABASE_VERSION = 1;
export const DEMO_WORKSPACE_STORE = "workspace";
export const DEMO_BLOBS_STORE = "blobs";
export const DEMO_WORKSPACE_SCHEMA_VERSION = 4;
export const DEMO_WORKSPACE_EVENT_LOG_LIMIT = 128;

export interface DemoLegacyPendingScenario {
  readonly scenarioId: string;
  readonly deadlineAt: string;
  readonly resetEpoch: number;
}

export type DemoScenarioPhase = "queued" | "running";

export interface DemoScenarioTargetRefs {
  readonly jobKey: string | null;
  readonly jobKeys: readonly string[];
  readonly draftId: string | null;
  readonly artifactId: string | null;
  readonly contactId: string | null;
  readonly taskId: string | null;
  readonly threadId: string | null;
  readonly stage: Stage | null;
}

/** Bounded, credential-free command facts needed to recover a scenario. */
export interface DemoScenarioSafeCommand {
  readonly stages: readonly Stage[];
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly allMatching: boolean;
  readonly limit: number | null;
  readonly generation: number | null;
  readonly kind: string | null;
}

export type DemoScenarioOutcome =
  | {
      readonly state: "succeeded";
      readonly summary: string;
    }
  | {
      readonly state: "failed";
      readonly errorCode: string;
      readonly retryable: true;
      readonly summary: string;
    };

export interface DemoScenarioDefinition {
  readonly queuedMessage: string;
  readonly runningMessage: string;
  readonly runningDelayMs: number;
  readonly terminalDelayMs: number;
  readonly outcome: DemoScenarioOutcome;
}

export type DemoScenarioRecoveryInput =
  | { readonly kind: "none" }
  | {
      readonly kind: "resume_render";
      readonly renderFormat: "text" | "html_pdf";
    }
  | {
      readonly kind: "outreach_generate";
      readonly draftKind: "intro_request" | "follow_up";
      readonly applicationRole: string | null;
    }
  | {
      readonly kind: "outreach_revise";
      /** Contract-bounded to 8,000 characters before reaching this adapter. */
      readonly editedBodyText: string;
      readonly draftKind: "intro_request" | "follow_up" | null;
      readonly applicationRole: string | null;
    };

export interface DemoScenarioInvocation extends DemoLegacyPendingScenario {
  readonly invocationVersion: 1;
  readonly operation: DemoSimulatedAsyncOperation;
  readonly phase: DemoScenarioPhase;
  readonly dedupeKey: string;
  readonly runId: string;
  readonly actionId: string;
  readonly attempt: number;
  readonly targetRefs: DemoScenarioTargetRefs;
  readonly safeCommand: DemoScenarioSafeCommand;
  readonly requestedAt: string;
  readonly definition: DemoScenarioDefinition;
  readonly recoveryInput: DemoScenarioRecoveryInput;
}

export type DemoPendingScenario =
  | DemoLegacyPendingScenario
  | DemoScenarioInvocation;

export function isDemoScenarioInvocation(
  pending: DemoPendingScenario,
): pending is DemoScenarioInvocation {
  return "invocationVersion" in pending && pending.invocationVersion === 1;
}

export interface DemoDynamicReceipt {
  readonly receiptId: string;
  readonly kind:
    | "application"
    | "outreach"
    | "discovery"
    | "compensation"
    | "contact_research"
    | "llm"
    | "os_open";
  readonly simulated: true;
  readonly externalEffectOccurred: false;
  readonly recordedAt: string;
  readonly wouldHaveDone: string;
  readonly didNotDo: string;
  readonly operation:
    | DemoExternalRehearsalOperation
    | DemoSimulatedAsyncOperation;
  readonly scenarioId?: string;
  readonly runId?: string;
  readonly entityType:
    | "artifact"
    | "contact"
    | "job"
    | "outreach_thread"
    | "source"
    | "workspace";
  readonly entityId: string;
}

export type DemoWorkspaceReceipt = Omit<DemoReceipt, "recordedAt"> & {
  readonly recordedAt: string;
};

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
    readonly receipts: readonly DemoWorkspaceReceipt[];
  };
  readonly pendingScenarios: readonly DemoPendingScenario[];
}

export type DemoWorkspaceStorageMode = "indexeddb" | "memory";

export type DemoWorkspaceWarning =
  | {
      readonly code: "indexeddb_unavailable";
      readonly message:
        | "Browser storage is unavailable; this tab will not share or retain demo changes."
        | "Browser storage is unavailable; this tab loaded the current synthetic examples in memory only.";
    }
  | {
      readonly code: "quota_exceeded";
      readonly message:
        | "Browser storage is full; this tab preserved the last confirmed demo state in memory only."
        | "Browser storage is full; this tab loaded the current synthetic examples in memory only.";
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
    }
  | {
      readonly kind: "upgrade_required";
      readonly scope: "seed_version";
      readonly foundSeedVersion: string;
      readonly supportedSeedVersion: string;
      readonly message: "This demo workspace seed is not supported by this version. Reload after updating the demo.";
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
