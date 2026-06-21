import type {
  ArtifactDetail,
  ArtifactSummary,
  ActivityEventSummary,
  ApplyAudit,
  ApplicationOutcomeListResponse,
  ApplyReviewQueueResponse,
  CredentialsResponse,
  DashboardSummary,
  JobAuditEntry,
  JobCompensationAudit,
  JobCompensationFloorComparison,
  JobCompensationFloorComparisonArm,
  JobCompensationRangeSummary,
  JobCompensationSummary,
  JobMarketCompensationSummary,
  JobPostedCompensationSummary,
  JobDetail,
  JobSummary,
  PaginatedResponse,
  ProfileConfigResponse,
  SettingsResponse,
  WorkflowRunSummary,
} from "@jobhunter/contracts";

import type { ApiHealthResponse } from "../../shared/ports/ApiClientPort.js";

export const sampleHealthResponse: ApiHealthResponse = {
  ok: true,
  appDir: "/tmp/jobhunter-test",
  dbPath: "/tmp/jobhunter-test/jobhunter.db",
  dbExists: true,
  dbIdentity: "1:2",
  worker: {
    status: "healthy",
    expectedDbPath: "/tmp/jobhunter-test/jobhunter.db",
    expectedAppDir: "/tmp/jobhunter-test",
    staleAfterSeconds: 45,
    message: "JobHunter automation worker heartbeat is current and uses the API database.",
    heartbeat: {
      workerId: "worker-test",
      component: "temporal-worker",
      pid: 123,
      hostname: "localhost",
      appDir: "/tmp/jobhunter-test",
      dbPath: "/tmp/jobhunter-test/jobhunter.db",
      taskQueue: "jobhunter-default",
      startedAt: "2026-05-20T10:00:00.000Z",
      lastSeenAt: "2026-05-20T10:00:10.000Z",
    },
  },
};

export const sampleCompensationSummary: JobCompensationSummary = {
  projectionVersion: 1,
  legacyRawSalary: "EUR 70000-90000/year",
  warningCount: 1,
  posted: {
    sourceKind: "posted",
    recordStatus: "recorded",
    parseState: "parsed_range",
    confidence: "high",
    warningCount: 0,
    range: {
      currency: "EUR",
      period: "year",
      component: "base_salary",
      minimumAmount: 70000,
      maximumAmount: 90000,
      annualizedMinimumAmount: 70000,
      annualizedMaximumAmount: 90000,
      displayRange: "EUR 70000-90000/year",
    },
    displayRange: "EUR 70000-90000/year",
  },
  market: {
    sourceKind: "reported_company_role_market",
    recordStatus: "recorded",
    estimateState: "estimated_range",
    confidenceBand: "medium",
    confidenceScore: 0.82,
    sourceCount: 2,
    sampleCount: 7,
    warningCount: 1,
    range: {
      currency: "EUR",
      period: "year",
      component: "base_salary",
      minimumAmount: 112000,
      maximumAmount: 142000,
      annualizedMinimumAmount: 112000,
      annualizedMaximumAmount: 142000,
      displayRange: "EUR 112000-142000/year",
    },
    displayRange: "EUR 112000-142000/year",
  },
};

export const sampleCompensationAudit: JobCompensationAudit = {
  projectionVersion: 1,
  posted: {
    ok: true,
    recordStatus: "recorded",
    fact: {
      tenantId: "local",
      jobKey: "job-2",
      sourceField: "salary",
      legacyRawSalary: "EUR 70000-90000/year",
      sourceText: "EUR 70000-90000/year",
      parseState: "parsed_range",
      currency: "EUR",
      period: "year",
      component: "base_salary",
      minimumAmount: 70000,
      maximumAmount: 90000,
      annualizedMinimumAmount: 70000,
      annualizedMaximumAmount: 90000,
      annualizationAssumption: null,
      confidence: "high",
      parserVersion: "posted-compensation-parser-v1",
      sourceHash: "posted-hash",
      parsedAt: "2026-06-20T08:00:00Z",
      warnings: [],
    },
  },
  market: {
    ok: true,
    recordStatus: "recorded",
    estimate: {
      tenantId: "local",
      jobKey: "job-2",
      estimateState: "estimated_range",
      confidenceBand: "medium",
      confidenceScore: 0.82,
      sourceCount: 2,
      sampleCount: 7,
      aggregateBucket: "company_role",
      geographyScope: "europe",
      occupationCode: "2512",
      occupationLabel: "Software developers",
      seniorityLabel: "principal",
      companyName: "Globex",
      normalizedCompany: "globex",
      roleTitle: "Principal Platform Engineer",
      normalizedRole: "principal platform engineer",
      companyTier: "tier_2_ambitious",
      matchScope: "exact_company_role",
      currency: "EUR",
      period: "year",
      component: "base_salary",
      minimumAmount: 112000,
      maximumAmount: 142000,
      sources: [
        {
          sourceId: "levels_fyi",
          displayName: "Levels.fyi",
          sourceType: "reported_compensation",
          releaseYear: 2026,
          snapshotVersion: "levels-export-2026-06",
          geographyScope: "europe",
          aggregateBucket: "company_role",
          attribution: "local permitted export",
          sampleCount: 4,
        },
        {
          sourceId: "glassdoor",
          displayName: "Glassdoor",
          sourceType: "reported_compensation",
          releaseYear: 2026,
          snapshotVersion: "glassdoor-export-2026-06",
          geographyScope: "europe",
          aggregateBucket: "company_role",
          attribution: "local permitted export",
          sampleCount: 3,
        },
      ],
      factors: [
        {
          name: "company",
          score: 0.96,
          band: "high",
          reason: "Reported rows match Globex directly.",
        },
        {
          name: "sample",
          score: 0.64,
          band: "medium",
          reason: "Seven reported rows support the estimate.",
        },
      ],
      warnings: [
        {
          code: "reported_compensation_sample",
          message: "Reported compensation support is moderate, not exhaustive.",
        },
      ],
      estimatorVersion: "company-role-reported-compensation-v1",
      estimatedAt: "2026-06-20T08:00:00Z",
    },
  },
};

