import { LOCAL_TENANT, type TenantId } from "@jobctrl/domain-types";
import { QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SseEventStreamAdapter } from "../../../shared/adapters/local/SseEventStreamAdapter.js";
import { PortsProvider } from "../../../shared/providers/PortsProvider.js";
import { TenantProvider } from "../../../shared/providers/TenantProvider.js";
import { eventByType } from "../../../test/fixtures/events.js";
import { createTestQueryClient } from "../../../test/render.js";
import { buildTestPorts, FakeEventStreamPort, FakeSessionPort } from "../../../test/testPorts.js";
import { ApplyRunTimeline } from "../../apply/components/ApplyRunTimeline.js";
import { applyRunsKeys } from "../applyRunsKeys.js";
import { workflowRunsKeys } from "../workflowRunsKeys.js";
import { EventStreamProvider } from "./EventStreamProvider.js";

class ControlledEventSource {
  static instances: ControlledEventSource[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    ControlledEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data?: string): void {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("event stream reconciliation", () => {
  beforeEach(() => {
    ControlledEventSource.instances = [];
    vi.stubGlobal("EventSource", ControlledEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes after error then first open, preserves a pending edit, and bounds repeated opens", async () => {
    const queryClient = createTestQueryClient();
    const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter() });
    const write = deferred<void>();
    let canonical = "initial";
    const read = vi.fn(async () => canonical);
    const save = vi.fn(() => write.promise);

    function View() {
      const [draft, setDraft] = useState("");
      const query = useQuery({ queryKey: ["tenant", LOCAL_TENANT, "probe"], queryFn: read });
      const mutation = useMutation({ mutationFn: save });
      return <>
        <div data-testid="canonical">{query.data}</div>
        <input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button onClick={() => mutation.mutate()}>Save</button>
        <div data-testid="saving">{String(mutation.isPending)}</div>
      </>;
    }

    render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
      <EventStreamProvider><View /></EventStreamProvider>
    </QueryClientProvider></TenantProvider></PortsProvider>);
    await screen.findByText("initial");
    const source = ControlledEventSource.instances[0]!;
    expect(new URL(source.url, "http://localhost").searchParams.has("since")).toBe(false);
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "unsaved edit" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByTestId("saving")).toHaveTextContent("true"));
    canonical = "changed before connection";
    await act(async () => { source.emit("error"); source.emit("open"); });
    await waitFor(() => expect(screen.getByTestId("canonical")).toHaveTextContent(canonical));
    expect(screen.getByLabelText("Draft")).toHaveValue("unsaved edit");
    expect(screen.getByTestId("saving")).toHaveTextContent("true");
    expect(save).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { source.emit("open"); source.emit("heartbeat"); });
    expect(read).toHaveBeenCalledTimes(2);

