import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InterviewCatalog } from "../src/contracts.js";
import { JobCtrlApiClient, JobCtrlApiError } from "@jobctrl/api-client";
import { InterviewNoteRevisionConflictError, listInterviewNotes, readInterviewNote, saveInterviewNote } from "../src/interview-notes.js";
import { buildApp } from "../src/server.js";
import { syntheticInterviewCatalogAsset, syntheticInterviewGenerationContext } from "./interview-fixture.js";
import { initializeExactDatabase } from "./exact-schema.js";

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
    initializeExactDatabase(dbPath);
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    for (const [tenantId, jobId] of [["local", JOB_ID], ["local", OTHER_JOB_ID], ["other", JOB_ID]]) {
      db.prepare("INSERT INTO jobs (tenant_id, job_id, url, title) VALUES (?, ?, ?, 'Synthetic job')").run(tenantId, jobId, `https://example.test/${tenantId}/${jobId}`);
    }
  });
  afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  function seedPrep(generation: number, context: unknown) {
    db.prepare(`INSERT INTO job_interview_prep (tenant_id,job_id,generation,status,generated_at,gate_status,generation_context_json)
      VALUES ('local',?,?,'accepted','2026-10-01T00:00:00Z','passed',?)`).run(JOB_ID,generation,context === null ? null : JSON.stringify(context));
  }

  it("rejects an unrelated preparation origin and forged bindings without saving a revision", async () => {
    seedPrep(1, syntheticInterviewGenerationContext(JOB_ID)); // TS09 only.
    const app = buildApp({ appDir: directory, dbPath, configPath: path.join(directory, "config.json"), interviewCatalogAssetLoader: syntheticInterviewCatalogAsset });
    const url = `/v1/jobs/${JOB_ID}/interview-notes`;
    const unrelated = await app.inject({ method: "POST", url, payload: { questionId: "TS10", expectedRevision: 0, noteText: "unsaved private draft", sourceGeneration: 1,
      bindings: { contextDigest: "f".repeat(64), cardRevision: "forged", cardDigest: "f".repeat(64), catalogBinding: { catalogRevision: "forged", catalogDigest: "f".repeat(64) } } } });
    expect(unrelated.statusCode, unrelated.body).toBe(400);
    expect(unrelated.json().error).toBe("invalid_interview_note_source");
    for (const bindings of [{ contextDigest: "f".repeat(64) }, { cardRevision: "forged" }, { cardDigest: "f".repeat(64) },
      { catalogBinding: { catalogRevision: "forged", catalogDigest: "f".repeat(64) } }]) {
      const forged = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 0, noteText: "another unsaved draft", sourceGeneration: 1, bindings } });
      expect(forged.statusCode, forged.body).toBe(400);
      expect(forged.json().error).toBe("invalid_interview_note_bindings");
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_interview_notes").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_interview_note_revisions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='InterviewQuestionNoteSaved'").get()).toEqual({ n: 0 });
    await app.close();
  });

  it("derives current and historical origins from retained snapshots, including retired cards", async () => {
    const historical = syntheticInterviewGenerationContext(JOB_ID);
    seedPrep(1, historical);
    const current = structuredClone(historical); current.contextDigest = "e".repeat(64);
    current.selectedQuestions[0]!.cardRevision = "2"; current.selectedQuestions[0]!.cardDigest = "c".repeat(64);
    current.selectedQuestions[0]!.snapshot.cardRevision = "2"; current.selectedQuestions[0]!.snapshot.cardDigest = "c".repeat(64);
    seedPrep(2, current);
    const catalog = syntheticInterviewCatalogAsset().data as InterviewCatalog;
    catalog.questions = catalog.questions.filter((card) => card.id !== "TS09");
    catalog.retiredQuestions.push({ id: "TS09", retiredAt: "2026-10-02", reason: "Synthetic retirement", replacementId: null });
    const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
    const { catalogDigest: _digest, ...content } = catalog;
    catalog.catalogDigest = createHash("sha256").update(JSON.stringify(sorted(content))).digest("hex");
    const app = buildApp({ appDir: directory, dbPath, configPath: path.join(directory, "config.json"),
      interviewCatalogAssetLoader: () => ({ ...syntheticInterviewCatalogAsset(), data: catalog }) });
    const url = `/v1/jobs/${JOB_ID}/interview-notes`;
    const first = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 0, noteText: "historic draft", sourceGeneration: 1 } });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().note).toMatchObject({ sourceGeneration: 1, bindings: { catalogBinding: historical.catalogBinding,
      cardRevision: historical.selectedQuestions[0]!.cardRevision, cardDigest: historical.selectedQuestions[0]!.cardDigest, contextDigest: historical.contextDigest } });
    const preserved = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 1, noteText: "historic edit" } });
    expect(preserved.statusCode).toBe(200); expect(preserved.json().note.bindings).toEqual(first.json().note.bindings);
    const rebased = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 2, noteText: "current origin", sourceGeneration: 2,
      bindings: { catalogBinding: current.catalogBinding, cardRevision: "2", cardDigest: "c".repeat(64), contextDigest: current.contextDigest } } });
    expect(rebased.statusCode, rebased.body).toBe(200); expect(rebased.json().note.bindings.contextDigest).toBe(current.contextDigest);
    const detached = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 3, noteText: "independent retired card", sourceGeneration: null, bindings: null } });
    expect(detached.statusCode).toBe(200); expect(detached.json().note).toMatchObject({ sourceGeneration: null, bindings: null });
    expect(JSON.parse((db.prepare("SELECT generation_context_json FROM job_interview_prep WHERE tenant_id='local' AND job_id=? AND generation=1").get(JOB_ID) as { generation_context_json: string }).generation_context_json)).toEqual(historical);
    await app.close();
  });

  it("keeps independent and legacy notes unbound to preparation while validating current card claims", async () => {
    seedPrep(1, null);
    const catalog = syntheticInterviewCatalogAsset().data as InterviewCatalog;
    const app = buildApp({ appDir: directory, dbPath, configPath: path.join(directory, "config.json"), interviewCatalogAssetLoader: syntheticInterviewCatalogAsset });
    const url = `/v1/jobs/${JOB_ID}/interview-notes`;
    const legacy = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 0, noteText: "legacy source", sourceGeneration: 1 } });
    expect(legacy.statusCode).toBe(400); expect(legacy.json().error).toBe("invalid_interview_note_source");
    for (const bindings of [{ contextDigest: "d".repeat(64) }, { cardDigest: "f".repeat(64) }]) {
      const invalid = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 0, noteText: "independent unsaved draft", sourceGeneration: null, bindings } });
      expect(invalid.statusCode).toBe(400); expect(invalid.json().error).toBe("invalid_interview_note_bindings");
    }
    const saved = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 0, noteText: "independent draft", sourceGeneration: null,
      bindings: { catalogBinding: { catalogRevision: catalog.catalogRevision, catalogDigest: catalog.catalogDigest }, cardDigest: catalog.questions[0]!.cardDigest, contextDigest: null } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().note).toMatchObject({ sourceGeneration: null, bindings: { cardRevision: catalog.questions[0]!.cardRevision, cardDigest: catalog.questions[0]!.cardDigest, contextDigest: null } });
    const omitted = await app.inject({ method: "POST", url, payload: { questionId: "TS10", expectedRevision: 0, noteText: "no declared origin" } });
    expect(omitted.statusCode).toBe(200); expect(omitted.json().note).toMatchObject({ sourceGeneration: null, bindings: { contextDigest: null, cardRevision: catalog.questions[1]!.cardRevision } });
    await app.close();
  });

  it("validates provenance after CAS and preserves every saved revision on errors", async () => {
    seedPrep(1, syntheticInterviewGenerationContext(JOB_ID));
    const app = buildApp({ appDir: directory, dbPath, configPath: path.join(directory, "config.json"), interviewCatalogAssetLoader: syntheticInterviewCatalogAsset });
    const url = `/v1/jobs/${JOB_ID}/interview-notes`;
    const saved = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 0, noteText: "newer valid draft", sourceGeneration: 1 } });
    expect(saved.statusCode).toBe(200);
    const badClaims = { questionId: "TS09", noteText: "unsaved stale private draft", sourceGeneration: 99, bindings: { contextDigest: "f".repeat(64) } };
    const conflict = await app.inject({ method: "POST", url, payload: { ...badClaims, expectedRevision: 0 } });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().currentNote).toEqual(saved.json().note);
    const missingRevision = await app.inject({ method: "POST", url, payload: { ...badClaims, questionId: "TS10", sourceGeneration: 1, expectedRevision: 1 } });
    expect(missingRevision.statusCode).toBe(409); expect(missingRevision.json().currentNote).toBeNull();
    const invalid = await app.inject({ method: "POST", url, payload: { ...badClaims, sourceGeneration: 1, expectedRevision: 1 } });
    expect(invalid.statusCode).toBe(400);
    expect(readInterviewNote(db, "local", JOB_ID, "TS09")).toEqual(saved.json().note);
    expect(listInterviewNotes(db, "local", JOB_ID, { ...query, questionId: "TS09", history: true }).total).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='InterviewQuestionNoteSaved'").get()).toEqual({ n: 1 });
    expect(JSON.stringify(db.prepare("SELECT payload_json,message FROM job_events").all())).not.toContain("private draft");
    await app.close();
  });

  it("keeps an existing note editable after its preparation is deleted without accepting fresh invalid origins", async () => {
    seedPrep(1, syntheticInterviewGenerationContext(JOB_ID));
    const app = buildApp({ appDir: directory, dbPath, configPath: path.join(directory, "config.json"), interviewCatalogAssetLoader: syntheticInterviewCatalogAsset });
    const url = `/v1/jobs/${JOB_ID}/interview-notes`;
    const original = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 0, noteText: "original retained draft", sourceGeneration: 1 } });
    expect(original.statusCode).toBe(200);
    db.prepare("DELETE FROM job_interview_prep WHERE tenant_id='local' AND job_id=? AND generation=1").run(JOB_ID);
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_interview_notes").get()).toEqual({ n: 1 });
    const edited = await app.inject({ method: "POST", url, payload: { questionId: "TS09", expectedRevision: 1, noteText: "ordinary orphan edit" } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().note).toMatchObject({ revision: 2, noteText: "ordinary orphan edit", sourceGeneration: null, bindings: { contextDigest: null } });
    const history = listInterviewNotes(db, "local", JOB_ID, { ...query, questionId: "TS09", history: true });
    expect(history.notes).toEqual([edited.json().note, original.json().note]);
    for (const [questionId, expectedRevision] of [["TS09", 2], ["TS10", 0]] as const) {
      const invalid = await app.inject({ method: "POST", url, payload: { questionId, expectedRevision, noteText: "unsaved explicit missing origin", sourceGeneration: 1 } });
      expect(invalid.statusCode, invalid.body).toBe(400);
      expect(invalid.json().error).toBe("invalid_interview_note_source");
    }
    expect(readInterviewNote(db, "local", JOB_ID, "TS09")).toEqual(edited.json().note);
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_interview_note_revisions").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='InterviewQuestionNoteSaved'").get()).toEqual({ n: 2 });
    expect(JSON.stringify(db.prepare("SELECT payload_json,message FROM job_events").all())).not.toContain("ordinary orphan edit");
    await app.close();
  });

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
    saveInterviewNote(db, "local", JOB_ID, { questionId: "TS09", expectedRevision: 0, noteText: "private-answer-do-not-emit" });
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
