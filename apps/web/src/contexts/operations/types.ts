import type {
  ArtifactDetail,
  ArtifactListQuery,
  ArtifactSummary,
  CredentialsResponse,
  DashboardSettings,
  DashboardSummary,
  DiscoveryFeedbackKind,
  DiscoveryFeedbackRequest,
  DiscoveryFeedbackResponse,
  DiscoveryPreviewResponse,
  JobDetail,
  JobListQuery,
  JobSortField,
  JobSummary,
  ManualCaptureImportRequest,
  ManualCaptureListResponse,
  PaginatedResponse,
  ProfileConfigResponse,
  QuarantineDecision,
  QuarantineListResponse,
  SettingsResponse,
  SourceLocatorListResponse,
  SourceRegistryEntrySummary,
  SourceRegistryListResponse,
  SourceRegistryMutationResponse,
  SourceStatePatch,
  SourceUpsertRequest,
  Stage,
  StageState,
  WorkflowRunStatus,
  WorkflowRunStatusFilter,
  WorkflowRunSummary,
  WorkflowRunsListQuery,
} from "@jobhunter/contracts";
import type { DomainEventUnion } from "@jobhunter/domain-types";

export type {
  ArtifactDetail,
  ArtifactListQuery,
  ArtifactSummary,
  CredentialsResponse,
  DashboardSettings,
  DashboardSummary,
  DiscoveryFeedbackKind,
  DiscoveryFeedbackRequest,
  DiscoveryFeedbackResponse,
  DiscoveryPreviewResponse,
  JobDetail,
  JobListQuery,
  JobSortField,
  JobSummary,
  ManualCaptureImportRequest,
  ManualCaptureListResponse,
  PaginatedResponse,
  ProfileConfigResponse,
  QuarantineDecision,
  QuarantineListResponse,
  SettingsResponse,
  SourceLocatorListResponse,
  SourceRegistryEntrySummary,
  SourceRegistryListResponse,
  SourceRegistryMutationResponse,
  SourceStatePatch,
  SourceUpsertRequest,
  Stage,
  StageState,
  WorkflowRunStatus,
  WorkflowRunStatusFilter,
  WorkflowRunSummary,
  WorkflowRunsListQuery,
};

export type JobId = string;

export type JobsListInput = Partial<JobListQuery>;
export type ArtifactsListInput = Partial<ArtifactListQuery>;
export type WorkflowRunsListInput = Partial<WorkflowRunsListQuery>;

export type StageOrAll = Stage | "all";
export type StageStateOrAll = StageState | "all";

export type KnownDomainEvent = DomainEventUnion;
export type KnownDomainEventType = KnownDomainEvent["eventType"];
