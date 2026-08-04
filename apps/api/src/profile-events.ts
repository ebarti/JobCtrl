import {
  createProfileUpdated,
  LOCAL_TENANT,
  type ProfileUpdated,
} from "@jobctrl/domain-types";

import {
  MIN_TAILORING_FIT_SCORE,
  PIPELINE_ACTION_JOB_KEY,
  type ActionCommandPayload,
  type ProfileUpdateRequest,
} from "./contracts.js";
import { getRow, type SqliteDatabase } from "./db.js";
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

export function shouldContinuePreparationForProfileUpdate(request: ProfileUpdateRequest): boolean {
  return request.profile !== undefined || request.profileText !== undefined;
}

export function hasRetailorableResumes(db: SqliteDatabase): boolean {
  const row = getRow<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count
     FROM job_materials_artifacts
     WHERE artifact_type = 'tailored_resume'
       AND status = 'approved'`,
  );
  return Number(row?.count ?? 0) > 0;
}

export function recordProfileUpdatedEvent(
  db: SqliteDatabase,
  changedSections: readonly string[],
  occurredAt = new Date().toISOString(),
): ProfileUpdated | null {
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
    stage: "score",
    stages: ["score", "tailor", "cover"],
    dryRun: false,
    limit: 0,
    workers: 1,
    minScore: MIN_TAILORING_FIT_SCORE,
    validationMode: "normal",
    rescore: true,
    retailor: true,
  };
  await actionDispatcher(command, actionContext);
}

function insertProfileEvent(db: SqliteDatabase, event: ProfileUpdated): void {
  db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level,
       message, occurred_at, payload_json
     ) VALUES (?, NULL, 1, NULL, ?, 'info', ?, ?, ?)`,
  ).run(
    event.tenantId,
    event.eventType,
    "Candidate profile updated.",
    event.occurredAt,
    JSON.stringify({
      tenantId: event.tenantId,
      ...event.payload,
    }),
  );
}
