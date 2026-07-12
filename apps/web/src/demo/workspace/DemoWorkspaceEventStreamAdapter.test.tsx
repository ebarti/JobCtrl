import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createJobUpdated,
  LOCAL_TENANT,
  type DomainEventUnion,
} from "@jobctrl/domain-types";

import { EventStreamProvider } from "../../contexts/operations/providers/EventStreamProvider.js";
import { jobsKeys } from "../../contexts/operations/jobsKeys.js";
import { buildProviderHarness } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { DEMO_WORKSPACE_EVENT_LOG_LIMIT } from "./contracts.js";
import { DemoWorkspaceEventStreamAdapter } from "./DemoWorkspaceEventStreamAdapter.js";
import { DemoWorkspaceRepository } from "./DemoWorkspaceRepository.js";
import {
  InMemoryDemoWorkspaceStore,
  type DemoWorkspaceStore,
  type DemoWorkspaceTransaction,
} from "./storage.js";
import type { DemoWorkspaceSnapshot } from "./contracts.js";

class ControlledStore implements DemoWorkspaceStore {
  readonly storageMode = "indexeddb" as const;
  private readonly memory = new InMemoryDemoWorkspaceStore();
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

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
    const gate = this.gate;
    this.gate = null;
    return gate
      ? gate.then(() => this.memory.transact(operation))
      : this.memory.transact(operation);
  }

  deferNextTransaction(): void {
    this.gate = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate?.();
    this.releaseGate = null;
  }
}

function createWorkspace(store: DemoWorkspaceStore = new ControlledStore()) {
  return new DemoWorkspaceRepository({
    store,
    channelFactory: { create: () => null },
    createWorkspaceId: () => "event-workspace",
  });
}

function event(index: number): DomainEventUnion {
  return createJobUpdated(LOCAL_TENANT, {
    jobId: `job-${index}`,
    changedFields: { title: `Title ${index}` },
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("DemoWorkspaceEventStreamAdapter", () => {
  it("serializes rapid revisions and emits each triggering committed sequence in order", async () => {
    const workspace = createWorkspace();
    await workspace.initialize();
    const adapter = new DemoWorkspaceEventStreamAdapter(workspace);
    const subscription = adapter.subscribe({ tenantId: LOCAL_TENANT });
    const received: string[] = [];
    subscription.on((envelope) =>
      received.push(String((envelope.payload as { jobId: string }).jobId)),
    );

    await Promise.all([
      workspace.mutate((_draft, context) =>
        context.appendDomainEvent(event(1)),
      ),
      workspace.mutate((_draft, context) =>
        context.appendDomainEvent(event(2)),
      ),
    ]);
    await settle();

    expect(received).toEqual(["job-1", "job-2"]);
    subscription.close();
  });

  it("never emits a domain event before its transaction commits", async () => {
    const store = new ControlledStore();
    const workspace = createWorkspace(store);
    await workspace.initialize();
    const adapter = new DemoWorkspaceEventStreamAdapter(workspace);
    const subscription = adapter.subscribe({ tenantId: LOCAL_TENANT });
    const received: string[] = [];
    subscription.on((envelope) => received.push(envelope.eventType));

    store.deferNextTransaction();
    const pending = workspace.mutate((_draft, context) =>
      context.appendDomainEvent(event(1)),
    );
    await Promise.resolve();
    expect(received).toEqual([]);
    store.release();
    await pending;
    await settle();
    expect(received).toEqual(["JobUpdated"]);
    subscription.close();
  });

  it("cycles closed to open on reset and bounded event-log loss", async () => {
    const workspace = createWorkspace();
    await workspace.initialize();
    const adapter = new DemoWorkspaceEventStreamAdapter(workspace);
    const subscription = adapter.subscribe({ tenantId: LOCAL_TENANT });
    const statuses: string[] = [];
    subscription.onStatusChange((status) => statuses.push(status));
    await settle();

    await workspace.reset();
    await settle();
    expect(statuses).toContain("closed");
    expect(statuses.at(-1)).toBe("open");

    statuses.length = 0;
    await workspace.mutate((_draft, context) => {
      for (
        let index = 1;
        index <= DEMO_WORKSPACE_EVENT_LOG_LIMIT + 1;
        index += 1
      ) {
        context.appendDomainEvent(event(index));
      }
    });
    await settle();
    expect(statuses).toEqual(["closed", "open"]);
    subscription.close();
  });

  it("uses the unchanged provider/router for event invalidation and reconnect broad invalidation", async () => {
    const workspace = createWorkspace();
    await workspace.initialize();
    const eventStream = new DemoWorkspaceEventStreamAdapter(workspace);
    const ports = buildTestPorts({ eventStream });
    const harness = buildProviderHarness({ ports });
    const unrelatedKey = ["unrelated-demo-query"] as const;
    harness.queryClient.setQueryData(jobsKeys.lists(LOCAL_TENANT), {
      items: [],
    });
    harness.queryClient.setQueryData(unrelatedKey, { retained: true });
    render(
      <EventStreamProvider>
        <span>child</span>
      </EventStreamProvider>,
      { wrapper: harness.Wrapper },
    );
    await waitFor(() => expect(eventStream.status).toBe("open"));

    await act(async () => {
      await workspace.mutate((draft) => {
        (draft.state as { title: string }).title = "No domain event";
      });
    });
    await settle();
    expect(
      harness.queryClient.getQueryState(jobsKeys.lists(LOCAL_TENANT))
        ?.isInvalidated,
    ).toBe(false);
    expect(harness.queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(
      false,
    );

    await act(async () => {
      await workspace.mutate((_draft, context) =>
        context.appendDomainEvent(event(1)),
      );
    });
    await waitFor(() =>
      expect(
        harness.queryClient.getQueryState(jobsKeys.lists(LOCAL_TENANT))
          ?.isInvalidated,
      ).toBe(true),
    );

    harness.queryClient.setQueryData(unrelatedKey, { retained: true });
    await act(async () => {
      await workspace.reset();
    });
    await waitFor(() =>
      expect(
        harness.queryClient.getQueryState(unrelatedKey)?.isInvalidated,
      ).toBe(true),
    );
  });
});
