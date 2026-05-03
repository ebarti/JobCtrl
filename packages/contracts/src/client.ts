import type {
  ArtifactDetail,
  ArtifactListQuery,
  ArtifactSummary,
  DashboardSummary,
  JobDetail,
  JobListQuery,
  JobSummary,
  PaginatedResponse,
  ProfileConfigResponse,
  SettingsResponse,
} from "./schemas.js";

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

  artifacts(query: Partial<ArtifactListQuery> = {}): Promise<PaginatedResponse<ArtifactSummary>> {
    return this.get("/v1/artifacts", query);
  }

  artifact(artifactId: string): Promise<ArtifactDetail> {
    return this.get(`/v1/artifacts/${encodeURIComponent(artifactId)}`);
  }

  profile(): Promise<ProfileConfigResponse> {
    return this.get("/v1/profile");
  }

  settings(): Promise<SettingsResponse> {
    return this.get("/v1/settings");
  }

  private async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`, this.baseUrl ? undefined : "http://jobhunter.local");
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const href = this.baseUrl ? url.href : `${url.pathname}${url.search}`;
    const response = await fetch(href);
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
  return typeof window === "undefined" ? DEFAULT_NODE_BASE_URL : "";
}
