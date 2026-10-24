import type { ManualApplicationOutcomeRequest, LogOutreachSendRequest } from "@jobctrl/contracts";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { JobCtrlApiClient, JobCtrlApiError } from "@jobctrl/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordManualApplicationOutcome } from "../src/application-feedback.js";
import { logOutreachSend } from "../src/outreach.js";
import { actionIdentity, ActionReceiptConflictError } from "../src/action-receipts.js";
import { hasExactV14SchemaManifest } from "../src/schema-manifest.js";
import { initializeExactDatabase } from "./exact-schema.js";

const JOB = "11720000-0000-4000-8000-000000000001";
const OTHER_JOB = "11720000-0000-4000-8000-000000000002";
const PRIVATE = "Synthetic private reflection: do not project this prose.";
const nativeFetch = globalThis.fetch;
const authorizedFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("origin", "http://127.0.0.1:5173");
  return nativeFetch(input, { ...init, headers });
};
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockImplementation(authorizedFetch); });
const children = new Set<ChildProcess>();
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...children].map(stop));
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
  children.delete(child);
}

async function server(dbPath: string) {
  const child = fork(fileURLToPath(new URL("./action-retry-server.ts", import.meta.url)), [dbPath], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  let diagnostics = "";
  child.stderr?.on("data", (data) => { diagnostics += String(data); });
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Owned API startup timed out: ${diagnostics}`)), 15_000);
    child.once("message", (message) => { clearTimeout(timeout); const url = (message as { url: string }).url;
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || !url || url.endsWith(":8766")) { reject(new Error("Invalid owned HTTP address")); return; }
      resolve(url); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Owned API exited ${code}: ${diagnostics}`)); });
  });
  return { child, url, client: new JobCtrlApiClient(url, 10_000) };
}

function entered(child: ChildProcess, requestId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.off("message", observe); reject(new Error("Owned writer did not enter the HTTP mutation")); }, 10_000);
    function observe(message: unknown) {
      const event = message as { stage?: string; requestId?: string };
      if (event.stage !== "mutation-entered" || event.requestId !== requestId) return;
      clearTimeout(timeout);
      child.off("message", observe);
      resolve();
    }
    child.on("message", observe);
  });
}

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-action-retry-"));
  directories.push(dir);
  const dbPath = path.join(dir, "jobs.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  for (const tenant of ["local", "foreign"]) for (const id of [JOB, OTHER_JOB]) {
    db.prepare("INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)").run(tenant, id, `https://example.test/jobs/${id}`);
    db.prepare("INSERT INTO job_interview_prep (tenant_id, job_id, generation, status, generated_at, model, gate_status) VALUES (?, ?, 1, 'accepted', '2026-01-01T00:00:00Z', 'synthetic', 'passed')").run(tenant, id);
  }
  for (const id of ["thread", "other-thread"]) {
    db.prepare("INSERT INTO outreach_threads (tenant_id, thread_id, contact_id, created_at, updated_at) VALUES ('local', ?, 'contact', '2026-01-01', '2026-01-01')").run(id);
    db.prepare("INSERT INTO outreach_drafts (tenant_id, draft_id, thread_id, generation, kind, status, body_text, created_at, gate_results_json) VALUES ('local', ?, ?, 1, 'intro_request', 'approved', ?, '2026-01-01', '{\"passed\":true}')").run(`draft-${id}`, id, PRIVATE);
  }
  db.close();
  return dbPath;
}

const families = ["outcome", "reflection", "send"] as const;
type Family = typeof families[number];
function body(family: "send", requestId?: string): LogOutreachSendRequest;
function body(family: "outcome" | "reflection", requestId?: string): ManualApplicationOutcomeRequest;
function body(family: Family, requestId?: string): ManualApplicationOutcomeRequest | LogOutreachSendRequest;
function body(family: Family, requestId: string = randomUUID()): ManualApplicationOutcomeRequest | LogOutreachSendRequest {
  return family === "send"
    ? { requestId, draftId: "draft-thread", channel: "email" as const, sentAt: "2026-01-01" }
    : { requestId, kind: "interview" as const, note: PRIVATE, ...(family === "reflection" ? { interviewPrepGeneration: 1 } : {}) };
}
function route(family: Family, target = JOB) { return family === "send" ? "/v1/outreach/threads/thread/send-logs" : `/v1/jobs/${target}/outcomes`; }
function mutate(client: JobCtrlApiClient, family: Family, request: ReturnType<typeof body>) {
  return "draftId" in request ? client.logOutreachSend("thread", request) : client.recordManualApplicationOutcome(JOB, request);
}
function counts(dbPath: string, family: Family) {
  const db = new Database(dbPath);
  const factTable = family === "send" ? "outreach_send_logs" : "application_outcomes";
  const eventType = family === "send" ? "OutreachSendLogged" : "ApplicationOutcomeRecorded";
  const facts = (db.prepare(`SELECT count(*) AS n FROM ${factTable} WHERE tenant_id='local'`).get() as { n: number }).n;
  const events = (db.prepare("SELECT count(*) AS n FROM job_events WHERE tenant_id='local' AND event_type=?").get(eventType) as { n: number }).n;
  const payloads = JSON.stringify(db.prepare("SELECT payload_json FROM job_events").all());
  expect(payloads).not.toContain(PRIVATE);
  expect(hasExactV14SchemaManifest(db)).toBe(true);
  db.close();
  return { facts, events };
}