export const sampleJob: JobSummary = {
  jobKey: "job-1",
  url: "https://example.com/jobs/1",
  title: "Staff Software Engineer",
  company: "Acme Corp",
  source: "Lever",
  discoverySource: "lever:acme",
  postingSource: "lever:acme",
  postingSourceUrl: "https://jobs.lever.co/acme/1",
  strategy: "ats:lever",
  location: "Remote (US)",
  salary: "$220k-$260k",
  compensationSummary: null,
  discoveredAt: "2026-05-01T12:00:00Z",
  applicationUrl: "https://example.com/apply/1",
  fitScore: 8,
  scoreBreakdown: {
    technicalFit: 9,
    experienceFit: 7,
    roleFit: 8,
    reasoning: "Strong fit on platform reliability.",
    fitBand: "strong",
    confidence: "high",
    eligibility: { status: "eligible", hardBlockers: [], warnings: [] },
    matchedSignals: ["platform reliability", "SRE leadership"],
    missingSignals: ["public company scale"],
    transferableSignals: ["incident leadership"],
  },
  scoreKeywords: ["platform reliability", "sre"],
  scoreReasoning: "Strong fit on platform reliability.",
  scoreVersion: 2,
  scoredAt: "2026-05-05T09:30:00Z",
  scoreCriteria: {
    minFitScore: 7,
    criteriaText: "Platform reliability and team leadership.",
    targetCriteria: "Director-plus infrastructure roles.",
    criteriaVersion: "criteria-1",
  },
  scoreTrace: {
    promptVersion: "score-fit-assessment-v1",
    schemaVersion: "score-fit-assessment-v1",
    model: "fake",
    criteriaVersion: "criteria-1",
    profileSnapshotVersion: 2,
    scoringPolicyId: "local:scoring-policy-v2",
    scoringPolicyVersion: 2,
    rubricVersion: "default-scoring-rubric-v1",
    rawWeightedScore: 8.1,
    calibrationAdjustment: 0,
    policyAnchorCount: 1,
    resolvedFitBand: "strong",
    resolutionReason: "weighted policy score",
    parserWarnings: [],
    correctionHistory: [],
  },
  scoreCorrection: null,
  scoreStaleness: {
    isStale: false,
    staleReason: null,
    currentPolicyVersion: null,
    targetPolicyVersion: null,
    markedAt: null,
    pendingExplicitRescore: false,
  },
  currentStage: "tailor",
  currentSubstage: "tailor",
  currentState: "running",
  errorCode: null,
  errorMessage: null,
  nextAction: null,
  artifactCount: 1,
  applyStatus: null,
  appliedAt: null,
  activeState: "active",
  deletedAt: null,
  hiddenAt: null,
};

export const sampleSecondaryJob: JobSummary = {
  ...sampleJob,
  jobKey: "job-2",
  url: "https://example.com/jobs/2",
  title: "Principal Platform Engineer",
  company: "Globex",
  compensationSummary: sampleCompensationSummary,
  fitScore: 9,
  currentStage: "apply",
  currentSubstage: "apply",
  currentState: "succeeded",
  artifactCount: 2,
  applyStatus: "applied",
  appliedAt: "2026-05-04T10:00:00Z",
};

export function makeCompensationRange(
  overrides: Partial<JobCompensationRangeSummary> = {},
): JobCompensationRangeSummary {
  return {
    currency: "EUR",
    period: "year",
    component: "base_salary",
    minimumAmount: 120_000,
    maximumAmount: 150_000,
    annualizedMinimumAmount: 120_000,
    annualizedMaximumAmount: 150_000,
    displayRange: "EUR 120k-150k",
    ...overrides,
  };
}

export function makeCompensationFloorComparisonArm(
  overrides: Partial<JobCompensationFloorComparisonArm> = {},
): JobCompensationFloorComparisonArm {
  return {
    state: "meets_floor",
    currency: "EUR",
    period: "year",
    component: "base_salary",
    minimumAmount: 120_000,
    maximumAmount: 150_000,
    annualizedMinimumAmount: 120_000,
    annualizedMaximumAmount: 150_000,
    displayRange: "EUR 120k-150k",
    ...overrides,
  };
}

export function makeCompensationFloorComparison(
  overrides: Partial<JobCompensationFloorComparison> = {},
): JobCompensationFloorComparison {
  return {
    state: "meets_floor",
    basis: "both_posted_and_market",
    floor: { amount: 100_000, currency: "EUR", period: "year" },
    posted: makeCompensationFloorComparisonArm(),
    market: makeCompensationFloorComparisonArm({
      minimumAmount: 135_000,
      maximumAmount: 165_000,
      annualizedMinimumAmount: 135_000,
      annualizedMaximumAmount: 165_000,
      displayRange: "EUR 135k-165k",
    }),
    warningCount: 0,
    warningLabels: [],
    ...overrides,
  };
}

export function makeFloorNotConfiguredCompensationSummary(
  overrides: Partial<JobCompensationSummary> = {},
): JobCompensationSummary {
  return makeCompensationSummary({
    floorComparison: makeCompensationFloorComparison({
      state: "not_configured",
      basis: "floor_not_configured",
      floor: null,
      posted: null,
      market: null,
      warningCount: 0,
      warningLabels: [],
    }),
    ...overrides,
  });
}

