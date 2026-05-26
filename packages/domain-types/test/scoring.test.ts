/**
 * Phase 5 / S-15 + S-18: TypeScript JobScore types.
 *
 * The TS types are pure compile-time interfaces, so the runtime tests
 * focus on (a) the FitScore validating constructor enforcing [1, 10] and
 * (b) a fully populated JobScore being structurally constructable from
 * literal data — i.e. no required field is accidentally missing.
 */

import { describe, it, expect } from "vitest";
import { LOCAL_TENANT } from "../src/tenant.js";
import { generateJobId } from "../src/identifiers.js";
import {
  FIT_SCORE_VALUES,
  createFitScore,
  type FitScore,
  type JobScore,
  type MatchedKeywords,
  type ScoreBreakdown,
  type ScoreCorrection,
  type ScoringCriteria,
} from "../src/scoring/index.js";

describe("Scoring types", () => {
  it("exposes the canonical FitScore literal range", () => {
    expect(FIT_SCORE_VALUES).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("createFitScore accepts in-range integers", () => {
    expect(createFitScore(1).value).toBe(1);
    expect(createFitScore(7).value).toBe(7);
    expect(createFitScore(10).value).toBe(10);
  });

  it.each([0, 11, -1, 1.5, Number.NaN])(
    "createFitScore rejects out-of-range value %p",
    (value) => {
      expect(() => createFitScore(value)).toThrow(RangeError);
    },
  );

  it("a fully specified JobScore is structurally constructable", () => {
    const fitScore: FitScore = createFitScore(8);
    const breakdown: ScoreBreakdown = {
      technicalFit: 9,
      experienceFit: 7,
      roleFit: 8,
      reasoning: "Strong overlap on Python and FastAPI",
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
    };
    const matchedKeywords: MatchedKeywords = {
      values: ["python", "fastapi"],
    };
    const correction: ScoreCorrection = {
      correctedFitScore: createFitScore(9),
      rationale: "False negative: stronger after second read",
      correctedBy: LOCAL_TENANT,
      correctedAt: "2024-01-02T00:00:00+00:00",
    };
    const score: JobScore = {
      tenantId: LOCAL_TENANT,
      jobId: generateJobId(),
      version: 2,
      fitScore,
      breakdown,
      matchedKeywords,
      scoredAt: "2024-01-02T00:00:00+00:00",
      criteria: {
        minFitScore: 7,
        criteriaText: "remote, US-based, Python or Go",
        targetCriteria: "",
        profilePreferences: {},
        criteriaVersion: "criteria-1",
      },
      trace: {
        promptVersion: "score-fit-assessment-v1",
        schemaVersion: "score-fit-assessment-v1",
        model: "test-model",
        criteriaVersion: "criteria-1",
        profileSnapshotVersion: 1,
        parserWarnings: [],
        correctionHistory: [correction],
      },
      correction,
    };

    expect(score.fitScore.value).toBe(8);
    expect(score.matchedKeywords.values).toEqual(["python", "fastapi"]);
    expect(score.correction?.correctedFitScore.value).toBe(9);
    expect(score.tenantId).toBe("local");
  });

  it("ScoringCriteria accepts the canonical defaults", () => {
    const criteria: ScoringCriteria = {
      minFitScore: 7,
      criteriaText: "remote, US-based, Python or Go",
      targetCriteria: "",
      profilePreferences: {},
      criteriaVersion: "criteria-1",
    };
    expect(criteria.minFitScore).toBe(7);
  });

  it("a JobScore without a correction sets correction to null", () => {
    const score: JobScore = {
      tenantId: LOCAL_TENANT,
      jobId: generateJobId(),
      version: 1,
      fitScore: createFitScore(5),
      breakdown: {
        technicalFit: 0,
        experienceFit: 0,
        roleFit: 0,
        reasoning: "",
        fitBand: "poor",
        confidence: "low",
        eligibility: {
          status: "unknown",
          hardBlockers: [],
          warnings: [],
        },
        matchedSignals: [],
        missingSignals: [],
        transferableSignals: [],
      },
      matchedKeywords: { values: [] },
      scoredAt: "2024-01-01T00:00:00+00:00",
      criteria: {
        minFitScore: 7,
        criteriaText: "",
        targetCriteria: "",
        profilePreferences: {},
        criteriaVersion: "criteria-1",
      },
      trace: {
        promptVersion: "score-fit-assessment-v1",
        schemaVersion: "score-fit-assessment-v1",
        model: "test-model",
        criteriaVersion: "criteria-1",
        profileSnapshotVersion: 1,
        parserWarnings: [],
        correctionHistory: [],
      },
      correction: null,
    };
    expect(score.correction).toBeNull();
  });
});
