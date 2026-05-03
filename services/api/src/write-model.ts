import fs from "node:fs";
import path from "node:path";

import type {
  MarkJobActionRequest,
  ProfileConfigResponse,
  ProfileUpdateRequest,
  Stage,
  StageState,
  StageSummary,
} from "./contracts.js";
import { STAGES } from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { readProfileConfig } from "./read-model.js";

export class InputError extends Error {}

interface ProfilePaths {
  profilePath: string;
  resumeStylePath: string;
  resumeTemplatePath: string;
}

const DEFAULT_MAX_ATTEMPTS: Record<Stage, number> = {
  discover: 1,
  enrich: 3,
  score: 3,
  tailor: 5,
  cover: 5,
  pdf: 3,
  apply: 3,
};

export function resolveJobUrl(db: SqliteDatabase, jobKey: string): string | null {
  if (!tableExists(db, "jobs")) {
    return null;
  }
  const row = getRow<{ url?: string }>(db, "SELECT url FROM jobs WHERE url = ? OR application_url = ? LIMIT 1", [
    jobKey,
    jobKey,
  ]);
  return row?.url ?? null;
}

export function resetJobStage(
  db: SqliteDatabase,
  jobKey: string,
  stage: Stage,
  options: { resetAttempts: boolean },
): { jobUrl: string; stage: StageSummary } {
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    throw new InputError("Job not found.");
  }

  updateLegacyJobColumnsForReset(db, jobUrl, stage, options.resetAttempts);
  const stageOptions: Parameters<typeof upsertStageState>[4] = {
    retryable: true,
    clearTiming: true,
  };
  if (options.resetAttempts) {
    stageOptions.attemptCount = 0;
  }
  upsertStageState(db, jobUrl, stage, "pending", stageOptions);
  recordActionEvent(db, {
    jobUrl,
    stage,
    eventType: "retry_requested",
    level: "info",
    message: `Retry reset requested for ${stage}`,
    payload: { reset_attempts: options.resetAttempts },
  });
  return { jobUrl, stage: getStageState(db, jobUrl, stage) };
}

export function markJobApplied(
  db: SqliteDatabase,
  jobKey: string,
  request: MarkJobActionRequest,
): { jobUrl: string; stage: StageSummary } {
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    throw new InputError("Job not found.");
  }
  updateExistingJobColumns(db, jobUrl, {
    apply_status: "applied",
    apply_error: null,
    applied_at: new Date().toISOString(),
  });
  upsertStageState(db, jobUrl, "apply", "succeeded", {
    retryable: false,
    finishedAt: new Date().toISOString(),
  });
  recordActionEvent(db, {
    jobUrl,
    stage: "apply",
    eventType: "mark_applied",
    level: "info",
    message: "Job marked applied from the local API.",
    payload: { reason: request.reason ?? "" },
  });
  return { jobUrl, stage: getStageState(db, jobUrl, "apply") };
}

export function markJobSkipped(
  db: SqliteDatabase,
  jobKey: string,
  request: MarkJobActionRequest,
): { jobUrl: string; stage: StageSummary } {
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    throw new InputError("Job not found.");
  }
  updateExistingJobColumns(db, jobUrl, {
    apply_status: "skipped",
    apply_error: null,
  });
  upsertStageState(db, jobUrl, "apply", "skipped", {
    retryable: false,
    finishedAt: new Date().toISOString(),
  });
  recordActionEvent(db, {
    jobUrl,
    stage: "apply",
    eventType: "mark_skipped",
    level: "info",
    message: "Job marked skipped from the local API.",
    payload: { reason: request.reason ?? "" },
  });
  return { jobUrl, stage: getStageState(db, jobUrl, "apply") };
}

export function cancelJobAction(db: SqliteDatabase, jobKey: string, runId = ""): { jobUrl: string; stage: StageSummary } {
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    throw new InputError("Job not found.");
  }
  const stage = currentMutableStage(db, jobUrl);
  upsertStageState(db, jobUrl, stage, "canceled", {
    retryable: true,
    finishedAt: new Date().toISOString(),
  });
  recordActionEvent(db, {
    jobUrl,
    stage,
    eventType: "cancel_requested",
    level: "warning",
    message: "Cancel requested from the local API.",
    payload: { run_id: runId },
  });
  return { jobUrl, stage: getStageState(db, jobUrl, stage) };
}

