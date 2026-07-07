import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { eventByType } from "../../../test/fixtures/events.js";
import { buildProviderHarness } from "../../../test/render.js";
import { FakeEventStreamPort, buildTestPorts } from "../../../test/testPorts.js";
import { applyRunsKeys } from "../applyRunsKeys.js";
import { jobsKeys } from "../jobsKeys.js";
import { EventStreamProvider, useEventStreamStatus } from "./EventStreamProvider.js";

function StatusProbe() {
  const status = useEventStreamStatus();
  return <span data-testid="status">{status}</span>;
}

describe("<EventStreamProvider>", () => {
  it("subscribes to the event stream port and exposes status", async () => {
    const eventStream = new FakeEventStreamPort();
    const ports = buildTestPorts({ eventStream });
    const harness = buildProviderHarness({ ports });

    const view = render(
      <EventStreamProvider>
        <StatusProbe />
      </EventStreamProvider>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => expect(eventStream.subscriptions.length).toBe(1));
    expect(view.getByTestId("status")).toHaveTextContent("open");
  });

  it("dispatches each event through the invalidation router and patches the cache", async () => {
    const eventStream = new FakeEventStreamPort();
    const ports = buildTestPorts({ eventStream });
    const harness = buildProviderHarness({ ports });

    harness.queryClient.setQueryData(applyRunsKeys.detail(LOCAL_TENANT, "run-1"), {
      events: [],
    });

    render(
      <EventStreamProvider>
        <span>child</span>
      </EventStreamProvider>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => expect(eventStream.subscriptions.length).toBe(1));

    await act(async () => {
      eventStream.emit({
        eventType: eventByType.ApplyRunEventRecorded.eventType,
        tenantId: eventByType.ApplyRunEventRecorded.tenantId,
        payload: eventByType.ApplyRunEventRecorded.payload,
      });
    });

    const cached = harness.queryClient.getQueryData<{ events: unknown[] }>(
      applyRunsKeys.detail(LOCAL_TENANT, "run-1"),
    );
    expect(cached?.events).toHaveLength(1);
  });

  it("logs telemetry for unknown event types instead of throwing", async () => {
    const eventStream = new FakeEventStreamPort();
    const ports = buildTestPorts({ eventStream });
    const harness = buildProviderHarness({ ports });

    render(
      <EventStreamProvider>
        <span>child</span>
      </EventStreamProvider>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => expect(eventStream.subscriptions.length).toBe(1));

    await act(async () => {
      eventStream.emit({
        eventType: "MysteryEvent",
        tenantId: LOCAL_TENANT,
        payload: {},
      });
    });

    const telemetryEvent = ports.telemetry.event as ReturnType<
      typeof import("vitest").vi.fn
    >;
    expect(telemetryEvent).toHaveBeenCalledWith(
      "event-stream.unknown-event",
      expect.objectContaining({ eventType: "MysteryEvent" }),
    );
  });

  it("invalidates all queries on a closed→open reconnection", async () => {
    const eventStream = new FakeEventStreamPort();
    const ports = buildTestPorts({ eventStream });
    const harness = buildProviderHarness({ ports });
    harness.queryClient.setQueryData(jobsKeys.lists(LOCAL_TENANT), {
      ok: true,
      items: [],
      pagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
      sort: { field: "discovered_at", dir: "desc" },
      filter: {},
    });

    render(
      <EventStreamProvider>
        <span>child</span>
      </EventStreamProvider>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => expect(eventStream.subscriptions.length).toBe(1));

    await act(async () => {
      eventStream.setStatus("closed");
    });
    await act(async () => {
      eventStream.setStatus("open");
    });

    await waitFor(() => {
      const state = harness.queryClient.getQueryState(jobsKeys.lists(LOCAL_TENANT));
      expect(state?.isInvalidated).toBe(true);
    });
  });
});
