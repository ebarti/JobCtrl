import { LOCAL_TENANT, createApplyRunEventRecorded } from "@jobhunter/domain-types";
import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { applyRunsKeys } from "../../operations/applyRunsKeys.js";
import { EventStreamProvider } from "../../operations/providers/EventStreamProvider.js";
import { buildProviderHarness } from "../../../test/render.js";
import { FakeEventStreamPort, buildTestPorts } from "../../../test/testPorts.js";
import { ApplyRunTimeline, applyRunEventLevelTone } from "./ApplyRunTimeline.js";

describe("<ApplyRunTimeline> + EventStream", () => {
  it("maps event levels into the shared tag tone vocabulary", () => {
    expect(applyRunEventLevelTone("error")).toBe("danger");
    expect(applyRunEventLevelTone("warning")).toBe("warn");
    expect(applyRunEventLevelTone("warn")).toBe("warn");
    expect(applyRunEventLevelTone("debug")).toBe("muted");
    expect(applyRunEventLevelTone("info")).toBe("info");
  });

  it("renders persisted timeline events without roadmap placeholder copy", () => {
    const harness = buildProviderHarness();

    render(
      <ApplyRunTimeline
        runId="run-1"
        events={[
          {
            at: "2026-05-06T08:00:00Z",
            type: "ApplyRunStarted",
            level: "info",
            message: "Apply agent acquired job",
            data: {},
          },
        ]}
      />,
      { wrapper: harness.Wrapper },
    );

    expect(screen.getByText("Apply Run Started")).toBeInTheDocument();
    expect(screen.getByText("Apply agent acquired job")).toBeInTheDocument();
    expect(screen.queryByText(/Phase 5|SSE consumer|landing/i)).not.toBeInTheDocument();
  });

  it("renders an operator-safe empty state when no timeline events exist", () => {
    const harness = buildProviderHarness();

    render(<ApplyRunTimeline runId="run-empty" />, { wrapper: harness.Wrapper });

    expect(screen.getByText("No timeline events recorded for this run.")).toBeInTheDocument();
    expect(screen.queryByText(/Phase 5|SSE consumer|landing/i)).not.toBeInTheDocument();
  });

  it("appends each ApplyRunEventRecorded into the cached apply-run detail", async () => {
    const eventStream = new FakeEventStreamPort();
    const ports = buildTestPorts({ eventStream });
    const harness = buildProviderHarness({ ports });
    harness.queryClient.setQueryData(applyRunsKeys.detail(LOCAL_TENANT, "run-1"), {
      events: [],
    });

    render(
      <EventStreamProvider>
        <ApplyRunTimeline runId="run-1" />
      </EventStreamProvider>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => expect(eventStream.subscriptions.length).toBe(1));
    expect(screen.getByText("No timeline events recorded for this run.")).toBeInTheDocument();

    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        const event = createApplyRunEventRecorded(LOCAL_TENANT, {
          runId: "run-1",
          event: {
            at: new Date(2026, 4, 6, 8, i).toISOString(),
            type: "navigation",
            url: `https://example.com/step/${i}`,
          },
        });
        eventStream.emit({
          eventType: event.eventType,
          tenantId: event.tenantId,
          payload: event.payload,
        });
      });
    }

    await waitFor(() => expect(screen.getAllByText("navigation")).toHaveLength(5));
    expect(screen.queryByText("No timeline events recorded for this run.")).not.toBeInTheDocument();

    const cached = harness.queryClient.getQueryData<{ events: unknown[] }>(
      applyRunsKeys.detail(LOCAL_TENANT, "run-1"),
    );
    expect(cached?.events).toHaveLength(5);
  });

  it("does not append events for a different run id", async () => {
    const eventStream = new FakeEventStreamPort();
    const ports = buildTestPorts({ eventStream });
    const harness = buildProviderHarness({ ports });
    harness.queryClient.setQueryData(applyRunsKeys.detail(LOCAL_TENANT, "run-2"), {
      events: [],
    });

    render(
      <EventStreamProvider>
        <ApplyRunTimeline runId="run-2" />
      </EventStreamProvider>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => expect(eventStream.subscriptions.length).toBe(1));

    await act(async () => {
      const event = createApplyRunEventRecorded(LOCAL_TENANT, {
        runId: "run-1",
        event: { at: "2026-05-06T08:00:00Z", type: "navigation" },
      });
      eventStream.emit({
        eventType: event.eventType,
        tenantId: event.tenantId,
        payload: event.payload,
      });
    });

    const cached = harness.queryClient.getQueryData<{ events: unknown[] }>(
      applyRunsKeys.detail(LOCAL_TENANT, "run-2"),
    );
    expect(cached?.events).toHaveLength(0);
  });
});
