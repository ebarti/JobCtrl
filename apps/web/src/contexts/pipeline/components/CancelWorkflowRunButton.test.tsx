import type { ActionRunResponse } from "@jobctrl/contracts";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { CancelWorkflowRunButton } from "./CancelWorkflowRunButton.js";

function cancelResponse(runId: string, status: string): ActionRunResponse {
  return {
    ok: true,
    runId,
    actionId: runId,
    action: "cancel",
    status,
    jobKey: "pipeline",
    command: { action: "cancel", jobKey: "pipeline", runId },
  };
}

describe("<CancelWorkflowRunButton>", () => {
  it("stops propagation and surfaces an accepted cancellation", async () => {
    const user = userEvent.setup();
    const cancelWorkflowRun = vi.fn(async (runId: string) =>
      cancelResponse(runId, "canceling"),
    );
    const parentClick = vi.fn();
    renderWithProviders(
      <div onClick={parentClick}>
        <CancelWorkflowRunButton runId="workflow-run-1" />
      </div>,
      { ports: buildTestPorts({ api: { cancelWorkflowRun } }) },
    );

    const button = screen.getByRole("button", {
      name: "Stop workflow run workflow-run-1",
    });
    expect(button).toHaveAttribute("data-slot", "button");
    expect(button).toHaveAttribute("data-typography", "control");
    await user.click(button);

    expect(await screen.findByText("Cancellation requested")).toBeDisabled();
    expect(cancelWorkflowRun).toHaveBeenCalledWith("workflow-run-1");
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("surfaces an already-terminal cancellation result", async () => {
    const user = userEvent.setup();
    const cancelWorkflowRun = vi.fn(async (runId: string) =>
      cancelResponse(runId, "already_terminal"),
    );
    renderWithProviders(<CancelWorkflowRunButton runId="workflow-run-1" />, {
      ports: buildTestPorts({ api: { cancelWorkflowRun } }),
    });

    await user.click(
      screen.getByRole("button", {
        name: "Stop workflow run workflow-run-1",
      }),
    );

    expect(await screen.findByText("Already finished")).toBeDisabled();
  });

  it("keeps cancellation retryable when the worker is unavailable", async () => {
    const user = userEvent.setup();
    const cancelWorkflowRun = vi.fn(async () => {
      throw new Error("JobCtrl worker is unavailable.");
    });
    renderWithProviders(<CancelWorkflowRunButton runId="workflow-run-1" />, {
      ports: buildTestPorts({ api: { cancelWorkflowRun } }),
    });

    const button = screen.getByRole("button", {
      name: "Stop workflow run workflow-run-1",
    });
    await user.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "JobCtrl worker is unavailable.",
    );
    expect(button).toBeEnabled();
  });

  it("keeps a transport-successful worker failure retryable and visible", async () => {
    const user = userEvent.setup();
    const cancelWorkflowRun = vi.fn(async (runId: string) => ({
      ...cancelResponse(runId, "failed"),
      message: "Temporal cancellation failed.",
    }));
    renderWithProviders(<CancelWorkflowRunButton runId="workflow-run-1" />, {
      ports: buildTestPorts({ api: { cancelWorkflowRun } }),
    });

    const button = screen.getByRole("button", {
      name: "Stop workflow run workflow-run-1",
    });
    await user.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Temporal cancellation failed.",
    );
    expect(button).toBeEnabled();
  });
});
