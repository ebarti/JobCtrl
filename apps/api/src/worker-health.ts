import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { databaseExists, openReadOnlyDatabase } from "./db.js";

const WORKER_HEARTBEAT_TABLE = "worker_runtime_heartbeats";
const LLM_SPEND_TABLE = "llm_spend";
const WORKER_STALE_AFTER_MS = 45_000;

export type WorkerHealthStatus = "healthy" | "missing" | "stale" | "mismatched";

export interface WorkerHeartbeatSnapshot {
  workerId: string;
  component: string;
  pid: number | null;
  hostname: string;
  appDir: string;
  dbPath: string;
  taskQueue: string;
  startedAt: string;
  lastSeenAt: string;
  maxConcurrentActivities: number | null;
  activityExecutorMaxWorkers: number | null;
}

export interface WorkerHealthSnapshot {
  status: WorkerHealthStatus;
  expectedDbPath: string;
  expectedAppDir: string;
  staleAfterSeconds: number;
  message: string;
  heartbeat: WorkerHeartbeatSnapshot | null;
}

export interface LlmSpendHealthSnapshot {
  status: "ok" | "over_budget";
  day: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  dailyBudgetUsd: number;
  remainingUsd: number | null;
  unlimited: boolean;
  message: string;
}

interface HeartbeatRow {
  worker_id: string;
  component: string;
  pid: number | null;
  hostname: string;
  app_dir: string;
  db_path: string;
  task_queue: string;
  started_at: string;
  last_seen_at: string;
  max_concurrent_activities?: number | null;
  activity_executor_max_workers?: number | null;
}

interface LlmSpendRow {
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_usd: number | null;
}

export function readWorkerHealth(dbPath: string, now = new Date()): WorkerHealthSnapshot {
  const expectedDbPath = normalizePath(dbPath);
  const expectedAppDir = normalizePath(path.dirname(dbPath));
  const staleAfterSeconds = Math.round(WORKER_STALE_AFTER_MS / 1000);

  if (!databaseExists(dbPath)) {
    return {
      status: "missing",
      expectedDbPath,
      expectedAppDir,
      staleAfterSeconds,
      message: `No JobHunter database found at ${expectedDbPath}.`,
      heartbeat: null,
    };
  }

  let db: Database.Database | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    if (!tableExists(db, WORKER_HEARTBEAT_TABLE)) {
      return {
        status: "missing",
        expectedDbPath,
        expectedAppDir,
        staleAfterSeconds,
        message: "No JobHunter automation worker heartbeat has been written to the API database.",
        heartbeat: null,
      };
    }

    const row = db
      .prepare(
        `SELECT *
         FROM ${WORKER_HEARTBEAT_TABLE}
         ORDER BY last_seen_at DESC
         LIMIT 1`,
      )
      .get() as HeartbeatRow | undefined;

    if (!row) {
      return {
        status: "missing",
        expectedDbPath,
        expectedAppDir,
        staleAfterSeconds,
        message: "No JobHunter automation worker heartbeat has been written to the API database.",
        heartbeat: null,
      };
    }

    const heartbeat = toHeartbeatSnapshot(row);
    const mismatches = runtimeMismatches({ heartbeat, expectedAppDir, expectedDbPath });
    if (mismatches.length > 0) {
      return {
        status: "mismatched",
        expectedDbPath,
        expectedAppDir,
        staleAfterSeconds,
        message: `JobHunter automation worker runtime does not match the API runtime: ${mismatches.join("; ")}.`,
        heartbeat,
      };
    }

    const lastSeenMs = Date.parse(heartbeat.lastSeenAt);
    const stale = Number.isNaN(lastSeenMs) || now.getTime() - lastSeenMs > WORKER_STALE_AFTER_MS;
    return {
      status: stale ? "stale" : "healthy",
      expectedDbPath,
      expectedAppDir,
      staleAfterSeconds,
      message: stale
        ? `JobHunter automation worker heartbeat is stale; last seen at ${heartbeat.lastSeenAt}.`
        : "JobHunter automation worker heartbeat is current and uses the API database.",
      heartbeat,
    };
  } finally {
    db?.close();
  }
}

export function readLlmSpendHealth(
  dbPath: string,
  settingsPath: string,
  now = new Date(),
): LlmSpendHealthSnapshot {
  const day = now.toISOString().slice(0, 10);
  const dailyBudgetUsd = readDailyBudgetUsd(settingsPath);
  const unlimited = dailyBudgetUsd <= 0;
  const usage = readTodayLlmSpend(dbPath, day);
  const overBudget = !unlimited && usage.estimatedUsd >= dailyBudgetUsd;
  const remainingUsd = unlimited ? null : Math.max(0, dailyBudgetUsd - usage.estimatedUsd);
  const budgetLabel = unlimited ? "unlimited" : `$${dailyBudgetUsd.toFixed(2)}`;
  return {
    status: overBudget ? "over_budget" : "ok",
    day,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedUsd: usage.estimatedUsd,
    dailyBudgetUsd,
    remainingUsd,
    unlimited,
    message: `LLM spend is $${usage.estimatedUsd.toFixed(2)} / ${budgetLabel} today.`,
  };
}

export function dbFileIdentity(dbPath: string): string | null {
  try {
    const stat = statSync(dbPath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function readTodayLlmSpend(
  dbPath: string,
  day: string,
): { inputTokens: number; outputTokens: number; estimatedUsd: number } {
  if (!databaseExists(dbPath)) {
    return { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
  }
  let db: Database.Database | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    if (!tableExists(db, LLM_SPEND_TABLE)) {
      return { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
    }
    const row = db
      .prepare(
        `SELECT input_tokens, output_tokens, estimated_usd
         FROM ${LLM_SPEND_TABLE}
         WHERE day = ?`,
      )
      .get(day) as LlmSpendRow | undefined;
    return {
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      estimatedUsd: Number(row?.estimated_usd ?? 0),
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
  } finally {
    db?.close();
  }
}

function readDailyBudgetUsd(settingsPath: string): number {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const raw = parsed.dailyBudgetUsd ?? parsed.daily_budget_usd;
    const numberValue = Number(raw);
    return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 25;
  } catch {
    return 25;
  }
}

function toHeartbeatSnapshot(row: HeartbeatRow): WorkerHeartbeatSnapshot {
  return {
    workerId: row.worker_id,
    component: row.component,
    pid: row.pid === null ? null : Number(row.pid),
    hostname: row.hostname,
    appDir: normalizePath(row.app_dir),
    dbPath: normalizePath(row.db_path),
    taskQueue: row.task_queue,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    maxConcurrentActivities: nullableNumber(row.max_concurrent_activities),
    activityExecutorMaxWorkers: nullableNumber(row.activity_executor_max_workers),
  };
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function nullableNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function runtimeMismatches(input: {
  heartbeat: WorkerHeartbeatSnapshot;
  expectedAppDir: string;
  expectedDbPath: string;
}): string[] {
  const mismatches: string[] = [];
  if (input.heartbeat.appDir !== input.expectedAppDir) {
    mismatches.push(`worker app dir ${input.heartbeat.appDir}, API app dir ${input.expectedAppDir}`);
  }
  if (input.heartbeat.dbPath !== input.expectedDbPath) {
    mismatches.push(`worker DB ${input.heartbeat.dbPath}, API DB ${input.expectedDbPath}`);
  }
  return mismatches;
}
