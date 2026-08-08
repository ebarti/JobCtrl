import { describe, expect, it, vi } from "vitest";

import { ConsoleTelemetryAdapter } from "../shared/adapters/local/ConsoleTelemetryAdapter.js";
import { FetchApiClientAdapter } from "../shared/adapters/local/FetchApiClientAdapter.js";
import { LocalSessionAdapter } from "../shared/adapters/local/LocalSessionAdapter.js";
import { LocalStorageAdapter } from "../shared/adapters/local/LocalStorageAdapter.js";
import { NavigatorClipboardAdapter } from "../shared/adapters/local/NavigatorClipboardAdapter.js";
import { OpenArtifactAdapter } from "../shared/adapters/local/OpenArtifactAdapter.js";
import { SseEventStreamAdapter } from "../shared/adapters/local/SseEventStreamAdapter.js";
import { StaticFeatureFlagAdapter } from "../shared/adapters/local/StaticFeatureFlagAdapter.js";
import { FakeTelemetryPort } from "../test/testPorts.js";
import type {
  DemoWorkspaceSnapshot,
  DemoWorkspaceStore,
  DemoWorkspaceTransaction,
} from "./workspace/index.js";
import { DemoApiClientAdapter } from "./DemoApiClientAdapter.js";
import {
  DemoWorkspaceStorageError,
  InMemoryDemoWorkspaceStore,
} from "./workspace/index.js";
import {
  createAppComposition,
  createLocalPorts,
  resolveAppMode,
} from "./portFactory.js";
import {
  DemoFeatureFlagAdapter,
  DemoOpenInOsAdapter,
  DemoSessionAdapter,
  DemoStorageAdapter,
} from "./ports.js";
import { DemoWorkspaceEventStreamAdapter } from "./workspace/DemoWorkspaceEventStreamAdapter.js";

class UnavailableWorkspaceStore implements DemoWorkspaceStore {
  readonly storageMode = "indexeddb" as const;

  async readSnapshot(): Promise<DemoWorkspaceSnapshot | null> {
    throw new DemoWorkspaceStorageError("unavailable");
  }

  async readBlob(): Promise<Blob | null> {
    throw new DemoWorkspaceStorageError("unavailable");
  }

  async readAllBlobs(): Promise<ReadonlyMap<string, Blob>> {
    throw new DemoWorkspaceStorageError("unavailable");
  }

  async transact<TResult>(
    _operation: (
      current: DemoWorkspaceSnapshot | null,
      transaction: DemoWorkspaceTransaction,
    ) => TResult,
  ): Promise<TResult> {
    throw new DemoWorkspaceStorageError("unavailable");
  }
}

describe("port factory", () => {
  it("defaults to local and preserves every original local adapter", async () => {
    expect(resolveAppMode(undefined)).toBe("local");
    expect(resolveAppMode("")).toBe("local");
    expect(resolveAppMode("local")).toBe("local");
    expect(resolveAppMode("preview")).toBe("local");

    const direct = createLocalPorts("http://127.0.0.1:8787");
    const composition = await createAppComposition({
      mode: "local",
      apiBaseUrl: "http://127.0.0.1:8787",
    });
    expect(composition.kind).toBe("local");
    expect(direct.api).toBeInstanceOf(FetchApiClientAdapter);
    expect(direct.eventStream).toBeInstanceOf(SseEventStreamAdapter);
    expect(direct.storage).toBeInstanceOf(LocalStorageAdapter);
    expect(direct.session).toBeInstanceOf(LocalSessionAdapter);
    expect(direct.clipboard).toBeInstanceOf(NavigatorClipboardAdapter);
    expect(direct.openInOs).toBeInstanceOf(OpenArtifactAdapter);
    expect(direct.telemetry).toBeInstanceOf(ConsoleTelemetryAdapter);
    expect(direct.featureFlags).toBeInstanceOf(StaticFeatureFlagAdapter);
    expect(direct.featureFlags.get("demoMode", false)).toBe(false);
    expect(composition.ports.api).toBeInstanceOf(FetchApiClientAdapter);
  });

  it("selects demo only explicitly and constructs no product-network, SSE, or host-OS adapter", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const previewOpener = vi.fn(() => ({ close: vi.fn() }));
    const telemetry = new FakeTelemetryPort();
    try {
      expect(resolveAppMode("demo")).toBe("demo");
      const composition = await createAppComposition({
        mode: "demo",
        demoPreviewOpener: previewOpener,
        demoTelemetry: telemetry,
        demoWorkspace: { store: new InMemoryDemoWorkspaceStore() },
      });

      expect(composition.kind).toBe("demo");
      if (composition.kind !== "demo") return;
      expect(composition.ports.api).not.toBeInstanceOf(FetchApiClientAdapter);
      expect(composition.ports.eventStream).toBeInstanceOf(
        DemoWorkspaceEventStreamAdapter,
      );
      expect(composition.ports.eventStream).not.toBeInstanceOf(
        SseEventStreamAdapter,
      );
      expect(composition.ports.session).toBeInstanceOf(DemoSessionAdapter);
      expect(composition.ports.storage).toBeInstanceOf(DemoStorageAdapter);
      expect(composition.ports.openInOs).toBeInstanceOf(DemoOpenInOsAdapter);
      expect(composition.ports.openInOs).not.toBeInstanceOf(
        OpenArtifactAdapter,
      );
      expect(composition.ports.featureFlags).toBeInstanceOf(
        DemoFeatureFlagAdapter,
      );
      expect(composition.ports.featureFlags.get("demoMode", false)).toBe(true);
      expect(composition.ports.telemetry).toBe(telemetry);
      expect(composition.ports.api).toBeInstanceOf(DemoApiClientAdapter);
      await expect(composition.ports.api.health()).resolves.toMatchObject({
        ok: true,
        appDir: "browser-local-demo",
      });
      await expect(
        composition.ports.openInOs.open("artifact-tailored-resume"),
      ).resolves.toMatchObject({
        opened: true,
        path: "/demo/tailored-resume.pdf",
      });
      expect(previewOpener).toHaveBeenCalledWith(
        "/demo/tailored-resume.pdf",
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      composition.dispose();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("falls back to local adapters for an invalid build-time mode", async () => {
    const composition = await createAppComposition({
      mode: resolveAppMode("preview"),
    });
    expect(composition.kind).toBe("local");
    expect(composition.ports.api).toBeInstanceOf(FetchApiClientAdapter);
  });

  it("continues demo initialization in typed tab-local memory mode when IndexedDB is unavailable", async () => {
    const composition = await createAppComposition({
      mode: "demo",
      demoWorkspace: { store: new UnavailableWorkspaceStore() },
    });
    expect(composition).toMatchObject({
      kind: "demo",
      initialization: {
        kind: "ready",
        storageMode: "memory",
        warning: { code: "indexeddb_unavailable" },
      },
    });
  });
});
