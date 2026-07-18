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
    const pill = screen.getByText("Live");
    expect(pill).toHaveAttribute("aria-live", "polite");
    expect(pill).toHaveAttribute("data-status", "open");
    expect(pill).toHaveAttribute("data-typography", "status");
    expect(await screen.findByText("LLM $0.12 / $25.00")).toHaveAttribute(
      "data-typography",
      "metadata",
    );
  });

  it("renders unlimited daily LLM budgets in the health line", async () => {
    renderConnectionStatusPill({
      health: {
        ...sampleHealthResponse,
        llmSpend: {
          ...sampleHealthResponse.llmSpend,
          dailyBudgetUsd: 0,
          remainingUsd: null,
          unlimited: true,
          message: "LLM spend is $0.12 / unlimited today.",
        },
      },
    });

    expect(await screen.findByText("LLM $0.12 / unlimited")).toBeInTheDocument();
  });

  it("keeps worker health failures visible as an alert", async () => {
    renderConnectionStatusPill({
      health: {
        ...sampleHealthResponse,
        worker: {
          ...sampleHealthResponse.worker,
          status: "missing",
          message: "No JobCtrl automation worker heartbeat has been written to the API database.",
          heartbeat: null,
        },
      },
    });

    const pill = await screen.findByText("Worker unavailable");
    expect(pill).toHaveAttribute("data-status", "lost");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("data-typography", "body");
    expect(alert).toHaveTextContent("No JobCtrl automation worker heartbeat has been written to the API database.");
  });

  it("surfaces long event-stream disconnections as a status banner", async () => {
    const { eventStream } = renderConnectionStatusPill();
    await waitFor(() => expect(eventStream.subscriptions.length).toBe(1));
    vi.useFakeTimers();

    await act(async () => {
      eventStream.setStatus("closed");
    });
    expect(screen.getByText("Reconnecting")).toHaveAttribute("data-status", "closed");

    await act(async () => {
      vi.advanceTimersByTime(30_001);
    });

    const pill = screen.getByText("Offline");
    expect(pill).toHaveAttribute("data-status", "lost");
    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(banner).toHaveTextContent("Connection lost");
  });
});
