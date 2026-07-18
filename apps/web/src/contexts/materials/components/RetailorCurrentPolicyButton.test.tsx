import type { ActionRunResponse } from "@jobctrl/contracts";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import {
  RetailorCurrentPolicyButton,
  RetailorJobButton,
  TailorJobButton,
} from "./RetailorCurrentPolicyButton.js";

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

describe("re-tailor current-policy buttons", () => {
  it("posts a per-job tailor request after confirmation", async () => {
    const user = userEvent.setup();
    const tailorJob = vi.fn(async () => queued("tailor_job", "job-1"));
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => true });

    renderWithProviders(<TailorJobButton jobId="job-1" />, {
      ports: buildTestPorts({ api: { tailorJob } }),
    });

    await user.click(screen.getByRole("button", { name: "Tailor this job" }));

    await waitFor(() =>
      expect(tailorJob).toHaveBeenCalledWith("job-1", {
        dryRun: false,
        reason: "manual_tailor",
        tailorModels: [],
      }),
    );
  });

  it("posts a per-job re-tailor request after confirmation", async () => {
    const user = userEvent.setup();
    const retailorJob = vi.fn(async () => queued("retailor_job", "job-1"));
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => true });

    renderWithProviders(<RetailorJobButton jobId="job-1" />, {
      ports: buildTestPorts({ api: { retailorJob } }),
    });

    await user.click(screen.getByRole("button", { name: "Re-tailor current policy" }));

    await waitFor(() =>
      expect(retailorJob).toHaveBeenCalledWith("job-1", {
        dryRun: false,
        suppressExistingArtifacts: true,
        tailorModels: [],
      }),
    );
  });

  it("posts a selected bulk re-tailor request after confirmation", async () => {
    const user = userEvent.setup();
    const retailorCurrentPolicy = vi.fn(async () => queued("retailor_current_policy", "pipeline"));
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => true });

    renderWithProviders(
      <RetailorCurrentPolicyButton jobKeys={["job-1"]} label="Re-tailor selected" />,
      {
        ports: buildTestPorts({ api: { retailorCurrentPolicy } }),
      },
    );

    await user.click(screen.getByRole("button", { name: "Re-tailor selected" }));

    await waitFor(() =>
      expect(retailorCurrentPolicy).toHaveBeenCalledWith({
        jobKeys: ["job-1"],
        limit: 100,
        dryRun: false,
        suppressExistingArtifacts: true,
        tailorModels: [],
      }),
    );
  });
});
