import type { ActionRunResponse, CancelJobActionRequest } from "@jobctrl/contracts";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleDashboardSummary } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { JobActions } from "./JobActions.js";

describe("<JobActions>", () => {
  it("keeps cancel visible for a job-scoped active run beyond 12 newer dashboard rows", async () => {
    const dashboardSummary = vi.fn(async () => ({
      ...sampleDashboardSummary,
      applyRuns: Array.from({ length: 12 }, (_, index) => ({
        ...sampleDashboardSummary.applyRuns[0]!,
        runId: `newer-run-${index}`,
        jobKey: `job-newer-${index}`,
        status: "succeeded" as const,
      })),
    }));
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
      <JobActions
        activeApplyRunId="active-run-older"
        currentStage="apply"
        jobId="job-1"
      />,
      { ports: buildTestPorts({ api: { dashboardSummary, cancelJobAction } }) },
    );

    await userEvent.click(await screen.findByRole("button", { name: /^cancel apply$/i }));

    await waitFor(() =>
      expect(cancelJobAction).toHaveBeenCalledWith("job-1", {
        runId: "active-run-older",
      }),
    );
    expect(dashboardSummary).not.toHaveBeenCalled();
  });

  it("keeps maintenance actions secondary and hides inactive apply cancellation", async () => {
    const dashboardSummary = vi.fn(async () => ({
      ...sampleDashboardSummary,
      applyRuns: [],
    }));

    renderWithProviders(
      <JobActions currentStage="tailor" jobId="job-materials-ready" />,
      {
        ports: buildTestPorts({ api: { dashboardSummary } }),
      },
    );

    const generateMaterials = screen.getByRole("button", {
      name: "generate materials",
    });
    expect(generateMaterials).toHaveClass(
      "border-border",
      "bg-card",
      "text-foreground",
    );
    expect(generateMaterials).not.toHaveClass("bg-primary");

    await waitFor(() => expect(dashboardSummary).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("button", { name: /^cancel apply$/i }),
    ).not.toBeInTheDocument();
  });
});
