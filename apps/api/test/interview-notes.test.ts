import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobCtrlApiClient, JobCtrlApiError } from "@jobctrl/api-client";
import { InterviewNoteRevisionConflictError, listInterviewNotes, readInterviewNote, saveInterviewNote } from "../src/interview-notes.js";
import { buildApp } from "../src/server.js";
import { syntheticInterviewCatalogAsset } from "./interview-fixture.js";
import { initializeExactV7Database } from "./v7-schema.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const query = { page: 1, pageSize: 20 };

describe("revisioned interview notes", () => {
  let directory: string;
  let dbPath: string;
  let db: Database.Database;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-notes-"));
    dbPath = path.join(directory, "jobctrl.db");
    initializeExactV7Database(dbPath);
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    for (const [tenantId, jobId] of [["local", JOB_ID], ["local", OTHER_JOB_ID], ["other", JOB_ID]]) {
      db.prepare("INSERT INTO jobs (tenant_id, job_id, url, title) VALUES (?, ?, ?, 'Synthetic job')").run(tenantId, jobId, `https://example.test/${tenantId}/${jobId}`);
    }
  });
  afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  it("creates independent notes and keeps saved revisions inspectable", () => {
    const first = saveInterviewNote(db, "local", JOB_ID, { questionId: "TS09", expectedRevision: 0, noteText: "unverified personal recollection" });
    expect(first).toMatchObject({ revision: 1, factualSupport: "unverified_user_statement", editStatus: "user_edited", sourceGeneration: null });
    const second = saveInterviewNote(db, "local", JOB_ID, { questionId: "TS09", expectedRevision: 1, noteText: "revised recollection", factualSupport: "needs_clarification" });
    expect(second).toMatchObject({ revision: 2, noteText: "revised recollection", factualSupport: "needs_clarification" });
    const history = listInterviewNotes(db, "local", JOB_ID, { ...query, questionId: "TS09", history: true, pageSize: 1 });
    expect(history).toMatchObject({ total: 2, notes: [{ revision: 2 }] });
    expect(listInterviewNotes(db, "local", JOB_ID, { ...query, questionId: "TS09", history: true, page: 2, pageSize: 1 }).notes[0]?.noteText).toBe(first.noteText);
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_interview_prep").get()).toEqual({ n: 0 });
  });

  it("CAS rejects both a duplicate create and concurrent stale edit preserving the newer value", () => {
    saveInterviewNote(db, "local", JOB_ID, { questionId: "TS09", expectedRevision: 0, noteText: "first" });
    const otherConnection = new Database(dbPath);
    try {
      saveInterviewNote(otherConnection, "local", JOB_ID, { questionId: "TS09", expectedRevision: 1, noteText: "newer" });
      expect(() => saveInterviewNote(db, "local", JOB_ID, { questionId: "TS09", expectedRevision: 1, noteText: "stale draft" })).toThrow(InterviewNoteRevisionConflictError);
      expect(() => saveInterviewNote(db, "local", JOB_ID, { questionId: "TS09", expectedRevision: 0, noteText: "duplicate create" })).toThrow(InterviewNoteRevisionConflictError);
      expect(readInterviewNote(db, "local", JOB_ID, "TS09")).toMatchObject({ revision: 2, noteText: "newer" });
      expect(listInterviewNotes(db, "local", JOB_ID, { ...query, questionId: "TS09", history: true }).total).toBe(2);
    } finally { otherConnection.close(); }
  });

  it("archive failure rolls back current note, history and event together", () => {
    saveInterviewNote(db, "local", JOB_ID, { questionId: "TS09", expectedRevision: 0, noteText: "accepted draft" });
    db.exec("CREATE TRIGGER fail_note_archive BEFORE INSERT ON job_interview_note_revisions BEGIN SELECT RAISE(ABORT, 'synthetic archive failure'); END");
    expect(() => saveInterviewNote(db, "local", JOB_ID, { questionId: "TS09", expectedRevision: 1, noteText: "failed replacement" })).toThrow("synthetic archive failure");
    expect(readInterviewNote(db, "local", JOB_ID, "TS09")).toMatchObject({ revision: 1, noteText: "accepted draft" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_interview_note_revisions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type = 'InterviewQuestionNoteSaved'").get()).toEqual({ n: 1 });
    db.exec("DROP TRIGGER fail_note_archive");
  });

  it("isolates tenants and jobs and cascades only the deleted job's notes/revisions", () => {
    saveInterviewNote(db, "local", JOB_ID, { questionId: "TS09", expectedRevision: 0, noteText: "local" });
    saveInterviewNote(db, "other", JOB_ID, { questionId: "TS09", expectedRevision: 0, noteText: "other tenant" });
    saveInterviewNote(db, "local", OTHER_JOB_ID, { questionId: "TS09", expectedRevision: 0, noteText: "other job" });
    expect(listInterviewNotes(db, "local", JOB_ID, query).notes.map((note) => note.noteText)).toEqual(["local"]);
    db.prepare("DELETE FROM jobs WHERE tenant_id = 'local' AND job_id = ?").run(JOB_ID);
    expect(readInterviewNote(db, "local", JOB_ID, "TS09")).toBeNull();
    expect(listInterviewNotes(db, "local", JOB_ID, { ...query, questionId: "TS09", history: true }).total).toBe(0);
    expect(readInterviewNote(db, "other", JOB_ID, "TS09")?.noteText).toBe("other tenant");
    expect(readInterviewNote(db, "local", OTHER_JOB_ID, "TS09")?.noteText).toBe("other job");
  });

  it("uses only safe note IDs/versions in events and never updates profile, fit or Apply", () => {
    const before = ["candidate_profiles", "job_scores", "application_outcomes", "job_interview_prep"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    saveInterviewNote(db, "local", JOB_ID, { questionId: "TS09", expectedRevision: 0, noteText: "private-answer-do-not-emit", bindings: { cardRevision: "1", contextDigest: "f".repeat(64) } });
    const event = db.prepare("SELECT message, payload_json FROM job_events WHERE event_type = 'InterviewQuestionNoteSaved'").get() as { message: string; payload_json: string };
    expect(JSON.parse(event.payload_json)).toEqual({ jobId: JOB_ID, questionId: "TS09", revision: 1, sourceGeneration: null, updatedAt: expect.any(String) });
    expect(event.message + event.payload_json).not.toContain("private-answer-do-not-emit");
    expect(event.payload_json).not.toContain("contextDigest");
    expect(["candidate_profiles", "job_scores", "application_outcomes", "job_interview_prep"].map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  });

  it("returns explicit HTTP conflict and bounds/untrusted-save errors", async () => {
    const app = buildApp({ appDir: directory, dbPath, configPath: path.join(directory, "config.json"), interviewCatalogAssetLoader: syntheticInterviewCatalogAsset });
    const url = `/v1/jobs/${JOB_ID}/interview-notes`;
    const saved = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 0, noteText: "newer edit" } });
    expect(saved.statusCode, saved.body).toBe(200);
    const conflict = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 0, noteText: "stale draft" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "interview_note_revision_conflict", currentNote: { revision: 1, noteText: "newer edit" } });
    for (const payload of [
      { questionId: "TS09", expectedRevision: 1, noteText: "x".repeat(20_001) },
      { questionId: "TS09", expectedRevision: 1, noteText: "draft", factualSupport: "supported" },
      { questionId: "TS09", expectedRevision: 1, noteText: "draft", sourceGeneration: 99 },
    ]) expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }, payload: { questionId: "TS09", expectedRevision: 1, noteText: "attacker" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `${url}?history=true` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${url}?pageSize=101` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/v1/jobs/33333333-3333-4333-8333-333333333333/interview-notes` })).statusCode).toBe(404);
    await app.close();
  });

  it("retains conflict payload through generated API-client forwarding", async () => {
    const app = buildApp({ appDir: directory, dbPath, configPath: path.join(directory, "config.json"), interviewCatalogAssetLoader: syntheticInterviewCatalogAsset });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic listener");
    const client = new JobCtrlApiClient(`http://127.0.0.1:${address.port}`);
    const note = await app.inject({ method: "POST", url: `/v1/jobs/${JOB_ID}/interview-notes`, payload: { questionId: "TS09", expectedRevision: 0, noteText: "newer" } });
    expect(note.statusCode).toBe(200);
    // Real client mutation needs the same trusted loopback Origin as a browser.
    const transport = globalThis.fetch;
    globalThis.fetch = (input, init) => transport(input, { ...init, headers: { ...init?.headers, Origin: "http://127.0.0.1:5173", "Sec-Fetch-Site": "same-origin" } });
    try {
      await client.saveInterviewNote(JOB_ID, { questionId: "TS09", expectedRevision: 0, noteText: "stale" }).then(() => { throw new Error("Expected conflict"); }, (error: unknown) => {
        expect(error).toBeInstanceOf(JobCtrlApiError);
        expect(error).toMatchObject({ status: 409, responseBody: { error: "interview_note_revision_conflict", currentNote: { revision: 1, noteText: "newer" } } });
      });
    } finally { globalThis.fetch = transport; await app.close(); }
  });
});
