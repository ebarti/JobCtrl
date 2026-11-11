import { BrowserRequestIdentityAdapter } from "../shared/adapters/local/BrowserRequestIdentityAdapter.js";
import { BrowserHttpAdapter } from "../shared/adapters/local/BrowserHttpAdapter.js";
import { BrowserProfileTransferAdapter } from "../shared/adapters/local/BrowserProfileTransferAdapter.js";
import { BrowserBlobDownloadAdapter } from "../shared/adapters/local/BrowserBlobDownloadAdapter.js";
import { BrowserSessionStorageAdapter } from "../shared/adapters/local/BrowserSessionStorageAdapter.js";
import { clearLearningDraftsForSession } from "../contexts/learning/index.js";
import { clearSettingsDraftsForSession } from "../contexts/settings/index.js";
import {
  clearSearchPreferencesDraftsForSession,
  clearProfileEditorDraftsForSession,
  clearWordingDraftsForSession,
} from "../contexts/profile/index.js";
import { clearDiscoverySearchSettingsDraftsForSession } from "../contexts/discovery/index.js";
import { clearResumeEditorDraftsForSession } from "../contexts/resumes/index.js";

import { ConsoleTelemetryAdapter } from "../shared/adapters/local/ConsoleTelemetryAdapter.js";
import { LocalSessionAdapter } from "../shared/adapters/local/LocalSessionAdapter.js";
import { LocalStorageAdapter } from "../shared/adapters/local/LocalStorageAdapter.js";
import { NavigatorClipboardAdapter } from "../shared/adapters/local/NavigatorClipboardAdapter.js";
import { BrowserPdfExportAdapter } from "../shared/adapters/local/BrowserPdfExportAdapter.js";
import { SseEventStreamAdapter } from "../shared/adapters/local/SseEventStreamAdapter.js";
import { StaticFeatureFlagAdapter } from "../shared/adapters/local/StaticFeatureFlagAdapter.js";
import type { Ports } from "../shared/providers/PortsProvider.js";
import { DemoApiClientAdapter } from "./DemoApiClientAdapter.js";
import { DemoHttpAdapter } from "./DemoHttpAdapter.js";
import type { DemoArtifactPreviewOpener } from "./DemoExternalRehearsalExecutor.js";
import type { AppMode } from "./contracts.js";
import {
  DemoWorkspaceEventStreamAdapter,
  DemoWorkspaceRepository,
  IndexedDbDemoWorkspaceStore,
  type DemoWorkspaceInitialization,
  type DemoWorkspaceRepositoryOptions,
} from "./workspace/index.js";
import {
  DemoFeatureFlagAdapter,
  DemoSessionAdapter,
  DemoSessionStorageAdapter,
  DemoStorageAdapter,
} from "./ports.js";

export interface PortFactoryOptions {
  readonly mode: AppMode;
  readonly apiBaseUrl?: string;
  readonly demoPreviewOpener?: DemoArtifactPreviewOpener;
  readonly demoTelemetry?: Ports["telemetry"];
  /** Clear only the current demo composition's cache before reset subscribers remount. */
  readonly onDemoWorkspaceReset?: () => void;
  readonly demoWorkspace?: Omit<DemoWorkspaceRepositoryOptions, "store"> & {
    readonly store?: DemoWorkspaceRepositoryOptions["store"];
  };
}

export type AppComposition =
  | {
      readonly kind: "local";
      readonly ports: Ports;
      readonly dispose: () => void;
    }
  | {
      readonly kind: "demo";
      readonly ports: Ports;
      readonly workspace: DemoWorkspaceRepository;
      readonly initialization: DemoWorkspaceInitialization;
      readonly dispose: () => void;
    };

export function resolveAppMode(value: unknown): AppMode {
  return value === "demo" ? "demo" : "local";
}

/** Preserves the original local composition in one named, directly testable factory. */
export function createLocalPorts(apiBaseUrl = ""): Ports {
  return {
    http: new BrowserHttpAdapter(apiBaseUrl),
    blobDownload: new BrowserBlobDownloadAdapter(),
    profileTransfer: new BrowserProfileTransferAdapter(),
    requestIdentity: new BrowserRequestIdentityAdapter(),
    eventStream: new SseEventStreamAdapter(apiBaseUrl),
    storage: new LocalStorageAdapter("jh:"),
    session: new LocalSessionAdapter(),
    sessionStorage: new BrowserSessionStorageAdapter("local"),
    clipboard: new NavigatorClipboardAdapter(),
    pdfExport: new BrowserPdfExportAdapter(),
    telemetry: new ConsoleTelemetryAdapter(),
    featureFlags: new StaticFeatureFlagAdapter(),
  };
}