export function makeFloorConfiguredCompensationSummary(
  overrides: Partial<JobCompensationSummary> = {},
): JobCompensationSummary {
  return makeCompensationSummary({
    floorComparison: makeCompensationFloorComparison({
      state: "below_floor",
      basis: "posted_salary_basis",
      floor: { amount: 140_000, currency: "EUR", period: "year" },
      posted: makeCompensationFloorComparisonArm({
        state: "below_floor",
        minimumAmount: 100_000,
        maximumAmount: 120_000,
        annualizedMinimumAmount: 100_000,
        annualizedMaximumAmount: 120_000,
        displayRange: "EUR 100k-120k",
      }),
      market: null,
      warningCount: 1,
      warningLabels: ["Posted salary is below configured profile floor."],
    }),
    warningCount: 1,
    ...overrides,
  });
}

export function makePostedCompensationSummary(
  overrides: Partial<JobPostedCompensationSummary> = {},
): JobPostedCompensationSummary {
  return {
    sourceKind: "posted",
    recordStatus: "recorded",
    parseState: "parsed_range",
    confidence: "high",
    warningCount: 0,
    range: makeCompensationRange(),
    displayRange: "EUR 120k-150k",
    ...overrides,
  };
}

export function makeMarketCompensationSummary(
  overrides: Partial<JobMarketCompensationSummary> = {},
): JobMarketCompensationSummary {
  return {
    sourceKind: "reported_company_role_market",
    recordStatus: "recorded",
    estimateState: "estimated_range",
    confidenceBand: "high",
    sourceCount: 6,
    warningCount: 2,
    range: makeCompensationRange({
      minimumAmount: 135_000,
      maximumAmount: 165_000,
      annualizedMinimumAmount: 135_000,
      annualizedMaximumAmount: 165_000,
      displayRange: "EUR 135k-165k",
    }),
    displayRange: "EUR 135k-165k",
    ...overrides,
  };
}

export function makeCompensationSummary(
  overrides: Partial<JobCompensationSummary> = {},
): JobCompensationSummary {
  return {
    projectionVersion: 1,
    legacyRawSalary: "EUR 120k-150k",
    warningCount: 2,
    posted: makePostedCompensationSummary(),
    market: makeMarketCompensationSummary(),
    floorComparison: makeCompensationFloorComparison(),
    ...overrides,
  };
}

export function makeNoPostedSalaryCompensationSummary(
  overrides: Partial<JobCompensationSummary> = {},
): JobCompensationSummary {
  return makeCompensationSummary({
    legacyRawSalary: null,
    posted: makePostedCompensationSummary({
      recordStatus: "recorded",
      parseState: "missing",
      confidence: "none",
      warningCount: 0,
      range: null,
      displayRange: null,
    }),
    ...overrides,
  });
}

export function makeUnsupportedMarketCompensationSummary(
  overrides: Partial<JobCompensationSummary> = {},
): JobCompensationSummary {
  return makeCompensationSummary({
    warningCount: 1,
    market: makeMarketCompensationSummary({
      estimateState: "unsupported",
      confidenceBand: "none",
      sourceCount: 0,
      warningCount: 1,
      range: null,
      displayRange: null,
    }),
    ...overrides,
  });
}

export function makeInsufficientEvidenceCompensationSummary(
  overrides: Partial<JobCompensationSummary> = {},
): JobCompensationSummary {
  return makeCompensationSummary({
    warningCount: 1,
    market: makeMarketCompensationSummary({
      estimateState: "insufficient_evidence",
      confidenceBand: "low",
      sourceCount: 2,
      warningCount: 1,
      range: null,
      displayRange: null,
    }),
    ...overrides,
  });
}

export function makeSourceUnavailableCompensationSummary(
  overrides: Partial<JobCompensationSummary> = {},
): JobCompensationSummary {
  return makeCompensationSummary({
    warningCount: 1,
    market: makeMarketCompensationSummary({
      estimateState: "source_unavailable",
      confidenceBand: "none",
      sourceCount: 0,
      warningCount: 1,
      range: null,
      displayRange: null,
    }),
    ...overrides,
  });
}

export function makeCompensationAudit(
  overrides: Partial<JobCompensationAudit> = {},
): JobCompensationAudit {
  return {
    projectionVersion: 1,
    posted: {
      ok: true,
      recordStatus: "not_recorded",
      jobKey: sampleJob.jobKey,
      legacyRawSalary: "EUR 120k-150k",
    },
    market: {
      ok: true,
      recordStatus: "not_requested",
      jobKey: sampleJob.jobKey,
    },
    floorComparison: makeCompensationFloorComparison(),
    ...overrides,
  };
}

type PostedRecordedResponse = Extract<
  JobCompensationAudit["posted"],
  { recordStatus: "recorded" }
>;
type PostedFact = PostedRecordedResponse["fact"];
type PostedParsedRangeFact = Extract<PostedFact, { parseState: "parsed_range" }>;
type PostedMissingFact = Extract<PostedFact, { parseState: "missing" }>;
type PostedUnparseableFact = Extract<PostedFact, { parseState: "unparseable" }>;
type PostedAmbiguousFact = Extract<PostedFact, { parseState: "ambiguous" }>;

function postedFactBase() {
  return {
    tenantId: "local",
    jobKey: sampleJob.jobKey,
    sourceField: "description",
    legacyRawSalary: "EUR 120k-150k",
    parserVersion: "posted-parser-test-v1",
    sourceHash: "sha256:synthetic-posted-source",
    parsedAt: "2026-06-20T12:00:00Z",
    warnings: [],
  };
}

export function makeRecordedPostedCompensationAudit(
  overrides: Partial<PostedParsedRangeFact> = {},
): PostedRecordedResponse {
  return {
    ok: true,
    recordStatus: "recorded",
    fact: {
      ...postedFactBase(),
      parseState: "parsed_range",
      sourceText: "Salary range EUR 120k-150k gross base.",
      currency: "EUR",
      period: "year",
      component: "base_salary",
      minimumAmount: 120_000,
      maximumAmount: 150_000,
      annualizedMinimumAmount: 120_000,
      annualizedMaximumAmount: 150_000,
      annualizationAssumption: "Annual gross base salary.",
      confidence: "high",
      ...overrides,
    },
  };
}