describe.each(families)("durable %s action identity through HTTP", (family) => {
  it("replays a lost acknowledgement after process restart, preserves later state, and permits a deliberate new action", async () => {
    const dbPath = seed();
    const first = await server(dbPath);
    const request = body(family);
    const realFetch = authorizedFetch;
    let accepted: unknown;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (input, init) => {
      const response = await realFetch(input, init);
      expect(response.status).toBe(200);
      accepted = await response.json(); // Commit and full HTTP acknowledgement, discarded before the normal caller receives it.
      throw new TypeError("Synthetic lost HTTP acknowledgement");
    });
    await expect(mutate(first.client, family, request)).rejects.toThrow();
    const committedCounts = counts(dbPath, family);
    expect(committedCounts).toEqual({ facts: 1, events: 1 });
    const db = new Database(dbPath);
    db.prepare("UPDATE outreach_threads SET follow_up_state='scheduled', follow_up_due_at='2030-01-01', updated_at='2030-01-01' WHERE thread_id='thread'").run();
    db.prepare("UPDATE outreach_drafts SET status='rejected' WHERE draft_id='draft-thread'").run();
    db.prepare("UPDATE job_interview_prep SET status='superseded'").run();
    db.close();
    await stop(first.child);
    const restarted = await server(dbPath);
    const restartReplay = await mutate(restarted.client, family, request);
    expect(restartReplay).toEqual(accepted);
    const replayCounts = counts(dbPath, family);
    expect(replayCounts).toEqual({ facts: 1, events: 1 });
    const state = new Database(dbPath);
    expect(state.prepare("SELECT updated_at, follow_up_due_at FROM outreach_threads WHERE thread_id='thread'").get()).toEqual({ updated_at: "2030-01-01", follow_up_due_at: "2030-01-01" });
    if (family === "send") {
      await expect(mutate(restarted.client, family, body(family))).rejects.toMatchObject({ status: 400 });
      state.prepare("UPDATE outreach_drafts SET status='approved' WHERE draft_id='draft-thread'").run();
    }
    state.close();
    await mutate(restarted.client, family, body(family));
    expect(await mutate(restarted.client, family, request)).toEqual(accepted);
    expect(counts(dbPath, family)).toEqual({ facts: 2, events: 2 });
    console.log(JSON.stringify({ scenario: "lost-ack-restart-later-action", family, request, accepted, restartReplay, committedCounts, replayCounts, counts: counts(dbPath, family) }));
  }, 45_000);

  it("serializes equal and conflicting independent HTTP writers", async () => {
    const dbPath = seed();
    const [left, right] = await Promise.all([server(dbPath), server(dbPath)]);
    const request = body(family);
    const writer = new Database(dbPath);
    writer.exec("BEGIN IMMEDIATE");
    const equalArrivals = Promise.all([entered(left.child, request.requestId), entered(right.child, request.requestId)]);
    const equal = Promise.all([mutate(left.client, family, request), mutate(right.client, family, request)]);
    await equalArrivals;
    writer.exec("COMMIT");
    const [a, b] = await equal;
    expect(a).toEqual(b);
    const equalCounts = counts(dbPath, family);
    expect(equalCounts).toEqual({ facts: 1, events: 1 });
    const next = body(family);
    const changed = family === "send" ? { ...next, sentAt: "2026-02-01" } : { ...next, note: "Different synthetic note" };
    writer.exec("BEGIN IMMEDIATE");
    const conflictingArrivals = Promise.all([entered(left.child, next.requestId), entered(right.child, next.requestId)]);
    const race = Promise.allSettled([mutate(left.client, family, next), mutate(right.client, family, changed)]);
    await conflictingArrivals;
    writer.exec("COMMIT");
    const results = await race;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure).toMatchObject({ reason: { status: 409, responseBody: { error: "action_identity_conflict" } } });
    expect(counts(dbPath, family)).toEqual({ facts: 2, events: 2 });
    writer.close();
    console.log(JSON.stringify({ scenario: "independent-writers", family, pids: [left.child.pid, right.child.pid], original: a, equalReplay: b, equalCounts, conflictStatuses: results.map((result) => result.status === "fulfilled" ? "accepted" : result.reason.status), counts: counts(dbPath, family) }));
  }, 45_000);

  it("rejects missing/malformed identity, changed payload, and invalid fresh bindings before mutation", async () => {
    const dbPath = seed();
    const app = await server(dbPath);
    const request = body(family);
    for (const invalid of [{ ...request, requestId: undefined }, { ...request, requestId: "bad" }]) {
      const response = await fetch(app.url + route(family), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(invalid) });
      expect(response.status).toBe(400);
    }
    expect(counts(dbPath, family)).toEqual({ facts: 0, events: 0 });
    const original = await mutate(app.client, family, request);
    const changed = family === "send" ? { ...request, draftId: "draft-other-thread" } : { ...request, occurredAt: "2026-01-01T00:00:00Z" };
    await expect(mutate(app.client, family, changed)).rejects.toMatchObject({ status: 409 });
    expect(await mutate(app.client, family, request)).toEqual(original);
    const invalidBinding = family === "send" ? { ...body(family), draftId: "draft-other-thread" } : { ...body(family), interviewPrepGeneration: 99 };
    await expect(mutate(app.client, family, invalidBinding)).rejects.toMatchObject({ status: 404 });
    expect(counts(dbPath, family)).toEqual({ facts: 1, events: 1 });
    if (family === "reflection") {
      await expect(mutate(app.client, family, { ...body("reflection"), requestId: request.requestId, interviewPrepGeneration: 2 })).rejects.toMatchObject({ status: 409 });
    }
    const damaged = new Database(dbPath);
    damaged.exec(family === "send" ? "DELETE FROM outreach_send_logs" : "DELETE FROM application_outcomes");
    damaged.close();
    await expect(mutate(app.client, family, request)).rejects.toMatchObject({ status: 409 });
    expect(counts(dbPath, family)).toEqual({ facts: 0, events: 1 });
  }, 45_000);
});

