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
  ExtensionCapabilityTokenResponse,
  EvidenceMapResponse,
  GenerateMaterialsRequest,
  JobDetail,
  EnsureCurrentResumeMaterialsRequest,
  EnsureCurrentResumeMaterialsResponse,
  JobResumeTemplateAssignmentRequest,
  JobResumeTemplateAssignmentResponse,
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
  OutcomeSuggestionDecisionRequest,
  OutcomeSuggestionDecisionResponse,
  OutcomeAnalyticsSummary,
  PaginatedResponse,
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
  ResumeTemplateDefaultSelectionRequest,
  ResumeTemplateDefaultSelectionResponse,
  ResumeTemplateDetailResponse,
  ResumeTemplateListResponse,
  ResumeTemplateVersionSaveRequest,
  ResumeTemplateVersionSaveResponse,
  TailorJobRequest,
  RetryStageRequest,
  RunJobStageRequest,
  ResetStaleScoresForRescoreRequest,
  ResetStaleScoresForRescoreResponse,
  RunPipelineStagesRequest,
  SettingsResponse,
  SettingsUpdateRequest,
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

export interface ApiHealthResponse {
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

export interface ApiClientPort {
  health(): Promise<ApiHealthResponse>;
  dashboardSummary(): Promise<DashboardSummary>;
  outcomeAnalytics(): Promise<OutcomeAnalyticsSummary>;
  digest(): Promise<DailyDigest>;
  acknowledgeDigest(body?: DigestAcknowledgeRequest): Promise<DigestAcknowledgeResponse>;
  activity(query?: Partial<ActivityListQuery>): Promise<PaginatedResponse<ActivityEventSummary>>;
  activityEvent(eventId: string): Promise<ActivityEventResponse>;
  discoverySettings(): Promise<DiscoverySettingsResponse>;
  updateDiscoverySettings(body: DiscoverySettingsUpdateRequest): Promise<DiscoverySettingsResponse>;
  discoverySources(): Promise<SourceRegistryListResponse>;
  upsertDiscoverySource(body: SourceUpsertRequest): Promise<SourceRegistryMutationResponse>;
  patchDiscoverySourceState(
    sourceId: string,
    body: SourceStatePatch,
  ): Promise<SourceRegistryMutationResponse>;
  discoverySourcePreview(sourceId: string): Promise<DiscoveryPreviewResponse>;
  compensationSources(): Promise<CompensationSourceRegistryResponse>;
  discoveryLocatorCandidates(): Promise<SourceLocatorListResponse>;
  promoteSourceLocatorCandidate(
    candidateId: string,
    body?: SourceLocatorDecisionRequest,
  ): Promise<SourceLocatorDecisionResponse>;
  rejectSourceLocatorCandidate(
    candidateId: string,
    body?: SourceLocatorDecisionRequest,
  ): Promise<SourceLocatorDecisionResponse>;
  discoveryQuarantine(): Promise<QuarantineListResponse>;
  decideDiscoveryQuarantine(
    jobKey: string,
    body: QuarantineDecision,
  ): Promise<QuarantineDecisionResponse>;
  manualCaptureQueue(): Promise<ManualCaptureListResponse>;
  importManualCapture(
    itemId: string,
    body: ManualCaptureImportRequest,
  ): Promise<ManualCaptureImportResponse>;
  dismissManualCapture(
    itemId: string,
    body?: ManualCaptureDismissRequest,
  ): Promise<ManualCaptureDismissResponse>;
  recordDiscoveryFeedback(body: DiscoveryFeedbackRequest): Promise<DiscoveryFeedbackResponse>;
  roleMatchFeedbackSuggestions(): Promise<RoleMatchFeedbackListResponse>;
  decideRoleMatchFeedbackSuggestion(
    suggestionId: string,
    body: RoleMatchFeedbackDecisionRequest,
  ): Promise<RoleMatchFeedbackDecisionResponse>;
  applyReviewQueue(): Promise<ApplyReviewQueueResponse>;
  decideApplyReview(
    jobKey: string,
    body: ApplyReviewDecisionRequest,
  ): Promise<ApplyReviewDecisionResponse>;
  resumeReviewDraft(jobKey: string): Promise<ResumeReviewDraftResponse>;
  createResumeReviewDraft(
    jobKey: string,
    body?: ResumeReviewDraftCreateRequest,
  ): Promise<ResumeReviewDraftResponse>;
  saveResumeReviewDraftRevision(
    draftId: string,
    body: ResumeReviewDraftRevisionSaveRequest,
  ): Promise<ResumeReviewDraftRevisionResponse>;
  seedResumeReviewCommentThreads(
    draftId: string,
    body: ResumeReviewCommentThreadSeedRequest,
  ): Promise<ResumeReviewCommentThreadSeedResponse>;
  renderResumeReviewDraft(
    draftId: string,
    body?: ResumeReviewDraftRenderRequest,
  ): Promise<ResumeReviewDraftRenderResponse>;
  replyToResumeReviewComment(
    threadId: string,
    body: ResumeCommentReplyRequest,
  ): Promise<ResumeCommentReplyResponse>;
  resumeReviewFeedback(jobKey: string): Promise<ResumeReviewFeedbackListResponse>;
  resumeTemplates(): Promise<ResumeTemplateListResponse>;
  resumeTemplate(templateId: string): Promise<ResumeTemplateDetailResponse>;
  saveResumeTemplate(body: ResumeTemplateVersionSaveRequest): Promise<ResumeTemplateVersionSaveResponse>;
  setDefaultResumeTemplate(
    body: ResumeTemplateDefaultSelectionRequest,
  ): Promise<ResumeTemplateDefaultSelectionResponse>;
  setJobResumeTemplate(
    jobKey: string,
    body: JobResumeTemplateAssignmentRequest,
  ): Promise<JobResumeTemplateAssignmentResponse>;
  ensureCurrentResumeMaterials(
    jobKey: string,
    body?: Partial<EnsureCurrentResumeMaterialsRequest>,
  ): Promise<EnsureCurrentResumeMaterialsResponse>;
  applicationOutcomes(): Promise<ApplicationOutcomeListResponse>;
  jobApplicationOutcomes(jobKey: string): Promise<JobApplicationOutcomeListResponse>;
  recordManualApplicationOutcome(
    jobKey: string,
    body: ManualApplicationOutcomeRequest,
  ): Promise<ApplicationOutcomeWriteResponse>;
  decideOutcomeSuggestion(
    suggestionId: string,
    body: OutcomeSuggestionDecisionRequest,
  ): Promise<OutcomeSuggestionDecisionResponse>;

