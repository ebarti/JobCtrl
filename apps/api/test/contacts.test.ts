import { fork, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JobCtrlApiClient, JobCtrlApiUnconfirmedWriteError } from "@jobctrl/api-client";
import { getContactDetail, updateContact, ContactRevisionConflictError } from "../src/contacts.js";
import { openDatabase } from "../src/db.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ContactDetail,
  ContactImportResponse,
  ContactSummary,
} from "../src/contracts.js";
import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";

const SECRET_NAME = "Jane Recruiter";
const SECRET_EMAIL = "jane@acme.example";
const JOB_ID_ONE = "00000000-0000-4000-8000-000000000011";
const JOB_ID_TWO = "00000000-0000-4000-8000-000000000012";

const cleanups: Array<() => void | Promise<void>> = [];
const writerCleanups: Array<() => Promise<void>> = [];

async function cleanupFixtures() {
  const failures: unknown[] = [];
  for (const cleanup of writerCleanups.splice(0).reverse()) {
    try { await cleanup(); }
    catch (error) {
      writerCleanups.push(cleanup); // Retain the original handle for retry.
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Contact writer closure failed; fixture directories retained.");
  }
  while (cleanups.length) await cleanups.pop()?.();
}

afterEach(cleanupFixtures);

function withTempApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-contacts-"));
  const dbPath = path.join(dir, "jobs.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const insertJob = db.prepare(
    `INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
     VALUES ('local', ?, ?, 'Fixture job', '2026-07-31T12:00:00Z')`,
  );
  insertJob.run(JOB_ID_ONE, "https://jobs.example.test/one");
  insertJob.run(JOB_ID_TWO, "https://jobs.example.test/two");
  db.close();
  const app = buildApp({ dbPath, configPath: path.join(dir, "config.json") });
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { app, dbPath };
}

async function createContact(
  app: ReturnType<typeof buildApp>,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; contact: ContactDetail | undefined; body: unknown }> {
  const res = await app.inject({ method: "POST", url: "/v1/contacts", payload });
  const body = res.json() as { ok: boolean; contact?: ContactDetail };
  return { statusCode: res.statusCode, contact: body.contact, body };
}

function canonicalState(db: Database.Database, contactId: string) {
  return {
    contact: db.prepare("SELECT * FROM contacts WHERE contact_id = ?").get(contactId),
    facts: db.prepare("SELECT * FROM contact_attributes WHERE contact_id = ? ORDER BY attribute_id").all(contactId),
    events: db.prepare("SELECT * FROM job_events WHERE entity_ref = ? ORDER BY event_id").all(contactId),
    threads: db.prepare("SELECT * FROM outreach_threads ORDER BY thread_id").all(),
    drafts: db.prepare("SELECT * FROM outreach_drafts ORDER BY draft_id").all(),
    sends: db.prepare("SELECT * FROM outreach_send_logs ORDER BY send_log_id").all(),
  };
}

function retainEditObservation(scenario: string, observation: unknown) {
  const root = process.env["JOBCTRL_CONTACT_EDIT_EVIDENCE_DIR"];
  if (!root) return;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, `${scenario}.json`), JSON.stringify({
    scenario, observedAt: new Date().toISOString(), observation,
  }, null, 2));
}

interface WriterOptions {
  readonly releaseFile?: string;
  readonly shortLockWait?: boolean;
}

function trackWriterClose(child: ChildProcess) {
  let didClose = false;
  // Capture close before any ready/result await; exit alone does not settle
  // the original child's stdio. Failed spawn emits error before close.
  const closed = new Promise<void>((resolve) => child.once("close", () => { didClose = true; resolve(); }));
  child.on("error", () => {});
  const waitForClose = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1_000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  return {
    closed,
    async cleanup() {
      if (didClose || await waitForClose()) return;
      // Prefer the writer's own completion/disconnect. If a failed assertion
      // left it waiting for input, close only its original IPC channel.
      try { if (child.connected) child.disconnect(); } catch { /* Await actual close below. */ }
      if (!await waitForClose()) {
        throw new Error("Synthetic contact writer close is unverified; fixture directory retained.");
      }
    },
  };
}