it.each(families)("rejects redirected %s receipt fact IDs without replacing either accepted action", async (family) => {
  const dbPath = seed();
  const api = await server(dbPath);
  const firstRequest = body(family);
  const secondRequest = { ...firstRequest, requestId: randomUUID() };
  const first = await mutate(api.client, family, firstRequest);
  const second = await mutate(api.client, family, secondRequest);
  const firstId = "sendLog" in first ? first.sendLog.sendLogId : first.outcome.outcomeId;
  const secondId = "sendLog" in second ? second.sendLog.sendLogId : second.outcome.outcomeId;
  expect(firstId).not.toBe(secondId);
  const operation = family === "send" ? "outreach-send-log" : family === "reflection" ? "interview-reflection" : "manual-outcome";
  const identity = actionIdentity("local", operation, family === "send" ? "thread" : JOB, firstRequest.requestId, firstRequest);
  const db = new Database(dbPath);
  try {
    const row = db.prepare("SELECT payload_json FROM job_events WHERE idempotency_key=?").get(identity.key) as { payload_json: string };
    const reference = family === "send" ? "sendLogId" : "outcomeId";
    const original = JSON.parse(row.payload_json) as Record<string, unknown> & { receipt: { factId: string } };
    expect(original[reference]).toBe(firstId);
    const conflictStatuses: number[] = [];
    for (const damage of ["redirected-receipt", "missing-event-reference", "wrong-event-reference"] as const) {
      const damaged = structuredClone(original);
      if (damage === "redirected-receipt") damaged.receipt.factId = secondId;
      if (damage === "missing-event-reference") delete damaged[reference];
      if (damage === "wrong-event-reference") damaged[reference] = secondId;
      db.prepare("UPDATE job_events SET payload_json=? WHERE idempotency_key=?").run(JSON.stringify(damaged), identity.key);
      const conflict = await mutate(api.client, family, firstRequest).catch((error: unknown) => error);
      expect(conflict).toMatchObject({ status: 409, responseBody: { error: "action_identity_conflict" } });
      if (!(conflict instanceof JobCtrlApiError)) throw new Error("Expected a typed HTTP conflict");
      conflictStatuses.push(conflict.status);
      expect(counts(dbPath, family)).toEqual({ facts: 2, events: 2 });
      expect(await mutate(api.client, family, secondRequest)).toEqual(second);
    }
    db.prepare("UPDATE job_events SET payload_json=? WHERE idempotency_key=?").run(row.payload_json, identity.key);
    expect(await mutate(api.client, family, firstRequest)).toEqual(first);
    console.log(JSON.stringify({ scenario: "damaged-fact-binding", family, firstId, secondId, conflictStatuses, counts: counts(dbPath, family) }));
  } finally { db.close(); }
}, 45_000);

