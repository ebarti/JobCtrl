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
  RetryStageRequest,
  SettingsUpdateRequest,
  SettingsResponse,
  WorkflowRunSummary,
  WorkflowRunsListQuery,
} from "@jobhunter/contracts";

type QueryValue = boolean | number | string | null | undefined;
const DEFAULT_NODE_BASE_URL = "http://127.0.0.1:8766";

export interface HealthResponse {
  ok: true;
  dbPath: string;
  dbExists: boolean;
}

export class JobHunterApiClient {
  readonly baseUrl: string;

  constructor(baseUrl = defaultBaseUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  health(): Promise<HealthResponse> {
    return this.get("/v1/health");
  }

  dashboardSummary(): Promise<DashboardSummary> {
    return this.get("/v1/dashboard/summary");
  }

  jobs(query: Partial<JobListQuery> = {}): Promise<PaginatedResponse<JobSummary>> {
    return this.get("/v1/jobs", query);
  }

  job(jobKey: string): Promise<JobDetail> {
    return this.get(`/v1/jobs/${encodeURIComponent(jobKey)}`);
  }

  deleteJob(jobKey: string, body: DeleteJobRequest = {}): Promise<JobMutationResponse> {
    return this.delete(`/v1/jobs/${encodeURIComponent(jobKey)}`, body);
  }

  deleteJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse> {
    return this.post("/v1/jobs/bulk-delete", body);
  }

  restoreJob(jobKey: string): Promise<JobMutationResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/restore`);
  }

  restoreJobs(body: BulkJobMutationRequest): Promise<JobMutationResponse> {
    return this.post("/v1/jobs/bulk-restore", body);
  }

  workflowRuns(
    query: Partial<WorkflowRunsListQuery> = {},
  ): Promise<PaginatedResponse<WorkflowRunSummary>> {
    return this.get("/v1/workflow-runs", query);
  }

  artifacts(query: Partial<ArtifactListQuery> = {}): Promise<PaginatedResponse<ArtifactSummary>> {
    return this.get("/v1/artifacts", query);
  }

  artifact(artifactId: string): Promise<ArtifactDetail> {
    return this.get(`/v1/artifacts/${encodeURIComponent(artifactId)}`);
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

  generateMaterials(jobKey: string, body: Partial<GenerateMaterialsRequest> = {}): Promise<ActionRunResponse> {
    return this.post(`/v1/jobs/${encodeURIComponent(jobKey)}/actions/generate-materials`, body);
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
    const response = await fetch(href, init);
    if (!response.ok) {
      throw new Error(`JobHunter API request failed: ${response.status} ${response.statusText}`);
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
