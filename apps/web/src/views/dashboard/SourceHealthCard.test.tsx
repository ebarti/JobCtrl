import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { SourceHealthCard } from "./SourceHealthCard.js";

describe("SourceHealthCard", () => {
  it("renders source quality rates from the dashboard summary", () => {
    render(<SourceHealthCard summary={sampleDashboardSummary} />);

    expect(screen.getByText("Source health")).toBeInTheDocument();
    expect(screen.getByText("greenhouse:acme")).toBeInTheDocument();
    expect(screen.getByText(/active 90%/i)).toBeInTheDocument();
  });

  it("renders an empty state when no source health exists", () => {
    render(<SourceHealthCard summary={{ ...sampleDashboardSummary, sourceHealth: [] }} />);

    expect(screen.getByText("No source health.")).toBeInTheDocument();
  });
});
