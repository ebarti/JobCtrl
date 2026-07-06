import type {
  ActionRunResponse,
  ActivityEventResponse,
  ActivityEventSummary,
  ActivityListQuery,
  ApplicationOutcomeListResponse,
  ApplicationOutcomeWriteResponse,
  ApplyJobRequest,
  ApplyReviewDecisionRequest,
  ApplyReviewDecisionResponse,
  ApplyReviewQueueResponse,
  ArtifactDetail,
  ArtifactListQuery,
  ArtifactOpenResponse,
  ArtifactSummary,
  BulkJobMutationRequest,
  BulkRunPendingPreparationRequest,
  BulkRunPendingPreparationResponse,
  BulkRetryFailedRequest,
  BulkRetryFailedResponse,
  BulkRescoreJobsNotOnCurrentScoringPolicyRequest,
  BulkRetailorCurrentPolicyRequest,
  CancelJobActionRequest,
  CompensationSourceRegistryResponse,
  CredentialKey,
  CorrectScoreRequest,
  CorrectScoreResponse,
  CredentialsResponse,
  CredentialUpdateRequest,
  DigestAcknowledgeRequest,
  DigestAcknowledgeResponse,
  DashboardSummary,
  DailyDigest,
  DeleteJobRequest,
  DiscoverySettingsResponse,
  DiscoverySettingsUpdateRequest,
  DiscoveryFeedbackRequest,
  DiscoveryFeedbackResponse,
  DiscoveryPreviewResponse,
  EvidenceMapResponse,
  GenerateInterviewPrepRequest,
  GenerateMaterialsRequest,
  GmailOutcomeScanRequest,
  GmailOutcomeScanResponse,
  EnsureCurrentResumeMaterialsRequest,
  EnsureCurrentResumeMaterialsResponse,
  ExtensionCapabilityTokenResponse,
  JobResumeTemplateAssignmentRequest,
  JobResumeTemplateAssignmentResponse,
  JobDetail,
  JobApplicationOutcomeListResponse,
  JobListQuery,
  JobMutationResponse,
  JobSummary,
  MarkJobActionRequest,
  ManualCaptureDismissRequest,
  ManualCaptureDismissResponse,
  ManualCaptureImportRequest,
  ManualCaptureImportResponse,
  ManualCaptureListResponse,
  ManualApplicationOutcomeRequest,
  MarketCompensationEstimateResponse,
  OutcomeSuggestionDecisionRequest,
  OutcomeSuggestionDecisionResponse,
  OutcomeAnalyticsSummary,
  PaginatedResponse,
  PostedCompensationFactResponse,
  ProfileConfigResponse,
  ProfileImportRequest,
  ProfileImportResponse,
  ProfileUpdateRequest,
  PipelineStageRunResponse,
  QuarantineDecision,
  QuarantineDecisionResponse,
  QuarantineListResponse,
  RefreshCompensationRequest,
  RoleMatchFeedbackDecisionRequest,
  RoleMatchFeedbackDecisionResponse,
  RoleMatchFeedbackListResponse,
  RescoreJobRequest,
  RetailorJobRequest,
  ResumeTemplateDefaultSelectionRequest,
  ResumeTemplateDefaultSelectionResponse,
  ResumeTemplateDetailResponse,
  ResumeTemplateListResponse,
  ResumeTemplateVersionSaveRequest,
  ResumeTemplateVersionSaveResponse,
  ResumeCommentReplyRequest,
  ResumeCommentReplyResponse,
  ResumeReviewCommentThreadSeedRequest,
  ResumeReviewCommentThreadSeedResponse,
  ResumeReviewDraftCreateRequest,
  ResumeReviewDraftRenderRequest,
  ResumeReviewDraftRenderResponse,
  ResumeReviewDraftResponse,
  ResumeReviewDraftRevisionResponse,
  ResumeReviewDraftRevisionSaveRequest,
  ResumeReviewFeedbackListResponse,
  TailorJobRequest,
  RetryStageRequest,
  RunJobStageRequest,
  ResetStaleScoresForRescoreRequest,
  ResetStaleScoresForRescoreResponse,
  RunPipelineStagesRequest,
  SampleDataMutationResponse,
  SampleDataStatus,
  SampleDataTtfvProbeResponse,
  SettingsUpdateRequest,
  SettingsResponse,
  SourceLocatorListResponse,
  SourceLocatorDecisionRequest,
  SourceLocatorDecisionResponse,
  SourceRegistryListResponse,
  SourceRegistryMutationResponse,
  SourceStatePatch,
  SourceUpsertRequest,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowRunsListQuery,
} from "@jobhunter/contracts";