function writer(dbPath: string, contact: ContactDetail, role: "referrer" | "warm_intro", options: WriterOptions = {}) {
  const child: ChildProcess = fork(fileURLToPath(new URL("./contact-edit-writer.ts", import.meta.url)),
    [dbPath, contact.contactId, JSON.stringify({ expectedFingerprint: contact.fingerprint, role }),
      options.releaseFile ?? "", ...(options.shortLockWait ? ["short-lock-wait"] : [])],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const lifetime = trackWriterClose(child);
  writerCleanups.push(lifetime.cleanup);
  const messages: Array<{ kind: string; outcome?: string; busyTimeoutMs?: number }> = [];
  const listeners = new Set<() => void>();
  let diagnostic = "";
  child.stderr?.on("data", (data) => { diagnostic += String(data); });
  child.on("message", (message) => {
    messages.push(message as typeof messages[number]);
    for (const listener of listeners) listener();
  });
  const wait = (kind: string) => new Promise<typeof messages[number]>((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Writer missing ${kind}: ${diagnostic}`)); }, 8_000);
    const check = () => {
      const found = messages.find((message) => message.kind === kind);
      if (found) { clearTimeout(timer); listeners.delete(check); resolve(found); }
    };
    listeners.add(check);
    check();
  });
  return { child, wait };
}

describe("contact writer teardown", () => {
  it("accepts an already-closed original child without signaling it again", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const lifetime = trackWriterClose(child);
    writerCleanups.push(lifetime.cleanup);
    await lifetime.closed;
    expect(child.exitCode).toBe(0);
    const kill = vi.spyOn(child, "kill");
    await lifetime.cleanup();
    expect(kill).not.toHaveBeenCalled();
  });

  it("awaits failed-spawn close without trying to signal an absent child", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-contact-writer-spawn-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const child = spawn(path.join(dir, "missing-executable"), [], { stdio: "ignore" });
    const lifetime = trackWriterClose(child);
    writerCleanups.push(lifetime.cleanup);
    let failure: NodeJS.ErrnoException | undefined;
    child.once("error", (error) => { failure = error; });
    const kill = vi.spyOn(child, "kill");
    await lifetime.cleanup();
    expect(failure?.code).toBe("ENOENT");
    expect(child.pid).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  });

  it("attempts every writer after a refusal and retains directories until all close", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-contact-writer-close-"));
    const release = path.join(dir, "release");
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const child = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      const timer = setInterval(() => {
        if (fs.existsSync(process.argv[1])) {
          clearInterval(timer);
          if (process.connected) process.disconnect();
        }
      }, 10);
    `, release], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const lifetime = trackWriterClose(child);
    const completed = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const completedLifetime = trackWriterClose(completed);
    const attempts: string[] = [];
    const pendingCleanup = async () => { attempts.push("pending"); await lifetime.cleanup(); };
    writerCleanups.push(
      async () => { attempts.push("completed"); await completedLifetime.cleanup(); },
      pendingCleanup,
    );
    const kill = vi.spyOn(child, "kill");
    const completedKill = vi.spyOn(completed, "kill");
    try {
      let failure: unknown;
      try { await cleanupFixtures(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toHaveLength(1);
      expect((failure as AggregateError).errors[0].message).toContain("close is unverified");
      expect(attempts).toEqual(["pending", "completed"]);
      expect(writerCleanups).toEqual([pendingCleanup]);
      expect(fs.existsSync(dir)).toBe(true);
      expect(kill).not.toHaveBeenCalled();
      expect(completedKill).not.toHaveBeenCalled();
    } finally {
      // Release the owned fixture through its test protocol, never a PID signal.
      fs.writeFileSync(release, "release");
      await cleanupFixtures();
    }
  }, 5_000);
});

describe("contact edit authority", () => {
  it("round-trips id-less raw facts before normalized matches without claiming an identity twice", async () => {
    const { app, dbPath } = withTempApp();
    const value = "synthetic@example.test";
    const raw = `  ${value}  `;
    const created = (await createContact(app, { employer: "Acme", attributes: [
      { kind: "email", value }, { kind: "email", value }, { kind: "email", value },
    ] })).contact!;
    const db = openDatabase(dbPath);
    try {
      const update = db.prepare("UPDATE contact_attributes SET value_json = ?, source_kind = 'user_imported_list', source_ref = ?, recorded_at = ? WHERE attribute_id = ?");
      created.attributes.forEach((fact, index) => update.run(JSON.stringify(index < 2 ? raw : value),
        `synthetic-import-${index}`, `2020-01-0${index + 1}T00:00:00Z`, fact.attributeId));
      const base = getContactDetail(db, created.contactId)!;
      const before = canonicalState(db, created.contactId).facts;
      const save = async (fingerprint: string, reserved: boolean) => app.inject({ method: "PATCH", url: `/v1/contacts/${created.contactId}`,
        payload: { expectedFingerprint: fingerprint, attributes: [
          { kind: "email", value: raw }, { kind: "email", value: raw },
          { ...(reserved ? { attributeId: base.attributes[2]!.attributeId } : {}), kind: "email", value },
        ] } });
      const mixed = await save(base.fingerprint, true);
      expect(mixed.statusCode).toBe(200);
      const mixedContact = (mixed.json() as { contact: ContactDetail }).contact;
      expect(mixedContact.attributes).toEqual(base.attributes);
      expect(canonicalState(db, created.contactId).facts).toEqual(before);
      const idless = await save(mixedContact.fingerprint, false);
      expect(idless.statusCode).toBe(200);
      expect((idless.json() as { contact: ContactDetail }).contact.attributes).toEqual(base.attributes);
      expect(canonicalState(db, created.contactId).facts).toEqual(before);
    } finally { db.close(); }
  });

  it("retains long sourced facts while validating only newly written values at the trimmed limit", async () => {
    const { app, dbPath } = withTempApp();
    const created = (await createContact(app, { employer: "Acme", attributes: [{ kind: "note", value: "seed" }] })).contact!;
    const db = openDatabase(dbPath);
    try {
      const long = "L".repeat(2001);
      db.prepare("UPDATE contact_attributes SET value_json = ?, attribute_kind = 'legacy_kind', source_kind = 'user_imported_list', source_ref = 'synthetic-long-import' WHERE attribute_id = ?")
        .run(JSON.stringify(long), created.attributes[0]!.attributeId);
      const base = getContactDetail(db, created.contactId)!;
      const original = base.attributes[0]!;
      const replacement = await app.inject({ method: "PATCH", url: `/v1/contacts/${created.contactId}`,
        payload: { expectedFingerprint: base.fingerprint, attributes: [
          { attributeId: original.attributeId, kind: original.kind, value: long },
          { kind: "note", value: `${"N".repeat(2000)} ` },
        ] } });
      expect(replacement.statusCode).toBe(200);
      const saved = (replacement.json() as { contact: ContactDetail }).contact;
      expect(saved.attributes.find((fact) => fact.attributeId === original.attributeId)).toEqual(original);
      expect(saved.attributes.find((fact) => fact.value === "N".repeat(2000))).toBeDefined();
      const idless = await app.inject({ method: "PATCH", url: `/v1/contacts/${created.contactId}`,
        payload: { expectedFingerprint: saved.fingerprint, attributes: saved.attributes.map(({ kind, value }) => ({ kind, value })) } });
      expect(idless.statusCode).toBe(200);
      const retained = (idless.json() as { contact: ContactDetail }).contact;
      expect(retained.attributes).toEqual(saved.attributes);
      const before = canonicalState(db, created.contactId);
      for (const fact of [
        { attributeId: original.attributeId, kind: "note", value: "X".repeat(2001) },
        { kind: "note", value: "Y".repeat(2001) },
        { kind: "unsupported_new", value: "synthetic" },
        { kind: "note", value: "   " },
      ]) {
        const invalid = await app.inject({ method: "PATCH", url: `/v1/contacts/${created.contactId}`,
          payload: { expectedFingerprint: retained.fingerprint, attributes: [fact] } });
        expect(invalid.statusCode).toBe(400);
        expect(canonicalState(db, created.contactId)).toEqual(before);
      }
    } finally { db.close(); }
  });

  it("retains the selected identity and provenance when duplicate facts are reconciled", async () => {
    const { app, dbPath } = withTempApp();
    const created = (await createContact(app, { employer: "Acme", attributes: [{ kind: "email", value: "duplicate@example.test" }] })).contact!;
    const first = openDatabase(dbPath);
    const second = openDatabase(dbPath);
    try {
      first.prepare("UPDATE contact_attributes SET source_kind = 'user_imported_list', source_ref = 'synthetic-import', recorded_at = '2020-01-01T00:00:00Z' WHERE attribute_id = ?")
        .run(created.attributes[0]!.attributeId);
      const base = getContactDetail(second, created.contactId)!;
      const newer = updateContact(first, created.contactId, { expectedFingerprint: base.fingerprint,
        attributes: [{ kind: "email", value: "duplicate@example.test" }, { kind: "email", value: "duplicate@example.test" }] });
      const retained = newer.attributes.find((fact) => fact.attributeId !== base.attributes[0]!.attributeId)!;
      const mixed = await app.inject({ method: "PATCH", url: `/v1/contacts/${created.contactId}`,
        payload: { expectedFingerprint: newer.fingerprint, attributes: [
          { kind: "email", value: retained.value },
          { attributeId: base.attributes[0]!.attributeId, kind: "email", value: retained.value },
        ] } });
      expect(mixed.statusCode).toBe(200);
      const mixedContact = (mixed.json() as { contact: ContactDetail }).contact;
      expect(mixedContact.attributes).toEqual(newer.attributes);
      const res = await app.inject({ method: "PATCH", url: `/v1/contacts/${created.contactId}`,
        payload: { expectedFingerprint: mixedContact.fingerprint, attributes: [{ attributeId: retained.attributeId, kind: retained.kind, value: retained.value }] } });
      expect(res.statusCode).toBe(200);
      const saved = (res.json() as { contact: ContactDetail }).contact;
      expect(saved.attributes).toEqual([retained]);
      const foreign = (await createContact(app, { employer: "Another", attributes: [{ kind: "email", value: retained.value }] })).contact!;
      const accepted = canonicalState(second, created.contactId);
      for (const attributes of [
        [{ attributeId: retained.attributeId, kind: "email", value: retained.value }, { attributeId: retained.attributeId, kind: "email", value: retained.value }],
        [{ attributeId: foreign.attributes[0]!.attributeId, kind: "email", value: retained.value }],
      ]) {
        const invalid = await app.inject({ method: "PATCH", url: `/v1/contacts/${created.contactId}`,
          payload: { expectedFingerprint: saved.fingerprint, attributes } });
        expect(invalid.statusCode).toBe(400);
        expect(canonicalState(second, created.contactId)).toEqual(accepted);
      }
      const normalized = updateContact(second, created.contactId, { expectedFingerprint: saved.fingerprint,
        attributes: [{ attributeId: retained.attributeId, kind: "email", value: `${retained.value} ` }] });
      expect(normalized.attributes).toEqual(saved.attributes);
      first.prepare("UPDATE contact_attributes SET value_json = ? WHERE attribute_id = ?")
        .run(JSON.stringify("  duplicate@example.test  "), retained.attributeId);
      const spaced = getContactDetail(first, created.contactId)!;
      const exactFacts = canonicalState(first, created.contactId).facts;
      const preserved = updateContact(second, created.contactId, { expectedFingerprint: spaced.fingerprint,
        attributes: [{ attributeId: retained.attributeId, kind: "email", value: spaced.attributes[0]!.value }] });
      expect(preserved.attributes).toEqual(spaced.attributes);
      expect(canonicalState(second, created.contactId).facts).toEqual(exactFacts);
    } finally { first.close(); second.close(); }
  });

  it.each([
    { role: "warm_intro" },
    { employer: "New employer" },
    { jobId: JOB_ID_TWO },
    { attributes: [{ kind: "name", value: "Corrected name" }, { kind: "email", value: "new@example.test" }] },
  ])("rejects stale replacement %j across independent connections without losing newer facts/history", async (replacement) => {
    const { app, dbPath } = withTempApp();
    const original = (await createContact(app, { employer: "Acme", jobId: JOB_ID_ONE,
      attributes: [{ kind: "name", value: "Original" }] })).contact!;
    const first = openDatabase(dbPath);
    const second = openDatabase(dbPath);
    try {
      // Seed accepted outreach content/history as preservation controls only.
      first.prepare("INSERT INTO outreach_threads (thread_id, contact_id, job_id, created_at, updated_at) VALUES ('preserved-thread', ?, ?, 'same', 'same')")
        .run(original.contactId, JOB_ID_ONE);
      first.exec("INSERT INTO outreach_drafts (draft_id, thread_id, kind, status, body_text, created_at, approved_at) VALUES ('preserved-draft', 'preserved-thread', 'initial', 'approved', 'Accepted synthetic message', 'same', 'same')");
      first.exec("INSERT INTO outreach_send_logs (send_log_id, thread_id, draft_id, channel, sent_at, logged_at) VALUES ('preserved-send', 'preserved-thread', 'preserved-draft', 'email', 'same', 'same')");
      const base = getContactDetail(second, original.contactId)!;
      const next = updateContact(first, original.contactId, { expectedFingerprint: original.fingerprint,
        ...replacement } as Parameters<typeof updateContact>[2]);
      const accepted = canonicalState(first, original.contactId);
      expect(accepted.events).toHaveLength(replacement.attributes ? 5 : 3);
      expect(accepted.facts).toHaveLength(replacement.attributes ? 2 : 1);
      expect(next.fingerprint).not.toBe(base.fingerprint);
      expect(() => updateContact(second, original.contactId, { expectedFingerprint: base.fingerprint,
        role: base.role, employer: base.employer, jobId: base.jobId,
        attributes: [{ kind: "name", value: "Original" }] })).toThrow(ContactRevisionConflictError);
      const rejected = await app.inject({ method: "PATCH", url: `/v1/contacts/${original.contactId}`,
        payload: { expectedFingerprint: base.fingerprint, ...replacement } });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ error: "contact_revision_conflict" });
      expect(canonicalState(second, original.contactId)).toEqual(accepted);
      expect(getContactDetail(second, original.contactId)).toEqual(next);
      retainEditObservation(`stale-${Object.keys(replacement)[0]}`, {
        base, next, conflict: rejected.json(), accepted, afterRejection: canonicalState(second, original.contactId),
      });
      expect(accepted.threads).toHaveLength(1);
      expect(accepted.drafts).toHaveLength(1);
      expect(accepted.sends).toHaveLength(1);
    } finally { first.close(); second.close(); }
  });

  it("rejects absent/malformed/foreign bases and deleted contacts explicitly", async () => {
    const { app } = withTempApp();
    const one = (await createContact(app, { employer: "One" })).contact!;
    const two = (await createContact(app, { employer: "Two" })).contact!;
    for (const base of [undefined, null, "", "invalid", 1]) {
      const res = await app.inject({ method: "PATCH", url: `/v1/contacts/${one.contactId}`,
        payload: { expectedFingerprint: base, role: "referrer" } });
      expect(res.statusCode).toBe(400);
    }
    const foreign = await app.inject({ method: "PATCH", url: `/v1/contacts/${one.contactId}`,
      payload: { expectedFingerprint: two.fingerprint, role: "referrer" } });
    expect(foreign.statusCode).toBe(409);
    await app.inject({ method: "DELETE", url: `/v1/contacts/${one.contactId}` });
    expect((await app.inject({ method: "PATCH", url: `/v1/contacts/${one.contactId}`,
      payload: { expectedFingerprint: one.fingerprint, role: "referrer" } })).statusCode).toBe(404);
  });

  it("binds full raw provenance and same-timestamp facts, while projection refresh leaves the token stable", async () => {
    const { app, dbPath } = withTempApp();
    const contact = (await createContact(app, { employer: "Acme", attributes: [{ kind: "email", value: "synthetic@example.test" }] })).contact!;
    const db = openDatabase(dbPath);
    try {
      await app.inject({ method: "GET", url: "/v1/contacts" });
      expect(getContactDetail(db, contact.contactId)!.fingerprint).toBe(contact.fingerprint);
      for (const sql of [
        "UPDATE contact_attributes SET confidence = 0.3",
        "UPDATE contact_attributes SET attribute_id = 'replacement-identity'",
        "UPDATE contact_attributes SET capture_method = 'another-method'",
        "UPDATE contact_attributes SET source_ref = 'another-source'",
        "UPDATE contact_attributes SET user_confirmed = 0",
        "UPDATE contact_attributes SET source_kind = 'user_imported_list'",
        "UPDATE contact_attributes SET recorded_at = '2026-10-24T00:00:00Z'",
        "UPDATE contact_attributes SET value_json = '\"other@example.test\"'",
        "UPDATE contacts SET role = 'warm_intro'",
      ]) {
        const before = getContactDetail(db, contact.contactId)!;
        db.exec(sql);
        const after = getContactDetail(db, contact.contactId)!;
        expect(after.updatedAt).toBe(before.updatedAt);
        expect(after.fingerprint).not.toBe(before.fingerprint);
        expect(() => updateContact(db, contact.contactId, { expectedFingerprint: before.fingerprint, role: "referrer" })).toThrow(ContactRevisionConflictError);
      }
      const before = canonicalState(db, contact.contactId);
      const current = getContactDetail(db, contact.contactId)!;
      const next = updateContact(db, contact.contactId, { expectedFingerprint: current.fingerprint,
        attributes: [{ kind: "email", value: "other@example.test" }], role: "referrer" });
      expect(next.fingerprint).not.toBe(current.fingerprint);
      expect(canonicalState(db, contact.contactId).facts).toEqual(before.facts);
    } finally { db.close(); }
  });

  it.each(["contact_attributes", "job_events"])("rolls back the complete replacement when %s persistence fails", async (table) => {
    const { app, dbPath } = withTempApp();
    const contact = (await createContact(app, { employer: "Acme", attributes: [{ kind: "name", value: "Accepted" }] })).contact!;
    const db = openDatabase(dbPath);
    try {
      const before = canonicalState(db, contact.contactId);
      db.exec(`CREATE TEMP TRIGGER fail_contact_edit BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END`);
      expect(() => updateContact(db, contact.contactId, { expectedFingerprint: contact.fingerprint,
        employer: "Changed", role: "referrer", attributes: [{ kind: "name", value: "Changed" }] })).toThrow("injected persistence failure");
      expect(canonicalState(db, contact.contactId)).toEqual(before);
      expect(getContactDetail(db, contact.contactId)).toEqual(contact);
      retainEditObservation(`rollback-${table}`, { before, afterFailure: canonicalState(db, contact.contactId) });
    } finally { db.close(); }
  });

  it("advances the base even for a no-op save on the identical clock tick", async () => {
    const { app, dbPath } = withTempApp();
    const contact = (await createContact(app, { employer: "Acme" })).contact!;
    const db = openDatabase(dbPath);
    const clock = vi.spyOn(Date.prototype, "toISOString").mockReturnValue(contact.updatedAt!);
    try {
      const before = canonicalState(db, contact.contactId);
      const next = updateContact(db, contact.contactId, { expectedFingerprint: contact.fingerprint });
      expect(canonicalState(db, contact.contactId).contact).toEqual(before.contact);
      expect(next.fingerprint).not.toBe(contact.fingerprint);
      expect(() => updateContact(db, contact.contactId, { expectedFingerprint: contact.fingerprint })).toThrow(ContactRevisionConflictError);
      expect(canonicalState(db, contact.contactId).events).toHaveLength(2);
    } finally { clock.mockRestore(); db.close(); }
  });

  it("reads the detail and fingerprint from one snapshot while another connection commits", async () => {
    const { app, dbPath } = withTempApp();
    const contact = (await createContact(app, { employer: "Acme", attributes: [{ kind: "name", value: "Accepted" }] })).contact!;
    const reader = openDatabase(dbPath);
    reader.pragma("journal_mode = WAL");
    const other = openDatabase(dbPath);
    const prepare = reader.prepare.bind(reader);
    let next: ContactDetail | undefined;
    reader.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith("SELECT * FROM contacts")) {
        const get = statement.get.bind(statement);
        statement.get = (...args: unknown[]) => {
          const result = get(...args);
          next = updateContact(other, contact.contactId, { expectedFingerprint: contact.fingerprint,
            role: "referrer", attributes: [{ kind: "name", value: "Newer" }] });
          return result;
        };
      }
      return statement;
    }) as typeof reader.prepare;
    try {
      expect(getContactDetail(reader, contact.contactId)).toEqual(contact);
      retainEditObservation("consistent-snapshot", { snapshot: contact, concurrentlyCommitted: next });
      expect(next?.displayName).toBe("Newer");
      reader.prepare = prepare;
      expect(getContactDetail(reader, contact.contactId)).toEqual(next);
    } finally { reader.close(); other.close(); }
  });

  it("admits only one of two independent concurrent writers sharing a base", async () => {
    const { app, dbPath } = withTempApp();
    const contact = (await createContact(app, { employer: "Acme", attributes: [{ kind: "name", value: "Accepted" }] })).contact!;
    const writers = [writer(dbPath, contact, "referrer"), writer(dbPath, contact, "warm_intro")];
    const ready = await Promise.all(writers.map((entry) => entry.wait("ready")));
    expect(ready.map((entry) => entry.busyTimeoutMs)).toEqual([5_000, 5_000]);
    writers.forEach((entry) => entry.child.send("start"));
    const outcomes = await Promise.all(writers.map((entry) => entry.wait("result")));
    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["committed", "conflict"]);
    const db = openDatabase(dbPath);
    try {
      const state = canonicalState(db, contact.contactId);
      expect(state.events).toHaveLength(3);
      expect(state.facts).toHaveLength(1);
      expect(state.facts[0]).toMatchObject({ attribute_id: contact.attributes[0]!.attributeId });
      retainEditObservation("concurrent-writers", { outcomes, state });
    } finally { db.close(); }
  });

  it("holds writer ownership between comparison and replacement, then refuses the superseded base", async () => {
    const { app, dbPath } = withTempApp();
    const contact = (await createContact(app, { employer: "Acme" })).contact!;
    const release = `${dbPath}.release`;
    const first = writer(dbPath, contact, "referrer", { releaseFile: release });
    await first.wait("ready");
    first.child.send("start");
    await first.wait("compared");
    const blocked = writer(dbPath, contact, "warm_intro", { shortLockWait: true });
    expect((await blocked.wait("ready")).busyTimeoutMs).toBe(100);
    blocked.child.send("start");
    const blockedResult = await blocked.wait("result");
    expect(blockedResult.outcome).toBe("SQLITE_BUSY");
    fs.writeFileSync(release, "release");
    expect((await first.wait("result")).outcome).toBe("committed");
    const retry = writer(dbPath, contact, "warm_intro");
    await retry.wait("ready");
    retry.child.send("start");
    const retryResult = await retry.wait("result");
    expect(retryResult.outcome).toBe("conflict");
    const db = openDatabase(dbPath);
    try {
      expect(canonicalState(db, contact.contactId).events).toHaveLength(2);
      expect(getContactDetail(db, contact.contactId)!.role).toBe("referrer");
      retainEditObservation("writer-barrier", { blocked: blockedResult, retried: retryResult, state: canonicalState(db, contact.contactId) });
    } finally { db.close(); }
  });

  it("fences a lost acknowledgement across API restart and recovers through the typed HTTP caller", async () => {
    const { app, dbPath } = withTempApp();
    let address = await app.listen({ host: "127.0.0.1", port: 0 });
    const realFetch = globalThis.fetch;
    let loseNextPatch = false;
    const browserFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await realFetch(input, { ...init, headers: { ...init?.headers, origin: "http://127.0.0.1:5173" } });
      if (loseNextPatch && init?.method === "PATCH") {
        loseNextPatch = false;
        await response.arrayBuffer();
        throw new TypeError("Injected lost acknowledgement after committed PATCH");
      }
      return response;
    });
    cleanups.push(() => browserFetch.mockRestore());
    let client = new JobCtrlApiClient(address);
    const contact = (await client.createContact({ role: "other", employer: "Acme", attributes: [] })).contact;
    const request = { expectedFingerprint: contact.fingerprint, role: "referrer" as const };
    loseNextPatch = true;
    const failure: unknown = await client.updateContact(contact.contactId, request).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(JobCtrlApiUnconfirmedWriteError);
    expect(failure).toMatchObject({
      method: "PATCH",
      path: `/v1/contacts/${contact.contactId}`,
      writeOutcomeUnknown: true,
      cause: expect.objectContaining({ message: "Injected lost acknowledgement after committed PATCH" }),
    });
    await app.close();
    const restarted = buildApp({ dbPath, configPath: path.join(path.dirname(dbPath), "config.json") });
    address = await restarted.listen({ host: "127.0.0.1", port: 0 });
    client = new JobCtrlApiClient(address);
    try {
      const db = openDatabase(dbPath);
      const accepted = canonicalState(db, contact.contactId);
      db.close();
      await expect(client.updateContact(contact.contactId, request)).rejects.toMatchObject({ status: 409,
        responseBody: { error: "contact_revision_conflict" } });
      const readback = (await client.contact(contact.contactId)).contact;
      expect(readback.role).toBe("referrer");
      const check = openDatabase(dbPath);
      expect(canonicalState(check, contact.contactId)).toEqual(accepted);
      expect(accepted.events).toHaveLength(2);
      check.close();
      const recovered = await client.updateContact(contact.contactId, { expectedFingerprint: readback.fingerprint, role: "warm_intro" });
      expect(recovered.contact.role).toBe("warm_intro");
      expect(recovered.contact.fingerprint).not.toBe(readback.fingerprint);
      retainEditObservation("lost-ack-restart", { original: contact, accepted, readback, recovered: recovered.contact });
    } finally { await restarted.close(); }
  });
});