  jobs(query?: Partial<JobListQuery>): Promise<PaginatedResponse<JobSummary>>;
  job(jobKey: string): Promise<JobDetail>;
  evidenceMap(): Promise<EvidenceMapResponse>;
  deleteJob(jobKey: string, body?: DeleteJobRequest): Promise<JobMutationResponse>;
  deleteJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse>;
  permanentlyDeleteJob(jobKey: string): Promise<JobMutationResponse>;
  permanentlyDeleteJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse>;
  restoreJob(jobKey: string): Promise<JobMutationResponse>;
  restoreJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse>;
  hideJob(jobKey: string, body?: DeleteJobRequest): Promise<JobMutationResponse>;
  hideJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse>;
  unhideJob(jobKey: string): Promise<JobMutationResponse>;
  unhideJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse>;
  retryFailedJobs(body: BulkRetryFailedRequest): Promise<BulkRetryFailedResponse>;
  runPendingPreparation(body: BulkRunPendingPreparationRequest): Promise<BulkRunPendingPreparationResponse>;
  correctScore(jobKey: string, body: CorrectScoreRequest): Promise<CorrectScoreResponse>;
  resetStaleScoresForRescore(
    body: ResetStaleScoresForRescoreRequest,
  ): Promise<ResetStaleScoresForRescoreResponse>;
  rescoreJob(jobKey: string, body?: Partial<RescoreJobRequest>): Promise<ActionRunResponse>;
  refreshCompensation(jobKey: string, body?: RefreshCompensationRequest): Promise<ActionRunResponse>;
  refreshAllCompensation(body?: RefreshCompensationRequest): Promise<ActionRunResponse>;
  rescoreJobsNotOnCurrentScoringPolicy(
    body: BulkRescoreJobsNotOnCurrentScoringPolicyRequest,
  ): Promise<ActionRunResponse>;
  retailorJob(jobKey: string, body?: Partial<RetailorJobRequest>): Promise<ActionRunResponse>;
  tailorJob(jobKey: string, body?: Partial<TailorJobRequest>): Promise<ActionRunResponse>;
  retailorCurrentPolicy(body: BulkRetailorCurrentPolicyRequest): Promise<ActionRunResponse>;

  workflowRuns(query?: Partial<WorkflowRunsListQuery>): Promise<PaginatedResponse<WorkflowRunSummary>>;
  workflowRun(runId: string): Promise<WorkflowRunDetail>;
  cancelWorkflowRun(runId: string): Promise<ActionRunResponse>;

  artifacts(query?: Partial<ArtifactListQuery>): Promise<PaginatedResponse<ArtifactSummary>>;
  artifact(artifactId: string): Promise<ArtifactDetail>;
  artifactPreviewPdfUrl(artifactId: string, cacheKey?: number | string): string;
  artifactPreviewHtmlUrl(artifactId: string, cacheKey?: number | string): string;
  openArtifact(artifactId: string): Promise<ArtifactOpenResponse>;

  profile(): Promise<ProfileConfigResponse>;
  profilePreviewPdfUrl(cacheKey?: number | string): string;
  profilePreviewHtmlUrl(cacheKey?: number | string): string;
  updateProfile(body: ProfileUpdateRequest): Promise<ProfileConfigResponse>;
  importResume(body: ProfileImportRequest): Promise<ProfileImportResponse>;

  settings(): Promise<SettingsResponse>;
  updateSettings(body: SettingsUpdateRequest): Promise<SettingsResponse>;
  extensionCapabilityToken(): Promise<ExtensionCapabilityTokenResponse>;
  rotateExtensionCapabilityToken(): Promise<ExtensionCapabilityTokenResponse>;
  runPipelineStages(body: RunPipelineStagesRequest): Promise<PipelineStageRunResponse>;

  credentials(): Promise<CredentialsResponse>;
  updateCredential(body: CredentialUpdateRequest): Promise<CredentialsResponse>;
  deleteCredential(key: CredentialKey): Promise<CredentialsResponse>;

  retryStage(jobKey: string, body: RetryStageRequest): Promise<ActionRunResponse>;
  runJobStage(jobKey: string, body: RunJobStageRequest): Promise<ActionRunResponse>;
  generateMaterials(jobKey: string, body?: Partial<GenerateMaterialsRequest>): Promise<ActionRunResponse>;
  applyJob(jobKey: string, body?: Partial<ApplyJobRequest>): Promise<ActionRunResponse>;
  cancelJobAction(jobKey: string, body?: CancelJobActionRequest): Promise<ActionRunResponse>;
  markApplied(jobKey: string, body?: MarkJobActionRequest): Promise<ActionRunResponse>;
  markSkipped(jobKey: string, body?: MarkJobActionRequest): Promise<ActionRunResponse>;
}
