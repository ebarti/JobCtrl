import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScoreBreakdown } from "./ScoreBreakdown.js";

describe("<ScoreBreakdown>", () => {
  it("renders typed score dimensions and keywords before legacy reasoning", () => {
    render(
      <ScoreBreakdown
        fitScore={8}
        scoreBreakdown={{
          technicalFit: 9,
          experienceFit: 7,
          roleFit: 8,
          reasoning: "Latest structured score evidence.",
          fitBand: "strong",
          confidence: "high",
          eligibility: { status: "eligible", hardBlockers: [], warnings: [] },
          matchedSignals: ["Python API leadership"],
          missingSignals: ["public company scale"],
          transferableSignals: ["incident leadership"],
        }}
        scoreKeywords={["python", "fastapi"]}
        scoreReasoning="Legacy reasoning should not be the primary path."
        scoreVersion={2}
        scoredAt="2026-05-05T09:30:00+00:00"
        scoreCriteria={{
          minFitScore: 7,
          criteriaText: "Platform reliability.",
          targetCriteria: "Remote leadership.",
          criteriaVersion: "criteria-1",
        }}
      />,
    );

    expect(screen.getByText("8 / 10 fit score")).toBeInTheDocument();
    expect(screen.getByText("Latest structured score evidence.")).toBeInTheDocument();
    expect(screen.queryByText("Legacy reasoning should not be the primary path.")).not.toBeInTheDocument();
    expect(screen.getByText("Technical fit")).toBeInTheDocument();
    expect(screen.getByText("Experience fit")).toBeInTheDocument();
    expect(screen.getByText("Role fit")).toBeInTheDocument();
    expect(screen.getByText("9 / 10")).toBeInTheDocument();
    expect(screen.getByText("7 / 10")).toBeInTheDocument();
    expect(screen.getByText("python")).toBeInTheDocument();
    expect(screen.getByText("fastapi")).toBeInTheDocument();
    expect(screen.getByText("strong")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("Python API leadership")).toBeInTheDocument();
    expect(screen.getByText("public company scale")).toBeInTheDocument();
    expect(screen.getByText("incident leadership")).toBeInTheDocument();
    expect(screen.getByText(/Criteria criteria-1/)).toBeInTheDocument();
    expect(screen.getByText(/version 2/i)).toBeInTheDocument();
    expect(screen.getByText(/2026-05-05/)).toBeInTheDocument();
  });

  it("keeps the legacy scoreReasoning fallback for migrated rows", () => {
    render(
      <ScoreBreakdown
        fitScore={8}
        scoreBreakdown={null}
        scoreKeywords={[]}
        scoreReasoning="Strong legacy fit. keywords: kubernetes, sre"
        scoreVersion={null}
        scoredAt={null}
      />,
    );

    expect(screen.getByText("Strong legacy fit.")).toBeInTheDocument();
    expect(screen.getByText("kubernetes")).toBeInTheDocument();
    expect(screen.getByText("sre")).toBeInTheDocument();
  });
});
