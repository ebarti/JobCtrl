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

    expect(audit).toMatchObject({ state: "ready", label: "materials ready" });
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

  it.each(["queued", "running", "pending"] as const)(
    "keeps accepted materials ready during a %s refresh",
    (currentState) => {
      const audit = buildApplyAudit({ ...READY_INPUT, currentStage: "tailor", currentState });
      expect(audit).toMatchObject({ state: "ready", label: "materials ready", reviewEvidenceAvailable: true });
      expect(audit.sources.find((source) => source.kind === "stage_state")?.detail).toContain(currentState);
    },
  );

  it("keeps a missing PDF distinct from incomplete attestations", () => {
    const audit = buildApplyAudit({ ...READY_INPUT, hasPdf: false, missingProfileData: ["age_18_plus"] });
    expect(audit).toMatchObject({ state: "preparing", label: "materials preparing" });
    expect(audit.missingPrerequisites.map((fact) => fact.code)).toEqual([
      "missing_resume_pdf", "missing_profile_attestations",
    ]);
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

it("keeps original intent and local disposition distinct after a newer unrelated result", () => {
  const audit = buildApplyAudit({ ...READY_INPUT, currentState: "skipped", manuallySkipped: true,
    submitIntentRunIds: ["original-intent"], latestApplyRun: { runId: "newer", status: "succeeded", result: "dry_run", dryRun: true, startedAt: null, finishedAt: null } });
  expect(audit.state).toBe("blocked");
  expect(audit.hardBlockers.map((fact) => fact.code)).toEqual(["submission_intent_recorded", "manual_apply_skip"]);
  expect(audit.summary).toContain("original-intent");
  expect(audit.summary).toContain("reset do not prove");
  expect(audit.reviewEvidenceAvailable).toBe(true);
});

it("retains original intent source after a manual Applied attestation without calling it unresolved", () => {
  const audit = buildApplyAudit({ ...READY_INPUT, currentState: "succeeded", submitIntentRunIds: ["original"], intentManuallyResolved: true,
    latestApplyRun: { runId: "original", status: "failed", result: "unknown", dryRun: false, startedAt: null, finishedAt: null } });
  expect(audit.state).toBe("ready");
  expect(audit.hardBlockers).toEqual([]);
  expect(audit.sources).toContainEqual(expect.objectContaining({ kind: "submit_intent", detail: "original; manually recorded Applied" }));
});

it("keeps prior Needs verification explicit without inventing an intent receipt", () => {
  const audit = buildApplyAudit({ ...READY_INPUT, currentState: "skipped", manuallySkipped: true, unresolvedSkippedOutcome: true });
  expect(audit.state).toBe("blocked");
  expect(audit.hardBlockers).toContainEqual(expect.objectContaining({ code: "submission_outcome_uncertain" }));
  expect(audit.sources.some((entry) => entry.kind === "submit_intent")).toBe(false);
});

it("retains exact recorded submission evidence without mislabeling an accepted outcome as uncertain", () => {
  const audit = buildApplyAudit({ ...READY_INPUT, currentState: "succeeded", submitIntentRunIds: ["original"], intentOutcomeRecorded: true });
  expect(audit.hardBlockers).not.toContainEqual(expect.objectContaining({ code: "submission_intent_recorded" }));
  expect(audit.sources).toContainEqual(expect.objectContaining({ kind: "submit_intent", detail: "original; submission recorded" }));
});