export function makeMissingPostedCompensationAudit(
  overrides: Partial<PostedMissingFact> = {},
): PostedRecordedResponse {
  return {
    ok: true,
    recordStatus: "recorded",
    fact: {
      ...postedFactBase(),
      parseState: "missing",
      sourceText: null,
      confidence: "none",
      legacyRawSalary: null,
      ...overrides,
    },
  };
}

export function makeUnparseablePostedCompensationAudit(
  overrides: Partial<PostedUnparseableFact> = {},
): PostedRecordedResponse {
  return {
    ok: true,
    recordStatus: "recorded",
    fact: {
      ...postedFactBase(),
      parseState: "unparseable",
      sourceText: "Competitive salary with meaningful equity.",
      confidence: "low",
      warnings: [{ code: "no_amount_found", message: "No numeric amount was found." }],
      ...overrides,
    },
  };
}

export function makeAmbiguousPostedCompensationAudit(
  overrides: Partial<PostedAmbiguousFact> = {},
): PostedRecordedResponse {
  return {
    ok: true,
    recordStatus: "recorded",
    fact: {
      ...postedFactBase(),
      parseState: "ambiguous",
      sourceText: "Base EUR 95k plus OTE EUR 150k.",
      confidence: "medium",
      warnings: [
        { code: "ambiguous_multiple_amounts", message: "Multiple amounts need review." },
        { code: "ote_component", message: "OTE compensation is not base salary." },
      ],
      ...overrides,
    },
  };
}

type MarketRecordedResponse = Extract<
  JobCompensationAudit["market"],
  { recordStatus: "recorded" }
>;
type MarketEstimate = MarketRecordedResponse["estimate"];
type MarketEstimatedRange = Extract<MarketEstimate, { estimateState: "estimated_range" }>;
type MarketUnsupported = Extract<MarketEstimate, { estimateState: "unsupported" }>;
type MarketInsufficient = Extract<MarketEstimate, { estimateState: "insufficient_evidence" }>;
type MarketUnavailable = Extract<MarketEstimate, { estimateState: "source_unavailable" }>;

function marketEstimateBase() {
  return {
    tenantId: "local",
    jobKey: sampleJob.jobKey,
    confidenceBand: "high" as const,
    confidenceScore: 0.86,
    sourceCount: 2,
    sampleCount: 42,
    aggregateBucket: "company-role",
    geographyScope: "Europe",
    occupationCode: "2512",
    occupationLabel: "Software developers",
    seniorityLabel: "Staff",
    companyName: "Acme Corp",
    normalizedCompany: "acme corp",
    roleTitle: "Staff Software Engineer",
    normalizedRole: "staff software engineer",
    companyTier: "tier_2_ambitious" as const,
    matchScope: "exact_company_role" as const,
    sources: [
      {
        sourceId: "manual_reported_compensation" as const,
        displayName: "Manual reported compensation import",
        sourceType: "reported_compensation" as const,
        releaseYear: 2026,
        snapshotVersion: "manual-2026-06",
        geographyScope: "Europe",
        aggregateBucket: "company-role",
        attribution: "Synthetic local reported-compensation fixture.",
        sampleCount: 24,
      },
      {
        sourceId: "glassdoor" as const,
        displayName: "Glassdoor",
        sourceType: "reported_compensation" as const,
        releaseYear: null,
        snapshotVersion: "disabled-provider-fixture",
        geographyScope: "Europe",
        aggregateBucket: "company-role",
        attribution: "Provider access disabled in test fixture.",
        sampleCount: null,
      },
    ],
    factors: [
      { name: "company" as const, score: 0.92, band: "high" as const, reason: "Exact company match." },
      { name: "role" as const, score: 0.84, band: "high" as const, reason: "Staff platform role match." },
      { name: "sample" as const, score: 0.7, band: "medium" as const, reason: "Sample size is adequate." },
    ],
    warnings: [
      {
        code: "source_conflict_with_posted_salary" as const,
        message: "Market estimate is above the posted range.",
      },
    ],
    estimatorVersion: "market-estimator-test-v1",
    estimatedAt: "2026-06-20T12:10:00Z",
  };
}

export function makeEstimatedMarketCompensationAudit(
  overrides: Partial<MarketEstimatedRange> = {},
): MarketRecordedResponse {
  return {
    ok: true,
    recordStatus: "recorded",
    estimate: {
      ...marketEstimateBase(),
      estimateState: "estimated_range",
      currency: "EUR",
      period: "year",
      component: "base_salary",
      minimumAmount: 135_000,
      maximumAmount: 165_000,
      ...overrides,
    },
  };
}

export function makeSourceConflictMarketCompensationAudit(
  overrides: Partial<MarketEstimatedRange> = {},
): MarketRecordedResponse {
  return makeEstimatedMarketCompensationAudit({
    confidenceBand: "medium",
    confidenceScore: 0.74,
    sourceCount: 2,
    sampleCount: 7,
    sources: [
      {
        sourceId: "manual_reported_compensation",
        displayName: "Manual reported compensation import",
        sourceType: "reported_compensation",
        releaseYear: 2026,
        snapshotVersion: "synthetic-source-conflict-2026-06",
        geographyScope: "Europe",
        aggregateBucket: "company-role",
        attribution: "Synthetic local reported-compensation fixture.",
        sampleCount: 4,
      },
      {
        sourceId: "glassdoor",
        displayName: "Glassdoor",
        sourceType: "reported_compensation",
        releaseYear: 2026,
        snapshotVersion: "disabled-provider-synthetic-source-conflict",
        geographyScope: "Europe",
        aggregateBucket: "company-role",
        attribution: "Synthetic provider-disabled reported-compensation fixture.",
        sampleCount: 3,
      },
    ],
    warnings: [
      {
        code: "reported_compensation_sample",
        message: "The estimate uses reported compensation rows for the job company and role.",
      },
      {
        code: "source_conflict_with_posted_salary",
        message: "Market estimate is above the posted range.",
      },
    ],
    ...overrides,
  });
}

