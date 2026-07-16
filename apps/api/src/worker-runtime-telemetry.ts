import path from "node:path";
import Database from "better-sqlite3";

import { databaseExists, openReadOnlyDatabase } from "./db.js";

const WORKER_HEARTBEAT_TABLE = "worker_runtime_heartbeats";

export const WORKER_RUNTIME_STALE_AFTER_MS = 45_000;
export const MAX_ACTIVE_ACTIVITY_DETAILS = 20;

const OPERATIONAL_ACTIVITY_KINDS = {
  plan_discovery_sources: "discovery-plan",
  discovery_source_family: "discovery-source-family",
  discovery_enrichment: "discovery-enrichment",
  discovery_preparation_fanout: "discovery-preparation-fanout",
  enrich: "enrichment",
  score: "scoring-batch",
  score_job: "job-scoring",
  tailor: "tailoring-batch",
  tailor_job: "job-tailoring",
  cover: "cover-letter-batch",
  cover_letter: "job-cover-letter",
  render_pdf: "job-pdf-render",
  derive_preparation_targets: "preparation-targets",
} as const;

type OperationalActivityType = keyof typeof OPERATIONAL_ACTIVITY_KINDS;
type OperationalActivityKind = (typeof OPERATIONAL_ACTIVITY_KINDS)[OperationalActivityType];

export interface OperationalActivityRef {
  kind: OperationalActivityKind;
  opaqueId: string;
}

export interface ActiveActivityTelemetryDetail {
  activityType: OperationalActivityType;
  operationalRef: OperationalActivityRef;
  workflowRef: string | null;
  executionRef: string | null;
  attempt: number;
  startedAt: string;
}

