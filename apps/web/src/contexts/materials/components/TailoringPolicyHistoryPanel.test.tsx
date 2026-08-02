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
        name: "Restore tailoring policy version 4",
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
        name: "Restore tailoring policy version 1",
      }),
    );

    await waitFor(() =>
      expect(rollbackTailoringPolicy).toHaveBeenCalledWith({
        targetVersion: 1,
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
            throw new Error("The policy restore could not be completed.");
          }),
        },
      }),
    });

    await screen.findByRole("article", { name: "Version 2" });
    await user.click(
      screen.getByRole("button", {
        name: "Restore tailoring policy version 2",
      }),
    );

    expect(
      await screen.findByText("Policy restore failed"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The policy restore could not be completed."),
    ).toBeInTheDocument();
  });
});
