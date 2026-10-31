import { describe, expect, it } from "vitest";

import type { JobDetail } from "@jobctrl/contracts";
import { blockedRequirementFitReport } from "../../test/fixtures/materials-inspector.js";
import { makeJobDetail, sampleJob } from "../../test/fixtures/projections.js";
import { requirementFitScoreContext } from "./fit-score-help.js";

function blockedDetail(): JobDetail {
  return makeJobDetail(
    { ...sampleJob, jobKey: "job-1", scoreVersion: 4, fitScore: 4 },
    { requirementFitReport: blockedRequirementFitReport },
  );
}

describe("requirementFitScoreContext", () => {
  it("explains recorded coverage and a blocked policy score without changing either", () => {
    const detail = blockedDetail();
    expect(requirementFitScoreContext(detail)).toBe(
      "80% weighted requirement coverage. Blocking requirement: The posting requires a current clearance. The recorded policy caps scores with blocked requirements at 4/10.",
    );
    expect(detail.job.fitScore).toBe(4);
    expect(detail.requirementFitReport?.summary.weightedFit).toBe(0.8);
  });

  it.each(["jobId", "scoreVersion", "resolvedFitScore"] as const)(
    "does not attach a mismatched report by %s to the current score",
    (field) => {
      const detail = blockedDetail();
      const report = detail.requirementFitReport!;
      detail.requirementFitReport = { ...report, [field]: field === "jobId" ? "foreign-job" : 99 };
      expect(requirementFitScoreContext(detail)).toBeNull();
    },
  );

  it("does not attribute a manual correction to an earlier requirement report", () => {
    const detail = blockedDetail();
    detail.job.scoreCorrection = {
      originalScore: 4, correctedScore: 4, rationale: "Reviewed independently",
      correctedBy: "local-user", correctedAt: "2026-05-06T09:30:00Z",
    };
    expect(requirementFitScoreContext(detail)).toBeNull();
  });

  it("does not invent a cap for a different recorded formula", () => {
    const detail = blockedDetail();
    detail.requirementFitReport = { ...detail.requirementFitReport!, formulaVersion: "future-formula" };
    expect(requirementFitScoreContext(detail)).toContain("The posting requires a current clearance.");
    expect(requirementFitScoreContext(detail)).not.toContain("caps");
  });

  it("keeps a recorded eligibility blocker separate from scoped capability coverage", () => {
    const detail = blockedDetail();
    detail.job.fitScore = 10;
    detail.requirementFitReport = {
      ...detail.requirementFitReport!, formulaVersion: "requirement-fit-v2-scoped", resolvedFitScore: 10,
      summary: { weightedFit: 1, mustHaveCoverage: 1, blockerCount: 0, missingHighWeightCount: 0 },
      assessments: detail.requirementFitReport!.assessments.map((row, index) => ({
        ...row, contribution: {
          ...row.contribution, scope: index ? "eligibility" : "resume", scopeSourceId: "1".repeat(64),
          ...(index ? { maxPoints: 0, awardedPoints: 0, weightedImpact: 0 } : {}),
        },
      })),
    };
    const context = requirementFitScoreContext(detail);
    expect(context).toContain("100% weighted capability coverage");
    expect(context).toContain("1 eligibility, logistics or employer condition is assessed separately");
    expect(context).not.toContain("caps");
  });

  it("does not present scoped coverage without the recorded classification source", () => {
    const detail = blockedDetail();
    detail.requirementFitReport = { ...detail.requirementFitReport!, formulaVersion: "requirement-fit-v2-scoped" };
    expect(requirementFitScoreContext(detail)).toBe(
      "No recorded source for requirement classification. Review the saved assessment.",
    );
  });
});
