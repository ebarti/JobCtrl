import { JobCtrlApiClient } from "@jobctrl/api-client";

import { ConsoleTelemetryAdapter } from "../shared/adapters/local/ConsoleTelemetryAdapter.js";
import { LocalSessionAdapter } from "../shared/adapters/local/LocalSessionAdapter.js";
import { LocalStorageAdapter } from "../shared/adapters/local/LocalStorageAdapter.js";
import { NavigatorClipboardAdapter } from "../shared/adapters/local/NavigatorClipboardAdapter.js";
import { OpenArtifactAdapter } from "../shared/adapters/local/OpenArtifactAdapter.js";
import { BrowserPdfExportAdapter } from "../shared/adapters/local/BrowserPdfExportAdapter.js";
import { SseEventStreamAdapter } from "../shared/adapters/local/SseEventStreamAdapter.js";
import { StaticFeatureFlagAdapter } from "../shared/adapters/local/StaticFeatureFlagAdapter.js";
import type { Ports } from "../shared/providers/PortsProvider.js";
import { DemoApiClientAdapter } from "./DemoApiClientAdapter.js";
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
  DemoOpenInOsAdapter,
  DemoSessionAdapter,
  DemoStorageAdapter,
} from "./ports.js";

export interface PortFactoryOptions {
  readonly mode: AppMode;
  readonly apiBaseUrl?: string;
  readonly demoPreviewOpener?: DemoArtifactPreviewOpener;
  readonly demoTelemetry?: Ports["telemetry"];
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
  const api = new JobCtrlApiClient(apiBaseUrl);
  return {
    api,
    eventStream: new SseEventStreamAdapter(apiBaseUrl),
    storage: new LocalStorageAdapter("jh:"),
    session: new LocalSessionAdapter(),
    clipboard: new NavigatorClipboardAdapter(),
    openInOs: new OpenArtifactAdapter(api),
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
  return {
    kind: "demo",
    ports: {
      api,
      eventStream: new DemoWorkspaceEventStreamAdapter(workspace),
      storage: new DemoStorageAdapter(),
      session: new DemoSessionAdapter(),
      clipboard: new NavigatorClipboardAdapter(),
      openInOs: new DemoOpenInOsAdapter(api),
      pdfExport: new BrowserPdfExportAdapter(),
      telemetry: options.demoTelemetry ?? new ConsoleTelemetryAdapter(),
      featureFlags: new DemoFeatureFlagAdapter(),
    },
    workspace,
    initialization,
    dispose: () => {
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
