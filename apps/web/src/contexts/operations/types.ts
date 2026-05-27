import type {
  ArtifactDetail,
  ArtifactListQuery,
  ArtifactSummary,
  ActivityEventSummary,
  ActivityListQuery,
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
  SourceLocatorDecisionRequest,
  SourceLocatorDecisionResponse,
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
  ActivityEventSummary,
  ActivityListQuery,
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
  SourceLocatorDecisionRequest,
  SourceLocatorDecisionResponse,
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

export type JobsListInput = Partial<Omit<JobListQuery, "stage">> & {
  readonly stage?: Stage;
  readonly stages?: readonly Stage[];
};
export type ArtifactsListInput = Partial<ArtifactListQuery>;
export type WorkflowRunsListInput = Partial<WorkflowRunsListQuery>;
export type ActivityListInput = Partial<ActivityListQuery>;

export type StageOrAll = Stage | "all";
export type StageStateOrAll = StageState | "all";

export type KnownDomainEvent = DomainEventUnion;
export type KnownDomainEventType = KnownDomainEvent["eventType"];
