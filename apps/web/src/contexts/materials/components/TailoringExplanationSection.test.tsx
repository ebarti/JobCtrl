import type { ArtifactTailoringExplanation } from "@jobctrl/contracts";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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
    declared: [],
    missing: ["AWS"],
    filtered: {
      planned: [],
      covered: [],
      missing: [],
    },
    counts: {
      planned: 3,
      covered: 2,
      declared: 0,
      missing: 1,
      displayedPlanned: 3,
      displayedCovered: 2,
      displayedDeclared: 0,
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
    errors: [
      "Tailoring audit metadata incomplete: missing target seniority, claim mode",
    ],
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
    render(
      <TailoringExplanationSection explanation={keywordOnlyExplanation} />,
    );

    expect(screen.getByText("Tailoring rationale")).toBeInTheDocument();
    expect(screen.getByText("2/3 demonstrated in resume")).toBeInTheDocument();
    expect(screen.getByText("Generation audit")).toBeInTheDocument();
    expect(
      screen.getByText("audit metadata incomplete for this artifact"),
    ).toBeInTheDocument();
    expect(screen.getByText("Blocking repair feedback")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Tailoring audit metadata incomplete: missing target seniority, claim mode",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Target seniority")).not.toBeInTheDocument();
    expect(screen.queryByText("Safety checks")).not.toBeInTheDocument();
    expect(screen.queryByText("Generation context")).not.toBeInTheDocument();
    expect(screen.queryByText("Selected model")).not.toBeInTheDocument();
  });

  it("renders declared-but-not-demonstrated skills in their own honest bucket (A6b)", () => {
    // A skill the user declares in skill_categories renders in the resume's skills
    // line but is not demonstrated in experience/evidence: it must NOT show as
    // "No resume keyword match found" (the lying surface A6b fixes).
    const explanation: ArtifactTailoringExplanation = {
      ...keywordOnlyExplanation,
      keywords: {
        ...keywordOnlyExplanation.keywords,
        planned: ["Developer Platform", "Terraform", "AWS"],
        covered: ["Developer Platform"],
        declared: ["Terraform"],
        missing: ["AWS"],
        counts: {
          ...keywordOnlyExplanation.keywords.counts,
          covered: 1,
          declared: 1,
          missing: 1,
          displayedCovered: 1,
          displayedDeclared: 1,
          displayedMissing: 1,
        },
      },
    };
    render(<TailoringExplanationSection explanation={explanation} />);

    const declaredRow = screen
      .getByText("Declared in skills (not demonstrated)")
      .closest("div");
    expect(declaredRow).not.toBeNull();
    expect(
      within(declaredRow as HTMLElement).getByText("Terraform"),
    ).toBeInTheDocument();

    const missingRow = screen
      .getByText("No resume keyword match found")
      .closest("div");
    expect(
      within(missingRow as HTMLElement).queryByText("Terraform"),
    ).not.toBeInTheDocument();
    expect(
      within(missingRow as HTMLElement).getByText("AWS"),
    ).toBeInTheDocument();
  });

  it("omits the declared bucket entirely when no keyword is declared-only", () => {
    render(
      <TailoringExplanationSection explanation={keywordOnlyExplanation} />,
    );

    expect(
      screen.queryByText("Declared in skills (not demonstrated)"),
    ).not.toBeInTheDocument();
  });

  it("renders human evidence references and keeps unresolved storage keys behind technical details", async () => {
    const user = userEvent.setup();
    const explanation: ArtifactTailoringExplanation = {
      ...keywordOnlyExplanation,
      evidence: {
        ...keywordOnlyExplanation.evidence,
        representedIds: ["ev-platform", "legacy-storage-key"],
      },
    };

    render(
      <TailoringExplanationSection
        explanation={explanation}
        renderEvidenceReference={(reference) => (
          <a href={`/evidence-map?entry=${reference.entryId}`}>
            <strong>{reference.title}</strong>
            {reference.excerpt ? <span>{reference.excerpt}</span> : null}
          </a>
        )}
        resolveEvidenceReference={(evidenceId) =>
          evidenceId === "ev-platform"
            ? {
                entryId: "ev-platform",
                title: "Led a platform reliability transformation",
                excerpt: "Reduced incident response time by 42%.",
              }
            : null
        }
      />,
    );

    expect(
      screen.getByRole("link", {
        name: /Led a platform reliability transformation/i,
      }),
    ).toHaveAttribute("href", "/evidence-map?entry=ev-platform");
    expect(
      screen.getByText("Reduced incident response time by 42%.", {
        selector: "span",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("ev-platform")).not.toBeInTheDocument();
    expect(
      screen.getByText("Evidence reference unavailable."),
    ).toBeInTheDocument();
    expect(screen.queryByText("legacy-storage-key")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Technical details" }));

    expect(screen.getByText("legacy-storage-key")).toBeInTheDocument();
  });

  it("preserves raw audit references for consumers that do not provide a resolver", () => {
    const explanation: ArtifactTailoringExplanation = {
      ...keywordOnlyExplanation,
      evidence: {
        ...keywordOnlyExplanation.evidence,
        representedIds: ["legacy-audit-key"],
      },
    };

    render(<TailoringExplanationSection explanation={explanation} />);

    expect(screen.getByText("legacy-audit-key")).toBeInTheDocument();
    expect(
      screen.queryByText("Evidence reference unavailable."),
    ).not.toBeInTheDocument();
  });

  it("renders an honest not-recorded voice pass and empty provenance (INSPECT-05)", () => {
    render(
      <TailoringExplanationSection explanation={keywordOnlyExplanation} />,
    );

    expect(screen.getByText("Voice pass")).toBeInTheDocument();
    expect(
      screen.getByText("No voice pass was recorded for this artifact."),
    ).toBeInTheDocument();
    expect(screen.getByText("Per-bullet provenance")).toBeInTheDocument();
    expect(
      screen.getByText(
        /No per-bullet provenance was recorded for this artifact/i,
      ),
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
      screen.getByText(
        "Voice edit introduced an unsourced metric and was rejected.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Buzzword Density: -0.2/)).toBeInTheDocument();
  });
});
