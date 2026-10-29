import { JobCtrlApiError } from "@jobctrl/api-client";
import type {
  TailoringPolicyRevisionListQuery,
  TailoringPolicyRollbackResponse,
} from "@jobctrl/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import {
  sampleLearningRecommendation,
  sampleTailoringPolicyRevisionList,
  sampleTailoringPolicyRollback,
} from "../../../test/fixtures/learning.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { TailoringPolicyHistoryPanel } from "./TailoringPolicyHistoryPanel.js";

describe("TailoringPolicyHistoryPanel", () => {
  it("renders truthful revision status and auditable provenance without axe violations", async () => {
    const view = renderWithProviders(<TailoringPolicyHistoryPanel />, {
      ports: buildTestPorts({
        api: {
          tailoringPolicyRevisions: vi.fn(
            async () => sampleTailoringPolicyRevisionList,
          ),
        },
      }),
    });

    const current = await screen.findByRole("article", { name: "Version 4" });
    const learned = screen.getByRole("article", { name: "Version 3" });
    const configured = screen.getByRole("article", { name: "Version 2" });
    expect(within(current).getByText("Current")).toBeInTheDocument();
    expect(
      within(current).getByText("Restored from version 1"),
    ).toBeInTheDocument();
    expect(
      within(current).getByText("Reason: user requested"),
    ).toBeInTheDocument();
    expect(within(learned).getByText("Superseded")).toBeInTheDocument();
    expect(
      within(learned).getByText("fact_handling → require_source_match"),
    ).toBeInTheDocument();
    expect(
      within(learned).getByText(
        `Accepted recommendation ${sampleLearningRecommendation.recommendationId}`,
      ),
    ).toBeInTheDocument();
    expect(
      within(learned).getByText(/^Review learning-recommendation-review:/),
    ).toBeInTheDocument();
    expect(
      within(configured).getByText(
        "No recommendation or restore provenance recorded.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Restore version 4 of tailoring policy",
      }),
    ).not.toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("pages through every auditable revision", async () => {
    const user = userEvent.setup();
    const tailoringPolicyRevisions = vi.fn(
      async (input: Partial<TailoringPolicyRevisionListQuery>) => ({
        ...sampleTailoringPolicyRevisionList,
        revisions:
          input.page === 2
            ? [sampleTailoringPolicyRevisionList.revisions.at(-1)!]
            : [sampleTailoringPolicyRevisionList.revisions[0]!],
        page: input.page ?? 1,
        total: 101,
        totalPages: 2,
      }),
    );
    renderWithProviders(<TailoringPolicyHistoryPanel />, {
      ports: buildTestPorts({ api: { tailoringPolicyRevisions } }),
    });

    await screen.findByRole("article", { name: "Version 4" });
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next page" }));

    expect(
      await screen.findByRole("article", { name: "Version 1" }),
    ).toBeInTheDocument();
    expect(tailoringPolicyRevisions).toHaveBeenLastCalledWith({
      page: 2,
      pageSize: 100,
    });
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
  });

  it("restores an older version without starting scoring, tailoring, or workflow work", async () => {
    const user = userEvent.setup();
    const rollbackTailoringPolicy = vi.fn(
      async (): Promise<TailoringPolicyRollbackResponse> =>
        sampleTailoringPolicyRollback,
    );
    const rescoreJob = vi.fn();
    const retailorJob = vi.fn();
    const runPipelineStages = vi.fn();
    renderWithProviders(<TailoringPolicyHistoryPanel />, {
      ports: buildTestPorts({
        api: {
          tailoringPolicyRevisions: vi.fn(
            async () => sampleTailoringPolicyRevisionList,
          ),
          rollbackTailoringPolicy,
          rescoreJob,
          retailorJob,
          runPipelineStages,
        },
      }),
    });

    await screen.findByRole("article", { name: "Version 1" });
    await user.click(
      screen.getByRole("button", {
        name: "Restore version 1 of tailoring policy",
      }),
    );

    expect(screen.getByText(/current version 4 → configuration from version 1/i)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Review policy restore" })).getByText(/Reason: user requested/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm restore" }));
    await waitFor(() =>
      expect(rollbackTailoringPolicy).toHaveBeenCalledWith({
        targetVersion: 1, expectedCurrentVersion: 4,
        commandId: expect.any(String), reasonCode: "user_requested",
      }),
    );
    expect(rescoreJob).not.toHaveBeenCalled();
    expect(retailorJob).not.toHaveBeenCalled();
    expect(runPipelineStages).not.toHaveBeenCalled();
  });

  it("surfaces a policy restore failure", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TailoringPolicyHistoryPanel />, {
      ports: buildTestPorts({
        api: {
          tailoringPolicyRevisions: vi.fn(
            async () => sampleTailoringPolicyRevisionList,
          ),
          rollbackTailoringPolicy: vi.fn(async () => {
            throw new JobCtrlApiError(422, "Unprocessable Entity", "The policy restore could not be completed.");
          }),
        },
      }),
    });

    await screen.findByRole("article", { name: "Version 2" });
    await user.click(
      screen.getByRole("button", {
        name: "Restore version 2 of tailoring policy",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Confirm restore" }));
    expect(
      await screen.findByText("Policy restore failed"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The policy restore could not be completed."),
    ).toBeInTheDocument();
  });
  it("keeps a command identity on uncertain failure and creates a new one only after stale review", async () => {
    const user = userEvent.setup();
    const restore = vi.fn()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockRejectedValueOnce(new JobCtrlApiError(409, "Conflict", "stale", { error: "tailoring_policy_stale_review" }))
      .mockResolvedValueOnce(sampleTailoringPolicyRollback);
    renderWithProviders(<TailoringPolicyHistoryPanel />, {
      ports: buildTestPorts({ api: {
        tailoringPolicyRevisions: vi.fn(async () => sampleTailoringPolicyRevisionList),
        rollbackTailoringPolicy: restore,
      } }),
    });
    await screen.findByRole("article", { name: "Version 1" });
    await user.click(screen.getByRole("button", { name: "Restore version 1 of tailoring policy" }));
    await user.click(screen.getByRole("button", { name: "Confirm restore" }));
    expect(await screen.findByText("Policy restore outcome not confirmed")).toBeInTheDocument();
    expect(screen.getByText("The restore may have completed. Retry this request to confirm the result, or check policy history.")).toBeInTheDocument();
    expect(await screen.findByText("Response lost")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm restore" }));
    expect(await screen.findByText("Policy changed since review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm restore" })).not.toBeInTheDocument();
    expect(restore.mock.calls[1]?.[0]).toEqual(restore.mock.calls[0]?.[0]);
    await user.click(screen.getByRole("button", { name: "Restore version 1 of tailoring policy" }));
    await user.click(screen.getByRole("button", { name: "Confirm restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(3));
    expect(restore.mock.calls[2]?.[0].commandId).not.toBe(restore.mock.calls[0]?.[0].commandId);
  });

  it("does not call an uncertain server error a failed restore", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TailoringPolicyHistoryPanel />, {
      ports: buildTestPorts({ api: {
        tailoringPolicyRevisions: vi.fn(async () => sampleTailoringPolicyRevisionList),
        rollbackTailoringPolicy: vi.fn(async () => {
          throw new JobCtrlApiError(500, "Server Error", "Response unavailable", undefined, true);
        }),
      } }),
    });
    await screen.findByRole("article", { name: "Version 1" });
    await user.click(screen.getByRole("button", { name: "Restore version 1 of tailoring policy" }));
    await user.click(screen.getByRole("button", { name: "Confirm restore" }));
    expect(await screen.findByText("Policy restore outcome not confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Policy restore failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm restore" })).toBeEnabled();
  });

});
