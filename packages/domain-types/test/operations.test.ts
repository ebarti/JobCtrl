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
      applyMode: null,
      resumeTemplateId: null,
      resumeTemplateName: null,
      tailoringPolicyVersion: null,
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
      requirementFitReport: {
        jobId: listProjection.jobId,
        scoreVersion: 2,
        employerAnalysisGeneration: 1,
        profileSnapshotVersion: 3,
        scoringPolicyVersion: 4,
        formulaVersion: "requirement-fit-v1",
        resolvedFitScore: 8,
        fitBand: "strong",
        confidence: "high",
        summary: {
          weightedFit: 0.8,
          mustHaveCoverage: 1,
          blockerCount: 0,
          missingHighWeightCount: 0,
        },
        assessments: [
          {
            requirementId: "r1",
            requirementText: "Build Python services",
            tier: "must_have",
            weight: 1,
            jobEvidenceSpan: "Python services",
            fit: {
              kind: "matched",
              evidenceIds: ["evidence-python"],
              strength: "direct",
            },
            contribution: {
              maxPoints: 10,
              awardedPoints: 10,
              weightedImpact: 0.8,
              rationale: "Direct evidence.",
            },
            tailoring: {
              action: "double_down",
              priority: 1,
              allowedEvidenceIds: ["evidence-python"],
              targetKeywords: ["python"],
              prohibitedClaims: [],
              instruction: "Use the existing evidence.",
            },
            artifactCoverage: null,
          },
        ],
      },
      interviewPrep: {
        jobId: listProjection.jobId,
        generation: 1,
        status: "accepted",
        generatedAt: "2026-05-05T09:30:00+00:00",
        model: "gpt-test",
        gateAudit: {
          status: "passed",
          fabricationFindings: [],
          groundingFindings: [],
          judgeVerdict: "grounded",
          warnings: [],
        },
        items: [],
      },
      lastUpdatedAt: listProjection.lastUpdatedAt,
    };

    expect(listProjection.scoreBreakdown?.technicalFit).toBe(9);
    expect(detailProjection.scoreKeywords).toEqual(["python", "fastapi"]);
    expect(detailProjection.requirementFitReport?.jobId).toBe(listProjection.jobId);
    expect(detailProjection.interviewPrep?.jobId).toBe(listProjection.jobId);
  });
});
