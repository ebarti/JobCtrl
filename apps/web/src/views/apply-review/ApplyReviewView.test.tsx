import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { routeTree } from "../../routeTree.gen.js";
import {
  sampleApplicationOutcomes,
  sampleApplyReviewQueue,
} from "../../test/fixtures/projections.js";
import { buildProviderHarness, renderWithProviders } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { ApplyReviewView } from "./ApplyReviewView.js";

describe("<ApplyReviewView>", () => {
  it("renders the review queue with readiness and latest apply context", async () => {
    renderWithProviders(<ApplyReviewView />);

    expect(await screen.findByText("Principal Platform Engineer")).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText(/dry run · succeeded · dry_run/i)).toBeInTheDocument();
    expect(screen.getByText("cover letter missing")).toBeInTheDocument();
    expect(screen.getByText("Recruiter reply indicates an interview request.")).toBeInTheDocument();
  });

  it("records approval without dispatching apply automation", async () => {
    const user = userEvent.setup();
    const decideApplyReview = vi.fn(async () => ({
      ok: true as const,
      decision: {
        decisionId: "decision-1",
        jobKey: "job-2",
        decision: "approve_submit" as const,
        reason: "approved",
        decidedBy: "user",
        decidedAt: "2026-05-06T08:30:00Z",
      },
    }));
    const applyJob = vi.fn();

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          applicationOutcomes: vi.fn(async () => sampleApplicationOutcomes),
          decideApplyReview,
          applyJob,
        },
      }),
    });

    await user.click(await screen.findByRole("button", { name: /approve submit for principal platform engineer/i }));

    await waitFor(() => expect(decideApplyReview).toHaveBeenCalledTimes(1));
    expect(decideApplyReview).toHaveBeenCalledWith(
      "job-2",
      expect.objectContaining({ decision: "approve_submit" }),
    );
    expect(applyJob).not.toHaveBeenCalled();
  });

  it("renders the queue route when outcome prefetch fails", async () => {
    const ports = buildTestPorts({
      api: {
        applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
        applicationOutcomes: vi.fn(async () => {
          throw new Error("outcomes unavailable");
        }),
      },
    });
    const harness = buildProviderHarness({ ports, withEventStream: true });
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/apply-review"] }),
      context: { ports, queryClient: harness.queryClient, tenantId: LOCAL_TENANT },
    });

    render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Principal Platform Engineer")).toBeInTheDocument();
    expect(await screen.findByText("outcomes unavailable")).toBeInTheDocument();
  });
});
