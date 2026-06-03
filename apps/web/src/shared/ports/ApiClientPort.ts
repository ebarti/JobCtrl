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
  BulkRescoreJobsNotOnCurrentScoringPolicyRequest,
  BulkRetailorCurrentPolicyRequest,
  CancelJobActionRequest,
  CredentialKey,
  CorrectScoreRequest,
  CorrectScoreResponse,
  CredentialsResponse,
  CredentialUpdateRequest,
  DashboardSummary,
  DeleteJobRequest,
  DiscoveryFeedbackRequest,
  DiscoveryFeedbackResponse,
  DiscoveryPreviewResponse,
  GenerateMaterialsRequest,
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
  OutcomeSuggestionDecisionRequest,
  OutcomeSuggestionDecisionResponse,
  PaginatedResponse,
  ProfileConfigResponse,
  ProfileImportRequest,
  ProfileImportResponse,
  ProfileUpdateRequest,
  PipelineStageRunResponse,
  QuarantineDecision,
  QuarantineDecisionResponse,
  QuarantineListResponse,
  RoleMatchFeedbackDecisionRequest,
  RoleMatchFeedbackDecisionResponse,
  RoleMatchFeedbackListResponse,
  RescoreJobRequest,
  RetailorJobRequest,
  RetryStageRequest,
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
  WorkflowRunSummary,
  WorkflowRunsListQuery,
} from "@jobhunter/contracts";

export interface ApiHealthResponse {
  ok: true;
  appDir: string;
  dbPath: string;
  dbExists: boolean;
  dbIdentity: string | null;
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
    } | null;
  };
}

export interface ApiClientPort {
  health(): Promise<ApiHealthResponse>;
  dashboardSummary(): Promise<DashboardSummary>;
  activity(query?: Partial<ActivityListQuery>): Promise<PaginatedResponse<ActivityEventSummary>>;
  activityEvent(eventId: string): Promise<ActivityEventResponse>;
  discoverySources(): Promise<SourceRegistryListResponse>;
  upsertDiscoverySource(body: SourceUpsertRequest): Promise<SourceRegistryMutationResponse>;
  patchDiscoverySourceState(
    sourceId: string,
    body: SourceStatePatch,
  ): Promise<SourceRegistryMutationResponse>;
  discoverySourcePreview(sourceId: string): Promise<DiscoveryPreviewResponse>;
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
  retryFailedJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse>;
  correctScore(jobKey: string, body: CorrectScoreRequest): Promise<CorrectScoreResponse>;
  resetStaleScoresForRescore(
    body: ResetStaleScoresForRescoreRequest,
  ): Promise<ResetStaleScoresForRescoreResponse>;
  rescoreJob(jobKey: string, body?: Partial<RescoreJobRequest>): Promise<ActionRunResponse>;
  rescoreJobsNotOnCurrentScoringPolicy(
    body: BulkRescoreJobsNotOnCurrentScoringPolicyRequest,
  ): Promise<ActionRunResponse>;
  retailorJob(jobKey: string, body?: Partial<RetailorJobRequest>): Promise<ActionRunResponse>;
  retailorCurrentPolicy(body: BulkRetailorCurrentPolicyRequest): Promise<ActionRunResponse>;

  workflowRuns(query?: Partial<WorkflowRunsListQuery>): Promise<PaginatedResponse<WorkflowRunSummary>>;
  cancelWorkflowRun(runId: string): Promise<ActionRunResponse>;

  artifacts(query?: Partial<ArtifactListQuery>): Promise<PaginatedResponse<ArtifactSummary>>;
  artifact(artifactId: string): Promise<ArtifactDetail>;
  artifactPreviewPdfUrl(artifactId: string, cacheKey?: number | string): string;
  openArtifact(artifactId: string): Promise<ArtifactOpenResponse>;

  profile(): Promise<ProfileConfigResponse>;
  profilePreviewPdfUrl(cacheKey?: number | string): string;
  updateProfile(body: ProfileUpdateRequest): Promise<ProfileConfigResponse>;
  importResume(body: ProfileImportRequest): Promise<ProfileImportResponse>;

  settings(): Promise<SettingsResponse>;
  updateSettings(body: SettingsUpdateRequest): Promise<SettingsResponse>;
  runPipelineStages(body: RunPipelineStagesRequest): Promise<PipelineStageRunResponse>;

  credentials(): Promise<CredentialsResponse>;
  updateCredential(body: CredentialUpdateRequest): Promise<CredentialsResponse>;
  deleteCredential(key: CredentialKey): Promise<CredentialsResponse>;

  retryStage(jobKey: string, body: RetryStageRequest): Promise<ActionRunResponse>;
  generateMaterials(jobKey: string, body?: Partial<GenerateMaterialsRequest>): Promise<ActionRunResponse>;
  applyJob(jobKey: string, body?: Partial<ApplyJobRequest>): Promise<ActionRunResponse>;
  cancelJobAction(jobKey: string, body?: CancelJobActionRequest): Promise<ActionRunResponse>;
  markApplied(jobKey: string, body?: MarkJobActionRequest): Promise<ActionRunResponse>;
  markSkipped(jobKey: string, body?: MarkJobActionRequest): Promise<ActionRunResponse>;
}