export function writeProfileConfig(paths: ProfilePaths, request: ProfileUpdateRequest): ProfileConfigResponse {
  let wrote = false;
  let profile: Record<string, unknown> | undefined;
  let style: Record<string, unknown> | undefined;
  let templateText: string | undefined;

  if (request.profile !== undefined || request.profileText !== undefined) {
    profile = parseJsonObjectInput(request.profile, request.profileText, "profile.json");
    wrote = true;
  }
  if (request.style !== undefined || request.styleText !== undefined) {
    style = parseJsonObjectInput(request.style, request.styleText, "resume_style.json");
    wrote = true;
  }
  if (request.templateText !== undefined) {
    if (!request.templateText.trim()) {
      throw new InputError("resume_template.tex cannot be empty.");
    }
    templateText = request.templateText;
    wrote = true;
  }
  if (!wrote) {
    throw new InputError("At least one profile, style, or template field is required.");
  }
  if (profile !== undefined) {
    writeJson(paths.profilePath, profile);
  }
  if (style !== undefined) {
    writeJson(paths.resumeStylePath, style);
  }
  if (templateText !== undefined) {
    writeText(paths.resumeTemplatePath, templateText);
  }
  return readProfileConfig(paths);
}

function updateLegacyJobColumnsForReset(
  db: SqliteDatabase,
  jobUrl: string,
  stage: Stage,
  resetAttempts: boolean,
): void {
  const updates: Record<string, SqliteValue> = {};
  if (stage === "enrich") {
    updates.detail_error = null;
    updates.detail_scraped_at = null;
  } else if (stage === "score") {
    updates.fit_score = null;
    updates.score_reasoning = null;
    updates.scored_at = null;
  } else if (stage === "tailor") {
    updates.tailored_resume_path = null;
    updates.tailored_at = null;
    if (resetAttempts) {
      updates.tailor_attempts = 0;
    }
  } else if (stage === "cover") {
    updates.cover_letter_path = null;
    updates.cover_letter_at = null;
    if (resetAttempts) {
      updates.cover_attempts = 0;
    }
  } else if (stage === "apply") {
    updates.apply_status = null;
    updates.apply_error = null;
    updates.agent_id = null;
    updates.apply_task_id = null;
    if (resetAttempts) {
      updates.apply_attempts = 0;
    }
  }
  updateExistingJobColumns(db, jobUrl, updates);
}

function updateExistingJobColumns(db: SqliteDatabase, jobUrl: string, updates: Record<string, SqliteValue>): void {
  const names = columnNames(db, "jobs");
  const entries = Object.entries(updates).filter(([name]) => names.has(name));
  if (!entries.length) {
    return;
  }
  const assignments = entries.map(([name]) => `${name} = ?`).join(", ");
  db.prepare(`UPDATE jobs SET ${assignments} WHERE url = ?`).run(...entries.map(([, value]) => value), jobUrl);
}

function upsertStageState(
  db: SqliteDatabase,
  jobUrl: string,
  stage: Stage,
  state: StageState,
  options: {
    attemptCount?: number;
    clearTiming?: boolean;
    finishedAt?: string;
    retryable?: boolean;
  } = {},
): void {
  if (!tableExists(db, "job_stage_states")) {
    return;
  }
  const columns = columnNames(db, "job_stage_states");
  const now = new Date().toISOString();
  const updates: Record<string, SqliteValue> = {
    state,
    updated_at: now,
    error_code: null,
    error_message: null,
    retryable: options.retryable === false ? 0 : 1,
    blocked_by_json: "[]",
    next_action: null,
  };
  if (options.attemptCount !== undefined) {
    updates.attempt_count = options.attemptCount;
  }
  if (options.clearTiming) {
    updates.started_at = null;
    updates.finished_at = null;
    updates.duration_ms = null;
  }
  if (options.finishedAt) {
    updates.finished_at = options.finishedAt;
  }

  const updateEntries = Object.entries(updates).filter(([name]) => columns.has(name));
  const assignments = updateEntries.map(([name]) => `${name} = ?`).join(", ");
  const result = db.prepare(`UPDATE job_stage_states SET ${assignments} WHERE job_url = ? AND stage = ?`).run(
    ...updateEntries.map(([, value]) => value),
    jobUrl,
    stage,
  );
  if (result.changes > 0) {
    return;
  }

  const insert: Record<string, SqliteValue> = {
    job_url: jobUrl,
    stage,
    state,
    attempt_count: options.attemptCount ?? 0,
    max_attempts: DEFAULT_MAX_ATTEMPTS[stage],
    updated_at: now,
    retryable: options.retryable === false ? 0 : 1,
    blocked_by_json: "[]",
  };
  if (options.finishedAt) {
    insert.finished_at = options.finishedAt;
  }
  const insertEntries = Object.entries(insert).filter(([name]) => columns.has(name));
  db.prepare(
    `INSERT INTO job_stage_states (${insertEntries.map(([name]) => name).join(", ")}) VALUES (${insertEntries
      .map(() => "?")
      .join(", ")})`,
  ).run(...insertEntries.map(([, value]) => value));
}

