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
    expect(screen.getByText("https://example.com/protected/job")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /preview greenhouse example/i }));
    expect(await screen.findByText("Product Engineer")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /promote https:\/\/example.com\/careers/i }));
    await user.click(screen.getByRole("button", { name: /mark source greenhouse-example useful/i }));
    await user.click(screen.getByRole("button", { name: /import https:\/\/example.com\/protected\/job/i }));

    await waitFor(() => expect(promoteSourceLocatorCandidate).toHaveBeenCalledTimes(1));
    expect(promoteSourceLocatorCandidate).toHaveBeenCalledWith("candidate-1", {
      reason: "User promoted source locator candidate from product controls.",
    });
    await waitFor(() => expect(recordDiscoveryFeedback).toHaveBeenCalledTimes(1));
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
    await user.click(screen.getByRole("button", { name: /reject https:\/\/example.com\/careers/i }));

    await waitFor(() => expect(rejectSourceLocatorCandidate).toHaveBeenCalledTimes(1));
    expect(rejectSourceLocatorCandidate).toHaveBeenCalledWith("candidate-1", {
      reason: "User rejected source locator candidate from product controls.",
    });
  });
});