export function makeUnsupportedMarketCompensationAudit(
  overrides: Partial<MarketUnsupported> = {},
): MarketRecordedResponse {
  return {
    ok: true,
    recordStatus: "recorded",
    estimate: {
      ...marketEstimateBase(),
      estimateState: "unsupported",
      confidenceBand: "none",
      confidenceScore: 0,
      sourceCount: 0,
      sampleCount: null,
      matchScope: "none",
      sources: [],
      factors: [],
      warnings: [],
      unsupportedReasons: [{ code: "unsupported_source", message: "This market is not supported." }],
      ...overrides,
    },
  };
}

export function makeInsufficientMarketCompensationAudit(
  overrides: Partial<MarketInsufficient> = {},
): MarketRecordedResponse {
  return {
    ok: true,
    recordStatus: "recorded",
    estimate: {
      ...marketEstimateBase(),
      estimateState: "insufficient_evidence",
      confidenceBand: "low",
      confidenceScore: 0.32,
      sourceCount: 1,
      sampleCount: 2,
      insufficientReasons: [{ code: "low_sample_count", message: "Only two reported rows matched." }],
      ...overrides,
    },
  };
}

export function makeUnavailableMarketCompensationAudit(
  overrides: Partial<MarketUnavailable> = {},
): MarketRecordedResponse {
  return {
    ok: true,
    recordStatus: "recorded",
    estimate: {
      ...marketEstimateBase(),
      estimateState: "source_unavailable",
      confidenceBand: "none",
      confidenceScore: 0,
      sourceCount: 0,
      sampleCount: null,
      sources: [],
      factors: [],
      warnings: [],
      sourceUnavailableReasons: [
        {
          code: "unsupported_source",
          message: "Levels.fyi access unavailable until permitted source access is configured.",
        },
      ],
      ...overrides,
    },
  };
}

export function jobWithCompensation(
  overrides: Partial<JobSummary> = {},
): JobSummary {
  return {
    ...sampleJob,
    jobKey: "job-compensation",
    title: "Compensated Platform Role",
    salary: "EUR 120k-150k",
    compensationSummary: makeCompensationSummary(),
    ...overrides,
  };
}

export function jobDetailWithCompensation(
  job: JobSummary = jobWithCompensation(),
  overrides: Partial<Omit<JobDetail, "ok" | "job">> = {},
): JobDetail {
  return makeJobDetail(job, {
    compensationAudit: makeCompensationAudit(),
    ...overrides,
  });
}

export function makeApplyAudit(overrides: Partial<ApplyAudit> = {}): ApplyAudit {
  const base: ApplyAudit = {
    state: "ready",
    label: "materials ready",
    summary: "The tailored materials are ready to review before approval.",
    reviewEvidenceAvailable: true,
    missingPrerequisites: [],
    hardBlockers: [],
    eligibilityConcerns: [],
    sources: [
      {
        kind: "application_url",
        label: "Application target",
        status: "present",
        detail: "Application target is available.",
      },
      {
        kind: "materials.resume",
        label: "Tailored resume",
        status: "present",
        detail: "Tailored resume is available.",
      },
      {
        kind: "materials.pdf",
        label: "Submit-ready PDF",
        status: "present",
        detail: "Resume PDF is available for submission.",
      },
      {
        kind: "score_eligibility",
        label: "Score eligibility",
        status: "present",
        detail: "Eligibility is recorded as eligible.",
      },
    ],
  };
  return {
    ...base,
    ...overrides,
    missingPrerequisites: overrides.missingPrerequisites ?? base.missingPrerequisites,
    hardBlockers: overrides.hardBlockers ?? base.hardBlockers,
    eligibilityConcerns: overrides.eligibilityConcerns ?? base.eligibilityConcerns,
    sources: overrides.sources ?? base.sources,
  };
}

