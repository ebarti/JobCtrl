import type { ArtifactTailoringExplanation } from "@jobhunter/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TailoringExplanationSection } from "./TailoringExplanationSection.js";

const keywordOnlyExplanation: ArtifactTailoringExplanation = {
  targetSeniority: null,
  claimMode: null,
  validationMode: null,
  safety: {
    autoApprovableClaimModes: [],
    allowAdjacentAchievementDrafts: null,
    qualityPassed: null,
  },
  keywords: {
    coverageRecorded: true,
    planned: ["Developer Platform", "CI/CD", "AWS"],
    covered: ["Developer Platform", "CI/CD"],
    missing: ["AWS"],
    filtered: {
      planned: [],
      covered: [],
      missing: [],
    },
    counts: {
      planned: 3,
      covered: 2,
      missing: 1,
      displayedPlanned: 3,
      displayedCovered: 2,
      displayedMissing: 1,
      filteredPlanned: 0,
      filteredCovered: 0,
      filteredMissing: 0,
    },
  },
  evidence: {
    requiredIds: [],
    seniorityIds: [],
    representedIds: [],
    missingIds: [],
    verifiedMetricCount: null,
  },
  quality: {
    passed: null,
    errors: ["Tailoring audit metadata incomplete: missing target seniority, claim mode"],
    warnings: [],
    notes: [],
    metricClaims: [],
    repeatedKeywords: [],
  },
  judge: {
    passed: null,
    verdict: null,
    score: null,
    minScore: null,
    issues: [],
    unsupportedClaims: [],
    fabrications: [],
    missingRequiredEvidence: [],
    repairInstructions: [],
  },
  adversarialReview: null,
  reviewFeedback: {
    warningRepairAttempted: null,
    acceptedWithResidualWarnings: null,
    acceptedWarnings: [],
  },
  annotatedChanges: [],
  bulletProvenance: [],
  coverageAudit: null,
  voicePass: null,
  models: {
    candidateModels: [],
    selectedModel: null,
    selectedCandidate: null,
    judgeModel: null,
    attempts: null,
  },
};

describe("<TailoringExplanationSection>", () => {
  it("flags keyword-only explanations as incomplete audit metadata", () => {
    render(<TailoringExplanationSection explanation={keywordOnlyExplanation} />);

    expect(screen.getByText("Tailoring rationale")).toBeInTheDocument();
    expect(screen.getByText("2/3 found in resume")).toBeInTheDocument();
    expect(screen.getByText("Generation audit")).toBeInTheDocument();
    expect(screen.getByText("audit metadata incomplete for this artifact")).toBeInTheDocument();
    expect(screen.getByText("Blocking repair feedback")).toBeInTheDocument();
    expect(screen.getByText("Tailoring audit metadata incomplete: missing target seniority, claim mode")).toBeInTheDocument();
    expect(screen.queryByText("Target seniority")).not.toBeInTheDocument();
    expect(screen.queryByText("Safety checks")).not.toBeInTheDocument();
    expect(screen.queryByText("Generation context")).not.toBeInTheDocument();
    expect(screen.queryByText("Selected model")).not.toBeInTheDocument();
  });

  it("renders an honest not-recorded voice pass and empty provenance (INSPECT-05)", () => {
    render(<TailoringExplanationSection explanation={keywordOnlyExplanation} />);

    expect(screen.getByText("Voice pass")).toBeInTheDocument();
    expect(screen.getByText("No voice pass was recorded for this artifact.")).toBeInTheDocument();
    expect(screen.getByText("Per-bullet provenance")).toBeInTheDocument();
    expect(
      screen.getByText(/No per-bullet provenance was recorded for this artifact/i),
    ).toBeInTheDocument();
  });

  it("labels a voice pass that ran but was not accepted, with its reason (INSPECT-05)", () => {
    const explanation: ArtifactTailoringExplanation = {
      ...keywordOnlyExplanation,
      voicePass: {
        ran: true,
        accepted: false,
        model: "voice-model",
        promptVersion: "voice-v1",
        proxyDelta: { buzzword_density: -0.2 },
        reason: "Voice edit introduced an unsourced metric and was rejected.",
      },
    };
    render(<TailoringExplanationSection explanation={explanation} />);

    expect(screen.getByText("not accepted")).toBeInTheDocument();
    expect(
      screen.getByText("Voice edit introduced an unsourced metric and was rejected."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Buzzword Density: -0.2/)).toBeInTheDocument();
  });
});
