import { ConsoleTelemetryAdapter } from "../shared/adapters/local/ConsoleTelemetryAdapter.js";
import { FetchApiClientAdapter } from "../shared/adapters/local/FetchApiClientAdapter.js";
import { LocalSessionAdapter } from "../shared/adapters/local/LocalSessionAdapter.js";
import { LocalStorageAdapter } from "../shared/adapters/local/LocalStorageAdapter.js";
import { NavigatorClipboardAdapter } from "../shared/adapters/local/NavigatorClipboardAdapter.js";
import { OpenArtifactAdapter } from "../shared/adapters/local/OpenArtifactAdapter.js";
import { SseEventStreamAdapter } from "../shared/adapters/local/SseEventStreamAdapter.js";
import { StaticFeatureFlagAdapter } from "../shared/adapters/local/StaticFeatureFlagAdapter.js";
import type { Ports } from "../shared/providers/PortsProvider.js";
import type { AppMode } from "./contracts.js";
import {
  DemoWorkspaceEventStreamAdapter,
  DemoWorkspaceRepository,
  IndexedDbDemoWorkspaceStore,
  type DemoWorkspaceInitialization,
  type DemoWorkspaceRepositoryOptions,
} from "./workspace/index.js";
import {
  createDemoApiClientPlaceholder,
  DemoFeatureFlagAdapter,
  DemoOpenInOsAdapter,
  DemoSessionAdapter,
  DemoStorageAdapter,
} from "./ports.js";

export interface PortFactoryOptions {
  readonly mode: AppMode;
  readonly apiBaseUrl?: string;
  readonly demoWorkspace?: Omit<DemoWorkspaceRepositoryOptions, "store"> & {
    readonly store?: DemoWorkspaceRepositoryOptions["store"];
  };
}

export type AppComposition =
  | {
      readonly kind: "local";
      readonly ports: Ports;
    }
  | {
      readonly kind: "demo";
      readonly ports: Ports;
      readonly workspace: DemoWorkspaceRepository;
      readonly initialization: DemoWorkspaceInitialization;
    };

export function resolveAppMode(value: unknown): AppMode {
  return value === "demo" ? "demo" : "local";
}

/** Preserves the original local composition in one named, directly testable factory. */
export function createLocalPorts(apiBaseUrl = ""): Ports {
  const api = new FetchApiClientAdapter(apiBaseUrl);
  return {
    api,
    eventStream: new SseEventStreamAdapter(apiBaseUrl),
    storage: new LocalStorageAdapter("jh:"),
    session: new LocalSessionAdapter(),
    clipboard: new NavigatorClipboardAdapter(),
    openInOs: new OpenArtifactAdapter(api),
    telemetry: new ConsoleTelemetryAdapter(),
    featureFlags: new StaticFeatureFlagAdapter(),
  };
}

export async function createAppComposition(
  options: PortFactoryOptions,
): Promise<AppComposition> {
  if (options.mode === "local") {
    return { kind: "local", ports: createLocalPorts(options.apiBaseUrl) };
  }

  const workspace = new DemoWorkspaceRepository({
    store: options.demoWorkspace?.store ?? new IndexedDbDemoWorkspaceStore(),
    ...options.demoWorkspace,
  });
  const initialization = await workspace.initialize();
  return {
    kind: "demo",
    ports: {
      api: createDemoApiClientPlaceholder(),
      eventStream: new DemoWorkspaceEventStreamAdapter(workspace),
      storage: new DemoStorageAdapter(),
      session: new DemoSessionAdapter(),
      clipboard: new NavigatorClipboardAdapter(),
      openInOs: new DemoOpenInOsAdapter(),
      telemetry: new ConsoleTelemetryAdapter(),
      featureFlags: new DemoFeatureFlagAdapter(),
    },
    workspace,
    initialization,
  };
}
