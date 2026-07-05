import { describe, expect, it } from "vitest";

import type { JobDetailProjection, JobListProjection } from "../src/operations/index.js";
import { LOCAL_TENANT } from "../src/tenant.js";

describe("Operations projection types", () => {
  it("carry latest persisted score evidence", () => {
    const listProjection: JobListProjection = {
      tenantId: LOCAL_TENANT,
      jobId: "https://example.com/job",
      title: "Staff Engineer",
      employer: "Acme",
      source: "lever",
      strategy: "ats:lever",
      location: "Remote",
      salary: "",
      applicationUrl: null,
      discoveredAt: "2026-05-01T00:00:00+00:00",
      description: "",
      fullDescription: "",
      fitScore: 8,
      scoreBreakdown: {
        technicalFit: 9,
        experienceFit: 7,
        roleFit: 8,
        reasoning: "Latest structured score evidence.",
        fitBand: "strong",
        confidence: "high",
        eligibility: {
          status: "eligible",
          hardBlockers: [],
          warnings: [],
        },
        matchedSignals: ["python", "fastapi"],
        missingSignals: [],
        transferableSignals: [],
      },
      scoreKeywords: ["python", "fastapi"],
      scoreReasoning: "Latest structured score evidence.",
      scoreVersion: 2,
      scoredAt: "2026-05-05T09:30:00+00:00",
      currentStage: "discover",
      currentState: "succeeded",
      currentErrorCode: null,
      currentErrorMessage: null,
      currentNextAction: null,
      hasResume: false,
      hasCoverLetter: false,
      hasPdf: false,
      applyStatus: null,
      appliedAt: null,
      artifactCount: 0,
      deletedAt: null,
      lastUpdatedAt: "2026-05-05T09:31:00+00:00",
    };
    const detailProjection: JobDetailProjection = {
      tenantId: LOCAL_TENANT,
      jobId: listProjection.jobId,
      descriptionPreview: "",
      scoreBreakdown: listProjection.scoreBreakdown,
      scoreKeywords: listProjection.scoreKeywords,
      scoreReasoning: listProjection.scoreReasoning,
      scoreVersion: listProjection.scoreVersion,
      scoredAt: listProjection.scoredAt,
      stages: [],
      requirementFitReport: null,
      interviewPrep: null,
      lastUpdatedAt: listProjection.lastUpdatedAt,
    };

    expect(listProjection.scoreBreakdown?.technicalFit).toBe(9);
    expect(detailProjection.scoreKeywords).toEqual(["python", "fastapi"]);
  });
});