export interface ActivityDurationTelemetry {
  completedCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface TaskQueueStatsTelemetry {
  pollerCount: number;
  approximateBacklogCount: number;
  approximateBacklogAgeSeconds: number;
  tasksAddRate: number;
  tasksDispatchRate: number;
}

export type TaskQueueObservationTelemetry =
  | {
      status: "available";
      observedAt: string;
      workflow: TaskQueueStatsTelemetry;
      activity: TaskQueueStatsTelemetry;
    }
  | {
      status: "unsupported";
      observedAt: string;
      reasonCode: "describe_task_queue_stats_unsupported";
    }
  | {
      status: "unavailable";
      observedAt: string;
      reasonCode:
        | "describe_task_queue_unavailable"
        | "not_sampled"
        | "no_observation"
        | "invalid_observation";
    }
  | {
      status: "stale";
      observedAt: string;
      lastKnownStatus: "available" | "unsupported" | "unavailable";
    };

type CurrentTaskQueueObservationTelemetry = Exclude<
  TaskQueueObservationTelemetry,
  { status: "stale" }
>;

export type WorkerRuntimeTelemetryStatus = "available" | "stale" | "unavailable";

export interface WorkerRuntimeTelemetrySnapshot {
  status: WorkerRuntimeTelemetryStatus;
  reason: "current" | "database_missing" | "heartbeat_missing" | "telemetry_stale" | "invalid_capacity";
  asOf: string;
  staleAfterSeconds: number;
  taskQueue: string | null;
  freshWorkerCount: number;
  staleWorkerCount: number;
  invalidWorkerCount: number;
  configuredSlots: number;
  /** Exact occupied slots across all executing Temporal activities. */
  activeSlots: number;
  availableSlots: number;
  executorThreads: number;
  slotSaturation: number | null;
  activeCountsByType: Partial<Record<OperationalActivityType, number>>;
  activeDetails: ActiveActivityTelemetryDetail[];
  /** Exact active count for the allowlisted detail/type subset only. */
  activeDetailsTotal: number;
  activeDetailsTruncated: boolean;
  activityDurationsByType: Partial<Record<OperationalActivityType, ActivityDurationTelemetry>>;
  taskQueueObservation: TaskQueueObservationTelemetry;
}

export interface ReadWorkerRuntimeTelemetryOptions {
  taskQueue?: string;
  now?: Date;
  staleAfterMs?: number;
}

interface HeartbeatRow {
  worker_id: string;
  component: string;
  app_dir: string;
  db_path: string;
  task_queue: string;
  last_seen_at: string;
  max_concurrent_activities?: number | null;
  activity_executor_max_workers?: number | null;
  active_activity_count?: number | null;
  active_activity_counts_json?: string | null;
  active_activity_details_json?: string | null;
  active_activity_details_total?: number | null;
  active_activity_details_truncated?: number | null;
  activity_duration_summary_json?: string | null;
  task_queue_observation_json?: string | null;
  heartbeat_schema_version?: number | null;
}

interface ParsedWorkerTelemetry {
  authoritative: boolean;
  configuredSlots: number;
  activeSlots: number;
  executorThreads: number;
  activeCountsByType: Partial<Record<OperationalActivityType, number>>;
  activeDetails: ActiveActivityTelemetryDetail[];
  activeDetailsTotal: number;
  activeDetailsTruncated: boolean;
  activityDurationsByType: Partial<Record<OperationalActivityType, ActivityDurationTelemetry>>;
}

export function readWorkerRuntimeTelemetry(
  dbPath: string,
  options: ReadWorkerRuntimeTelemetryOptions = {},
): WorkerRuntimeTelemetrySnapshot {
  const now = options.now ?? new Date();
  const staleAfterMs = Math.max(1, options.staleAfterMs ?? WORKER_RUNTIME_STALE_AFTER_MS);
  const asOf = now.toISOString();
  const staleAfterSeconds = Math.round(staleAfterMs / 1_000);

  if (!databaseExists(dbPath)) {
    return emptySnapshot({
      status: "unavailable",
      reason: "database_missing",
      asOf,
      staleAfterSeconds,
      taskQueue: options.taskQueue ?? null,
    });
  }

  let db: Database.Database | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    if (!tableExists(db, WORKER_HEARTBEAT_TABLE)) {
      return emptySnapshot({
        status: "unavailable",
        reason: "heartbeat_missing",
        asOf,
        staleAfterSeconds,
        taskQueue: options.taskQueue ?? null,
      });
    }

    const expectedDbPath = path.resolve(dbPath);
    const expectedAppDir = path.resolve(path.dirname(dbPath));
    const rows = db
      .prepare(
        `SELECT *
         FROM ${WORKER_HEARTBEAT_TABLE}
         WHERE component = 'temporal-worker'
         ORDER BY last_seen_at DESC`,
      )
      .all() as HeartbeatRow[];
    const identityRows = rows.filter(
      (row) => path.resolve(row.db_path) === expectedDbPath && path.resolve(row.app_dir) === expectedAppDir,
    );
    const taskQueue = options.taskQueue ?? identityRows[0]?.task_queue ?? null;
    const queueRows = taskQueue === null ? [] : identityRows.filter((row) => row.task_queue === taskQueue);

    if (queueRows.length === 0) {
      return emptySnapshot({
        status: "unavailable",
        reason: "heartbeat_missing",
        asOf,
        staleAfterSeconds,
        taskQueue,
      });
    }

    const freshRows = queueRows.filter((row) => isFresh(row.last_seen_at, now, staleAfterMs));
    const staleWorkerCount = queueRows.length - freshRows.length;
    if (freshRows.length === 0) {
      return emptySnapshot({
        status: "stale",
        reason: "telemetry_stale",
        asOf,
        staleAfterSeconds,
        taskQueue,
        staleWorkerCount,
        taskQueueObservation: freshestTaskQueueObservation(queueRows, now, staleAfterMs),
      });
    }

    const parsedRows = freshRows.map(parseWorkerTelemetry);
    const validRows = parsedRows.filter((row) => row.authoritative);
    const invalidWorkerCount = parsedRows.length - validRows.length;
    if (invalidWorkerCount > 0) {
      return emptySnapshot({
        status: "unavailable",
        reason: "invalid_capacity",
        asOf,
        staleAfterSeconds,
        taskQueue,
        freshWorkerCount: freshRows.length,
        staleWorkerCount,
        invalidWorkerCount,
        taskQueueObservation: freshestTaskQueueObservation(freshRows, now, staleAfterMs),
      });
    }

    const configuredSlots = sum(validRows.map((row) => row.configuredSlots));
    const activeSlots = sum(validRows.map((row) => row.activeSlots));
    const activeDetailsTotal = sum(validRows.map((row) => row.activeDetailsTotal));
    const details = validRows
      .flatMap((row) => row.activeDetails)
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
      .slice(0, MAX_ACTIVE_ACTIVITY_DETAILS);

    return {
      status: "available",
      reason: "current",
      asOf,
      staleAfterSeconds,
      taskQueue,
      freshWorkerCount: freshRows.length,
      staleWorkerCount,
      invalidWorkerCount,
      configuredSlots,
      activeSlots,
      availableSlots: configuredSlots - activeSlots,
      executorThreads: sum(validRows.map((row) => row.executorThreads)),
      slotSaturation: configuredSlots > 0 ? activeSlots / configuredSlots : null,
      activeCountsByType: mergeActivityCounts(validRows),
      activeDetails: details,
      activeDetailsTotal,
      activeDetailsTruncated:
        activeDetailsTotal > details.length ||
        validRows.some((row) => row.activeDetailsTruncated),
      activityDurationsByType: mergeActivityDurations(validRows),
      taskQueueObservation: freshestTaskQueueObservation(freshRows, now, staleAfterMs),
    };
  } catch {
    return emptySnapshot({
      status: "unavailable",
      reason: "heartbeat_missing",
      asOf,
      staleAfterSeconds,
      taskQueue: options.taskQueue ?? null,
    });
  } finally {
    db?.close();
  }
}

