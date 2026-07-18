import { DEFAULT_PIPELINE_LLM_MODEL, type ActionRunResponse } from "@jobctrl/contracts";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { RunJobStageButton } from "./RunJobStageButton.js";

const originalConfirm = globalThis.window?.confirm;

function queued(): ActionRunResponse {
  return {
    ok: true,
    runId: "run-current-stage",
    actionId: "action-current-stage",
    action: "run_stage",
    status: "queued",
    jobKey: "job-1",
    command: { action: "run_stage", jobKey: "job-1" },
  };
}

afterEach(() => {
  if (typeof originalConfirm === "function") {
    Object.defineProperty(window, "confirm", {
      configurable: true,
      writable: true,
      value: originalConfirm,
    });
  }
});

describe("<RunJobStageButton>", () => {
  it("dispatches the current stage after confirmation", async () => {
    const user = userEvent.setup();
    const runJobStage = vi.fn(async () => queued());
    Object.defineProperty(window, "confirm", {
      configurable: true,
      writable: true,
      value: () => true,
    });

    renderWithProviders(
      <RunJobStageButton jobId="job-1" stage="score" />,
      { ports: buildTestPorts({ api: { runJobStage } }) },
    );

    const button = screen.getByRole("button", { name: "Run current stage" });
    expect(button).toHaveAttribute("data-slot", "button");
    expect(button).toHaveAttribute("data-typography", "control");

    await user.click(button);

    await waitFor(() =>
      expect(runJobStage).toHaveBeenCalledWith("job-1", {
        stage: "score",
        dryRun: false,
        limit: 1,
        workers: 1,
        minScore: 7,
        validationMode: "normal",
        llmModel: DEFAULT_PIPELINE_LLM_MODEL,
      }),
    );
  });

  it("does not dispatch when confirmation is declined", async () => {
    const user = userEvent.setup();
    const runJobStage = vi.fn(async () => queued());
    Object.defineProperty(window, "confirm", {
      configurable: true,
      writable: true,
      value: () => false,
    });

    renderWithProviders(
      <RunJobStageButton jobId="job-1" stage="tailor" />,
      { ports: buildTestPorts({ api: { runJobStage } }) },
    );

    await user.click(screen.getByRole("button", { name: "Run current stage" }));

    expect(runJobStage).not.toHaveBeenCalled();
  });

  it("is disabled while its owning stage cannot be started", () => {
    renderWithProviders(
      <RunJobStageButton disabled jobId="job-1" stage="tailor" />,
    );

    expect(
      screen.getByRole("button", { name: "Run current stage" }),
    ).toBeDisabled();
  });
});