function getStageState(db: SqliteDatabase, jobUrl: string, stage: Stage): StageSummary {
  if (!tableExists(db, "job_stage_states")) {
    return defaultStage(stage, "pending");
  }
  const row = getRow<Record<string, unknown>>(
    db,
    "SELECT * FROM job_stage_states WHERE job_url = ? AND stage = ? LIMIT 1",
    [jobUrl, stage],
  );
  if (!row) {
    return defaultStage(stage, "pending");
  }
  return {
    stage,
    state: isStageState(row.state) ? row.state : "pending",
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: nullableNumber(row.max_attempts) ?? DEFAULT_MAX_ATTEMPTS[stage],
    startedAt: nullableString(row.started_at),
    updatedAt: nullableString(row.updated_at),
    finishedAt: nullableString(row.finished_at),
    durationMs: nullableNumber(row.duration_ms),
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    retryable: row.retryable === null || row.retryable === undefined ? true : Boolean(row.retryable),
    blockedBy: parseStringArray(nullableString(row.blocked_by_json)),
    nextAction: nullableString(row.next_action),
  };
}

function currentMutableStage(db: SqliteDatabase, jobUrl: string): Stage {
  if (!tableExists(db, "job_stage_states")) {
    return "apply";
  }
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT stage, state FROM job_stage_states WHERE job_url = ? ORDER BY rowid",
    [jobUrl],
  );
  const active = rows.find((row) => ["queued", "running"].includes(String(row.state ?? "")));
  if (active && STAGES.includes(active.stage as Stage)) {
    return active.stage as Stage;
  }
  return "apply";
}

function recordActionEvent(
  db: SqliteDatabase,
  event: {
    jobUrl: string;
    stage: Stage;
    eventType: string;
    level: string;
    message: string;
    payload: Record<string, unknown>;
  },
): void {
  if (!tableExists(db, "job_events")) {
    return;
  }
  const columns = columnNames(db, "job_events");
  const values: Record<string, SqliteValue> = {
    job_url: event.jobUrl,
    stage: event.stage,
    event_type: event.eventType,
    level: event.level,
    message: event.message,
    occurred_at: new Date().toISOString(),
    payload_json: JSON.stringify(event.payload),
  };
  const entries = Object.entries(values).filter(([name]) => columns.has(name));
  db.prepare(
    `INSERT INTO job_events (${entries.map(([name]) => name).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`,
  ).run(...entries.map(([, value]) => value));
}

function parseJsonObjectInput(raw: unknown, rawText: string | undefined, label: string): Record<string, unknown> {
  const parsed = rawText !== undefined ? parseJson(rawText, label) : raw;
  if (!isRecord(parsed)) {
    throw new InputError(`${label} must be a JSON object.`);
  }
  return parsed;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON.";
    throw new InputError(`${label} contains invalid JSON: ${message}`);
  }
}

function writeJson(filePath: string, value: Record<string, unknown>): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function columnNames(db: SqliteDatabase, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) {
    return new Set();
  }
  return new Set(allRows<{ name: string }>(db, `PRAGMA table_info(${tableName})`).map((row) => row.name));
}

function defaultStage(stage: Stage, state: StageState): StageSummary {
  return {
    stage,
    state,
    attemptCount: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS[stage],
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    retryable: true,
    blockedBy: [],
    nextAction: null,
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function isStageState(value: unknown): value is StageState {
  return (
    value === "pending" ||
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "blocked" ||
    value === "skipped" ||
    value === "exhausted" ||
    value === "canceled" ||
    value === "stale"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
