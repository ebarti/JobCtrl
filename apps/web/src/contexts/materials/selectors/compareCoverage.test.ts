import { describe, expect, it } from "vitest";

import {
  makeArtifactDetail,
  makeArtifactTailoringExplanation,
  makeCoverageAudit,
  sampleAcceptedResumeArtifact,
  sampleDraftResumeArtifact,
} from "../../../test/fixtures/projections.js";
import { compareArtifactCoverage } from "./compareCoverage.js";

describe("compareArtifactCoverage", () => {
  it("computes exact coverage set differences from recorded coverage audits", () => {
    const accepted = makeArtifactDetail(
      sampleAcceptedResumeArtifact,
      makeArtifactTailoringExplanation(
        makeCoverageAudit({
          covered: ["platform reliability", "typescript"],
          missing: ["incident response", "kubernetes"],
        }),
      ),
    );
    const draft = makeArtifactDetail(
      sampleDraftResumeArtifact,
      makeArtifactTailoringExplanation(
        makeCoverageAudit({
          covered: ["platform reliability", "incident response"],
          missing: ["kubernetes", "typescript"],
        }),
      ),
    );

    const comparison = compareArtifactCoverage(accepted, draft);

    expect(comparison.coverageDelta).toMatchObject({
      coverageRecorded: true,
      state: "recorded",
      newlyCovered: ["incident response"],
      coverageLost: ["typescript"],
      stillMissing: ["kubernetes"],
    });
  });

  it("keeps declared-only coverage in its own comparison bucket", () => {
    const accepted = makeArtifactDetail(
      sampleAcceptedResumeArtifact,
      makeArtifactTailoringExplanation(
        makeCoverageAudit({
          covered: ["typescript"],
          declared: ["terraform", "gcp"],
          missing: ["incident response", "kubernetes"],
        }),
      ),
    );
    const draft = makeArtifactDetail(
      sampleDraftResumeArtifact,
      makeArtifactTailoringExplanation(
        makeCoverageAudit({
          covered: ["incident response", "terraform"],
          declared: ["kubernetes", "gcp"],
          missing: ["typescript"],
        }),
      ),
    );

    const comparison = compareArtifactCoverage(accepted, draft);

    expect(comparison.coverageDelta).toMatchObject({
      coverageRecorded: true,
      state: "recorded",
      newlyCovered: ["incident response", "terraform"],
      coverageLost: ["typescript"],
      newlyDeclared: ["kubernetes"],
      declaredLost: ["terraform"],
      stillDeclared: ["gcp"],
      stillMissing: [],
    });
    expect(comparison.left.coverageCounts).toMatchObject({ declared: 2 });
    expect(comparison.right.coverageCounts).toMatchObject({ declared: 2 });
  });

  it("keeps coverage absent instead of treating missing coverage rows as zero coverage", () => {
    const accepted = makeArtifactDetail(
      sampleAcceptedResumeArtifact,
      makeArtifactTailoringExplanation(makeCoverageAudit()),
    );
    const draft = makeArtifactDetail(
      sampleDraftResumeArtifact,
      makeArtifactTailoringExplanation(null),
    );

    const comparison = compareArtifactCoverage(accepted, draft);

    expect(comparison.right.coverageRecorded).toBe(false);
    expect(comparison.right.coverageCounts).toBeNull();
    expect(comparison.coverageDelta).toEqual({
      coverageRecorded: false,
      state: "right_not_recorded",
      computedAgainst: null,
      newlyCovered: [],
      coverageLost: [],
      newlyDeclared: [],
      declaredLost: [],
      stillDeclared: [],
      stillMissing: [],
    });
  });

  it("surfaces template identity for template comparisons", () => {
    const accepted = makeArtifactDetail(
      sampleAcceptedResumeArtifact,
      makeArtifactTailoringExplanation(makeCoverageAudit()),
    );
    const draft = makeArtifactDetail(
      sampleDraftResumeArtifact,
      makeArtifactTailoringExplanation(makeCoverageAudit()),
    );

    const comparison = compareArtifactCoverage(accepted, draft);

    expect(comparison.left.templateId).toBe("classic");
    expect(comparison.left.templateName).toBe("Classic");
    expect(comparison.right.templateId).toBe("compact");
    expect(comparison.right.templateName).toBe("Compact");
  });

  it("deduplicates recorded risk labels without synthesizing them", () => {
    const comparison = compareArtifactCoverage(
      makeArtifactDetail(sampleAcceptedResumeArtifact, makeArtifactTailoringExplanation()),
      makeArtifactDetail(sampleDraftResumeArtifact, makeArtifactTailoringExplanation()),
      {
        leftRiskLabels: ["claim risk", "claim risk"],
        rightRiskLabels: ["claim risk", "evidence risk"],
      },
    );

    expect(comparison.left.riskLabels).toEqual(["claim risk"]);
    expect(comparison.right.riskLabels).toEqual(["claim risk", "evidence risk"]);
  });
});
