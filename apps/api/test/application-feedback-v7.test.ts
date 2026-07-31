import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/projections.js", () => ({ refreshProjections: vi.fn() }));
vi.mock("../src/repeat-application.js", () => ({
  evaluateRepeatApplication: vi.fn(() => ({ blocked: false, matches: [] })),
}));
vi.mock("../src/resume-templates.js", () => ({
  resumeTemplateStateForJob: vi.fn(() => null),
}));

import {
  decideOutcomeSuggestion,
  listApplicationOutcomes,
  listApplyReviewQueue,
  listJobApplicationOutcomes,
  recordManualApplicationOutcome,
} from "../src/application-feedback.js";
import { InputError } from "../src/write-model.js";
import { hasExactV7SchemaManifest } from "../src/schema-manifest.js";
import { initializeExactV7Database } from "./v7-schema.js";

const JOB_ID = "00000000-0000-4000-8000-000000000071";
const JOB_URL = "https://jobs.example.test/application-feedback";
const OTHER_TENANT = "other";
const PRIVATE_NOTE = "private outcome note";
const PRIVATE_BODY = "raw confidential email body";
const PRIVATE_RATIONALE = "private classification rationale";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function seededDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-application-feedback-v7-"));
  const dbPath = path.join(dir, "jobs.db");
  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const tenantId of ["local", OTHER_TENANT]) {
    db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, company, discovered_at, application_url)
       VALUES (?, ?, ?, 'Feedback Engineer', 'Example', '2026-07-31T12:00:00Z', ?)`,
    ).run(tenantId, JOB_ID, `${JOB_URL}/${tenantId}`, JOB_URL);
    db.prepare(
      `INSERT INTO job_list_projections (
         tenant_id, job_id, title, employer, source, application_url, fit_score,
         current_stage, current_substage, current_state, has_resume
       ) VALUES (?, ?, 'Feedback Engineer', 'Example', 'fixture', ?, 9, 'apply', 'apply', 'pending', 1)`,
    ).run(tenantId, JOB_ID, JOB_URL);
    db.prepare(
      `INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at)
       VALUES (?, ?, 'apply', 'pending', '2026-07-31T12:00:00Z')`,
    ).run(tenantId, JOB_ID);
  }
  return db;
}

function seedSuggestion(db: Database.Database, suggestionId: string, suggestedKind = "interview"): void {
  const evidenceId = `evidence-${suggestionId}`;
  db.prepare(
    `INSERT INTO application_email_evidence (
       tenant_id, evidence_id, job_id, provider, provider_message_id, linked_at,
       link_confidence, link_signals_json, body_text
     ) VALUES ('local', ?, ?, 'gmail', ?, '2026-07-31T12:05:00Z', 0.9, '[]', ?)`,
  ).run(evidenceId, JOB_ID, `message-${suggestionId}`, PRIVATE_BODY);
  db.prepare(
    `INSERT INTO application_outcome_suggestions (
       tenant_id, suggestion_id, job_id, evidence_id, suggested_kind, confidence,
       rationale, status, created_at
     ) VALUES ('local', ?, ?, ?, ?, 0.9, ?, 'pending', '2026-07-31T12:06:00Z')`,
  ).run(suggestionId, JOB_ID, evidenceId, suggestedKind, PRIVATE_RATIONALE);
}

describe("application feedback exact v7 identity", () => {
  it("keeps queue and outcome reads tenant-isolated when tenants share a canonical job id", () => {
    const db = seededDatabase();
    db.prepare(
      `INSERT INTO application_outcomes (
         tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at
       ) VALUES (?, 'other-outcome', ?, 'rejection', 'manual', '2026-07-31T12:01:00Z', '2026-07-31T12:01:00Z')`,
    ).run(OTHER_TENANT, JOB_ID);

    const manual = recordManualApplicationOutcome(db, JOB_ID, {
      kind: "interview",
      note: PRIVATE_NOTE,
      occurredAt: "2026-07-31T12:02:00Z",
    });
    const jobOutcomes = listJobApplicationOutcomes(db, JOB_ID);
    const allOutcomes = listApplicationOutcomes(db);
    const queue = listApplyReviewQueue(db);

    expect(jobOutcomes?.jobKey).toBe(JOB_ID);
    expect(jobOutcomes?.outcomes).toEqual([
      expect.objectContaining({ outcomeId: manual.outcome.outcomeId, jobKey: JOB_ID }),
    ]);
    expect(allOutcomes.outcomes).toHaveLength(1);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.jobKey).toBe(JOB_ID);
  });

  it("accepts, corrects, and ignores exact-v7 suggestions without exposing private text in events", () => {
    const db = seededDatabase();
    seedSuggestion(db, "accept", "interview");
    seedSuggestion(db, "correct", "unknown");
    seedSuggestion(db, "ignore", "rejection");

    const accepted = decideOutcomeSuggestion(db, "accept", {
      decision: "accept",
      note: PRIVATE_NOTE,
    });
    const corrected = decideOutcomeSuggestion(db, "correct", {
      decision: "correct",
      outcomeKind: "offer",
      reason: PRIVATE_RATIONALE,
    });
    const ignored = decideOutcomeSuggestion(db, "ignore", {
      decision: "ignore",
      reason: PRIVATE_RATIONALE,
    });
    const events = db.prepare("SELECT payload_json FROM job_events ORDER BY event_id").all() as Array<{
      payload_json: string | null;
    }>;

    expect(accepted).toMatchObject({ suggestion: { status: "accepted", jobKey: JOB_ID }, outcome: { kind: "interview" } });
    expect(corrected).toMatchObject({ suggestion: { status: "corrected" }, outcome: { kind: "offer" } });
    expect(ignored).toMatchObject({ suggestion: { status: "ignored" }, outcome: null });
    expect(listApplicationOutcomes(db).outcomes).toHaveLength(2);
    expect(events.map((event) => event.payload_json).join("\n")).not.toContain(PRIVATE_NOTE);
    expect(events.map((event) => event.payload_json).join("\n")).not.toContain(PRIVATE_BODY);
    expect(events.map((event) => event.payload_json).join("\n")).not.toContain(PRIVATE_RATIONALE);
  });

  it("does not mutate the exact-v7 schema and refuses an invalid job id", () => {
    const db = seededDatabase();
    expect(hasExactV7SchemaManifest(db)).toBe(true);

    expect(() =>
      recordManualApplicationOutcome(db, "not-a-canonical-job-id", { kind: "interview" }),
    ).toThrow(InputError);
    expect(hasExactV7SchemaManifest(db)).toBe(true);
  });
});
