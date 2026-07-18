import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { GenerateInterviewPrepButton } from "./GenerateInterviewPrepButton.js";

const originalConfirm = globalThis.window?.confirm;

afterEach(() => {
  if (typeof originalConfirm === "function") {
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: originalConfirm });
  }
});

describe("<GenerateInterviewPrepButton>", () => {
  it("dispatches interview prep generation after confirmation", async () => {
    const user = userEvent.setup();
    const generateInterviewPrep = vi.fn(async () => ({
      ok: true as const,
      runId: "run-prep",
      actionId: "act-prep",
      action: "generate_interview_prep" as const,
      status: "queued",
      jobKey: "job-1",
      command: { action: "generate_interview_prep" as const, jobKey: "job-1" },
    }));
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => true });

    renderWithProviders(<GenerateInterviewPrepButton jobId="job-1" />, {
      ports: buildTestPorts({ api: { generateInterviewPrep } }),
    });

    await user.click(screen.getByRole("button", { name: "Generate interview prep" }));

    await waitFor(() => expect(generateInterviewPrep).toHaveBeenCalledWith("job-1"));
  });

  it("uses regenerate copy and does not dispatch when confirmation is declined", async () => {
    const user = userEvent.setup();
    const generateInterviewPrep = vi.fn();
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => false });

    renderWithProviders(<GenerateInterviewPrepButton jobId="job-1" hasAcceptedPrep />, {
      ports: buildTestPorts({ api: { generateInterviewPrep } }),
    });

    await user.click(screen.getByRole("button", { name: "Regenerate interview prep" }));

    expect(generateInterviewPrep).not.toHaveBeenCalled();
  });
});