function emptySnapshot(input: {
  status: WorkerRuntimeTelemetryStatus;
  reason: WorkerRuntimeTelemetrySnapshot["reason"];
  asOf: string;
  staleAfterSeconds: number;
  taskQueue: string | null;
  freshWorkerCount?: number;
  staleWorkerCount?: number;
  invalidWorkerCount?: number;
  taskQueueObservation?: TaskQueueObservationTelemetry;
}): WorkerRuntimeTelemetrySnapshot {
  return {
    status: input.status,
    reason: input.reason,
    asOf: input.asOf,
    staleAfterSeconds: input.staleAfterSeconds,
    taskQueue: input.taskQueue,
    freshWorkerCount: input.freshWorkerCount ?? 0,
    staleWorkerCount: input.staleWorkerCount ?? 0,
    invalidWorkerCount: input.invalidWorkerCount ?? 0,
    configuredSlots: 0,
    activeSlots: 0,
    availableSlots: 0,
    executorThreads: 0,
    slotSaturation: null,
    activeCountsByType: {},
    activeDetails: [],
    activeDetailsTotal: 0,
    activeDetailsTruncated: false,
    activityDurationsByType: {},
    taskQueueObservation:
      input.taskQueueObservation ?? unavailableObservation(input.asOf, "no_observation"),
  };
}

function parseWorkerTelemetry(row: HeartbeatRow): ParsedWorkerTelemetry {
  const configuredSlots = nonnegativeInteger(row.max_concurrent_activities);
  const activeSlots = nonnegativeInteger(row.active_activity_count);
  const executorThreads = nonnegativeInteger(row.activity_executor_max_workers);
  const activeCountsByType = parseActivityCounts(row.active_activity_counts_json);
  const reportedActiveByType = sum(
    operationalActivityTypes().map((activityType) => activeCountsByType[activityType] ?? 0),
  );
  const reportedDetailsTotal = nonnegativeInteger(row.active_activity_details_total);
  const activeDetails = parseActiveDetails(row.active_activity_details_json);
  return {
    authoritative:
      nonnegativeInteger(row.heartbeat_schema_version) >= 2 &&
      configuredSlots > 0 &&
      executorThreads > 0 &&
      activeSlots <= configuredSlots &&
      reportedDetailsTotal <= activeSlots &&
      activeDetails.length <= reportedDetailsTotal &&
      reportedActiveByType === reportedDetailsTotal,
    configuredSlots,
    activeSlots,
    executorThreads,
    activeCountsByType,
    activeDetails,
    activeDetailsTotal: reportedDetailsTotal,
    activeDetailsTruncated:
      reportedDetailsTotal > activeDetails.length ||
      Boolean(row.active_activity_details_truncated),
    activityDurationsByType: parseActivityDurations(row.activity_duration_summary_json),
  };
}