type QueryValue = boolean | number | string | null | undefined;
const DEFAULT_NODE_BASE_URL = "http://127.0.0.1:8766";

export class JobHunterApiError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string) {
    super(`JobHunter API request failed: ${status} ${statusText}`);
    this.name = "JobHunterApiError";
    this.status = status;
    this.statusText = statusText;
  }
}

export interface HealthResponse {
  ok: true;
  appDir: string;
  dbPath: string;
  dbExists: boolean;
  dbIdentity: string | null;
  llmSpend: {
    status: "ok" | "over_budget";
    day: string;
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number;
    dailyBudgetUsd: number;
    remainingUsd: number | null;
    unlimited: boolean;
    message: string;
  };
  worker: {
    status: "healthy" | "missing" | "stale" | "mismatched";
    expectedDbPath: string;
    expectedAppDir: string;
    staleAfterSeconds: number;
    message: string;
    heartbeat: {
      workerId: string;
      component: string;
      pid: number | null;
      hostname: string;
      appDir: string;
      dbPath: string;
      taskQueue: string;
      startedAt: string;
      lastSeenAt: string;
      maxConcurrentActivities: number | null;
      activityExecutorMaxWorkers: number | null;
    } | null;
  };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class JobHunterApiClient {
  readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(baseUrl = defaultBaseUrl(), requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.requestTimeoutMs = requestTimeoutMs;
  }

  health(): Promise<HealthResponse> {
    return this.get("/v1/health");
  }

  dashboardSummary(): Promise<DashboardSummary> {
    return this.get("/v1/dashboard/summary");
  }

  sampleDataStatus(): Promise<SampleDataStatus> {
    return this.get("/v1/sample-data/status");
  }

  loadSampleData(): Promise<SampleDataMutationResponse> {
    return this.post("/v1/sample-data/load", {});
  }

  clearSampleData(): Promise<SampleDataMutationResponse> {
    return this.post("/v1/sample-data/clear", {});
  }

  sampleDataTtfvProbe(): Promise<SampleDataTtfvProbeResponse> {
    return this.get("/v1/sample-data/ttfv-probe");
  }

  outcomeAnalytics(): Promise<OutcomeAnalyticsSummary> {
    return this.get("/v1/analytics/outcomes");
  }

  digest(): Promise<DailyDigest> {
    return this.get("/v1/digest");
  }

  acknowledgeDigest(body: DigestAcknowledgeRequest = {}): Promise<DigestAcknowledgeResponse> {
    return this.post("/v1/digest/acknowledge", body);
  }

  activity(query: Partial<ActivityListQuery> = {}): Promise<PaginatedResponse<ActivityEventSummary>> {
    return this.get("/v1/debug/activity", query);
  }

  activityEvent(eventId: string): Promise<ActivityEventResponse> {
    return this.get(`/v1/debug/activity/${encodeURIComponent(eventId)}`);
  }

  discoverySources(): Promise<SourceRegistryListResponse> {
    return this.get("/v1/discovery/sources");
  }

  discoverySettings(): Promise<DiscoverySettingsResponse> {
    return this.get("/v1/discovery/settings");
  }

  updateDiscoverySettings(body: DiscoverySettingsUpdateRequest): Promise<DiscoverySettingsResponse> {
    return this.patch("/v1/discovery/settings", body);
  }

  upsertDiscoverySource(body: SourceUpsertRequest): Promise<SourceRegistryMutationResponse> {
    return this.post("/v1/discovery/sources", body);
  }

  patchDiscoverySourceState(
    sourceId: string,
    body: SourceStatePatch,
  ): Promise<SourceRegistryMutationResponse> {
    return this.patch(`/v1/discovery/sources/${encodeURIComponent(sourceId)}/state`, body);
  }

  discoverySourcePreview(sourceId: string): Promise<DiscoveryPreviewResponse> {
    return this.get(`/v1/discovery/sources/${encodeURIComponent(sourceId)}/preview`);
  }

  compensationSources(): Promise<CompensationSourceRegistryResponse> {
    return this.get("/v1/compensation/sources");
  }

  postedCompensationFact(jobKey: string): Promise<PostedCompensationFactResponse> {
    return this.get(`/v1/jobs/${encodeURIComponent(jobKey)}/compensation/posted`);
  }

  marketCompensationEstimate(jobKey: string): Promise<MarketCompensationEstimateResponse> {
    return this.get(`/v1/jobs/${encodeURIComponent(jobKey)}/compensation/market`);
  }

  refreshCompensation(jobKey: string, body: RefreshCompensationRequest = {}): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/refresh-compensation`, body);
  }

  refreshAllCompensation(body: RefreshCompensationRequest = {}): Promise<ActionRunResponse> {
    return this.post("/v1/jobs/actions/refresh-compensation", body);
  }

  discoveryLocatorCandidates(): Promise<SourceLocatorListResponse> {
    return this.get("/v1/discovery/locator-candidates");
  }

  promoteSourceLocatorCandidate(
    candidateId: string,
    body: SourceLocatorDecisionRequest = {},
  ): Promise<SourceLocatorDecisionResponse> {
    return this.post(
      `/v1/discovery/locator-candidates/${encodeURIComponent(candidateId)}/promote`,
      body,
    );
  }

  rejectSourceLocatorCandidate(
    candidateId: string,
    body: SourceLocatorDecisionRequest = {},
  ): Promise<SourceLocatorDecisionResponse> {
    return this.post(
      `/v1/discovery/locator-candidates/${encodeURIComponent(candidateId)}/reject`,
      body,
    );
  }

  discoveryQuarantine(): Promise<QuarantineListResponse> {
    return this.get("/v1/discovery/quarantine");
  }

  decideDiscoveryQuarantine(
    jobKey: string,
    body: QuarantineDecision,
  ): Promise<QuarantineDecisionResponse> {
    return this.post(`/v1/discovery/quarantine/${encodeURIComponent(jobKey)}/decision`, body);
  }

  manualCaptureQueue(): Promise<ManualCaptureListResponse> {
    return this.get("/v1/discovery/manual-capture");
  }

  importManualCapture(
    itemId: string,
    body: ManualCaptureImportRequest,
  ): Promise<ManualCaptureImportResponse> {
    return this.post(`/v1/discovery/manual-capture/${encodeURIComponent(itemId)}/import`, body);
  }

  dismissManualCapture(
    itemId: string,
    body: ManualCaptureDismissRequest = {},
  ): Promise<ManualCaptureDismissResponse> {
    return this.post(`/v1/discovery/manual-capture/${encodeURIComponent(itemId)}/dismiss`, body);
  }

  recordDiscoveryFeedback(body: DiscoveryFeedbackRequest): Promise<DiscoveryFeedbackResponse> {
    return this.post("/v1/discovery/feedback", body);
  }

  roleMatchFeedbackSuggestions(): Promise<RoleMatchFeedbackListResponse> {
    return this.get("/v1/discovery/role-match-feedback");
  }

  decideRoleMatchFeedbackSuggestion(
    suggestionId: string,
    body: RoleMatchFeedbackDecisionRequest,
  ): Promise<RoleMatchFeedbackDecisionResponse> {
    return this.post(
      `/v1/discovery/role-match-feedback/${encodeURIComponent(suggestionId)}/decision`,
      body,
    );
  }

  applyReviewQueue(): Promise<ApplyReviewQueueResponse> {
    return this.get("/v1/apply/review-queue");
  }

  decideApplyReview(
    jobKey: string,
    body: ApplyReviewDecisionRequest,
  ): Promise<ApplyReviewDecisionResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/apply-review/decision`, body);
  }

  resumeReviewDraft(jobKey: string): Promise<ResumeReviewDraftResponse> {
    return this.get(`/v1/jobs/${encodeURIComponent(jobKey)}/resume-review/draft`);
  }

  createResumeReviewDraft(
    jobKey: string,
    body: ResumeReviewDraftCreateRequest = {},
  ): Promise<ResumeReviewDraftResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/resume-review/draft`, body);
  }

  saveResumeReviewDraftRevision(
    draftId: string,
    body: ResumeReviewDraftRevisionSaveRequest,
  ): Promise<ResumeReviewDraftRevisionResponse> {
    return this.post(`/v1/resume-review/drafts/${encodeURIComponent(draftId)}/revisions`, body);
  }

  seedResumeReviewCommentThreads(
    draftId: string,
    body: ResumeReviewCommentThreadSeedRequest,
  ): Promise<ResumeReviewCommentThreadSeedResponse> {
    return this.post(`/v1/resume-review/drafts/${encodeURIComponent(draftId)}/comment-threads`, body);
  }

  renderResumeReviewDraft(
    draftId: string,
    body: ResumeReviewDraftRenderRequest = {},
  ): Promise<ResumeReviewDraftRenderResponse> {
    return this.post(`/v1/resume-review/drafts/${encodeURIComponent(draftId)}/render`, body);
  }

  replyToResumeReviewComment(
    threadId: string,
    body: ResumeCommentReplyRequest,
  ): Promise<ResumeCommentReplyResponse> {
    return this.post(`/v1/resume-review/comment-threads/${encodeURIComponent(threadId)}/replies`, body);
  }

  resumeReviewFeedback(jobKey: string): Promise<ResumeReviewFeedbackListResponse> {
    return this.get(`/v1/jobs/${encodeURIComponent(jobKey)}/resume-review/feedback`);
  }

  resumeTemplates(): Promise<ResumeTemplateListResponse> {
    return this.get("/v1/resume-templates");
  }

  resumeTemplate(templateId: string): Promise<ResumeTemplateDetailResponse> {
    return this.get(`/v1/resume-templates/${encodeURIComponent(templateId)}`);
  }

  saveResumeTemplate(
    body: ResumeTemplateVersionSaveRequest,
  ): Promise<ResumeTemplateVersionSaveResponse> {
    return this.post("/v1/resume-templates", body);
  }

  setDefaultResumeTemplate(
    body: ResumeTemplateDefaultSelectionRequest,
  ): Promise<ResumeTemplateDefaultSelectionResponse> {
    return this.patch("/v1/resume-templates/default", body);
  }

  setJobResumeTemplate(
    jobKey: string,
    body: JobResumeTemplateAssignmentRequest,
  ): Promise<JobResumeTemplateAssignmentResponse> {
    return this.patch(`/v1/jobs/${encodeURIComponent(jobKey)}/resume-template`, body);
  }

  ensureCurrentResumeMaterials(
    jobKey: string,
    body: Partial<EnsureCurrentResumeMaterialsRequest> = {},
  ): Promise<EnsureCurrentResumeMaterialsResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/resume-template/ensure-current`, body);
  }

  applicationOutcomes(): Promise<ApplicationOutcomeListResponse> {
    return this.get("/v1/outcomes");
  }

  jobApplicationOutcomes(jobKey: string): Promise<JobApplicationOutcomeListResponse> {
    return this.get(`/v1/jobs/${encodeURIComponent(jobKey)}/outcomes`);
  }

  recordManualApplicationOutcome(
    jobKey: string,
    body: ManualApplicationOutcomeRequest,
  ): Promise<ApplicationOutcomeWriteResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/outcomes`, body);
  }

  decideOutcomeSuggestion(
    suggestionId: string,
    body: OutcomeSuggestionDecisionRequest,
  ): Promise<OutcomeSuggestionDecisionResponse> {
    return this.post(`/v1/outcome-suggestions/${encodeURIComponent(suggestionId)}/decision`, body);
  }

  scanGmailApplicationOutcomes(
    body: GmailOutcomeScanRequest = {},
  ): Promise<GmailOutcomeScanResponse> {
    return this.post("/v1/outcomes/gmail/scan", body);
  }

  jobs(query: Partial<JobListQuery> = {}): Promise<PaginatedResponse<JobSummary>> {
    return this.get("/v1/jobs", query);
  }

  job(jobKey: string): Promise<JobDetail> {
    return this.get(`/v1/jobs/${encodeURIComponent(jobKey)}`);
  }

  evidenceMap(): Promise<EvidenceMapResponse> {
    return this.get("/v1/evidence-map");
  }

  deleteJob(jobKey: string, body: DeleteJobRequest = {}): Promise<JobMutationResponse> {
    return this.delete(`/v1/jobs/${encodeURIComponent(jobKey)}`, body);
  }

  deleteJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse> {
    return this.post("/v1/jobs/bulk-delete", body);
  }

  permanentlyDeleteJob(jobKey: string): Promise<JobMutationResponse> {
    return this.delete(`/v1/jobs/${encodeURIComponent(jobKey)}/permanent`);
  }

  permanentlyDeleteJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse> {
    return this.post("/v1/jobs/bulk-delete-permanent", body);
  }

  restoreJob(jobKey: string): Promise<JobMutationResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/restore`);
  }

  restoreJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse> {
    return this.post("/v1/jobs/bulk-restore", body);
  }

  hideJob(jobKey: string, body: DeleteJobRequest = {}): Promise<JobMutationResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/hide`, body);
  }

  hideJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse> {
    return this.post("/v1/jobs/bulk-hide", body);
  }

  unhideJob(jobKey: string): Promise<JobMutationResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/unhide`);
  }

  unhideJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse> {
    return this.post("/v1/jobs/bulk-unhide", body);
  }

  retryFailedJobs(body: BulkRetryFailedRequest): Promise<BulkRetryFailedResponse> {
    return this.post("/v1/jobs/bulk-retry-failed", body);
  }

  runPendingPreparation(body: BulkRunPendingPreparationRequest): Promise<BulkRunPendingPreparationResponse> {
    return this.post("/v1/jobs/bulk-run-pending-preparation", body);
  }

  correctScore(jobKey: string, body: CorrectScoreRequest): Promise<CorrectScoreResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/score-correction`, body);
  }

  resetStaleScoresForRescore(
    body: ResetStaleScoresForRescoreRequest = { limit: 0, jobKeys: [] },
  ): Promise<ResetStaleScoresForRescoreResponse> {
    return this.post("/v1/scoring/stale-scores/actions/reset-for-rescore", body);
  }

  rescoreJob(jobKey: string, body: Partial<RescoreJobRequest> = {}): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/rescore-current-policy`, body);
  }

  rescoreJobsNotOnCurrentScoringPolicy(
    body: BulkRescoreJobsNotOnCurrentScoringPolicyRequest,
  ): Promise<ActionRunResponse> {
    return this.post("/v1/scoring/actions/rescore-current-policy", body);
  }

  retailorJob(jobKey: string, body: Partial<RetailorJobRequest> = {}): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/retailor-current-policy`, body);
  }

  tailorJob(jobKey: string, body: Partial<TailorJobRequest> = {}): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/tailor`, body);
  }

  retailorCurrentPolicy(body: BulkRetailorCurrentPolicyRequest): Promise<ActionRunResponse> {
    return this.post("/v1/materials/actions/retailor-current-policy", body);
  }

  workflowRuns(
    query: Partial<WorkflowRunsListQuery> = {},
  ): Promise<PaginatedResponse<WorkflowRunSummary>> {
    return this.get("/v1/workflow-runs", query);
  }

  workflowRun(runId: string): Promise<WorkflowRunDetail> {
    return this.get(`/v1/workflow-runs/${encodeURIComponent(runId)}`);
  }

  cancelWorkflowRun(runId: string): Promise<ActionRunResponse> {
    return this.post(`/v1/workflow-runs/${encodeURIComponent(runId)}/actions/cancel`);
  }

  artifacts(query: Partial<ArtifactListQuery> = {}): Promise<PaginatedResponse<ArtifactSummary>> {
    return this.get("/v1/artifacts", query);
  }

  artifact(artifactId: string): Promise<ArtifactDetail> {
    return this.get(`/v1/artifacts/${encodeURIComponent(artifactId)}`);
  }

  artifactPreviewPdfUrl(artifactId: string, cacheKey?: QueryValue): string {
    const path = `/v1/artifacts/${encodeURIComponent(artifactId)}/preview.pdf`;
    const url = new URL(`${this.baseUrl}${path}`, this.baseUrl ? undefined : "http://jobhunter.local");
    if (cacheKey !== undefined && cacheKey !== null && cacheKey !== "") {
      url.searchParams.set("v", String(cacheKey));
    }
    return this.baseUrl ? url.href : `${url.pathname}${url.search}`;
  }

  artifactPreviewHtmlUrl(artifactId: string, cacheKey?: QueryValue): string {
    const path = `/v1/artifacts/${encodeURIComponent(artifactId)}/preview.html`;
    const url = new URL(`${this.baseUrl}${path}`, this.baseUrl ? undefined : "http://jobhunter.local");
    if (cacheKey !== undefined && cacheKey !== null && cacheKey !== "") {
      url.searchParams.set("v", String(cacheKey));
    }
    return this.baseUrl ? url.href : `${url.pathname}${url.search}`;
  }

  openArtifact(artifactId: string): Promise<ArtifactOpenResponse> {
    return this.post(`/v1/artifacts/${encodeURIComponent(artifactId)}/open`);
  }

  profile(): Promise<ProfileConfigResponse> {
    return this.get("/v1/profile");
  }

  profilePreviewPdfUrl(cacheKey?: QueryValue): string {
    const path = "/v1/profile/preview.pdf";
    const url = new URL(`${this.baseUrl}${path}`, this.baseUrl ? undefined : "http://jobhunter.local");
    if (cacheKey !== undefined && cacheKey !== null && cacheKey !== "") {
      url.searchParams.set("v", String(cacheKey));
    }
    return this.baseUrl ? url.href : `${url.pathname}${url.search}`;
  }

  profilePreviewHtmlUrl(cacheKey?: QueryValue): string {
    const path = "/v1/profile/preview.html";
    const url = new URL(`${this.baseUrl}${path}`, this.baseUrl ? undefined : "http://jobhunter.local");
    if (cacheKey !== undefined && cacheKey !== null && cacheKey !== "") {
      url.searchParams.set("v", String(cacheKey));
    }
    return this.baseUrl ? url.href : `${url.pathname}${url.search}`;
  }

  updateProfile(body: ProfileUpdateRequest): Promise<ProfileConfigResponse> {
    return this.patch("/v1/profile", body);
  }

  importResume(body: ProfileImportRequest): Promise<ProfileImportResponse> {
    return this.post("/v1/profile/import-resume", body);
  }

  settings(): Promise<SettingsResponse> {
    return this.get("/v1/settings");
  }

  updateSettings(body: SettingsUpdateRequest): Promise<SettingsResponse> {
    return this.patch("/v1/settings", body);
  }

  extensionCapabilityToken(): Promise<ExtensionCapabilityTokenResponse> {
    return this.get("/v1/extension/pairing-token");
  }

  rotateExtensionCapabilityToken(): Promise<ExtensionCapabilityTokenResponse> {
    return this.post("/v1/extension/pairing-token/rotate", {});
  }

  runPipelineStages(body: RunPipelineStagesRequest): Promise<PipelineStageRunResponse> {
    return this.post("/v1/pipeline/actions/run-stage", body);
  }

  credentials(): Promise<CredentialsResponse> {
    return this.get("/v1/credentials");
  }

  updateCredential(body: CredentialUpdateRequest): Promise<CredentialsResponse> {
    return this.patch("/v1/credentials", body);
  }

  deleteCredential(key: CredentialKey): Promise<CredentialsResponse> {
    return this.delete(`/v1/credentials/${encodeURIComponent(key)}`);
  }

  retryStage(jobKey: string, body: RetryStageRequest): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/retry-stage`, body);
  }

  runJobStage(jobKey: string, body: RunJobStageRequest): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/run-stage`, body);
  }

  generateMaterials(jobKey: string, body: Partial<GenerateMaterialsRequest> = {}): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/generate-materials`, body);
  }

  generateInterviewPrep(
    jobKey: string,
    body: Partial<GenerateInterviewPrepRequest> = {},
  ): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/generate-interview-prep`, body);
  }

  applyJob(jobKey: string, body: Partial<ApplyJobRequest> = {}): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/apply`, body);
  }

  cancelJobAction(jobKey: string, body: CancelJobActionRequest = {}): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/cancel`, body);
  }

  markApplied(jobKey: string, body: MarkJobActionRequest = {}): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/mark-applied`, body);
  }

  markSkipped(jobKey: string, body: MarkJobActionRequest = {}): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/mark-skipped`, body);
  }

  private async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request("GET", path, query ? { query } : {});
  }

  private async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request("PATCH", path, { body });
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request("POST", path, { body });
  }

  private async delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request("DELETE", path, { body });
  }

  private async request<T>(
    method: "DELETE" | "GET" | "PATCH" | "POST",
    path: string,
    options: { body?: unknown; query?: Record<string, QueryValue> } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`, this.baseUrl ? undefined : "http://jobhunter.local");
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const href = this.baseUrl ? url.href : `${url.pathname}${url.search}`;
    const init: RequestInit = { method };
    if (method !== "GET" && options.body !== undefined) {
      init.body = JSON.stringify(options.body);
      init.headers = { "content-type": "application/json" };
    }
    // Bound every request with an AbortController so a stuck API call (e.g. the
    // API waiting on a hung worker) fails cleanly instead of freezing the tab.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(href, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`JobHunter API request timed out after ${this.requestTimeoutMs}ms: ${method} ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new JobHunterApiError(response.status, response.statusText);
    }
    return (await response.json()) as T;
  }
}

export function createJobHunterApiClient(baseUrl?: string): JobHunterApiClient {
  return new JobHunterApiClient(baseUrl);
}

function defaultBaseUrl(): string {
  return "window" in globalThis ? "" : DEFAULT_NODE_BASE_URL;
}
