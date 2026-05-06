import type {
  ArtifactDetail,
  ArtifactListQuery,
  ArtifactSummary,
  CredentialsResponse,
  DashboardSettings,
  DashboardSummary,
  JobDetail,
  JobListQuery,
  JobSortField,
  JobSummary,
  PaginatedResponse,
  ProfileConfigResponse,
  SettingsResponse,
  Stage,
  StageState,
} from "@jobhunter/contracts";
import type { DomainEventUnion } from "@jobhunter/domain-types";

export type {
  ArtifactDetail,
  ArtifactListQuery,
  ArtifactSummary,
  CredentialsResponse,
  DashboardSettings,
  DashboardSummary,
  JobDetail,
  JobListQuery,
  JobSortField,
  JobSummary,
  PaginatedResponse,
  ProfileConfigResponse,
  SettingsResponse,
  Stage,
  StageState,
};

export type JobId = string;

export type JobsListInput = Partial<JobListQuery>;
export type ArtifactsListInput = Partial<ArtifactListQuery>;

export type StageOrAll = Stage | "all";
export type StageStateOrAll = StageState | "all";

export type KnownDomainEvent = DomainEventUnion;
export type KnownDomainEventType = KnownDomainEvent["eventType"];
