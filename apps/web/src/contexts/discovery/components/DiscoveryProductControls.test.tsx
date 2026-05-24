import { screen, waitFor, within } from "@testing-library/react";
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
    const sourceTable = screen.getByRole("table");
    expect(sourceTable).toHaveTextContent("Type");
    expect(sourceTable).toHaveTextContent("Employer careers page");
    expect(sourceTable).toHaveTextContent("preferred");
    expect(sourceTable).toHaveTextContent("trusted");
    expect(sourceTable).toHaveTextContent("3");
    expect(sourceTable).toHaveTextContent("2");
    expect(sourceTable).toHaveTextContent("80%");
    expect(sourceTable).toHaveTextContent("70%");
    expect(screen.getByText(/Unconfirmed careers page/i)).toBeInTheDocument();
    expect(
      screen.getByText(/cannot confirm which careers system/i),
    ).toBeInTheDocument();
  });

  it("filters active sources by default on the discovery page table and sorts the registry", async () => {
    renderWithProviders(<DiscoveryProductControls layout="tabs" />, {
      ports: buildTestPorts({
        api: {
          discoverySources: vi.fn(async () => ({
            ok: true as const,
            sources: [
              {
                sourceId: "workday:salesforce",
                kind: "ats_api" as const,
                displayName: "Salesforce",
                owner: "system" as const,
                priority: "canonical" as const,
                state: "active" as const,
                policyId: "workday_api_canonical",
                recommendedState: "normal" as const,
                lastRunId: "run-1",
                lastRunCompletedAt: "2026-05-15T10:00:00+00:00",
                lastErrorClass: null,
                consecutiveFailures: 0,
                observedJobs: 3,
                newJobs: 0,
                duplicateRate: null,
                activeVerificationRate: null,
                fullDescriptionSuccessRate: null,
                applyUrlSuccessRate: null,
                qualityTrend: "unknown" as const,
              },
              {
                sourceId: "jobspy:indeed",
                kind: "broad_board" as const,
                displayName: "Indeed",
                owner: "system" as const,
                priority: "fallback" as const,
                state: "active" as const,
                policyId: "jobspy_board",
                recommendedState: "normal" as const,
                lastRunId: "run-2",
                lastRunCompletedAt: "2026-05-16T10:00:00+00:00",
                lastErrorClass: null,
                consecutiveFailures: 0,
                observedJobs: 8,
                newJobs: 1,
                duplicateRate: null,
                activeVerificationRate: null,
                fullDescriptionSuccessRate: null,
                applyUrlSuccessRate: null,
                qualityTrend: "unknown" as const,
              },
              {
                sourceId: "workday:hidden",
                kind: "ats_api" as const,
                displayName: "Hidden Co",
                owner: "system" as const,
                priority: "canonical" as const,
                state: "disabled" as const,
                policyId: "workday_api_canonical",
                recommendedState: "disabled" as const,
                lastRunId: null,
                lastRunCompletedAt: null,
                lastErrorClass: null,
                consecutiveFailures: 0,
                observedJobs: 1,
                newJobs: 0,
                duplicateRate: null,
                activeVerificationRate: null,
                fullDescriptionSuccessRate: null,
                applyUrlSuccessRate: null,
                qualityTrend: "unknown" as const,
              },
            ],
          })),
        },
      }),
    });

    await screen.findByRole("tab", { name: "Source registry" });
    expect(await screen.findByText("Salesforce")).toBeInTheDocument();
    const sourceTable = screen.getByRole("table");
    expect(screen.getAllByText("Workday ATS").length).toBeGreaterThan(0);
    expect(within(sourceTable).queryByText("Provider")).not.toBeInTheDocument();
    expect(within(sourceTable).queryByText("ats api")).not.toBeInTheDocument();
    expect(screen.queryByText("Hidden Co")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /filter company column/i }),
    );
    await user.type(screen.getByLabelText("Company filter text"), "sales");
    expect(within(sourceTable).getByText("Salesforce")).toBeInTheDocument();
    expect(within(sourceTable).queryByText("Indeed")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("Company filter text"));
    await user.click(screen.getByRole("button", { name: /close/i }));

    await user.click(screen.getByRole("button", { name: /sort by observed/i }));
    await user.click(
      screen.getByRole("button", { name: /sort by observed \(ascending\)/i }),
    );

    const rows = within(sourceTable).getAllByRole("row");
    expect(within(rows[1]!).getByText("Indeed")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /filter state column/i }),
    );
    await user.click(screen.getByRole("checkbox", { name: "active" }));
    await waitFor(() => {
      expect(within(sourceTable).getByText("Hidden Co")).toBeInTheDocument();
    });
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
