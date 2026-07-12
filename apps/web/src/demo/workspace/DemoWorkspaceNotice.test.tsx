import { act, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { LocalModeCard } from "../../shared/layout/SideRail.js";
import { DemoWorkspaceNotice } from "./DemoWorkspaceNotice.js";
import { DemoWorkspaceProvider } from "./DemoWorkspaceProvider.js";
import { DemoWorkspaceRepository } from "./DemoWorkspaceRepository.js";
import {
  DemoWorkspaceStorageError,
  InMemoryDemoWorkspaceStore,
  type DemoWorkspaceStore,
  type DemoWorkspaceTransaction,
} from "./storage.js";
import type { DemoWorkspaceSnapshot } from "./contracts.js";

class QuotaStore implements DemoWorkspaceStore {
  readonly storageMode = "indexeddb" as const;
  readonly memory = new InMemoryDemoWorkspaceStore();
  failNext: "quota" | "unavailable" | null = null;

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
      const failure = this.failNext;
      this.failNext = null;
      return Promise.reject(new DemoWorkspaceStorageError(failure));
    }
    return this.memory.transact(operation);
  }
}

describe("<DemoWorkspaceNotice>", () => {
  it("always explains browser-profile sharing and personal-data boundaries in demo mode", async () => {
    const workspace = new DemoWorkspaceRepository({
      store: new QuotaStore(),
      createWorkspaceId: () => "notice-workspace",
    });
    await workspace.initialize();
    const view = render(
      <DemoWorkspaceProvider workspace={workspace}>
        <DemoWorkspaceNotice />
        <LocalModeCard />
      </DemoWorkspaceProvider>,
    );

    expect(
      screen.getByRole("status", { name: "Public demo data boundary" }),
    ).toHaveTextContent(
      "shared with other tabs and people using this browser profile",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Do not enter personal data or secrets",
    );
    expect(
      screen.getByText("Demo mode — shared browser profile"),
    ).toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("reacts immediately when a later quota failure switches the tab to memory", async () => {
    const store = new QuotaStore();
    const workspace = new DemoWorkspaceRepository({
      store,
      createWorkspaceId: () => "quota-workspace",
    });
    await workspace.initialize();
    render(
      <DemoWorkspaceProvider workspace={workspace}>
        <DemoWorkspaceNotice />
        <LocalModeCard />
      </DemoWorkspaceProvider>,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    store.failNext = "quota";
    await act(async () => {
      await workspace.mutate(() => undefined);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Browser storage is full",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "stays only in this tab and is not shared",
    );
    expect(screen.getByText("Demo mode — this tab only")).toBeInTheDocument();
    expect(workspace.getRuntimeSnapshot()).toMatchObject({
      status: "ready",
      storageMode: "memory",
      warning: { code: "quota_exceeded" },
    });
  });

  it("reacts when a later browser security failure switches the tab to memory", async () => {
    const store = new QuotaStore();
    const workspace = new DemoWorkspaceRepository({
      store,
      createWorkspaceId: () => "security-workspace",
    });
    await workspace.initialize();
    render(
      <DemoWorkspaceProvider workspace={workspace}>
        <DemoWorkspaceNotice />
      </DemoWorkspaceProvider>,
    );

    store.failNext = "unavailable";
    await act(async () => {
      await workspace.mutate(() => undefined);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Browser storage is unavailable",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "stays only in this tab and is not shared",
    );
    expect(workspace.getRuntimeSnapshot()).toMatchObject({
      status: "ready",
      storageMode: "memory",
      warning: { code: "indexeddb_unavailable" },
    });
  });
});