export const sampleApplyReviewQueue: ApplyReviewQueueResponse = {
  ok: true,
  items: [
    {
      jobKey: sampleSecondaryJob.jobKey,
      title: sampleSecondaryJob.title,
      company: sampleSecondaryJob.company,
      source: sampleSecondaryJob.source,
      compensationSummary: sampleSecondaryJob.compensationSummary,
      fitScore: sampleSecondaryJob.fitScore,
      scoreBreakdown: sampleSecondaryJob.scoreBreakdown,
      scoreKeywords: sampleSecondaryJob.scoreKeywords,
      scoreReasoning: sampleSecondaryJob.scoreReasoning,
      scoreVersion: sampleSecondaryJob.scoreVersion,
      scoredAt: sampleSecondaryJob.scoredAt,
      scoreCriteria: sampleSecondaryJob.scoreCriteria,
      scoreTrace: sampleSecondaryJob.scoreTrace,
      applicationUrl: sampleSecondaryJob.applicationUrl,
      currentStage: "apply",
      currentState: "succeeded",
      materials: {
        hasResume: true,
        hasCoverLetter: true,
        hasPdf: true,
        ready: true,
      },
      applyAudit: makeApplyAudit(),
      position: {
        descriptionPreview:
          "Globex needs a principal engineer to lead platform reliability, incident response, and developer experience improvements.",
        idealCandidate:
          "A principal engineer who can lead platform reliability, improve developer experience, and guide incident-response practices across teams.",
        idealRequirements: [
          {
            id: "r1",
            text: "Lead platform reliability improvements across critical services.",
            tier: "must_have",
            weight: 0.9,
            evidence: "lead platform reliability",
            fit: {
              kind: "matched",
              evidenceIds: ["ev_platform_reliability"],
              strength: "direct",
            },
            contribution: {
              maxPoints: 1.125,
              awardedPoints: 1.125,
              weightedImpact: 1.125,
              rationale: "Direct platform reliability evidence covers the must-have requirement.",
            },
            tailoring: {
              action: "double_down",
              priority: 0.9,
              allowedEvidenceIds: ["ev_platform_reliability"],
              targetKeywords: ["platform reliability"],
              prohibitedClaims: [],
              instruction: "Keep platform reliability ownership prominent in the resume.",
            },
            coverage: {
              state: "covered",
              source: "tailored_resume_bullet_provenance",
              bulletCount: 2,
              examples: ["Owned platform reliability improvements for incident response."],
            },
          },
          {
            id: "r2",
            text: "Improve incident-response practices and developer experience.",
            tier: "important",
            weight: 0.7,
            evidence: "incident response, and developer experience improvements",
            fit: {
              kind: "transferable",
              evidenceIds: ["ev_incident_leadership"],
              gap: "No direct developer-experience ownership evidence was recorded.",
              bridge: "Incident leadership can support adjacent developer-experience expectations.",
            },
            contribution: {
              maxPoints: 0.7,
              awardedPoints: 0.42,
              weightedImpact: 0.42,
              rationale: "Transferable incident leadership partially covers the requirement.",
            },
            tailoring: {
              action: "bridge_gap",
              priority: 0.7,
              allowedEvidenceIds: ["ev_incident_leadership"],
              targetKeywords: ["incident response", "developer experience"],
              prohibitedClaims: ["owned developer experience end to end"],
              instruction: "Bridge from incident leadership without claiming direct developer-experience ownership.",
            },
            coverage: {
              state: "missing_from_resume",
              source: "tailored_resume_bullet_provenance",
              bulletCount: 0,
              examples: [],
            },
          },
        ],
        requirements: ["platform reliability", "SRE leadership", "incident response"],
        matched: ["platform reliability", "SRE leadership"],
        missing: ["public company scale"],
        transferable: ["incident leadership"],
        keywords: ["platform reliability", "sre"],
      },
      materialsPreview: {
        resumeText:
          "Principal Platform Engineer\n\nOwned platform reliability improvements for incident response.",
        resumeTextArtifactId: "resume-text-2",
        resumePdfArtifactId: "resume-pdf-2",
        profileSourceFields: [
          {
            path: "personal.full_name",
            label: "Profile > Personal information > Full name",
            value: "Jordan Candidate",
            section: "profile_personal",
          },
          {
            path: "personal.email",
            label: "Profile > Personal information > Email",
            value: "jordan@example.com",
            section: "profile_personal",
          },
        ],
        coverLetterText:
          "Dear Hiring Manager,\n\nI am excited to bring platform reliability leadership to Globex.",
      },
      latestApplyRun: {
        runId: "apply-run-2",
        status: "succeeded",
        result: "dry_run",
        dryRun: true,
        startedAt: "2026-05-06T06:30:00Z",
        finishedAt: "2026-05-06T06:35:00Z",
      },
      review: {
        state: "pending",
        decision: null,
        decidedAt: null,
      },
      blockers: [],
    },
    {
      jobKey: sampleJob.jobKey,
      title: sampleJob.title,
      company: sampleJob.company,
      source: sampleJob.source,
      compensationSummary: sampleJob.compensationSummary,
      fitScore: sampleJob.fitScore,
      scoreBreakdown: sampleJob.scoreBreakdown,
      scoreKeywords: sampleJob.scoreKeywords,
      scoreReasoning: sampleJob.scoreReasoning,
      scoreVersion: sampleJob.scoreVersion,
      scoredAt: sampleJob.scoredAt,
      scoreCriteria: sampleJob.scoreCriteria,
      scoreTrace: sampleJob.scoreTrace,
      applicationUrl: sampleJob.applicationUrl,
      currentStage: "apply",
      currentState: "pending",
      materials: {
        hasResume: true,
        hasCoverLetter: false,
        hasPdf: true,
        ready: false,
      },
      applyAudit: makeApplyAudit(),
      position: {
        descriptionPreview:
          "Acme is hiring a staff software engineer to own platform reliability and product engineering workflows.",
        idealCandidate: null,
        idealRequirements: [],
        requirements: ["platform reliability", "team leadership"],
        matched: ["platform reliability"],
        missing: ["team leadership"],
        transferable: [],
        keywords: ["platform", "typescript"],
      },
      materialsPreview: {
        resumeText:
          "Staff Software Engineer\n\nTailored resume draft focused on reliability, TypeScript, and product platform delivery.",
        resumeTextArtifactId: "resume-text-1",
        resumePdfArtifactId: "resume-pdf-1",
        profileSourceFields: [],
        coverLetterText: null,
      },
      latestApplyRun: null,
      review: {
        state: "pending",
        decision: null,
        decidedAt: null,
      },
      blockers: ["cover letter missing"],
    },
  ],
};

export const sampleApplicationOutcomes: ApplicationOutcomeListResponse = {
  ok: true,
  outcomes: [
    {
      outcomeId: "outcome-1",
      jobKey: sampleSecondaryJob.jobKey,
      kind: "applied_confirmation",
      source: "manual",
      note: "Confirmed in the ATS portal.",
      occurredAt: "2026-05-06T07:10:00Z",
      recordedAt: "2026-05-06T07:12:00Z",
      suggestionId: null,
      evidenceId: null,
    },
  ],
  suggestions: [
    {
      suggestionId: "suggestion-1",
      jobKey: sampleSecondaryJob.jobKey,
      evidenceId: "evidence-1",
      suggestedKind: "interview",
      confidence: 0.84,
      rationale: "Recruiter reply indicates an interview request.",
      status: "pending",
      createdAt: "2026-05-06T08:00:00Z",
      decidedAt: null,
      decisionReason: null,
      decidedOutcomeId: null,
    },
  ],
};

export function makeJobsPage(items: readonly JobSummary[] = [sampleJob, sampleSecondaryJob]):
  PaginatedResponse<JobSummary> {
  return {
    ok: true,
    items: [...items],
    pagination: {
      page: 1,
      pageSize: 50,
      total: items.length,
      pages: 1,
    },
    sort: { field: "discovered_at", dir: "desc" },
    filter: {},
  };
}

