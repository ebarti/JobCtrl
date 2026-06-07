import type {
  ArtifactDetail,
  ArtifactSummary,
  ActivityEventSummary,
  ApplicationOutcomeListResponse,
  ApplyReviewQueueResponse,
  CredentialsResponse,
  DashboardSummary,
  JobAuditEntry,
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
    message: "Temporal worker heartbeat is current and uses the API database.",
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
  fitScore: 9,
  currentStage: "apply",
  currentSubstage: "apply",
  currentState: "succeeded",
  artifactCount: 2,
  applyStatus: "applied",
  appliedAt: "2026-05-04T10:00:00Z",
};

export const sampleApplyReviewQueue: ApplyReviewQueueResponse = {
  ok: true,
  items: [
    {
      jobKey: sampleSecondaryJob.jobKey,
      title: sampleSecondaryJob.title,
      company: sampleSecondaryJob.company,
      source: sampleSecondaryJob.source,
      fitScore: sampleSecondaryJob.fitScore,
      applicationUrl: sampleSecondaryJob.applicationUrl,
      currentStage: "apply",
      currentState: "succeeded",
      materials: {
        hasResume: true,
        hasCoverLetter: true,
        hasPdf: true,
        ready: true,
      },
      position: {
        descriptionPreview:
          "Globex needs a principal engineer to lead platform reliability, incident response, and developer experience improvements.",
        requirements: ["platform reliability", "SRE leadership", "incident response"],
        matched: ["platform reliability", "SRE leadership"],
        missing: ["public company scale"],
        transferable: ["incident leadership"],
        keywords: ["platform reliability", "sre"],
      },
      materialsPreview: {
        resumeText:
          "Principal Platform Engineer\n\nLed platform reliability programs and incident response improvements for distributed systems teams.",
        resumePdfArtifactId: "resume-pdf-2",
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
      fitScore: sampleJob.fitScore,
      applicationUrl: sampleJob.applicationUrl,
      currentStage: "apply",
      currentState: "pending",
      materials: {
        hasResume: true,
        hasCoverLetter: false,
        hasPdf: true,
        ready: false,
      },
      position: {
        descriptionPreview:
          "Acme is hiring a staff software engineer to own platform reliability and product engineering workflows.",
        requirements: ["platform reliability", "team leadership"],
        matched: ["platform reliability"],
        missing: ["team leadership"],
        transferable: [],
        keywords: ["platform", "typescript"],
      },
      materialsPreview: {
        resumeText:
          "Staff Software Engineer\n\nTailored resume draft focused on reliability, TypeScript, and product platform delivery.",
        resumePdfArtifactId: "resume-pdf-1",
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

export function makeJobDetail(job: JobSummary = sampleJob): JobDetail {
  return {
    ok: true,
    job: {
      ...job,
      descriptionPreview: "Lead the platform engineering team...",
      scoreReasoning: job.scoreReasoning,
    },
    stages: [
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
    ],
    artifacts: [],
    auditHistory: sampleJobAuditHistory,
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
