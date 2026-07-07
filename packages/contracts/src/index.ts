export * from "./schemas.js";
export * from "./rpc.js";

// Operations / Read-Side projection types — re-exported from
// @jobctl/domain-types so apps/api (which depends on contracts but
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
} from "@jobctl/domain-types";
export {
  PROJECTION_TABLES,
  PROJECTION_WATERMARK_NAME,
  type ProjectionTable,
} from "@jobctl/domain-types";
