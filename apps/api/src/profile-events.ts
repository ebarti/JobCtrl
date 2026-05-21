import {
  createProfileUpdated,
  LOCAL_TENANT,
  type ProfileUpdated,
} from "@jobhunter/domain-types";

import {
  PIPELINE_ACTION_JOB_KEY,
  type ActionCommandPayload,
  type ProfileUpdateRequest,
} from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import type { ActionDispatchContext, ActionDispatcher } from "./local-actions.js";

export function profileChangedSections(request: ProfileUpdateRequest): string[] {
  const sections: string[] = [];
  if (request.profile !== undefined || request.profileText !== undefined) {
    sections.push("profile");
  }
  if (request.style !== undefined || request.styleText !== undefined) {
    sections.push("style");
  }
  if (request.templateText !== undefined) {
    sections.push("template");
  }
  return sections;
}

export function shouldRetailorForProfileUpdate(request: ProfileUpdateRequest): boolean {
  return request.profile !== undefined || request.profileText !== undefined;
}

export function hasRetailorableResumes(db: SqliteDatabase): boolean {
  if (tableExists(db, "job_materials_artifacts")) {
    const row = getRow<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count
       FROM job_materials_artifacts
       WHERE artifact_type = 'tailored_resume'
         AND status = 'approved'`,
    );
    if (Number(row?.count ?? 0) > 0) {
      return true;
    }
  }

  if (tableExists(db, "jobs")) {
    const row = getRow<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count
       FROM jobs
       WHERE tailored_resume_path IS NOT NULL
         AND tailored_resume_path != ''`,
    );
    if (Number(row?.count ?? 0) > 0) {
      return true;
    }
  }

  if (tableExists(db, "job_artifacts")) {
    const row = getRow<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count
       FROM job_artifacts
       WHERE artifact_type IN ('tailored_resume', 'tailored_resume_txt')
         AND status IN ('active', 'approved')`,
    );
    if (Number(row?.count ?? 0) > 0) {
      return true;
    }
  }

  return false;
}

export function recordProfileUpdatedEvent(
  db: SqliteDatabase,
  changedSections: readonly string[],
  occurredAt = new Date().toISOString(),
): ProfileUpdated | null {
  if (!tableExists(db, "job_events")) {
    return null;
  }
  const event = {
    ...createProfileUpdated(LOCAL_TENANT, {
      changedSections,
      updatedAt: occurredAt,
    }),
    occurredAt,
  };
  insertProfileEvent(db, event);
  return event;
}

export async function handleProfileUpdatedEvent(
  event: ProfileUpdated,
  actionDispatcher: ActionDispatcher,
  actionContext: ActionDispatchContext,
): Promise<void> {
  if (!event.payload.changedSections.includes("profile")) {
    return;
  }
  const command: ActionCommandPayload = {
    action: "run_stage",
    jobKey: PIPELINE_ACTION_JOB_KEY,
    stage: "tailor",
    stages: ["tailor", "pdf"],
    dryRun: false,
    limit: 0,
    workers: 1,
    minScore: 0,
    validationMode: "normal",
    retailor: true,
  };
  await actionDispatcher(command, actionContext);
}

function insertProfileEvent(db: SqliteDatabase, event: ProfileUpdated): void {
  const columns = columnNames(db, "job_events");
  const values: Record<string, SqliteValue> = {
    job_url: null,
    stage: null,
    event_type: event.eventType,
    level: "info",
    message: "Candidate profile updated.",
    occurred_at: event.occurredAt,
    payload_json: JSON.stringify({
      tenantId: event.tenantId,
      ...event.payload,
    }),
  };
  const entries = Object.entries(values).filter(([name]) => columns.has(name));
  if (entries.length === 0) {
    return;
  }
  db.prepare(
    `INSERT INTO job_events (${entries.map(([name]) => name).join(", ")}) VALUES (${entries
      .map(() => "?")
      .join(", ")})`,
  ).run(...entries.map(([, value]) => value));
}

function columnNames(db: SqliteDatabase, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) {
    return new Set();
  }
  return new Set(allRows<{ name: string }>(db, `PRAGMA table_info(${tableName})`).map((row) => row.name));
}