it.each(families)("rolls back %s fact/event failures and failed commits; nested caller owns rollback", (family) => {
  const dbPath = seed();
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const request = body(family);
  const write = (input = request) => "draftId" in input ? logOutreachSend(db, "thread", input) : recordManualApplicationOutcome(db, JOB, input);
  const original = write();
  db.exec("CREATE TEMP TRIGGER fail_event BEFORE INSERT ON job_events BEGIN SELECT RAISE(ABORT, 'synthetic event failure'); END");
  expect(() => write(body(family))).toThrow("synthetic event failure");
  db.exec("DROP TRIGGER fail_event");
  expect(write()).toEqual(original);
  expect(counts(dbPath, family)).toEqual({ facts: 1, events: 1 });
  // Synthetic deferred FK rejects COMMIT after both fact and event statements succeeded.
  db.exec("CREATE TABLE probe_parent(id INTEGER PRIMARY KEY); CREATE TABLE probe_child(id INTEGER REFERENCES probe_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER fail_commit AFTER INSERT ON job_events BEGIN INSERT INTO probe_child VALUES (1); END");
  expect(() => write(body(family))).toThrow(/FOREIGN KEY/);
  db.exec("DROP TRIGGER fail_commit; DROP TABLE probe_child; DROP TABLE probe_parent");
  expect(write()).toEqual(original);
  const nested = body(family);
  expect(() => db.transaction(() => { write(nested); throw new Error("outer rollback"); }).immediate()).toThrow("outer rollback");
  expect(counts(dbPath, family)).toEqual({ facts: 1, events: 1 });
  write(nested);
  expect(counts(dbPath, family)).toEqual({ facts: 2, events: 2 });
  db.close();
});

it("binds tenant, operation and canonical target, accepts a job URL alias, and refuses damaged receipts", async () => {
  const dbPath = seed();
  const app = await server(dbPath);
  const request = body("outcome");
  const original = await mutate(app.client, "outcome", request);
  expect(await app.client.recordManualApplicationOutcome(`https://example.test/jobs/${JOB}`, request)).toEqual(original);
  const other = await app.client.recordManualApplicationOutcome(OTHER_JOB, request);
  expect(other).not.toEqual(original);
  const reflection = await mutate(app.client, "reflection", { ...body("reflection"), requestId: request.requestId });
  expect(reflection).not.toEqual(original);
  const send = await mutate(app.client, "send", { ...body("send"), requestId: request.requestId });
  expect(send).not.toEqual(original);
  const otherThread = await app.client.logOutreachSend("other-thread", { ...body("send", request.requestId), draftId: "draft-other-thread" });
  expect(otherThread.sendLog.sendLogId).not.toEqual((send as { sendLog: { sendLogId: string } }).sendLog.sendLogId);
  expect(counts(dbPath, "send")).toEqual({ facts: 2, events: 2 });
  const db = new Database(dbPath);
  const identity = actionIdentity("local", "manual-outcome", JOB, request.requestId, request);
  const foreign = actionIdentity("foreign", "manual-outcome", JOB, request.requestId, request);
  expect(foreign.key).not.toEqual(identity.key);
  db.prepare("UPDATE job_events SET tenant_id='foreign' WHERE idempotency_key=?").run(identity.key);
  // The global unique key fails closed: never retrieve a foreign tenant receipt.
  await expect(mutate(app.client, "outcome", request)).rejects.toMatchObject({ status: 409 });
  db.prepare("UPDATE job_events SET tenant_id='local', payload_json='{}' WHERE idempotency_key=?").run(identity.key);
  expect(() => recordManualApplicationOutcome(db, JOB, request)).toThrow(ActionReceiptConflictError);
  expect(counts(dbPath, "outcome")).toEqual({ facts: 3, events: 3 });
  db.close();
}, 45_000);
