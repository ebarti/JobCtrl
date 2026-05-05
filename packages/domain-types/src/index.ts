/**
 * @jobhunter/domain-types — shared domain vocabulary.
 *
 * Pure type definitions and value objects with no runtime I/O.
 * Consumers: packages/contracts, apps/api, workers/automation (via parity).
 */

export { type TenantId, createTenantId, LOCAL_TENANT } from "./tenant.js";

export { type JobId, createJobId, generateJobId } from "./identifiers.js";

export {
  STAGES,
  type Stage,
  type SerializedStage,
  serializeStage,
  deserializeStage,
  STAGE_STATE_KINDS,
  type StageStateKind,
  type SerializedStageState,
  type Pending,
  type Queued,
  type Running,
  type Succeeded,
  type Failed,
  type Blocked,
  type Skipped,
  type Exhausted,
  type Stale,
  type Canceled,
  type StageState,
  serializeStageState,
  deserializeStageStateKind,
} from "./pipeline.js";

export * from "./events/index.js";
