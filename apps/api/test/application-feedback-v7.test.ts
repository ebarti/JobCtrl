import crypto from "node:crypto";
import { seedApplicationUrl } from "./seed-enrichment.js";
import fs from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import type { OutcomeSuggestionDecisionRequest } from "@jobctrl/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/projections.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/projections.js")>(),
  refreshProjections: vi.fn(),
}));
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
import { hasExactV15SchemaManifest } from "../src/schema-manifest.js";
import { initializeExactDatabase } from "./exact-schema.js";

import { recordOutcomeDecision } from "./semantic-fixtures.js";

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
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const tenantId of ["local", OTHER_TENANT]) {
    db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, company, discovered_at)
       VALUES (?, ?, ?, 'Feedback Engineer', 'Example', '2026-07-31T12:00:00Z')`,
    ).run(tenantId, JOB_ID, `${JOB_URL}/${tenantId}`);
    seedApplicationUrl(db, tenantId, JOB_ID, JOB_URL);
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
  recordOutcomeDecision(db,suggestionId,`message-${suggestionId}`,suggestedKind,0.9,PRIVATE_BODY);
}

describe("application feedback exact current identity", () => {
  it("keeps queue and outcome reads tenant-isolated when tenants share a canonical job id", () => {
    const db = seededDatabase();
    db.prepare(
      `INSERT INTO application_outcomes (
         tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at
       ) VALUES (?, 'other-outcome', ?, 'rejection', 'manual', '2026-07-31T12:01:00Z', '2026-07-31T12:01:00Z')`,
    ).run(OTHER_TENANT, JOB_ID);

    const manual = recordManualApplicationOutcome(db, JOB_ID, { requestId: crypto.randomUUID(),
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

  it("accepts, corrects, and ignores exact-current suggestions without exposing private text in events", () => {
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

  it("returns exact replays and conflicts without replacing decisions, outcomes or events", () => {
    const db = seededDatabase();
    seedSuggestion(db, "correct-replay");
    const request = {
      decision: "correct" as const, outcomeKind: "offer" as const,
      occurredAt: "2026-07-30T12:00:00.000Z", note: PRIVATE_NOTE, reason: PRIVATE_RATIONALE,
    };
    const first = decideOutcomeSuggestion(db, "correct-replay", request);
    const replay = decideOutcomeSuggestion(db, "correct-replay", request);
    expect(first).toMatchObject({ ok: true, disposition: "applied" });
    expect(replay).toMatchObject({ ok: true, disposition: "replayed", outcome: first.outcome });
    for (const changed of [
      { decision: "ignore" as const, reason: request.reason },
      { ...request, outcomeKind: "rejection" as const },
      { ...request, note: "different private note" },
      { ...request, reason: "different private reason" },
      { ...request, occurredAt: "2026-07-29T12:00:00.000Z" },
      { ...request, occurredAt: undefined },
    ]) {
      expect(decideOutcomeSuggestion(db, "correct-replay", changed)).toMatchObject({
        ok: false, error: "outcome_suggestion_conflict", suggestion: { status: "corrected" }, outcome: first.outcome,
      });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM application_outcomes WHERE tenant_id='local'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='OutcomeSuggestionDecided'").get()).toEqual({ n: 1 });
    const events = JSON.stringify(db.prepare("SELECT payload_json FROM job_events").all());
    expect(events).not.toContain(PRIVATE_NOTE);
    expect(events).not.toContain(PRIVATE_RATIONALE);
    expect(events).not.toContain("different private");
  });

  it("recognizes default-time and ignored replays and reports ambiguous legacy time honestly", () => {
    const db = seededDatabase();
    seedSuggestion(db, "default-time");
    seedSuggestion(db, "ignored-replay");
    const request = { decision: "accept" as const, note: PRIVATE_NOTE };
    const first = decideOutcomeSuggestion(db, "default-time", request);
    expect(decideOutcomeSuggestion(db, "default-time", request)).toMatchObject({ ok: true, disposition: "replayed" });
    expect(decideOutcomeSuggestion(db, "default-time", { ...request, occurredAt: first.suggestion.decidedAt! })).toMatchObject({
      ok: false, error: "outcome_suggestion_conflict",
    });
    const ignored = { decision: "ignore" as const, reason: PRIVATE_RATIONALE };
    decideOutcomeSuggestion(db, "ignored-replay", ignored);
    expect(decideOutcomeSuggestion(db, "ignored-replay", ignored)).toMatchObject({ ok: true, disposition: "replayed" });
    expect(decideOutcomeSuggestion(db, "ignored-replay", { ...ignored, reason: "different" })).toMatchObject({ ok: false, error: "outcome_suggestion_conflict" });
    db.prepare(`UPDATE job_events SET payload_json=json_remove(payload_json, '$.decisionRequestVersion', '$.occurredAtProvided')
      WHERE event_type='OutcomeSuggestionDecided' AND json_extract(payload_json, '$.suggestionId')='default-time'`).run();
    expect(decideOutcomeSuggestion(db, "default-time", request)).toMatchObject({ ok: false, error: "outcome_suggestion_replay_unverifiable" });
  });

  it("does not infer legacy or damaged request identity from incomplete history", () => {
    const db = seededDatabase();
    seedSuggestion(db, "legacy-accept");
    seedSuggestion(db, "legacy-correct");
    seedSuggestion(db, "inconsistent-decision");
    const accepted = { decision: "accept" as const, occurredAt: "2026-01-01T12:00:00.000Z" };
    const corrected = { decision: "correct" as const, outcomeKind: "offer" as const,
      occurredAt: "2026-01-01T12:00:00.000Z", note: PRIVATE_NOTE };
    decideOutcomeSuggestion(db, "legacy-accept", accepted);
    decideOutcomeSuggestion(db, "legacy-correct", corrected);
    decideOutcomeSuggestion(db, "inconsistent-decision", { decision: "ignore" });
    db.prepare(`UPDATE job_events SET payload_json=json_remove(payload_json, '$.decisionRequestVersion', '$.occurredAtProvided')
      WHERE event_type='OutcomeSuggestionDecided' AND json_extract(payload_json, '$.suggestionId') IN ('legacy-accept','legacy-correct')`).run();
    // Legacy accept requests could also contain an ignored outcomeKind.
    expect(decideOutcomeSuggestion(db, "legacy-accept", accepted)).toMatchObject({
      ok: false, error: "outcome_suggestion_replay_unverifiable",
    });
    expect(decideOutcomeSuggestion(db, "legacy-correct", corrected)).toMatchObject({
      ok: false, error: "outcome_suggestion_replay_unverifiable",
    });
    db.prepare(`UPDATE job_events SET payload_json=json_set(payload_json, '$.decisionRequestVersion', 1, '$.occurredAtProvided', 1)
      WHERE event_type='OutcomeSuggestionDecided' AND json_extract(payload_json, '$.suggestionId')='legacy-correct'`).run();
    expect(decideOutcomeSuggestion(db, "legacy-correct", corrected)).toMatchObject({
      ok: false, error: "outcome_suggestion_replay_unverifiable",
    });
    db.prepare(`DELETE FROM job_events WHERE event_type='OutcomeSuggestionDecided'
      AND json_extract(payload_json, '$.suggestionId')='legacy-correct'`).run();
    expect(decideOutcomeSuggestion(db, "legacy-correct", corrected)).toMatchObject({
      ok: false, error: "outcome_suggestion_replay_unverifiable",
    });
    db.prepare("UPDATE application_outcome_suggestions SET decision = NULL WHERE suggestion_id='inconsistent-decision'").run();
    expect(decideOutcomeSuggestion(db, "inconsistent-decision", { decision: "accept" })).toMatchObject({
      ok: false, error: "outcome_suggestion_replay_unverifiable",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='OutcomeSuggestionDecided'").get()).toEqual({ n: 2 });
  });

  it.each([
    "outcome-kind", "outcome-note", "decision-reason", "outcome-time", "outcome-creator",
    "event-kind", "receipt-binding", "receipt-key", "missing-receipt", "missing-event", "duplicate-event", "reset-pending",
  ] as const)("refuses replay or redecision after synthetic %s corruption", (damage) => {
    const db = seededDatabase();
    const suggestionId = `integrity-${damage}`;
    seedSuggestion(db, suggestionId);
    const request: OutcomeSuggestionDecisionRequest = { decision: "correct", outcomeKind: "offer",
      occurredAt: "2026-01-01T12:00:00.000Z", note: PRIVATE_NOTE, reason: PRIVATE_RATIONALE };
    const first = decideOutcomeSuggestion(db, suggestionId, request);
    expect(first).toMatchObject({ ok: true, disposition: "applied" });
    expect(decideOutcomeSuggestion(db, suggestionId, request)).toMatchObject({ ok: true, disposition: "replayed" });
    const eventRow = db.prepare(`SELECT event_id, payload_json, idempotency_key FROM job_events
      WHERE event_type='OutcomeSuggestionDecided' AND json_extract(payload_json, '$.suggestionId')=?`).get(suggestionId) as
      { event_id: number; payload_json: string; idempotency_key: string };
    expect(eventRow.payload_json).not.toContain(PRIVATE_NOTE);
    expect(eventRow.payload_json).not.toContain(PRIVATE_RATIONALE);
    expect(eventRow.payload_json).not.toContain(eventRow.idempotency_key);
    let retry = request;
    switch (damage) {
      case "outcome-kind":
        db.prepare("UPDATE application_outcomes SET kind='rejection' WHERE suggestion_id=?").run(suggestionId);
        retry = { ...request, outcomeKind: "rejection" };
        break;
      case "outcome-note":
        db.prepare("UPDATE application_outcomes SET note='altered synthetic note' WHERE suggestion_id=?").run(suggestionId);
        retry = { ...request, note: "altered synthetic note" };
        break;
      case "decision-reason":
        db.prepare("UPDATE application_outcome_suggestions SET decision_reason='altered synthetic reason' WHERE suggestion_id=?").run(suggestionId);
        retry = { ...request, reason: "altered synthetic reason" };
        break;
      case "outcome-time":
        db.prepare("UPDATE application_outcomes SET occurred_at='2025-01-01T12:00:00.000Z' WHERE suggestion_id=?").run(suggestionId);
        retry = { ...request, occurredAt: "2025-01-01T12:00:00.000Z" };
        break;
      case "outcome-creator":
        db.prepare("UPDATE application_outcomes SET created_by='altered' WHERE suggestion_id=?").run(suggestionId);
        break;
      case "event-kind":
        db.prepare("UPDATE job_events SET payload_json=json_set(payload_json, '$.outcomeKind', 'rejection') WHERE event_id=?").run(eventRow.event_id);
        break;
      case "receipt-binding":
        db.prepare("UPDATE job_events SET payload_json=json_set(payload_json, '$.receipt.factId', 'other') WHERE event_id=?").run(eventRow.event_id);
        break;
      case "receipt-key":
        db.prepare("UPDATE job_events SET idempotency_key=substr(idempotency_key, 1, length(idempotency_key)-1) || 'z' WHERE event_id=?").run(eventRow.event_id);
        break;
      case "missing-receipt":
        db.prepare("UPDATE job_events SET idempotency_key=NULL WHERE event_id=?").run(eventRow.event_id);
        break;
      case "missing-event":
        db.prepare("DELETE FROM job_events WHERE event_id=?").run(eventRow.event_id);
        break;
      case "duplicate-event":
        db.prepare(`INSERT INTO job_events (tenant_id,job_id,identity_version,stage,event_type,level,message,occurred_at,payload_json,entity_kind,entity_ref)
          SELECT tenant_id,job_id,identity_version,stage,event_type,level,message,occurred_at,payload_json,entity_kind,entity_ref
          FROM job_events WHERE event_id=?`).run(eventRow.event_id);
        break;
      case "reset-pending":
        db.prepare("UPDATE application_outcome_suggestions SET status='pending', decision=NULL, decided_at=NULL, decision_reason=NULL, decided_outcome_id=NULL WHERE suggestion_id=?").run(suggestionId);
        break;
    }
    expect(decideOutcomeSuggestion(db, suggestionId, retry)).toMatchObject({
      ok: false, error: "outcome_suggestion_replay_unverifiable",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM application_outcomes WHERE suggestion_id=?").get(suggestionId)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='OutcomeSuggestionDecided' AND json_extract(payload_json, '$.suggestionId')=?").get(suggestionId))
      .toEqual({ n: damage === "missing-event" ? 0 : damage === "duplicate-event" ? 2 : 1 });
  });

  it("rolls back the outcome and decision when its audit event cannot be written", () => {
    const db = seededDatabase();
    seedSuggestion(db, "event-failure");
    db.exec(`CREATE TEMP TRIGGER fail_outcome_decision BEFORE INSERT ON job_events
      WHEN NEW.event_type='OutcomeSuggestionDecided' BEGIN SELECT RAISE(ABORT, 'synthetic event failure'); END`);
    expect(() => decideOutcomeSuggestion(db, "event-failure", { decision: "accept" })).toThrow("synthetic event failure");
    expect(db.prepare("SELECT status, decided_outcome_id FROM application_outcome_suggestions WHERE suggestion_id='event-failure'").get()).toEqual({ status: "pending", decided_outcome_id: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM application_outcomes WHERE tenant_id='local'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_events").get()).toEqual({ n: 0 });
  });

  it("does not normalize a damaged raw kind into an identical unknown-outcome replay", () => {
    const db = seededDatabase();
    const suggestionId = "integrity-unknown-kind";
    seedSuggestion(db, suggestionId);
    const request = { decision: "correct" as const, outcomeKind: "unknown" as const, note: PRIVATE_NOTE };
    const first = decideOutcomeSuggestion(db, suggestionId, request);
    expect(first).toMatchObject({ ok: true, disposition: "applied", outcome: { kind: "unknown" } });
    expect(decideOutcomeSuggestion(db, suggestionId, request)).toMatchObject({ ok: true, disposition: "replayed" });
    db.prepare("UPDATE application_outcomes SET kind='unsupported-synthetic-kind' WHERE suggestion_id=?").run(suggestionId);
    expect(decideOutcomeSuggestion(db, suggestionId, request)).toMatchObject({
      ok: false, error: "outcome_suggestion_replay_unverifiable", outcome: null,
    });
    expect(db.prepare("SELECT kind FROM application_outcomes WHERE suggestion_id=?").get(suggestionId)).toEqual({ kind: "unsupported-synthetic-kind" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='OutcomeSuggestionDecided' AND json_extract(payload_json, '$.suggestionId')=?").get(suggestionId)).toEqual({ n: 1 });
  });

  it("serializes distinct and identical concurrent decisions on independent connections", async () => {
    const db = seededDatabase();
    const childPath = fileURLToPath(new URL("./fixtures/outcome-decision-child.mjs", import.meta.url));
    for (const scenario of [
      { id: "race-opposite", requests: [{ decision: "accept" }, { decision: "ignore" }], identical: false },
      { id: "race-identical", requests: [{ decision: "accept" }, { decision: "accept" }], identical: true },
      { id: "race-corrections", requests: [
        { decision: "correct", outcomeKind: "offer", note: "first synthetic correction" },
        { decision: "correct", outcomeKind: "rejection", note: "second synthetic correction" },
      ], identical: false },
    ]) {
      seedSuggestion(db, scenario.id);
      const locker = new Database(db.name);
      locker.exec("BEGIN IMMEDIATE");
      const children = scenario.requests.map((request) => fork(childPath, [db.name, scenario.id, JSON.stringify(request)], {
        execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
      }));
      const messages = children.map((child) => {
        const received: Array<Record<string, unknown>> = [];
        child.on("message", (message) => received.push(message as Record<string, unknown>));
        return received;
      });
      const waitForPhase = async (phase: string) => {
        const deadline = Date.now() + 10000;
        while (!messages.every((items) => items.some((item) => item.phase === phase))) {
          if (Date.now() > deadline || children.some((child, index) => child.exitCode !== null && !messages[index]!.some((item) => item.phase === phase))) throw new Error(`Children did not reach ${phase}: ${JSON.stringify(messages)}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      try {
        await waitForPhase("ready");
        children.forEach((child) => child.send("go"));
        await waitForPhase("attempting");
        locker.exec("COMMIT");
        await waitForPhase("result");
        const results = messages.map((items) => items.find((item) => item.phase === "result")?.result as {
          ok: boolean; disposition?: string; error?: string; suggestion: unknown; outcome: unknown;
        });
        expect(results.filter((result) => result.disposition === "applied")).toHaveLength(1);
        if (scenario.identical) expect(results.filter((result) => result.disposition === "replayed")).toHaveLength(1);
        else expect(results.filter((result) => !result.ok && result.error === "outcome_suggestion_conflict")).toHaveLength(1);
        expect(results[0]!.suggestion).toEqual(results[1]!.suggestion);
        expect(results[0]!.outcome).toEqual(results[1]!.outcome);
        expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='OutcomeSuggestionDecided' AND json_extract(payload_json, '$.suggestionId')=?").get(scenario.id)).toEqual({ n: 1 });
        const status = (db.prepare("SELECT status FROM application_outcome_suggestions WHERE suggestion_id=?").get(scenario.id) as {status: string}).status;
        const expectedOutcomes = status === "ignored" ? 0 : 1;
        expect(db.prepare("SELECT COUNT(*) AS n FROM application_outcomes WHERE tenant_id='local' AND suggestion_id=?").get(scenario.id)).toEqual({ n: expectedOutcomes });
        expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='ApplicationOutcomeRecorded' AND json_extract(payload_json, '$.suggestionId')=?").get(scenario.id)).toEqual({ n: expectedOutcomes });
      } finally {
        if (locker.inTransaction) locker.exec("ROLLBACK");
        locker.close();
        await Promise.all(children.map((child) => new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
          child.once("exit", () => resolve());
          child.kill();
        })));
      }
    }
  }, 45000);

  it("does not mutate the exact-current schema and refuses an invalid job id", () => {
    const db = seededDatabase();
    expect(hasExactV15SchemaManifest(db)).toBe(true);

    expect(() =>
      recordManualApplicationOutcome(db, "not-a-canonical-job-id", { requestId: crypto.randomUUID(), kind: "interview" }),
    ).toThrow(InputError);
    expect(hasExactV15SchemaManifest(db)).toBe(true);
  });
});