    canonical = "changed during reconnect";
    await act(async () => { source.emit("error"); source.emit("open"); });
    await waitFor(() => expect(screen.getByTestId("canonical")).toHaveTextContent(canonical));
    expect(read).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("Draft")).toHaveValue("unsaved edit");
    await act(async () => { write.resolve(); await write.promise; });
  });

  it("reconciles an unfinished initial read without rejecting its loader", async () => {
    const queryClient = createTestQueryClient();
    const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter() });
    const first = deferred<string>();
    const fresh = deferred<string>();
    const independent = deferred<string>();
    const independentRead = queryClient.fetchQuery({
      queryKey: ["tenant", LOCAL_TENANT, "independent"],
      queryFn: () => independent.promise,
    });
    const read = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => fresh.promise);
    const key = ["tenant", LOCAL_TENANT, "pending"] as const;
    function View() {
      const query = useQuery({ queryKey: key, queryFn: read });
      return <div data-testid="value">{query.data ?? "loading"}</div>;
    }
    render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
      <EventStreamProvider><View /></EventStreamProvider>
    </QueryClientProvider></TenantProvider></PortsProvider>);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const loader = queryClient.ensureQueryData({ queryKey: key, queryFn: read });
    await act(async () => { ControlledEventSource.instances[0]!.emit("open"); });
    await act(async () => {
      ControlledEventSource.instances[0]!.emit("error");
      ControlledEventSource.instances[0]!.emit("open");
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve("stale"); await first.promise; });
    await expect(loader).resolves.toBe("stale");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => { fresh.resolve("current"); await fresh.promise; });
    await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent("current"));
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("value")).toHaveTextContent("current");
    expect(queryClient.getQueryData(key)).toBe("current");
    independent.resolve("independent result");
    await expect(independentRead).resolves.toBe("independent result");
  });

  it("preserves a first-read failure for its loader and still reconciles the active view", async () => {
    const queryClient = createTestQueryClient();
    const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter() });
    const first = deferred<string>();
    const read = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue("recovered");
    const key = ["tenant", LOCAL_TENANT, "failure"] as const;
    const loader = queryClient.ensureQueryData({ queryKey: key, queryFn: read });
    const loaderAssertion = expect(loader).rejects.toThrow("synthetic read failure");
    function View() {
      const query = useQuery({ queryKey: key, queryFn: read });
      return <div data-testid="failure-value">{query.data ?? "loading"}</div>;
    }
    render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
      <EventStreamProvider><View /></EventStreamProvider>
    </QueryClientProvider></TenantProvider></PortsProvider>);
    await act(async () => { ControlledEventSource.instances[0]!.emit("open"); });
    await act(async () => { first.reject(new Error("synthetic read failure")); await loaderAssertion; });
    await waitFor(() => expect(screen.getByTestId("failure-value")).toHaveTextContent("recovered"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reconciles a port that is already open at subscription", async () => {
    const queryClient = createTestQueryClient();
    const ports = buildTestPorts({ eventStream: new FakeEventStreamPort() });
    const key = ["tenant", LOCAL_TENANT, "cached"] as const;
    queryClient.setQueryData(key, "before connection");
    render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
      <EventStreamProvider><span>view</span></EventStreamProvider>
    </QueryClientProvider></TenantProvider></PortsProvider>);
    await waitFor(() => expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true));
  });

  it("retains live timeline events received during first open and reconnect", async () => {
    const queryClient = createTestQueryClient();
    const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter() });
    const event = eventByType.ApplyRunEventRecorded;
    const key = applyRunsKeys.detail(LOCAL_TENANT, event.payload.runId);
    render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
      <EventStreamProvider><ApplyRunTimeline runId={event.payload.runId} /></EventStreamProvider>
    </QueryClientProvider></TenantProvider></PortsProvider>);
    const source = ControlledEventSource.instances[0]!;
    await act(async () => {
      source.emit("open");
      source.emit(event.eventType, JSON.stringify(event));
    });
    await waitFor(() => expect(queryClient.getQueryData<{ events: unknown[] }>(key)?.events).toHaveLength(1));
    await act(async () => {
      source.emit("error");
      source.emit("open");
      source.emit(event.eventType, JSON.stringify(event));
    });
    await waitFor(() => expect(queryClient.getQueryData<{ events: unknown[] }>(key)?.events).toHaveLength(2));
    const intended = eventByType.ApplySubmitIntended;
    await act(async () => { source.emit(intended.eventType, JSON.stringify(intended)); });
    expect(queryClient.getQueryData<{ events: unknown[] }>(key)?.events).toHaveLength(2);
  });

  it("merges an Apply baseline with a live event that arrives during its refresh", async () => {
    const queryClient = createTestQueryClient();
    const ports = buildTestPorts({ eventStream: new SseEventStreamAdapter() });
    const event = eventByType.ApplyRunEventRecorded;
    const pending = deferred<{ events: unknown[]; applyEvents: unknown[] }>();
    const read = vi.fn().mockResolvedValueOnce({ events: [], applyEvents: [] }).mockImplementationOnce(() => pending.promise);
    function View() {
      const query = useQuery({
        queryKey: workflowRunsKeys.detail(LOCAL_TENANT, event.payload.runId),
        queryFn: read,
      });
      return query.data ? <ApplyRunTimeline runId={event.payload.runId} events={query.data.events} applyEvents={query.data.applyEvents} /> : null;
    }
    render(<PortsProvider ports={ports}><TenantProvider><QueryClientProvider client={queryClient}>
      <EventStreamProvider><View /></EventStreamProvider>
    </QueryClientProvider></TenantProvider></PortsProvider>);
    await screen.findByText("No timeline events recorded for this run.");
    await act(async () => { ControlledEventSource.instances[0]!.emit("open"); });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const live = { ...event, payload: { ...event.payload, event: { event_id: 2, type: "live", message: "Live synthetic event" } } };
    await act(async () => { ControlledEventSource.instances[0]!.emit(live.eventType, JSON.stringify(live)); });
    await screen.findByText("Live synthetic event");
    const missed = { sourceEventId: "11", runEventId: 1, type: "missed", at: null, level: "info", message: "Missed synthetic event" };
    await act(async () => { pending.resolve({ events: [], applyEvents: [missed] }); await pending.promise; });
    await screen.findByText("Missed synthetic event");
    expect(screen.getByText("Live synthetic event")).toBeInTheDocument();
    await act(async () => {
      queryClient.setQueryData(workflowRunsKeys.detail(LOCAL_TENANT, event.payload.runId), {
        events: [], applyEvents: [missed, { sourceEventId: "12", runEventId: 2, type: "live", at: null, level: "info", message: "Live synthetic event" }],
      });
    });
    expect(screen.getAllByText("Live synthetic event")).toHaveLength(1);
  });

  it("scopes reconciliation and event delivery to the current subscription after a tenant switch", async () => {
    const otherTenant = "tenant-b" as TenantId;
    const queryClient = createTestQueryClient();
    const eventStream = new SseEventStreamAdapter();
    const basePorts = buildTestPorts({ eventStream });
    const portsA = { ...basePorts, session: new FakeSessionPort({ tenantId: LOCAL_TENANT, userId: null }) };
    const portsB = { ...basePorts, session: new FakeSessionPort({ tenantId: otherTenant, userId: null }) };
    const otherRead = deferred<string>();
    const otherFetch = queryClient.fetchQuery({ queryKey: ["tenant", otherTenant, "pending"], queryFn: () => otherRead.promise });
    const event = eventByType.ApplyRunEventRecorded;
    const localCanonical = ["tenant", LOCAL_TENANT, "canonical"] as const;
    const otherCanonical = ["tenant", otherTenant, "canonical"] as const;
    queryClient.setQueryData(localCanonical, "local");
    queryClient.setQueryData(otherCanonical, "other");
    queryClient.setQueryData(applyRunsKeys.detail(LOCAL_TENANT, event.payload.runId), { events: [] });
    queryClient.setQueryData(applyRunsKeys.detail(otherTenant, event.payload.runId), { events: [] });
    const mount = (ports: typeof portsA) => <PortsProvider ports={ports}><TenantProvider>
      <QueryClientProvider client={queryClient}><EventStreamProvider><span>view</span></EventStreamProvider></QueryClientProvider>
    </TenantProvider></PortsProvider>;
    const view = render(mount(portsA));
    const firstSource = ControlledEventSource.instances[0]!;
    await act(async () => { firstSource.emit("open"); });
    await waitFor(() => expect(queryClient.getQueryState(localCanonical)?.isInvalidated).toBe(true));
    expect(queryClient.getQueryState(otherCanonical)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["tenant", otherTenant, "pending"])?.fetchStatus).toBe("fetching");
    view.rerender(mount(portsB));
    expect(firstSource.close).toHaveBeenCalledOnce();
    const secondSource = ControlledEventSource.instances[1]!;
    expect(new URL(secondSource.url, "http://localhost").searchParams.get("tenantId")).toBe(otherTenant);
    await act(async () => { firstSource.emit("ApplyRunEventRecorded", JSON.stringify(event)); secondSource.emit("open"); });
    await waitFor(() => expect(queryClient.getQueryState(otherCanonical)?.isInvalidated).toBe(true));
    expect(queryClient.getQueryData<{ events: unknown[] }>(applyRunsKeys.detail(LOCAL_TENANT, event.payload.runId))?.events).toHaveLength(0);
    const otherEvent = { ...event, tenantId: otherTenant };
    await act(async () => { secondSource.emit("ApplyRunEventRecorded", JSON.stringify(otherEvent)); });
    expect(queryClient.getQueryData<{ events: unknown[] }>(applyRunsKeys.detail(otherTenant, event.payload.runId))?.events).toHaveLength(1);
    // A late or malformed envelope cannot write to a different tenant's cache.
    await act(async () => { secondSource.emit("ApplyRunEventRecorded", JSON.stringify(event)); });
    expect(queryClient.getQueryData<{ events: unknown[] }>(applyRunsKeys.detail(LOCAL_TENANT, event.payload.runId))?.events).toHaveLength(0);
    const snakeEvent = { ...otherEvent, payload: { run_id: event.payload.runId, event: event.payload.event } };
    await act(async () => { secondSource.emit("ApplyRunEventRecorded", JSON.stringify(snakeEvent)); });
    expect(queryClient.getQueryData<{ events: unknown[] }>(applyRunsKeys.detail(otherTenant, event.payload.runId))?.events).toHaveLength(2);
    const conflict = { ...otherEvent, payload: { ...event.payload, run_id: "different-run" } };
    await act(async () => { secondSource.emit("ApplyRunEventRecorded", JSON.stringify(conflict)); });
    expect(queryClient.getQueryData<{ events: unknown[] }>(applyRunsKeys.detail(otherTenant, event.payload.runId))?.events).toHaveLength(2);
    otherRead.resolve("other tenant result");
    await expect(otherFetch).resolves.toBe("other tenant result");
  });
});
