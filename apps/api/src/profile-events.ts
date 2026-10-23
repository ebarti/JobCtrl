import { isDeepStrictEqual } from "node:util";

import {
  createProfileUpdated,
  LOCAL_TENANT,
  type ProfileUpdated,
} from "@jobctrl/domain-types";

import {
  type ProfileConfigResponse,
  type ProfileUpdateRequest,
} from "./contracts.js";
import type { SqliteDatabase } from "./db.js";
import { readProfileConfig, writeProfileConfig } from "./profile-store.js";

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
} {
  return db.transaction(() => {
    const previous = readProfileConfig(db);
    const profile = writeProfileConfig(db, request);
    const changedSections = profileChangedSections(request, previous, profile);
    return {
      profile,
      recorded: changedSections.length > 0 ? recordEvent(db, changedSections) : null,
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
