import { describe, expect, it } from "vitest";

import { buildApplyAudit, type BuildApplyAuditInput } from "../src/apply-audit.js";

const READY_INPUT: BuildApplyAuditInput = {
  applicationUrl: "https://example.com/apply",
  hasResume: true,
  hasCoverLetter: false,
  hasPdf: true,
  currentStage: "apply",
  currentState: "pending",
  currentErrorCode: null,
  currentErrorMessage: null,
  latestApplyRun: null,
  scoreBreakdown: {
    technicalFit: 9,
    experienceFit: 8,
    roleFit: 8,
    reasoning: "Strong fit.",
    fitBand: "strong",
    confidence: "high",
    eligibility: { status: "eligible", hardBlockers: [], warnings: [] },
    matchedSignals: ["platform"],
    missingSignals: [],
    transferableSignals: [],
  },
  reviewEvidenceAvailable: true,
};

describe("buildApplyAudit", () => {
  it("marks ready jobs as reviewable without blockers", () => {
    expect(buildApplyAudit(READY_INPUT)).toMatchObject({
      state: "ready",
      label: "materials ready",
      reviewEvidenceAvailable: true,
      missingPrerequisites: [],
      hardBlockers: [],
    });
  });

  it("marks missing resume and PDF as preparing prerequisites", () => {
    const audit = buildApplyAudit({
      ...READY_INPUT,
      hasResume: false,
      hasPdf: false,
    });

    expect(audit).toMatchObject({
      state: "preparing",
      label: "materials preparing",
    });
    expect(audit.missingPrerequisites.map((fact) => fact.code)).toEqual([
      "missing_resume",
      "missing_resume_pdf",
    ]);
  });

  it("marks missing apply target and blocked eligibility as hard blockers", () => {
    const audit = buildApplyAudit({
      ...READY_INPUT,
      applicationUrl: null,
      scoreBreakdown: {
        ...READY_INPUT.scoreBreakdown!,
        eligibility: {
          status: "blocked",
          hardBlockers: ["Requires existing US work authorization."],
          warnings: [],
        },
      },
    });

    expect(audit.state).toBe("blocked");
    expect(audit.hardBlockers.map((fact) => fact.code)).toEqual([
      "missing_application_url",
      "score_eligibility_blocked",
    ]);
    expect(audit.sources.find((source) => source.kind === "application_url")).toMatchObject({
      status: "missing",
    });
  });

  it("marks stage failures and failed apply runs as repair while preserving evidence availability", () => {
    const audit = buildApplyAudit({
      ...READY_INPUT,
      currentState: "failed",
      currentErrorMessage: "SKIPPED: process killed by signal",
      latestApplyRun: {
        runId: "submit-failed",
        status: "failed",
        result: "SKIPPED: process killed by signal",
        dryRun: false,
        startedAt: "2026-06-01T10:00:00.000Z",
        finishedAt: "2026-06-01T10:01:00.000Z",
      },
    });

    expect(audit).toMatchObject({
      state: "repair",
      label: "submit failed",
      reviewEvidenceAvailable: true,
    });
    expect(audit.hardBlockers.map((fact) => fact.code)).toContain("stage_not_ready");
    expect(audit.hardBlockers.map((fact) => fact.code)).toContain("apply_run_failed");
  });

  it("surfaces missing eligibility source data explicitly", () => {
    const audit = buildApplyAudit({
      ...READY_INPUT,
      scoreBreakdown: null,
    });

    expect(audit.eligibilityConcerns).toEqual([
      expect.objectContaining({
        code: "score_eligibility_unknown",
        severity: "unknown",
      }),
    ]);
    expect(audit.sources.find((source) => source.kind === "score_eligibility")).toMatchObject({
      status: "unknown",
    });
  });

  it("surfaces incomplete profile attestations as review warnings", () => {
    const audit = buildApplyAudit({
      ...READY_INPUT,
      missingProfileData: ["age_18_plus", "felony_conviction"],
    });

    expect(audit.state).toBe("preparing");
    expect(audit.missingPrerequisites).toEqual([
      expect.objectContaining({
        code: "missing_profile_attestations",
        label: "Profile attestations incomplete",
        detail: "Application attestations missing: Age 18+, Felony conviction.",
        source: "profile_attestations",
        severity: "warning",
      }),
    ]);
    expect(audit.sources.find((source) => source.kind === "profile_attestations")).toMatchObject({
      status: "missing",
      detail: "Application attestations missing: Age 18+, Felony conviction.",
    });
  });

  it("turns legacy missing-profile failure keys into actionable labels", () => {
    const audit = buildApplyAudit({
      ...READY_INPUT,
      currentStage: "apply",
      currentState: "failed",
      currentErrorMessage: "missing_profile_data:age_18_plus,background_check_consent",
    });

    expect(audit.hardBlockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "stage_not_ready",
          detail: "required profile answers missing: Age 18+, Background check consent",
        }),
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain("age_18_plus");
    expect(JSON.stringify(audit)).not.toContain("background_check_consent");
  });
});