export const sampleJobAuditHistory: JobAuditEntry[] = [
  {
    id: "event-1",
    category: "discovery",
    tone: "success",
    title: "Job discovered",
    description: "Found via lever:acme.",
    occurredAt: "2026-05-01T12:00:00Z",
    actor: "system",
    details: [
      { label: "Source", value: "lever:acme" },
      { label: "Employer", value: "Acme Corp" },
    ],
  },
  {
    id: "event-2",
    category: "scoring",
    tone: "success",
    title: "Job scored",
    description: "Fit score 8.",
    occurredAt: "2026-05-05T09:30:00Z",
    actor: "system",
    details: [
      { label: "Fit score", value: "8" },
      { label: "Fit band", value: "Strong" },
    ],
  },
  {
    id: "event-3",
    category: "apply",
    tone: "info",
    title: "Apply review decision recorded",
    description: "Human review approved a dry-run application.",
    occurredAt: "2026-05-06T06:20:00Z",
    actor: "user",
    details: [{ label: "Decision", value: "Approve Dry Run" }],
  },
];

export function makeJobDetail(
  job: JobSummary = sampleJob,
  overrides: Partial<Omit<JobDetail, "ok" | "job">> = {},
): JobDetail {
  const stages = overrides.stages ?? [
    {
      stage: "discover",
      state: "succeeded",
      attemptCount: 1,
      maxAttempts: 3,
      startedAt: "2026-05-01T12:00:00Z",
      updatedAt: "2026-05-01T12:00:30Z",
      finishedAt: "2026-05-01T12:00:30Z",
      durationMs: 30_000,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      blockedBy: [],
      nextAction: null,
    },
    {
      stage: "score",
      state: "succeeded",
      attemptCount: 1,
      maxAttempts: 3,
      startedAt: "2026-05-01T12:01:00Z",
      updatedAt: "2026-05-01T12:01:20Z",
      finishedAt: "2026-05-01T12:01:20Z",
      durationMs: 20_000,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      blockedBy: [],
      nextAction: null,
    },
  ];

  return {
    ok: true,
    job: {
      ...job,
      descriptionPreview: "Lead the platform engineering team...",
      scoreReasoning: job.scoreReasoning,
    },
    stages,
    artifacts: overrides.artifacts ?? [],
    auditHistory: overrides.auditHistory ?? sampleJobAuditHistory,
    applyAudit: overrides.applyAudit ?? makeApplyAudit(),
    employerAnalysis: overrides.employerAnalysis ?? null,
    requirementFitReport: overrides.requirementFitReport ?? null,
    compensationAudit: overrides.compensationAudit ?? null,
  };
}

export const sampleArtifact: ArtifactSummary = {
  artifactId: "artifact-1",
  jobKey: "job-1",
  title: "Staff Software Engineer — Resume",
  company: "Acme Corp",
  type: "resume_pdf",
  status: "approved",
  localPath: "/tmp/jobhunter-test/artifacts/artifact-1.pdf",
  createdAt: "2026-05-02T08:00:00Z",
  sizeBytes: 65_432,
  size: "63.9 KB",
};

export function makeArtifactsPage(items: readonly ArtifactSummary[] = [sampleArtifact]):
  PaginatedResponse<ArtifactSummary> {
  return {
    ok: true,
    items: [...items],
    pagination: {
      page: 1,
      pageSize: 50,
      total: items.length,
      pages: 1,
    },
    sort: { field: "created_at", dir: "desc" },
    filter: {},
  };
}

export function makeActivityPage(
  items: readonly ActivityEventSummary[] = sampleDashboardSummary.activity,
  page = 1,
  pageSize = 50,
  total = items.length,
): PaginatedResponse<ActivityEventSummary> {
  return {
    ok: true,
    items: [...items],
    pagination: {
      page,
      pageSize,
      total,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    },
    sort: { field: "occurred_at", dir: "desc" },
    filter: {},
  };
}

export function makeArtifactDetail(artifact: ArtifactSummary = sampleArtifact): ArtifactDetail {
  return { ok: true, artifact, tailoringExplanation: null };
}

