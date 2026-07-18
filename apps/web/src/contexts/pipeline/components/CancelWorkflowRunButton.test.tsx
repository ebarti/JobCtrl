import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { CancelWorkflowRunButton } from "./CancelWorkflowRunButton.js";

describe("<CancelWorkflowRunButton>", () => {
  it("stops propagation and cancels the workflow run", async () => {
    const user = userEvent.setup();
    const cancelWorkflowRun = vi.fn(async (runId: string) => ({
      ok: true as const,
      runId,
      actionId: runId,
      action: "cancel" as const,
      status: "cancel_requested",
      jobKey: "pipeline",
      command: { action: "cancel" as const, jobKey: "pipeline", runId },
    }));
    const parentClick = vi.fn();

    renderWithProviders(
      <div onClick={parentClick}>
        <CancelWorkflowRunButton runId="workflow-run-1" label="Stop" />
      </div>,
      { ports: buildTestPorts({ api: { cancelWorkflowRun } }) },
    );

    const button = screen.getByRole("button", {
      name: "Stop workflow run workflow-run-1",
    });
    expect(button).toHaveAttribute("data-slot", "button");
    expect(button).toHaveAttribute("data-typography", "control");

    await user.click(button);

    await waitFor(() => expect(cancelWorkflowRun).toHaveBeenCalledWith("workflow-run-1"));
    expect(parentClick).not.toHaveBeenCalled();
  });
});
