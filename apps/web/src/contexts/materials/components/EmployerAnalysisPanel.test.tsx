import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  degradedEmployerAnalysis,
  emptyEmployerAnalysis,
  populatedEmployerAnalysis,
} from "../../../test/fixtures/materials-inspector.js";
import { EmployerAnalysisPanel } from "./EmployerAnalysisPanel.js";

describe("<EmployerAnalysisPanel>", () => {
  it("renders requirements with tier + importance and quoted evidence spans", () => {
    render(<EmployerAnalysisPanel analysis={populatedEmployerAnalysis} />);

    expect(screen.getByText("Lead platform reliability programs across multiple teams")).toBeInTheDocument();
    expect(screen.getByText("Must Have")).toBeInTheDocument();
    expect(screen.getByText("importance 90%")).toBeInTheDocument();
    expect(
      screen.getByText("Lead our platform reliability initiatives across the engineering org"),
    ).toBeInTheDocument();
    expect(screen.getByText("Nice To Have")).toBeInTheDocument();
    expect(screen.getByText("importance 55%")).toBeInTheDocument();
  });

  it("renders reasoned keywords with evidence spans and flags orphans", () => {
    render(<EmployerAnalysisPanel analysis={populatedEmployerAnalysis} />);

    expect(screen.getByText("platform reliability")).toBeInTheDocument();
    expect(screen.getByText("Kubernetes")).toBeInTheDocument();
    expect(screen.getByText("orphan")).toBeInTheDocument();
    expect(screen.getByText("Named technology with no dedicated requirement.")).toBeInTheDocument();
  });

  it("surfaces a degraded ensemble with the succeeded/attempted ratio and failure", () => {
    render(<EmployerAnalysisPanel analysis={degradedEmployerAnalysis} />);

    expect(screen.getByText("degraded (1/2)")).toBeInTheDocument();
    expect(screen.getByText("codex: timeout after 60s")).toBeInTheDocument();
  });

  it("renders explicit empty states when no requirements/keywords were recorded", () => {
    render(<EmployerAnalysisPanel analysis={emptyEmployerAnalysis} />);

    expect(screen.getByText("No requirements were recorded for this analysis.")).toBeInTheDocument();
    expect(screen.getByText("No reasoned keywords were recorded for this analysis.")).toBeInTheDocument();
  });

  it("renders an explicit not-recorded state when no analysis exists (never blank)", () => {
    render(<EmployerAnalysisPanel analysis={null} />);

    expect(screen.getByText("Employer analysis")).toBeInTheDocument();
    expect(
      screen.getByText(/No employer analysis has been recorded for this job yet/i),
    ).toBeInTheDocument();
  });
});
