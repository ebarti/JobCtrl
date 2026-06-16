import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  degradedEmployerAnalysis,
  emptyEmployerAnalysis,
  populatedEmployerAnalysis,
  populatedRequirementFitReport,
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

  it("renders each requirement beside canonical requirement fit evidence", () => {
    render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        requirementFitReport={populatedRequirementFitReport}
      />,
    );

    const matched = screen.getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    expect(within(matched).getByText("Requirement fit")).toBeInTheDocument();
    expect(within(matched).getByText("matched")).toBeInTheDocument();
    expect(within(matched).getByText("Score contribution")).toBeInTheDocument();
    expect(within(matched).getByText("1.125 / 1.125 points")).toBeInTheDocument();
    expect(within(matched).getByText("Tailoring directive")).toBeInTheDocument();
    expect(within(matched).getByText("Double Down · priority 90%")).toBeInTheDocument();
    expect(within(matched).getByText("ev-platform")).toBeInTheDocument();
    expect(within(matched).getByText("platform reliability")).toBeInTheDocument();
    expect(within(matched).getByText("Covered · 1 bullet")).toBeInTheDocument();

    const transferable = screen.getByRole("article", {
      name: "Requirement: Experience with Kubernetes-based developer platforms",
    });
    expect(within(transferable).getByText("transferable")).toBeInTheDocument();
    expect(within(transferable).getByText("Bridge Gap · priority 55%")).toBeInTheDocument();
    expect(
      within(transferable).getByText("Kubernetes operations evidence can support adjacent platform experience."),
    ).toBeInTheDocument();
    expect(within(transferable).getByText("owned Kubernetes developer platforms end to end")).toBeInTheDocument();
  });

  it("distinguishes requirement gaps in profile evidence from gaps in the accepted tailored resume", () => {
    const directAssessment = populatedRequirementFitReport.assessments[0]!;
    const transferableAssessment = populatedRequirementFitReport.assessments[1]!;

    render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        requirementFitReport={{
          ...populatedRequirementFitReport,
          assessments: [
            {
              ...directAssessment,
              artifactCoverage: {
                state: "missing_from_resume",
                source: "tailored_resume_bullet_provenance",
                bulletCount: 0,
                examples: [],
              },
            },
            {
              ...transferableAssessment,
              artifactCoverage: {
                state: "missing_from_profile",
                source: "tailored_resume_bullet_provenance",
                bulletCount: 0,
                examples: [],
              },
            },
          ],
        }}
      />,
    );

    const matched = screen.getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    expect(within(matched).getByText("missing from tailored resume · 0 bullets")).toBeInTheDocument();

    const transferable = screen.getByRole("article", {
      name: "Requirement: Experience with Kubernetes-based developer platforms",
    });
    expect(within(transferable).getByText("missing from profile · 0 bullets")).toBeInTheDocument();
  });

  it("falls back to legacy fit-score signals when no requirement fit report exists", () => {
    render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        scoreEvidence={{
          matchedSignals: ["platform reliability"],
          missingSignals: ["Kubernetes-based developer platforms"],
          transferableSignals: ["incident leadership"],
        }}
      />,
    );

    const matched = screen.getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    expect(within(matched).getByText("Legacy score signals")).toBeInTheDocument();
    expect(within(matched).getByText("matched")).toBeInTheDocument();
    expect(within(matched).getByText("Matched score signal")).toBeInTheDocument();
    expect(within(matched).getByText("platform reliability")).toBeInTheDocument();

    const missing = screen.getByRole("article", {
      name: "Requirement: Experience with Kubernetes-based developer platforms",
    });
    expect(within(missing).getByText("not matched")).toBeInTheDocument();
    expect(within(missing).getByText("Missing score signal")).toBeInTheDocument();
    expect(within(missing).getByText("Kubernetes-based developer platforms")).toBeInTheDocument();
  });

  it("shows an honest no-explicit-match state when score evidence has no linked signal", () => {
    render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        scoreEvidence={{ matchedSignals: [], missingSignals: [], transferableSignals: [] }}
      />,
    );

    expect(screen.getAllByText("no explicit match")).toHaveLength(2);
    expect(
      screen.getAllByText("No matched, missing, or transferable score signal was linked to this requirement."),
    ).toHaveLength(2);
  });

  it("links long narrative score signals to requirements through meaningful token overlap", () => {
    render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        scoreEvidence={{
          matchedSignals: [
            "Pioneered self-service internal developer platforms with Kubernetes workflows across engineering teams",
          ],
          missingSignals: [],
          transferableSignals: [],
        }}
      />,
    );

    const platformRequirement = screen.getByRole("article", {
      name: "Requirement: Experience with Kubernetes-based developer platforms",
    });
    expect(within(platformRequirement).getByText("matched")).toBeInTheDocument();
    expect(within(platformRequirement).getByText("Matched score signal")).toBeInTheDocument();
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
    expect(screen.getByText("ensemble divergence")).toBeInTheDocument();
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
