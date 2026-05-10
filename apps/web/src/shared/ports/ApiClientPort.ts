import type {
  ActionRunResponse,
  ApplyJobRequest,
  ArtifactDetail,
  ArtifactListQuery,
  ArtifactOpenResponse,
  ArtifactSummary,
  BulkJobMutationRequest,
  CancelJobActionRequest,
  CredentialKey,
  CredentialsResponse,
  CredentialUpdateRequest,
  DashboardSummary,
  DeleteJobRequest,
  GenerateMaterialsRequest,
  JobDetail,
  JobListQuery,
  JobMutationResponse,
  JobSummary,
  MarkJobActionRequest,
  PaginatedResponse,
  ProfileConfigResponse,
  ProfileImportRequest,
  ProfileImportResponse,
  ProfileUpdateRequest,
  PipelineStageRunResponse,
  RetryStageRequest,
  RunPipelineStagesRequest,
  SettingsResponse,
  SettingsUpdateRequest,
  WorkflowRunSummary,
  WorkflowRunsListQuery,
} from "@jobhunter/contracts";

export interface ApiHealthResponse {
  ok: true;
  dbPath: string;
  dbExists: boolean;
}

export interface ApiClientPort {
  health(): Promise<ApiHealthResponse>;
  dashboardSummary(): Promise<DashboardSummary>;

  jobs(query?: Partial<JobListQuery>): Promise<PaginatedResponse<JobSummary>>;
  job(jobKey: string): Promise<JobDetail>;
  deleteJob(jobKey: string, body?: DeleteJobRequest): Promise<JobMutationResponse>;
  deleteJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse>;
  restoreJob(jobKey: string): Promise<JobMutationResponse>;
  restoreJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse>;

  workflowRuns(query?: Partial<WorkflowRunsListQuery>): Promise<PaginatedResponse<WorkflowRunSummary>>;

  artifacts(query?: Partial<ArtifactListQuery>): Promise<PaginatedResponse<ArtifactSummary>>;
  artifact(artifactId: string): Promise<ArtifactDetail>;
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