function parseActivityCounts(
  raw: string | null | undefined,
): Partial<Record<OperationalActivityType, number>> {
  const parsed = parseJsonObject(raw);
  const result: Partial<Record<OperationalActivityType, number>> = {};
  for (const activityType of operationalActivityTypes()) {
    const count = parsed?.[activityType];
    if (isNonnegativeInteger(count)) {
      result[activityType] = count;
    }
  }
  return result;
}

function parseActiveDetails(raw: string | null | undefined): ActiveActivityTelemetryDetail[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .slice(0, MAX_ACTIVE_ACTIVITY_DETAILS)
    .map(parseActiveDetail)
    .filter((detail): detail is ActiveActivityTelemetryDetail => detail !== null);
}

function parseActiveDetail(value: unknown): ActiveActivityTelemetryDetail | null {
  if (!isRecord(value)) {
    return null;
  }
  const activityType = value.activityType;
  if (!isOperationalActivityType(activityType)) {
    return null;
  }
  const operationalRef = value.operationalRef;
  const workflowRef = value.workflowRef;
  const executionRef = value.executionRef;
  const attempt = value.attempt;
  const startedAt = value.startedAt;
  if (
    !isRecord(operationalRef) ||
    operationalRef.kind !== OPERATIONAL_ACTIVITY_KINDS[activityType] ||
    !isOpaqueRef(operationalRef.opaqueId, "op")
  ) {
    return null;
  }
  if (
    !isNullableWorkflowRef(workflowRef) ||
    !isNullableTemporalRunRef(executionRef) ||
    !isPositiveInteger(attempt) ||
    !isIsoTimestamp(startedAt)
  ) {
    return null;
  }
  return {
    activityType,
    operationalRef: {
      kind: operationalRef.kind as OperationalActivityKind,
      opaqueId: operationalRef.opaqueId,
    },
    workflowRef,
    executionRef,
    attempt,
    startedAt,
  };
}

function parseActivityDurations(
  raw: string | null | undefined,
): Partial<Record<OperationalActivityType, ActivityDurationTelemetry>> {
  const parsed = parseJsonObject(raw);
  const result: Partial<Record<OperationalActivityType, ActivityDurationTelemetry>> = {};
  for (const activityType of operationalActivityTypes()) {
    const metric = parsed?.[activityType];
    if (
      isRecord(metric) &&
      isNonnegativeInteger(metric.completedCount) &&
      isNonnegativeInteger(metric.totalDurationMs) &&
      isNonnegativeInteger(metric.maxDurationMs)
    ) {
      result[activityType] = {
        completedCount: metric.completedCount,
        totalDurationMs: metric.totalDurationMs,
        maxDurationMs: metric.maxDurationMs,
      };
    }
  }
  return result;
}

function mergeActivityCounts(
  rows: ParsedWorkerTelemetry[],
): Partial<Record<OperationalActivityType, number>> {
  const result: Partial<Record<OperationalActivityType, number>> = {};
  for (const activityType of operationalActivityTypes()) {
    const count = sum(rows.map((row) => row.activeCountsByType[activityType] ?? 0));
    if (count > 0) {
      result[activityType] = count;
    }
  }
  return result;
}

function mergeActivityDurations(
  rows: ParsedWorkerTelemetry[],
): Partial<Record<OperationalActivityType, ActivityDurationTelemetry>> {
  const result: Partial<Record<OperationalActivityType, ActivityDurationTelemetry>> = {};
  for (const activityType of operationalActivityTypes()) {
    const metrics = rows
      .map((row) => row.activityDurationsByType[activityType])
      .filter((metric): metric is ActivityDurationTelemetry => metric !== undefined);
    if (metrics.length > 0) {
      result[activityType] = {
        completedCount: sum(metrics.map((metric) => metric.completedCount)),
        totalDurationMs: sum(metrics.map((metric) => metric.totalDurationMs)),
        maxDurationMs: Math.max(...metrics.map((metric) => metric.maxDurationMs)),
      };
    }
  }
  return result;
}

