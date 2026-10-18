import type {
  ActivityListQuery,
  ArtifactListQuery,
  JobListQuery,
  Stage,
  StageState,
  WorkflowRunsListQuery,
} from "@jobctrl/contracts";
import type { DomainEventUnion } from "@jobctrl/domain-types";

// Keep string IDs compatible with URL state and existing API-client inputs.
export type JobId = string;

// The UI accepts readonly stage selections; the wire query uses mutable arrays.
export type JobsListInput = Partial<Omit<JobListQuery, "stage" | "stages">> & {
  readonly stage?: Stage;
  readonly stages?: readonly Stage[] | undefined;
};
export type ArtifactsListInput = Partial<ArtifactListQuery>;
export type WorkflowRunsListInput = Partial<WorkflowRunsListQuery>;
export type ActivityListInput = Partial<ActivityListQuery>;

export type StageOrAll = Stage | "all";
export type StageStateOrAll = StageState | "all";
export type KnownDomainEventType = DomainEventUnion["eventType"];

export type CheckAvailabilityResponse =
  import("@jobctrl/contracts").EndpointResponse<
    typeof import("@jobctrl/contracts").ENDPOINTS.checkPostingAvailability
  >;
