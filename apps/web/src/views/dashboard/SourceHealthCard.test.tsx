import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { SourceHealthCard } from "./SourceHealthCard.js";

describe("SourceHealthCard", () => {
  it("shows the registry name while preserving source quality failures", () => {
    const [source] = sampleDashboardSummary.sourceHealth;
    render(<SourceHealthCard summary={{
      ...sampleDashboardSummary,
      sourceHealth: [{ ...source!, sourceId: "jobspy:linkedin", displayName: "JobStreaming LinkedIn", recommendedState: "quarantined", fullDescriptionSuccessRate: 0 }],
    }} />);

    expect(screen.getByText("JobStreaming LinkedIn")).toBeInTheDocument();
    expect(screen.queryByText("jobspy:linkedin")).not.toBeInTheDocument();
    expect(screen.getByText("quarantined")).toBeInTheDocument();
    expect(screen.getByText(/0% full detail/)).toBeInTheDocument();
  });

  it("renders source quality rates from the dashboard summary", () => {
    render(<SourceHealthCard summary={sampleDashboardSummary} />);

    expect(screen.getByText("Source health")).toBeInTheDocument();
    expect(screen.getByText("greenhouse:acme")).toBeInTheDocument();
    expect(screen.getByText("normal").querySelector("svg")).toHaveClass("tabler-icon-circle-check");
    expect(screen.getByText(/90% active/i)).toBeInTheDocument();
    expect(screen.getByText(/80% apply/i)).toBeInTheDocument();
    expect(screen.getByText(/100% full detail/i)).toBeInTheDocument();
    // The fixture records a robots-disallowed outcome; it surfaces as a badge.
    expect(screen.getByText("robots disallowed")).toBeInTheDocument();
  });

  it("marks quarantined sources as blocked rather than as a generic failure", () => {
    const [source] = sampleDashboardSummary.sourceHealth;
    render(
      <SourceHealthCard
        summary={{
          ...sampleDashboardSummary,
          sourceHealth: [{ ...source!, recommendedState: "quarantined" }],
        }}
      />,
    );

    expect(screen.getByText("quarantined").querySelector("svg")).toHaveClass("tabler-icon-ban");
  });

  it("omits politeness badges when a source has no recorded outcomes", () => {
    const [source] = sampleDashboardSummary.sourceHealth;
    render(
      <SourceHealthCard
        summary={{
          ...sampleDashboardSummary,
          sourceHealth: [
            {
              ...source!,
              politeness: {
                robotsDisallowedCount: 0,
                rateLimitedCount: 0,
                budgetExhaustedCount: 0,
                lastBlockedReason: null,
                lastBlockedAt: null,
              },
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("greenhouse:acme")).toBeInTheDocument();
    expect(screen.queryByText("robots disallowed")).not.toBeInTheDocument();
  });

  it("renders an empty state when no source health exists", () => {
    render(<SourceHealthCard summary={{ ...sampleDashboardSummary, sourceHealth: [] }} />);

    expect(screen.getByText("No source health.")).toBeInTheDocument();
  });
});
