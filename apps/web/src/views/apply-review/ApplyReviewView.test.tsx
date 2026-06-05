import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { routeTree } from "../../routeTree.gen.js";
import { sampleApplyReviewQueue } from "../../test/fixtures/projections.js";
import { buildProviderHarness, renderWithProviders } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { ApplyReviewView } from "./ApplyReviewView.js";

vi.mock("../../shared/ui/PdfPreviewViewer.js", () => ({
  PdfPreviewViewer: ({ title, url }: { title: string; url: string }) => (
    <div aria-label={title} data-url={url} role="img">
      PDF preview
    </div>
  ),
}));

describe("<ApplyReviewView>", () => {
  it("renders the review workspace with job evidence and tailored materials", async () => {
    renderWithProviders(<ApplyReviewView />);

    expect(await screen.findAllByText("Principal Platform Engineer")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Requirements and original post" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tailored resume and cover" })).toBeInTheDocument();
    expect(screen.getAllByText("materials ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText("platform reliability").length).toBeGreaterThan(0);
    expect(screen.getByText("public company scale")).toBeInTheDocument();
    expect(screen.getByText(/Dry run completed/i)).toBeInTheDocument();
    expect(screen.queryByText(/dry_run/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Globex needs a principal engineer/i)).toBeInTheDocument();
    const detailLink = screen.getByRole("link", {
      name: /Open job detail for Principal Platform Engineer in a new tab/i,
    });
    expect(detailLink).toHaveAttribute("target", "_blank");
    expect(detailLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(detailLink).toHaveAttribute("href", `/jobs/${encodeURIComponent(sampleApplyReviewQueue.items[0]!.jobKey)}`);
    const resumePdf = screen.getByRole("img", { name: "Tailored resume PDF" });
    expect(resumePdf.getAttribute("data-url")).toContain("/v1/artifacts/resume-pdf-2/preview.pdf");
    expect(screen.queryByText("Recruiter reply indicates an interview request.")).not.toBeInTheDocument();
  });

  it("renders non-pending review decisions as user-facing copy", async () => {
    const approvedQueue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              review: {
                state: "approved_submit" as const,
                decision: "approve_submit" as const,
                decidedAt: "2026-05-06T08:30:00Z",
              },
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => approvedQueue),
        },
      }),
    });

    expect(await screen.findByText(/Current decision: Approved when ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/approved_submit/i)).not.toBeInTheDocument();
  });

  it("shows a stop control for the selected in-flight apply run", async () => {
    const runningQueue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              latestApplyRun: {
                runId: "apply-running-1",
                status: "in_progress" as const,
                result: null,
                dryRun: false,
                startedAt: "2026-05-30T06:33:32Z",
                finishedAt: null,
              },
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => runningQueue),
        },
      }),
    });

    expect(
      await screen.findByRole("button", {
        name: /Stop apply run for Principal Platform Engineer/i,
      }),
    ).toBeInTheDocument();
  });

  it("renders the verbatim job post markdown without injecting raw html", async () => {
    const markdownQueue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              position: {
                ...item.position,
                descriptionPreview: [
                  "**Welcome to the good side of tech 👋**",
                  "Build [patient workflows](https://example.com) with `SDLC` discipline.",
                  "",
                  "- Lead engineering teams",
                  "- Improve platform reliability",
                  "",
                  "<script>alert('xss')</script>",
                ].join("\n"),
              },
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => markdownQueue),
        },
      }),
    });

    expect(
      await screen.findByRole("heading", { name: "Welcome to the good side of tech 👋" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "patient workflows" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(screen.getByText("SDLC")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("<script>alert('xss')</script>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });

  it("explains repair status with the latest apply failure reason", async () => {
    const repairQueue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              currentState: "failed" as const,
              latestApplyRun: {
                runId: "submit-failed",
                status: "failed",
                result: "SKIPPED: process killed by signal",
                dryRun: false,
                startedAt: "2026-05-30T06:33:32Z",
                finishedAt: "2026-05-30T06:40:29Z",
              },
              blockers: ["SKIPPED: process killed by signal"],
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => repairQueue),
        },
      }),
    });

    expect((await screen.findAllByText(/Submit failed: process killed by signal/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("submit failed").length).toBeGreaterThan(0);
    expect(screen.getByText(/Last submit failed: process killed by signal/i)).toBeInTheDocument();
    expect(screen.queryByText("needs repair")).not.toBeInTheDocument();
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
          decideApplyReview,
          applyJob,
        },
      }),
    });

    await user.click(await screen.findByRole("button", { name: /approve when ready for principal platform engineer/i }));

    await waitFor(() => expect(decideApplyReview).toHaveBeenCalledTimes(1));
    expect(decideApplyReview).toHaveBeenCalledWith(
      "job-2",
      expect.objectContaining({ decision: "approve_submit" }),
    );
    expect(applyJob).not.toHaveBeenCalled();
  });

  it("does not depend on outcome suggestions to render the queue route", async () => {
    const applicationOutcomes = vi.fn(async () => {
      throw new Error("outcomes unavailable");
    });
    const ports = buildTestPorts({
      api: {
        applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
        applicationOutcomes,
      },
    });
    const harness = buildProviderHarness({ ports, withEventStream: true });
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/apply-review"] }),
      context: { ports, queryClient: harness.queryClient, tenantId: LOCAL_TENANT },
    });

    render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });

    expect(await screen.findAllByText("Principal Platform Engineer")).toHaveLength(2);
    expect(screen.queryByText("outcomes unavailable")).not.toBeInTheDocument();
    expect(applicationOutcomes).not.toHaveBeenCalled();
  });
});
