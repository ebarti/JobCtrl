import { screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sampleHealthResponse } from "../../test/fixtures/projections.js";
import { renderWithProviders } from "../../test/render.js";
import { FakeEventStreamPort, buildTestPorts } from "../../test/testPorts.js";
import { ConnectionStatusPill } from "./ConnectionStatusPill.js";

function renderConnectionStatusPill({
  health = sampleHealthResponse,
}: {
  health?: typeof sampleHealthResponse;
} = {}) {
  const eventStream = new FakeEventStreamPort();
  const ports = buildTestPorts({
    eventStream,
    api: { health: vi.fn(async () => health) },
  });
  renderWithProviders(<ConnectionStatusPill />, { ports, withEventStream: true });
  return { eventStream };
}

describe("<ConnectionStatusPill>", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders live status with a polite live region", async () => {
    const { eventStream } = renderConnectionStatusPill();

    await waitFor(() => expect(eventStream.subscriptions.length).toBe(1));
    const pill = screen.getByText("live");
    expect(pill).toHaveAttribute("aria-live", "polite");
    expect(pill).toHaveAttribute("data-status", "open");
  });

  it("keeps worker health failures visible as an alert", async () => {
    renderConnectionStatusPill({
      health: {
        ...sampleHealthResponse,
        worker: {
          ...sampleHealthResponse.worker,
          status: "missing",
          message: "No JobHunter automation worker heartbeat has been written to the API database.",
          heartbeat: null,
        },
      },
    });

    const pill = await screen.findByText("worker");
    expect(pill).toHaveAttribute("data-status", "lost");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent("No JobHunter automation worker heartbeat has been written to the API database.");
  });

  it("surfaces long event-stream disconnections as a status banner", async () => {
    const { eventStream } = renderConnectionStatusPill();
    await waitFor(() => expect(eventStream.subscriptions.length).toBe(1));
    vi.useFakeTimers();

    await act(async () => {
      eventStream.setStatus("closed");
    });
    expect(screen.getByText("reconnecting")).toHaveAttribute("data-status", "closed");

    await act(async () => {
      vi.advanceTimersByTime(30_001);
    });

    const pill = screen.getByText("offline");
    expect(pill).toHaveAttribute("data-status", "lost");
    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(banner).toHaveTextContent("Connection lost");
  });
});
