import type {
  ActionRunResponse,
  CancelJobActionRequest,
} from "@jobctrl/contracts";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleDashboardSummary } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { CancelApplyButton } from "./CancelApplyButton.js";

describe("<CancelApplyButton>", () => {
  it("renders the explicit stop label and is enabled by default", () => {
    renderWithProviders(<CancelApplyButton jobId="job-1" runId="run-1" />);
    const button = screen.getByRole("button", {
      name: "Stop application run",
    });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("data-slot", "button");
    expect(button).toHaveAttribute("data-typography", "control");
  });

  it("uses an authoritative job-scoped target without consulting dashboard history", async () => {
    const dashboardSummary = vi.fn(async () => sampleDashboardSummary);
    const cancelJobAction = vi.fn(
      async (
        jobId: string,
        body: CancelJobActionRequest = {},
      ): Promise<ActionRunResponse> => ({
        ok: true,
        runId: body.runId ?? "run-cancel",
        actionId: "action-cancel",
        action: "cancel",
        status: "queued",
        jobKey: jobId,
        command: {
          action: "cancel",
          jobKey: jobId,
          ...(body.runId ? { runId: body.runId } : {}),
        },
      }),
    );

    renderWithProviders(
      <CancelApplyButton jobId="job-1" runId="active-run-older" />,
      { ports: buildTestPorts({ api: { dashboardSummary, cancelJobAction } }) },
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Stop application run" }),
    );

    await waitFor(() =>
      expect(cancelJobAction).toHaveBeenCalledWith("job-1", {
        runId: "active-run-older",
      }),
    );
    expect(dashboardSummary).not.toHaveBeenCalled();
  });

  it("does not offer cancellation when the job has no active apply run", async () => {
    const dashboardSummary = vi.fn(async () => ({
      ...sampleDashboardSummary,
      applyRuns: sampleDashboardSummary.applyRuns.map((run) => ({
        ...run,
        status: "succeeded" as const,
      })),
    }));

    renderWithProviders(<CancelApplyButton jobId="job-1" />, {
      ports: buildTestPorts({ api: { dashboardSummary } }),
    });

    await waitFor(() => expect(dashboardSummary).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("button", { name: "Stop application run" }),
    ).not.toBeInTheDocument();
  });

  it("targets the detected active run when cancellation is available", async () => {
    const cancelJobAction = vi.fn(
      async (
        jobId: string,
        body: CancelJobActionRequest = {},
      ): Promise<ActionRunResponse> => ({
        ok: true,
        runId: body.runId ?? "run-cancel",
        actionId: "action-cancel",
        action: "cancel",
        status: "queued",
        jobKey: jobId,
        command: {
          action: "cancel",
          jobKey: jobId,
          ...(body.runId ? { runId: body.runId } : {}),
        },
      }),
    );

    renderWithProviders(<CancelApplyButton jobId="job-1" />, {
      ports: buildTestPorts({
        api: {
          dashboardSummary: vi.fn(async () => sampleDashboardSummary),
          cancelJobAction,
        },
      }),
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Stop application run" }),
    );

    await waitFor(() =>
      expect(cancelJobAction).toHaveBeenCalledWith("job-1", {
        runId: "run-1",
      }),
    );
  });
});