function freshestTaskQueueObservation(
  rows: HeartbeatRow[],
  now: Date,
  staleAfterMs: number,
): TaskQueueObservationTelemetry {
  const observations = rows
    .map((row) => parseTaskQueueObservation(row.task_queue_observation_json))
    .filter((observation): observation is CurrentTaskQueueObservationTelemetry => observation !== null)
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
  const freshest = observations[0];
  if (!freshest) {
    return unavailableObservation(now.toISOString(), "no_observation");
  }
  if (!isFresh(freshest.observedAt, now, staleAfterMs)) {
    return {
      status: "stale",
      observedAt: freshest.observedAt,
      lastKnownStatus: freshest.status,
    };
  }
  return freshest;
}

function parseTaskQueueObservation(
  raw: string | null | undefined,
): CurrentTaskQueueObservationTelemetry | null {
  const parsed = parseJsonObject(raw);
  if (!parsed || !isIsoTimestamp(parsed.observedAt)) {
    return null;
  }
  if (parsed.status === "available") {
    const workflow = parseTaskQueueStats(parsed.workflow);
    const activity = parseTaskQueueStats(parsed.activity);
    return workflow && activity
      ? { status: "available", observedAt: parsed.observedAt, workflow, activity }
      : unavailableObservation(parsed.observedAt, "invalid_observation");
  }
  if (parsed.status === "unsupported") {
    return {
      status: "unsupported",
      observedAt: parsed.observedAt,
      reasonCode: "describe_task_queue_stats_unsupported",
    };
  }
  if (parsed.status === "unavailable") {
    const reasonCode =
      parsed.reasonCode === "not_sampled" ? "not_sampled" : "describe_task_queue_unavailable";
    return unavailableObservation(parsed.observedAt, reasonCode);
  }
  return null;
}

function parseTaskQueueStats(value: unknown): TaskQueueStatsTelemetry | null {
  if (
    !isRecord(value) ||
    !isNonnegativeInteger(value.pollerCount) ||
    !isNonnegativeInteger(value.approximateBacklogCount) ||
    !isNonnegativeNumber(value.approximateBacklogAgeSeconds) ||
    !isNonnegativeNumber(value.tasksAddRate) ||
    !isNonnegativeNumber(value.tasksDispatchRate)
  ) {
    return null;
  }
  return {
    pollerCount: value.pollerCount,
    approximateBacklogCount: value.approximateBacklogCount,
    approximateBacklogAgeSeconds: value.approximateBacklogAgeSeconds,
    tasksAddRate: value.tasksAddRate,
    tasksDispatchRate: value.tasksDispatchRate,
  };
}

function unavailableObservation(
  observedAt: string,
  reasonCode: Extract<TaskQueueObservationTelemetry, { status: "unavailable" }>["reasonCode"],
): Extract<TaskQueueObservationTelemetry, { status: "unavailable" }> {
  return { status: "unavailable", observedAt, reasonCode };
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function isFresh(timestamp: string, now: Date, staleAfterMs: number): boolean {
  const timestampMs = Date.parse(timestamp);
  if (Number.isNaN(timestampMs)) {
    return false;
  }
  const ageMs = now.getTime() - timestampMs;
  return ageMs >= -staleAfterMs && ageMs <= staleAfterMs;
}

function operationalActivityTypes(): OperationalActivityType[] {
  return Object.keys(OPERATIONAL_ACTIVITY_KINDS) as OperationalActivityType[];
}

function isOperationalActivityType(value: unknown): value is OperationalActivityType {
  return typeof value === "string" && value in OPERATIONAL_ACTIVITY_KINDS;
}

function isOpaqueRef(value: unknown, prefix: "op"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}_[a-f0-9]{24}$`).test(value);
}

function isNullableWorkflowRef(value: unknown): value is string | null {
  if (value === null) {
    return true;
  }
  return (
    typeof value === "string" &&
    (/^discover-local$/.test(value) ||
      /^prep-preparation:[a-f0-9]{64}$/.test(value) ||
      /^run-[a-f0-9]{32}$/.test(value))
  );
}

function isNullableTemporalRunRef(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value,
      ))
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  const value = parseJson(raw);
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): number {
  return isNonnegativeInteger(value) ? value : 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