export const sampleDashboardSummary: DashboardSummary = {
  ok: true,
  generatedAt: "2026-05-06T08:00:00Z",
  totals: {
    jobs: 12,
    jobsToday: 2,
    failures: 1,
    blocked: 0,
    ready: 5,
    applied: 3,
    appliedToday: 1,
    dryRuns: 2,
  },
  preparation: {
    currentScoringPolicyVersion: 2,
    currentTailoringPolicyVersion: 2,
    outdatedScoreCount: 1,
    outdatedTailoredArtifactCount: 1,
    workItems: {
      queued: 1,
      running: 1,
      failed: 0,
    },
  },
  funnel: [
    { stage: "discover", total: 12, succeeded: 12, running: 0, pending: 0, blocked: 0, failed: 0 },
    { stage: "score", total: 12, succeeded: 10, running: 1, pending: 0, blocked: 0, failed: 1 },
    { stage: "tailor", total: 8, succeeded: 5, running: 2, pending: 1, blocked: 0, failed: 0 },
    { stage: "apply", total: 5, succeeded: 3, running: 0, pending: 2, blocked: 0, failed: 0 },
  ],
  activity: [
    {
      eventId: "evt-1",
      eventType: "JobScored",
      jobKey: "job-1",
      title: sampleJob.title,
      company: sampleJob.company,
      stage: "score",
      level: "info",
      message: "Job scored 8/10",
      at: "2026-05-06T07:30:00Z",
    },
  ],
  progress: [],
  sourceHealth: [
    {
      sourceId: "greenhouse:acme",
      recommendedState: "normal",
      runCount: 2,
      failedRunCount: 0,
      consecutiveFailures: 0,
      observedJobs: 6,
      newJobs: 4,
      existingJobs: 2,
      duplicateRate: 0.1,
      activeVerificationRate: 0.9,
      fullDescriptionSuccessRate: 1,
      applyUrlSuccessRate: 0.8,
      operationalFailureCount: 1,
      scrapeFailureCount: 1,
      retryableFailureCount: 1,
      lastFailureCategory: "timeout",
      lastRunId: "run-1",
      lastErrorClass: "TimeoutError",
      updatedAt: "2026-05-06T07:40:00Z",
    },
  ],
  operationalMetrics: {
    attempts: 4,
    failures: 1,
    operationalFailures: 1,
    scrapeFailures: 1,
    retryableFailures: 1,
    byStage: [
      {
        stage: "discover",
        attempts: 2,
        failures: 1,
        operationalFailures: 1,
        scrapeFailures: 1,
        retryableFailures: 1,
        avgDurationMs: 800,
        lastOutcome: "failed",
        lastFailureCategory: "timeout",
        lastErrorClass: "TimeoutError",
      },
      {
        stage: "score",
        attempts: 1,
        failures: 0,
        operationalFailures: 0,
        scrapeFailures: 0,
        retryableFailures: 0,
        avgDurationMs: 120,
        lastOutcome: "succeeded",
        lastFailureCategory: null,
        lastErrorClass: null,
      },
      {
        stage: "apply",
        attempts: 1,
        failures: 0,
        operationalFailures: 0,
        scrapeFailures: 0,
        retryableFailures: 0,
        avgDurationMs: null,
        lastOutcome: "dry_run",
        lastFailureCategory: null,
        lastErrorClass: null,
      },
    ],
    bySource: [
      {
        stage: "discover",
        sourceId: "greenhouse:acme",
        adapter: "workday",
        sourceKind: "ats_api",
        sourcePriority: "canonical",
        sourceRole: "canonical_source",
        attempts: 1,
        failures: 1,
        operationalFailures: 1,
        scrapeFailures: 1,
        retryableFailures: 1,
        avgDurationMs: 800,
        lastOutcome: "failed",
        lastFailureCategory: "timeout",
        lastErrorClass: "TimeoutError",
        lastRunId: "run-1",
      },
    ],
  },
  applyRuns: [
    {
      runId: "run-1",
      jobKey: "job-1",
      title: sampleJob.title,
      company: sampleJob.company,
      status: "running",
      dryRun: false,
      startedAt: "2026-05-06T07:45:00Z",
      events: [
        {
          at: "2026-05-06T07:45:00Z",
          type: "ApplyRunStarted",
          level: "info",
          message: "Apply agent acquired job",
        },
      ],
    },
  ],
};

export const sampleProfileResponse: ProfileConfigResponse = {
  ok: true,
  profile: {
    personal: { full_name: "Jordan Candidate", email: "jordan@example.com" },
    resume: {
      executive_profile: { baseline_text: "Experienced platform leader." },
      experience_entries: [
        {
          id: "exp-1",
          title: "Director of Platform",
          company: "Initech",
          date_range: "2022-2025",
          location: "Remote",
          bullets: ["Scaled the platform 10x.", "Led the SRE org."],
        },
      ],
      education_entries: [],
      skill_categories: [],
      tailoring_rules: {},
    },
  },
  style: { font_family: "moderncv" },
  templateText: "\\documentclass{article}",
};

export const sampleSettingsResponse: SettingsResponse = {
  ok: true,
  settings: {
    targetRole: "Platform Engineering",
    locationFilter: "Remote",
    minFitScore: 7,
    autoApply: false,
    applyConcurrency: 2,
    scoreCriteria: "Platform reliability and team leadership.",
    targetCriteria: "Director-plus infrastructure roles.",
  },
  paths: { settingsPath: "/tmp/jobhunter-test/settings.json" },
};

export const sampleDiscoverySettingsResponse = {
  ok: true as const,
  settings: {
    boards: ["indeed", "linkedin", "zip_recruiter"] as const,
    resultsPerSite: 50,
    hoursOld: 72,
    source: "database" as const,
  },
};

export const sampleWorkflowRun: WorkflowRunSummary = {
  workflowId: "apply-run-1",
  runId: "apply-run-1",
  jobKey: "job-1",
  title: sampleJob.title,
  company: sampleJob.company,
  status: "in_progress",
  result: null,
  dryRun: false,
  model: "haiku",
  startedAt: "2026-05-06T07:45:00Z",
  finishedAt: null,
  durationMs: null,
};

export const sampleWorkflowRunCompleted: WorkflowRunSummary = {
  workflowId: "apply-run-2",
  runId: "apply-run-2",
  jobKey: "job-2",
  title: sampleSecondaryJob.title,
  company: sampleSecondaryJob.company,
  status: "succeeded",
  result: "applied",
  dryRun: false,
  model: "haiku",
  startedAt: "2026-05-06T06:30:00Z",
  finishedAt: "2026-05-06T06:35:00Z",
  durationMs: 300_000,
};

export function makeWorkflowRunsPage(
  items: readonly WorkflowRunSummary[] = [sampleWorkflowRun, sampleWorkflowRunCompleted],
): PaginatedResponse<WorkflowRunSummary> {
  return {
    ok: true,
    items: [...items],
    pagination: {
      page: 1,
      pageSize: 50,
      total: items.length,
      pages: 1,
    },
    sort: { field: "started_at", dir: "desc" },
    filter: { status: "all" },
  };
}

export const sampleCredentialsResponse: CredentialsResponse = {
  ok: true,
  credentials: [
    { key: "OPENAI_API_KEY", label: "OpenAI API Key", configured: true, storage: "keychain" },
    { key: "GEMINI_API_KEY", label: "Gemini API Key", configured: false, storage: "keychain" },
    { key: "LLM_URL", label: "Custom LLM URL", configured: false, storage: "keychain" },
  ],
};
