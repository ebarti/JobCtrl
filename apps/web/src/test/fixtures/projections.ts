import type {
  ArtifactDetail,
  ArtifactSummary,
  CredentialsResponse,
  DashboardSummary,
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
  currentState: "running",
  errorCode: null,
  errorMessage: null,
  nextAction: null,
  artifactCount: 1,
  applyStatus: null,
  appliedAt: null,
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
  currentState: "succeeded",
  artifactCount: 2,
  applyStatus: "applied",
  appliedAt: "2026-05-04T10:00:00Z",
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

export function makeArtifactDetail(artifact: ArtifactSummary = sampleArtifact): ArtifactDetail {
  return { ok: true, artifact };
}

export const sampleDashboardSummary: DashboardSummary = {
  ok: true,
  generatedAt: "2026-05-06T08:00:00Z",
  totals: {
    jobs: 12,
    failures: 1,
    blocked: 0,
    ready: 5,
    applied: 3,
    dryRuns: 2,
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
      lastRunId: "run-1",
      lastErrorClass: null,
      updatedAt: "2026-05-06T07:40:00Z",
    },
  ],
  applyRuns: [
    {
      runId: "run-1",
      jobKey: "job-1",
      title: sampleJob.title,
      company: sampleJob.company,
      status: "running",
      dryRun: false,
      startedAt: "2026-05-06T07:45:00Z",
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