export async function createAppComposition(
  options: PortFactoryOptions,
): Promise<AppComposition> {
  if (options.mode === "local") {
    return {
      kind: "local",
      ports: createLocalPorts(options.apiBaseUrl),
      dispose: () => undefined,
    };
  }

  const workspace = new DemoWorkspaceRepository({
    store: options.demoWorkspace?.store ?? new IndexedDbDemoWorkspaceStore(),
    ...options.demoWorkspace,
  });
  const initialization = await workspace.initialize();
  const api = new DemoApiClientAdapter(workspace, {
    ...(options.demoTelemetry ? { telemetry: options.demoTelemetry } : {}),
    external: {
      opener: options.demoPreviewOpener ?? browserDemoArtifactPreviewOpener,
    },
  });
  if (initialization.kind === "ready") {
    await api.initialize();
  }
  const storage = new DemoStorageAdapter(workspace);
  const session = new DemoSessionAdapter();
  const sessionStorage = new DemoSessionStorageAdapter();
  let recoveryScope =
    initialization.kind === "ready"
      ? {
          workspaceId: initialization.snapshot.workspaceId,
          resetEpoch: initialization.snapshot.resetEpoch,
        }
      : undefined;
  const syncRecoveryScope = () => {
    if (recoveryScope) {
      sessionStorage.setWorkspaceScope(
        recoveryScope.workspaceId,
        recoveryScope.resetEpoch,
      );
      storage.setWorkspaceScope(
        recoveryScope.workspaceId,
        recoveryScope.resetEpoch,
        workspace.getRuntimeSnapshot().storageMode === "indexeddb",
      );
    }
  };
  syncRecoveryScope();
  const unsubscribeStorage = workspace.subscribe((notification) => {
    if (notification.kind === "reset") {
      options.onDemoWorkspaceReset?.();
      recoveryScope = {
        workspaceId: notification.workspaceId,
        resetEpoch: notification.resetEpoch,
      };
      syncRecoveryScope();
      const tenant = session.getSession().tenantId;
      clearLearningDraftsForSession(session, tenant);
      clearSettingsDraftsForSession(session, tenant);
      clearProfileEditorDraftsForSession(session, tenant);
      clearWordingDraftsForSession(session, tenant);
      clearSearchPreferencesDraftsForSession(session, tenant);
      clearDiscoverySearchSettingsDraftsForSession(session, tenant);
      clearResumeEditorDraftsForSession(session, tenant);
    }
  });
  const unsubscribeRecoveryRuntime =
    workspace.subscribeRuntime(syncRecoveryScope);
  return {
    kind: "demo",
    ports: {
      http: new DemoHttpAdapter(api, workspace),
      places: {
        async search() {
          throw new Error(
            "Place lookup is unavailable in the demo. Your location remains unverified.",
          );
        },
      },
      blobDownload: new BrowserBlobDownloadAdapter(),
      requestIdentity: new BrowserRequestIdentityAdapter(),
      eventStream: new DemoWorkspaceEventStreamAdapter(workspace),
      storage,
      session,
      sessionStorage,
      clipboard: new NavigatorClipboardAdapter(),
      pdfExport: new BrowserPdfExportAdapter(),
      telemetry: options.demoTelemetry ?? new ConsoleTelemetryAdapter(),
      featureFlags: new DemoFeatureFlagAdapter(),
    },
    workspace,
    initialization,
    dispose: () => {
      unsubscribeStorage();
      unsubscribeRecoveryRuntime();
      api.dispose();
      workspace.dispose();
    },
  };
}

const browserDemoArtifactPreviewOpener: DemoArtifactPreviewOpener = (
  previewUrl,
) => {
  if (typeof window === "undefined") return null;
  const popup = window.open(previewUrl, "_blank");
  if (!popup) return null;
  try {
    popup.opener = null;
  } catch {
    // The URL is already restricted to a same-origin bundled demo asset.
  }
  return { close: () => popup.close() };
};
