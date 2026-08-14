import { isDeepStrictEqual } from "node:util";

import {
  createProfileUpdated,
  LOCAL_TENANT,
  type ProfileUpdated,
} from "@jobctrl/domain-types";

import {
  MIN_TAILORING_FIT_SCORE,
  PIPELINE_ACTION_JOB_KEY,
  type ActionCommandPayload,
  type ProfileConfigResponse,
  type ProfileUpdateRequest,
} from "./contracts.js";
import { getRow, type SqliteDatabase } from "./db.js";
import type { ActionDispatchContext, ActionDispatcher } from "./local-actions.js";
import { readProfileConfig, writeProfileConfig } from "./profile-store.js";
import {
  DEFAULT_JOBCTRL_SETTINGS,
  readJobCtrlSettings,
} from "./settings-config.js";

interface RecordedProfileUpdated {
  event: ProfileUpdated;
  eventId: number;
}

export function persistProfileUpdate(
  db: SqliteDatabase,
  request: ProfileUpdateRequest,
  recordEvent: typeof recordProfileUpdatedEvent = recordProfileUpdatedEvent,
): {
  profile: ProfileConfigResponse;
  recorded: RecordedProfileUpdated | null;
  continuePreparation: boolean;
} {
  return db.transaction(() => {
    const previous = readProfileConfig(db);
    const profile = writeProfileConfig(db, request);
    const changedSections = profileChangedSections(request, previous, profile);
    return {
      profile,
      recorded: changedSections.length > 0 ? recordEvent(db, changedSections) : null,
      continuePreparation: shouldContinuePreparationForProfileUpdate(changedSections),
    };
  })();
}

export function profileChangedSections(
  request: ProfileUpdateRequest,
  before: ProfileConfigResponse,
  after: ProfileConfigResponse,
): string[] {
  const sections: string[] = [];
  if (
    (request.profile !== undefined || request.profileText !== undefined)
    && !isDeepStrictEqual(before.profile, after.profile)
  ) {
    sections.push("profile");
  }
  if (
    (request.style !== undefined || request.styleText !== undefined)
    && !isDeepStrictEqual(before.style, after.style)
  ) {
    sections.push("style");
  }
  if (request.templateText !== undefined && before.templateText !== after.templateText) {
    sections.push("template");
  }
  return sections;
}

export function shouldContinuePreparationForProfileUpdate(changedSections: readonly string[]): boolean {
  return changedSections.includes("profile");
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
): RecordedProfileUpdated | null {
  const event = {
    ...createProfileUpdated(LOCAL_TENANT, {
      changedSections,
      updatedAt: occurredAt,
    }),
    occurredAt,
  };
  return { event, eventId: insertProfileEvent(db, event) };
}

export async function handleProfileUpdatedEvent(
  eventId: number,
  actionDispatcher: ActionDispatcher,
  actionContext: ActionDispatchContext,
): Promise<void> {
  const workers = actionContext.configPath
    ? readJobCtrlSettings(actionContext.configPath).settings.pipelineInternalConcurrency
    : DEFAULT_JOBCTRL_SETTINGS.pipelineInternalConcurrency;
  const command: ActionCommandPayload = {
    action: "run_stage",
    jobKey: PIPELINE_ACTION_JOB_KEY,
    stage: "score",
    stages: ["score", "tailor", "cover"],
    dryRun: false,
    limit: 0,
    workers,
    minScore: MIN_TAILORING_FIT_SCORE,
    validationMode: "normal",
    retailor: true,
    reason: `profile_updated:${eventId}`,
  };
  const result = await actionDispatcher(command, actionContext);
  if (result.status === "failed" || result.status === "unsupported") {
    throw new Error(result.message || `Profile continuation dispatch ended ${result.status}.`);
  }
}

export function pendingProfileContinuationEventIds(db: SqliteDatabase): number[] {
  return (db.prepare(
    `SELECT updated.event_id
       FROM job_events AS updated
      WHERE updated.tenant_id = ?
        AND updated.event_type = 'ProfileUpdated'
        AND EXISTS (
          SELECT 1
            FROM json_each(json_extract(updated.payload_json, '$.changedSections'))
           WHERE value = 'profile'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM job_events AS handled
           WHERE handled.idempotency_key = 'profile-continuation-handled:' || updated.event_id
        )
      ORDER BY updated.event_id`,
  ).all(LOCAL_TENANT) as Array<{ event_id: number }>).map((row) => Number(row.event_id));
}

export function claimNextProfileContinuationEvent(db: SqliteDatabase): number | null {
  const pendingEventIds = pendingProfileContinuationEventIds(db);
  if (pendingEventIds.length === 0) return null;
  const intendedEventIds = new Set(
    (db.prepare(
      `SELECT json_extract(payload_json, '$.sourceEventId') AS source_event_id
         FROM job_events
        WHERE tenant_id = ?
          AND event_type = 'ProfileContinuationDispatchIntended'`,
    ).all(LOCAL_TENANT) as Array<{ source_event_id: number }>).map((row) => Number(row.source_event_id)),
  );
  const alreadyIntended = pendingEventIds.find((eventId) => intendedEventIds.has(eventId));
  if (alreadyIntended !== undefined) {
    return alreadyIntended;
  }

  const eventId = pendingEventIds.at(-1);
  if (eventId === undefined) return null;
  const occurredAt = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level,
         message, occurred_at, payload_json, idempotency_key
       ) VALUES (?, NULL, 1, NULL, 'ProfileContinuationDispatchIntended', 'info', ?, ?, ?, ?)`,
    ).run(
      LOCAL_TENANT,
      "Profile update continuation dispatch reserved.",
      occurredAt,
      JSON.stringify({ sourceEventId: eventId, status: "dispatch_intended" }),
      `profile-continuation-dispatch-intended:${eventId}`,
    );
    insertProfileContinuationHandledEvents(
      db,
      pendingEventIds.filter((candidate) => candidate !== eventId),
      eventId,
      occurredAt,
    );
  })();
  return eventId;
}

export function markProfileContinuationEventsHandled(
  db: SqliteDatabase,
  eventIds: readonly number[],
  dispatchedEventId: number,
  occurredAt = new Date().toISOString(),
): void {
  db.transaction(() => {
    insertProfileContinuationHandledEvents(db, eventIds, dispatchedEventId, occurredAt);
  })();
}

function insertProfileContinuationHandledEvents(
  db: SqliteDatabase,
  eventIds: readonly number[],
  dispatchedEventId: number,
  occurredAt: string,
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level,
       message, occurred_at, payload_json, idempotency_key
     ) VALUES (?, NULL, 1, NULL, 'ProfileContinuationHandled', 'info', ?, ?, ?, ?)`,
  );
  for (const eventId of eventIds) {
    const status = eventId === dispatchedEventId ? "completed" : "superseded";
    insert.run(
      LOCAL_TENANT,
      status === "completed"
        ? "Profile update continuation completed."
        : "Profile update continuation superseded by a newer profile version.",
      occurredAt,
      JSON.stringify({ sourceEventId: eventId, dispatchedEventId, status }),
      `profile-continuation-handled:${eventId}`,
    );
  }
}

function insertProfileEvent(db: SqliteDatabase, event: ProfileUpdated): number {
  const result = db.prepare(
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
  return Number(result.lastInsertRowid);
}
