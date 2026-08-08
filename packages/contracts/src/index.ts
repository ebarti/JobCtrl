export * from "./schemas.js";
export * from "./rpc.js";
export * from "./demo-fixture-contract.js";
export * from "./jobs-query.js";

// Operations / Read-Side projection types — re-exported from
// @jobctrl/domain-types so apps/api (which depends on contracts but
// not directly on domain-types) can consume the shared shapes.
// Matches the dependency direction defined in docs/decisions.md.
export type {
  StageProjection,
  JobListProjection,
  DashboardFunnelStage,
  DashboardProjection,
  JobDetailProjection,
  ArtifactListProjection,
  ApplyRunProjection,
  ContactProjection,
  ContactProvenanceEntry,
  OutreachThreadProjection,
  OutreachDraftMetadataEntry,
} from "@jobctrl/domain-types";
export {
  PROJECTION_TABLES,
  PROJECTION_WATERMARK_NAME,
  type ProjectionTable,
} from "@jobctrl/domain-types";
