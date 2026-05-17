import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { DiscoveryProductControls } from "./DiscoveryProductControls.js";

describe("DiscoveryProductControls", () => {
  it("renders source health, quarantine review, and manual capture queues", async () => {
    renderWithProviders(<DiscoveryProductControls />);

    await screen.findByText("Greenhouse Example");
    expect(screen.getByText("https://example.com/careers")).toBeInTheDocument();
    expect(screen.getByText("Engineering Manager")).toBeInTheDocument();
    expect(
      screen.getByText("https://example.com/protected/job"),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /preview greenhouse example/i }),
    );
    expect(await screen.findByText("Product Engineer")).toBeInTheDocument();
  });

  it("renders readable source details and manual capture reasons", async () => {
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({
        api: {
          discoverySources: vi.fn(async () => ({
            ok: true as const,
            sources: [
              {
                sourceId: "readable-source",
                kind: "employer_careers_page" as const,
                displayName: "Readable Source",
                owner: "user" as const,
                priority: "preferred" as const,
                state: "active" as const,
                policyId: "local:readable-source",
                recommendedState: "trusted" as const,
                lastRunId: "run-1",
                lastRunCompletedAt: "2026-05-15T10:00:00+00:00",
                lastErrorClass: null,
                consecutiveFailures: 0,
                observedJobs: 3,
                newJobs: 2,
                duplicateRate: 0.1,
                activeVerificationRate: 0.8,
                fullDescriptionSuccessRate: 0.7,
                applyUrlSuccessRate: 0.6,
                qualityTrend: "flat" as const,
              },
            ],
          })),
          manualCaptureQueue: vi.fn(async () => ({
            ok: true as const,
            items: [
              {
                itemId: "manual-ambiguous",
                originatingUrl: "https://example.com/jobs/?q={query}",
                sourceId: "example-source",
                reason: "ambiguous_career_system" as const,
                retryContext: { sourceId: "example-source" },
                requiredAt: "2026-05-15T10:00:00+00:00",
                status: "pending" as const,
              },
            ],
          })),
        },
      }),
    });

    await screen.findByText("Readable Source");
    expect(screen.getByLabelText("Source registry summary")).toHaveTextContent(
      "1 active",
    );
    expect(screen.getByTitle("Source type: employer careers page")).toHaveClass(
      "source-meta-chip",
      "info",
    );
    expect(screen.getByTitle("Priority: preferred")).toHaveClass(
      "source-meta-chip",
      "good",
    );
    expect(screen.getByTitle("Recommended state: trusted")).toHaveClass(
      "source-meta-chip",
      "good",
    );
    expect(screen.getByText("3 observed leads · 2 new")).toBeInTheDocument();
    const qualityGrid = screen.getByRole("list", {
      name: "Readable Source quality metrics",
    });
    expect(qualityGrid).toHaveTextContent("Active");
    expect(qualityGrid).toHaveTextContent("80%");
    expect(qualityGrid).toHaveTextContent("Full text");
    expect(qualityGrid).toHaveTextContent("70%");
    expect(screen.getByText(/Unconfirmed careers page/i)).toBeInTheDocument();
    expect(
      screen.getByText(/cannot confirm which careers system/i),
    ).toBeInTheDocument();
  });

  it("records feedback and manual capture actions through the API port", async () => {
    const recordDiscoveryFeedback = vi.fn(async () => ({
      ok: true as const,
      feedbackId: "feedback-1",
      jobKey: "https://example.com/jobs/quarantined",
      sourceId: "greenhouse-example",
      kind: "useful" as const,
      recordedAt: "2026-05-12T10:00:00+00:00",
    }));
    const importManualCapture = vi.fn(async () => ({
      ok: true as const,
      itemId: "manual-1",
      jobKey: "https://example.com/protected/job",
      importedAt: "2026-05-12T10:00:00+00:00",
      provenance: {
        sourceKind: "user_mediated_capture" as const,
        originatingUrl: "https://example.com/protected/job",
        captureMode: "copied_url" as const,
        futureManualActionRequired: false,
      },
    }));
    const promoteSourceLocatorCandidate = vi.fn(async () => ({
      ok: true as const,
      candidateId: "candidate-1",
      decision: "promote" as const,
      source: {
        sourceId: "greenhouse-example",
        kind: "ats_api" as const,
        displayName: "Greenhouse Example",
        owner: "user" as const,
        priority: "canonical" as const,
        state: "experimental" as const,
        policyId: "local:greenhouse-example",
        recommendedState: "normal" as const,
        lastRunId: null,
        lastRunCompletedAt: null,
        lastErrorClass: null,
        consecutiveFailures: 0,
        observedJobs: 0,
        newJobs: 0,
        duplicateRate: null,
        activeVerificationRate: null,
        fullDescriptionSuccessRate: null,
        applyUrlSuccessRate: null,
        qualityTrend: "unknown" as const,
      },
      decidedAt: "2026-05-12T10:00:00+00:00",
    }));
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({
        api: {
          recordDiscoveryFeedback,
          importManualCapture,
          promoteSourceLocatorCandidate,
        },
      }),
    });

    await screen.findByText("Engineering Manager");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: /promote https:\/\/example.com\/careers/i,
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: /mark source greenhouse-example useful/i,
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: /import https:\/\/example.com\/protected\/job/i,
      }),
    );

    await waitFor(() =>
      expect(promoteSourceLocatorCandidate).toHaveBeenCalledTimes(1),
    );
    expect(promoteSourceLocatorCandidate).toHaveBeenCalledWith("candidate-1", {
      reason: "User promoted source locator candidate from product controls.",
    });
    await waitFor(() =>
      expect(recordDiscoveryFeedback).toHaveBeenCalledTimes(1),
    );
    expect(recordDiscoveryFeedback).toHaveBeenCalledWith({
      jobKey: "https://example.com/jobs/quarantined",
      sourceId: "greenhouse-example",
      kind: "useful",
    });
    await waitFor(() => expect(importManualCapture).toHaveBeenCalledTimes(1));
    expect(importManualCapture).toHaveBeenCalledWith("manual-1", {
      captureMode: "copied_url",
      capturedUrl: "https://example.com/protected/job",
      futureManualActionRequired: false,
    });
  });

  it("imports pasted manual capture content with follow-up provenance", async () => {
    const importManualCapture = vi.fn(async () => ({
      ok: true as const,
      itemId: "manual-1",
      jobKey: "https://example.com/protected/job",
      importedAt: "2026-05-12T10:00:00+00:00",
      provenance: {
        sourceKind: "user_mediated_capture" as const,
        originatingUrl: "https://example.com/protected/job",
        captureMode: "pasted_text" as const,
        futureManualActionRequired: true,
      },
    }));
    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({
        api: {
          importManualCapture,
        },
      }),
    });

    await screen.findByText("https://example.com/protected/job");
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByLabelText("Capture mode"),
      "pasted_text",
    );
    await user.type(
      screen.getByLabelText("Pasted text"),
      "Visible user-provided posting text.",
    );
    await user.type(
      screen.getByLabelText("Note"),
      "Captured after local login.",
    );
    await user.click(screen.getByLabelText("Needs manual follow-up"));
    await user.click(
      screen.getByRole("button", {
        name: /import https:\/\/example.com\/protected\/job/i,
      }),
    );

    await waitFor(() => expect(importManualCapture).toHaveBeenCalledTimes(1));
    expect(importManualCapture).toHaveBeenCalledWith("manual-1", {
      captureMode: "pasted_text",
      capturedUrl: "https://example.com/protected/job",
      contentText: "Visible user-provided posting text.",
      note: "Captured after local login.",
      futureManualActionRequired: true,
    });
  });

  it("rejects source locator candidates through the API port", async () => {
    const rejectSourceLocatorCandidate = vi.fn(async () => ({
      ok: true as const,
      candidateId: "candidate-1",
      decision: "reject" as const,
      source: null,
      decidedAt: "2026-05-12T10:00:00+00:00",
    }));

    renderWithProviders(<DiscoveryProductControls />, {
      ports: buildTestPorts({
        api: {
          rejectSourceLocatorCandidate,
        },
      }),
    });

    await screen.findByText("https://example.com/careers");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: /reject https:\/\/example.com\/careers/i,
      }),
    );

    await waitFor(() =>
      expect(rejectSourceLocatorCandidate).toHaveBeenCalledTimes(1),
    );
    expect(rejectSourceLocatorCandidate).toHaveBeenCalledWith("candidate-1", {
      reason: "User rejected source locator candidate from product controls.",
    });
  });
});
