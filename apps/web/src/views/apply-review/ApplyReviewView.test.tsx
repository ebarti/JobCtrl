import type { ArtifactTailoringExplanation } from "@jobhunter/contracts";
import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { routeTree } from "../../routeTree.gen.js";
import { sampleApplyReviewQueue, sampleArtifact } from "../../test/fixtures/projections.js";
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

vi.mock("../jobs/JobDetailDrawer.js", () => ({
  JobDetailDrawer: ({
    jobId,
    onClose,
  }: {
    readonly jobId: string;
    readonly onClose: () => void;
  }) => (
    <div aria-label={`Job details for ${jobId}`} role="dialog">
      <button type="button" onClick={onClose}>
        close details
      </button>
    </div>
  ),
}));

const sampleTailoringExplanation: ArtifactTailoringExplanation = {
  targetSeniority: "principal",
  claimMode: "evidence_reframing",
  validationMode: "normal",
  safety: {
    autoApprovableClaimModes: ["verified_only"],
    allowAdjacentAchievementDrafts: false,
    qualityPassed: true,
  },
  keywords: {
    planned: ["platform reliability", "incident response"],
    covered: ["platform reliability"],
    missing: ["incident response"],
  },
  evidence: {
    requiredIds: ["ev_platform_reliability"],
    seniorityIds: ["ev_principal_scope"],
    representedIds: ["ev_platform_reliability"],
    missingIds: [],
    verifiedMetricCount: 2,
  },
  quality: {
    passed: true,
    errors: [],
    warnings: [],
    notes: ["Keyword coverage: 1/2"],
    metricClaims: ["42%"],
    repeatedKeywords: [],
  },
  judge: {
    passed: true,
    verdict: "PASS",
    score: 0.93,
    minScore: 0.84,
    issues: [],
    unsupportedClaims: [],
    fabrications: [],
    missingRequiredEvidence: [],
    repairInstructions: [],
  },
  adversarialReview: {
    ran: true,
    passed: true,
    score: 0.9,
    threshold: 0.8,
    blockers: [],
    warnings: [],
    repairInstructions: [],
    personas: [{ persona: "evidence_auditor", verdict: "PASS", score: 0.91 }],
    skippedReason: null,
  },
  models: {
    candidateModels: ["generator-a"],
    selectedModel: "generator-a",
    selectedCandidate: "candidate-1",
    judgeModel: "judge-a",
    attempts: 2,
  },
};

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
    const detailButton = screen.getByRole("button", {
      name: /Open job detail for Principal Platform Engineer/i,
    });
    expect(detailButton).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open job detail/i })).not.toBeInTheDocument();
    const resumePdf = screen.getByRole("img", { name: "Tailored resume PDF" });
    expect(resumePdf.getAttribute("data-url")).toContain("/v1/artifacts/resume-pdf-2/preview.pdf");
    expect(screen.queryByText("Recruiter reply indicates an interview request.")).not.toBeInTheDocument();
  });

  it("surfaces resume tailoring rationale in the apply review workspace", async () => {
    const artifact = vi.fn(async (artifactId: string) => ({
      ok: true as const,
      artifact: {
        ...sampleArtifact,
        artifactId,
        jobKey: sampleApplyReviewQueue.items[0]!.jobKey,
        title: "Principal Platform Engineer Resume",
        company: sampleApplyReviewQueue.items[0]!.company,
      },
      tailoringExplanation: sampleTailoringExplanation,
    }));

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          artifact,
        },
      }),
    });

    expect(await screen.findByText("Evidence Reframing")).toBeInTheDocument();
    expect(screen.getByText("Principal")).toBeInTheDocument();
    expect(screen.getByText("Why these changes")).toBeInTheDocument();
    expect(screen.getAllByText("platform reliability").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ev_platform_reliability")).toHaveLength(2);
    expect(screen.getByText("93% / minimum 84%")).toBeInTheDocument();
    expect(artifact).toHaveBeenCalledWith("resume-pdf-2");
  });

  it("opens job detail as an in-place overlay", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ApplyReviewView />);

    await user.click(
      await screen.findByRole("button", {
        name: /Open job detail for Principal Platform Engineer/i,
      }),
    );

    expect(
      screen.getByRole("dialog", {
        name: `Job details for ${sampleApplyReviewQueue.items[0]!.jobKey}`,
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "close details" }));

    expect(
      screen.queryByRole("dialog", {
        name: `Job details for ${sampleApplyReviewQueue.items[0]!.jobKey}`,
      }),
    ).not.toBeInTheDocument();
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

    expect(await screen.findByText(/Current decision: Approved for submit/i)).toBeInTheDocument();
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

  it("hides submit approval until a dry run has completed", async () => {
    const noDryRunQueue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              latestApplyRun: null,
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => noDryRunQueue),
        },
      }),
    });

    expect(
      await screen.findByRole("button", {
        name: /Approve dry run for Principal Platform Engineer/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Approve submit for Principal Platform Engineer/i,
      }),
    ).not.toBeInTheDocument();
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

    await user.click(await screen.findByRole("button", { name: /approve submit for principal platform engineer/i }));

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