describe("contacts API", () => {
  it("creates a contact and renders provenance for every fact (INV-2)", async () => {
    const { app } = withTempApp();
    const { statusCode, contact } = await createContact(app, {
      role: "recruiter",
      employer: "Acme",
      jobId: JOB_ID_ONE,
      attributes: [
        { kind: "name", value: SECRET_NAME },
        { kind: "email", value: SECRET_EMAIL },
      ],
    });
    expect(statusCode).toBe(200);
    expect(contact?.displayName).toBe(SECRET_NAME);
    expect(contact?.role).toBe("recruiter");
    expect(contact?.attributes).toHaveLength(2);
    for (const attribute of contact?.attributes ?? []) {
      expect(attribute.provenance.sourceKind).toBe("user_entered");
      expect(attribute.provenance.captureMethod).toBe("manual");
      expect(attribute.provenance.userConfirmed).toBe(true);
      expect(attribute.provenance.capturedAt).not.toBe("");
    }
  });

  it("lists contacts with source-kind provenance summary", async () => {
    const { app } = withTempApp();
    await createContact(app, {
      role: "recruiter",
      employer: "Acme",
      attributes: [{ kind: "name", value: SECRET_NAME }],
    });
    const res = await app.inject({ method: "GET", url: "/v1/contacts" });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: ContactSummary[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.displayName).toBe(SECRET_NAME);
    expect(items[0]?.sourceKinds).toEqual(["user_entered"]);
    expect(items[0]?.allConfirmed).toBe(true);
  });

  it("filters the list by application (jobId)", async () => {
    const { app } = withTempApp();
    await createContact(app, { employer: "Acme", jobId: JOB_ID_ONE, attributes: [{ kind: "name", value: "A" }] });
    await createContact(app, { employer: "Acme", jobId: JOB_ID_TWO, attributes: [{ kind: "name", value: "B" }] });
    const res = await app.inject({ method: "GET", url: `/v1/contacts?jobId=${JOB_ID_ONE}` });
    const items = (res.json() as { items: ContactSummary[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.jobId).toBe(JOB_ID_ONE);
  });

  it("rejects noncanonical JobId list filters before opening the database", async () => {
    const { app } = withTempApp();
    for (const jobId of [
      "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
      "https://jobs.example.test/not-an-id",
    ]) {
      const res = await app.inject({ method: "GET", url: `/v1/contacts?jobId=${encodeURIComponent(jobId)}` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: "invalid_contact_query" });
    }
  });

  it("never leaks attribute values into job_events payloads (sensitivity)", async () => {
    const { app, dbPath } = withTempApp();
    await createContact(app, {
      employer: "Acme",
      attributes: [
        { kind: "name", value: SECRET_NAME },
        { kind: "email", value: SECRET_EMAIL },
      ],
    });
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      "SELECT tenant_id, job_id, identity_version, event_type, payload_json, entity_kind, entity_ref FROM job_events",
    ).all() as Array<{
      tenant_id: string;
      job_id: string | null;
      identity_version: number;
      event_type: string;
      payload_json: string;
      entity_kind: string;
      entity_ref: string;
    }>;
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.event_type)).toContain("ContactCreated");
    for (const row of rows) {
      expect(row.tenant_id).toBe("local");
      expect(row.identity_version).toBe(1);
      expect(row.entity_kind).toBe("contact");
      expect(row.entity_ref).not.toBe("");
      expect(row.payload_json).not.toContain(SECRET_NAME);
      expect(row.payload_json).not.toContain(SECRET_EMAIL);
    }
  });

  it("rejects a contact with no employer and no jobId", async () => {
    const { app } = withTempApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      payload: { attributes: [{ kind: "name", value: "Nobody" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a URL-shaped JobId before contacts or events are written", async () => {
    const { app, dbPath } = withTempApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      payload: { employer: "Acme", jobId: "https://jobs.example.test/not-an-id" },
    });
    expect(res.statusCode).toBe(400);
    const db = new Database(dbPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM contacts").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count).toBe(0);
    db.close();
  });

  it("updates role and re-projects", async () => {
    const { app } = withTempApp();
    const created = await createContact(app, {
      employer: "Acme",
      attributes: [{ kind: "name", value: SECRET_NAME }],
    });
    const contactId = created.contact!.contactId;
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/contacts/${contactId}`,
      payload: { expectedFingerprint: created.contact!.fingerprint, role: "referrer" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { contact: ContactDetail }).contact.role).toBe("referrer");
  });

  it("returns 404 for updating an unknown contact", async () => {
    const { app } = withTempApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/contacts/does-not-exist",
      payload: { expectedFingerprint: "0".repeat(64), role: "referrer" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("soft-deletes a contact and hides it from reads", async () => {
    const { app } = withTempApp();
    const created = await createContact(app, {
      employer: "Acme",
      attributes: [{ kind: "name", value: SECRET_NAME }],
    });
    const contactId = created.contact!.contactId;
    const del = await app.inject({ method: "DELETE", url: `/v1/contacts/${contactId}`, payload: { reason: "dup" } });
    expect(del.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/v1/contacts/${contactId}` });
    expect(detail.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: "/v1/contacts" });
    expect((list.json() as { items: ContactSummary[] }).items).toHaveLength(0);
  });

  it("imports a CSV list, tagging provenance and skipping linkless rows", async () => {
    const { app } = withTempApp();
    const csvText =
      "name,email,employer,role\n" +
      "Bob Manager,bob@globex.example,Globex,hiring_manager\n" +
      "Orphan,orphan@nowhere.example,,\n";
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "referrals.csv", csvText },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json() as ContactImportResponse;
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);

    const detail = await app.inject({ method: "GET", url: `/v1/contacts/${result.contactIds[0]}` });
    const contact = (detail.json() as { contact: ContactDetail }).contact;
    expect(contact.role).toBe("hiring_manager");
    for (const attribute of contact.attributes) {
      expect(attribute.provenance.sourceKind).toBe("user_imported_list");
      expect(attribute.provenance.sourceRef).toBe("referrals.csv");
    }
  });

  it("revalidates CSV job links at commit and still imports valid neighboring rows", async () => {
    const { app, dbPath } = withTempApp();
    const content = [
      "name,employer,job_id",
      "Ready,Review Company,",
      `Linked,,${JOB_ID_TWO}`,
      "Missing,,00000000-0000-4000-8000-000000000099",
    ].join("\n");
    const preview = (
      await app.inject({
        method: "POST",
        url: "/v1/contacts/import",
        payload: { filename: "links.csv", format: "csv", mode: "preview", content },
      })
    ).json() as ContactImportResponse;
    expect(preview.summary).toMatchObject({ ready: 2, invalid: 1 });
    expect(preview.items[2]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_job_link" }),
    ]));

    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM jobs WHERE tenant_id = 'local' AND job_id = ?").run(JOB_ID_TWO);
    db.close();

    const committed = (
      await app.inject({
        method: "POST",
        url: "/v1/contacts/import",
        payload: { filename: "links.csv", format: "csv", mode: "commit", content },
      })
    ).json() as ContactImportResponse;
    expect(committed).toMatchObject({ imported: 1, skipped: 2, summary: { ready: 1, invalid: 2 } });
    const check = new Database(dbPath, { readonly: true });
    expect((check.prepare("SELECT COUNT(*) AS count FROM contacts").get() as { count: number }).count).toBe(1);
    check.close();
  });

  it("previews vCard 3.0/4.0 facts and outcomes without writing SQLite", async () => {
    const { app, dbPath } = withTempApp();
    const content = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Dana\\, Reyes",
      "ORG:Acme\\; Research;People",
      "item1.EMAIL;TYPE=work:dana@acme.example",
      "TITLE:VP Talent",
      "PHOTO;VALUE=uri:https://images.example.test/dana.jpg",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "N:Blake;Morgan;;;",
      "ORG:Globex",
      "TEL;VALUE=uri:tel:+1-555-0102",
      "URL:https://globex.example/people/morgan",
      "NOTE:Met at the unicode",
      " conference",
      "END:VCARD",
    ].join("\r\n");
    const before = new Database(dbPath, { readonly: true });
    const beforeContacts = (before.prepare("SELECT COUNT(*) AS count FROM contacts").get() as { count: number }).count;
    const beforeEvents = (before.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count;
    before.close();

    const response = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "network.vcf", format: "vcard", mode: "preview", content },
    });
    expect(response.statusCode).toBe(200);
    const preview = response.json() as ContactImportResponse;
    expect(preview).toMatchObject({
      format: "vcard",
      mode: "preview",
      imported: 0,
      summary: { total: 2, ready: 2, duplicates: 0, invalid: 0, unsupported: 1 },
    });
    expect(preview.items[0]).toMatchObject({
      displayName: "Dana, Reyes",
      employer: "Acme; Research",
      role: "other",
      status: "ready",
    });
    expect(preview.items[0]?.attributes).toEqual(expect.arrayContaining([
      { kind: "email", value: "dana@acme.example" },
      { kind: "title", value: "VP Talent" },
    ]));
    expect(preview.items[0]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported_property", property: "PHOTO", severity: "warning" }),
      expect.objectContaining({ code: "ignored_parameter", property: "EMAIL", severity: "warning" }),
    ]));
    expect(preview.items[1]?.attributes).toEqual(expect.arrayContaining([
      { kind: "name", value: "Morgan Blake" },
      { kind: "phone", value: "+1-555-0102" },
      { kind: "profile_url", value: "https://globex.example/people/morgan" },
      { kind: "note", value: "Met at the unicodeconference" },
    ]));

    const after = new Database(dbPath, { readonly: true });
    expect((after.prepare("SELECT COUNT(*) AS count FROM contacts").get() as { count: number }).count).toBe(beforeContacts);
    expect((after.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count).toBe(beforeEvents);
    after.close();
  });

  it("commits reviewed vCards with filename provenance and deduplicates replay", async () => {
    const { app } = withTempApp();
    const content = "BEGIN:VCARD\nVERSION:4.0\nFN:Dana Reyes\nORG:Acme\nEMAIL:dana@acme.example\nTITLE:VP Talent\nEND:VCARD";
    const first = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "network.vcf", format: "vcard", mode: "commit", content },
    });
    const committed = first.json() as ContactImportResponse;
    expect(committed).toMatchObject({ imported: 1, skipped: 0, summary: { ready: 1, duplicates: 0, invalid: 0 } });
    const detail = await app.inject({ method: "GET", url: `/v1/contacts/${committed.contactIds[0]}` });
    const contact = (detail.json() as { contact: ContactDetail }).contact;
    expect(contact.role).toBe("other");
    expect(contact.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "title", value: "VP Talent" }),
    ]));
    for (const attribute of contact.attributes) {
      expect(attribute.provenance).toMatchObject({
        sourceKind: "user_imported_list",
        sourceRef: "network.vcf",
      });
    }

    const replay = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "network.vcf", format: "vcard", mode: "commit", content },
    });
    expect(replay.json()).toMatchObject({ imported: 0, skipped: 1, summary: { duplicates: 1 } });
  });

  it("reports malformed, unsupported encodings and ambiguous identifiers without importing", async () => {
    const { app } = withTempApp();
    await createContact(app, {
      employer: "Acme",
      attributes: [{ kind: "email", value: "same@acme.example" }],
    });
    await createContact(app, {
      employer: "Acme",
      attributes: [{ kind: "phone", value: "+1 555 0109" }],
    });
    const content = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN;ENCODING=QUOTED-PRINTABLE:Dana=20Reyes",
      "ORG:Acme",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Ambiguous Person",
      "ORG:Acme",
      "EMAIL:same@acme.example",
      "TEL:+1 555 0109",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:2.1",
      "FN:Old Card",
      "ORG:Acme",
      "END:VCARD",
    ].join("\n");
    const response = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "unsafe.vcf", format: "vcard", mode: "commit", content },
    });
    const result = response.json() as ContactImportResponse;
    expect(result.imported).toBe(0);
    expect(result.summary.invalid).toBe(3);
    expect(result.items.map((item) => item.issues.map((issue) => issue.code))).toEqual([
      expect.arrayContaining(["unsupported_encoding"]),
      expect.arrayContaining(["ambiguous_identity"]),
      expect.arrayContaining(["unsupported_version"]),
    ]);
  });

  it("decodes escaped vCard text exactly once and rejects qualified TEL URI identity", async () => {
    const { app } = withTempApp();
    const escapedName = String.raw`Test\name`;
    const content = String.raw`BEGIN:VCARD
VERSION:4.0
FN:Test\\name
ORG:Acme
TEL;VALUE=uri:tel:5550100;phone-context=office-a.example
END:VCARD`;
    const response = await app.inject({
      method: "POST",
      url: "/v1/contacts/import",
      payload: { filename: "qualified.vcf", format: "vcard", mode: "preview", content },
    });
    const preview = response.json() as ContactImportResponse;
    expect(preview.items[0]?.displayName).toBe(escapedName);
    expect(preview.items[0]?.attributes.find((attribute) => attribute.kind === "name")?.value).toBe(escapedName);
    expect(preview.items[0]).toMatchObject({ status: "invalid" });
    expect(preview.items[0]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported_qualified_tel_uri", property: "TEL" }),
    ]));
  });

  it("does not erase unsafe phone qualifiers when deduplicating", async () => {
    const { app } = withTempApp();
    await createContact(app, {
      employer: "Acme",
      attributes: [{ kind: "phone", value: "5550100 ext 1" }],
    });
    const content = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Safe Plain Phone",
      "ORG:Acme",
      "TEL:+55501001",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:SIP Phone",
      "ORG:Acme",
      "TEL;VALUE=uri:sip:55501001@office.example",
      "END:VCARD",
    ].join("\n");
    const result = (
      await app.inject({
        method: "POST",
        url: "/v1/contacts/import",
        payload: { filename: "phones.vcf", format: "vcard", mode: "preview", content },
      })
    ).json() as ContactImportResponse;
    expect(result.items[0]).toMatchObject({ status: "ready", duplicate: null });
    expect(result.items[1]).toMatchObject({ status: "invalid" });
    expect(result.items[1]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported_tel_uri" }),
    ]));
  });

  it("preserves imported provenance on unrelated edits (INV-2 regression)", async () => {
    const { app } = withTempApp();
    const csvText =
      "name,email,employer,role\n" + "Bob Manager,bob@globex.example,Globex,hiring_manager\n";
    const imported = (
      await app.inject({
        method: "POST",
        url: "/v1/contacts/import",
        payload: { filename: "referrals.csv", csvText },
      })
    ).json() as ContactImportResponse;
    const contactId = imported.contactIds[0]!;
    const before = (
      (await app.inject({ method: "GET", url: `/v1/contacts/${contactId}` })).json() as {
        contact: ContactDetail;
      }
    ).contact;
    const originalByKind = new Map(before.attributes.map((attribute) => [attribute.kind, attribute]));

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/contacts/${contactId}`,
      payload: {
        expectedFingerprint: before.fingerprint,
        role: "referrer",
        attributes: [
          { kind: "name", value: "Bob Manager" },
          { kind: "email", value: "bob@globex.example" },
          { kind: "phone", value: "+1 555 0100" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const after = (res.json() as { contact: ContactDetail }).contact;
    const afterByKind = new Map(after.attributes.map((attribute) => [attribute.kind, attribute]));
    for (const kind of ["name", "email"]) {
      const kept = afterByKind.get(kind)!;
      const original = originalByKind.get(kind)!;
      expect(kept).toEqual(original);
      expect(kept.provenance.sourceKind).toBe("user_imported_list");
      expect(kept.provenance.sourceRef).toBe("referrals.csv");
      expect(kept.provenance.capturedAt).toBe(original.provenance.capturedAt);
      expect(kept.attributeId).toBe(original.attributeId);
    }
    expect(afterByKind.get("phone")!.provenance.sourceKind).toBe("user_entered");

    const revalued = await app.inject({
      method: "PATCH",
      url: `/v1/contacts/${contactId}`,
      payload: {
        expectedFingerprint: after.fingerprint,
        attributes: [
          { kind: "name", value: "Bob Manager" },
          { kind: "email", value: "bob.manager@globex.example" },
        ],
      },
    });
    const finalByKind = new Map(
      (revalued.json() as { contact: ContactDetail }).contact.attributes.map((attribute) => [
        attribute.kind,
        attribute,
      ]),
    );
    expect(finalByKind.get("name")!.provenance.sourceKind).toBe("user_imported_list");
    expect(finalByKind.get("email")!.provenance.sourceKind).toBe("user_entered");
  });
});
