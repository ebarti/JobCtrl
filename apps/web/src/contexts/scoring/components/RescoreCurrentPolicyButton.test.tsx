import type { ActionRunResponse } from "@jobctrl/contracts";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { RescoreCurrentPolicyButton, RescoreJobButton } from "./RescoreCurrentPolicyButton.js";

const originalConfirm = globalThis.window?.confirm;

function queued(action: ActionRunResponse["action"], jobKey: string): ActionRunResponse {
  return {
    ok: true,
    runId: `run-${action}`,
    actionId: `action-${action}`,
    action,
    status: "queued",
    jobKey,
    command: { action, jobKey },
  };
}

afterEach(() => {
  if (typeof originalConfirm === "function") {
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: originalConfirm });
  }
});

describe("rescore current-policy buttons", () => {
  it("posts a per-job rescore request after confirmation", async () => {
    const user = userEvent.setup();
    const rescoreJob = vi.fn(async () => queued("rescore_job", "job-1"));
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => true });

    renderWithProviders(<RescoreJobButton jobId="job-1" />, {
      ports: buildTestPorts({ api: { rescoreJob } }),
    });

    const button = screen.getByRole("button", { name: "Rescore current policy" });
    expect(button).toHaveAttribute("data-slot", "button");

    await user.click(button);

    await waitFor(() => expect(rescoreJob).toHaveBeenCalledWith("job-1", { dryRun: false }));
  });

  it("posts a selected bulk rescore request after confirmation", async () => {
    const user = userEvent.setup();
    const rescoreJobsNotOnCurrentScoringPolicy = vi.fn(async () =>
      queued("rescore_jobs_not_on_current_scoring_policy", "pipeline"),
    );
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => true });

    renderWithProviders(
      <RescoreCurrentPolicyButton jobKeys={["job-1", "job-2"]} label="rescore selected" />,
      {
        ports: buildTestPorts({ api: { rescoreJobsNotOnCurrentScoringPolicy } }),
      },
    );

    await user.click(screen.getByRole("button", { name: "rescore selected" }));

    await waitFor(() =>
      expect(rescoreJobsNotOnCurrentScoringPolicy).toHaveBeenCalledWith({
        jobKeys: ["job-1", "job-2"],
        limit: 100,
        dryRun: false,
      }),
    );
  });
});
