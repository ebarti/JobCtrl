/**
 * Outreach drafts — TS API routes + approve/reject transitions (R6 Phase 3).
 *
 * Covers: the canonical-join read (thread by contact, gate results + provenance
 * mapped from canonical JSON), the INV-5 approval gate (approve is BLOCKED with
 * 409/draft_gates_not_passed when the persisted gate_results_json.passed is
 * false), approve superseding the prior approved generation, reject leaving an
 * approved draft untouched (INV-5), the projection reflecting the lifecycle
 * without leaking draft bodies, and the generate/revise routes dispatching to the
 * injected worker generator. No route exposes a send transport (INV-1).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OutreachDraftGateResults, OutreachThreadDetail } from "../src/contracts.js";
import { ensureOutreachTables } from "../src/outreach.js";
import type { OutreachDraftGenerator } from "../src/local-actions.js";
import { buildApp } from "../src/server.js";

const SECRET_BODY = "Hi Dana, I boosted revenue 40% and would love to connect.";
const SECRET_RATIONALE = "Grounded in the confirmed employer attribute.";

const PASSING_GATE: OutreachDraftGateResults = {
  passed: true,
  computedAgainst: "rendered_draft_text",
  fabrications: [],
  validation: { passed: true, errors: [], warnings: [] },
  judge: { approved: true, score: 9, criterionScores: { truthfulness: 10 }, issues: [], notes: "ok" },
};

const FAILING_GATE: OutreachDraftGateResults = {
  passed: false,
  computedAgainst: "rendered_draft_text",
  fabrications: [
    { section: "body", kind: "metric", token: "40%", control: "none", generatedText: "boosted revenue 40%" },
  ],
  validation: { passed: false, errors: ["unverifiable metric"], warnings: [] },
  judge: null,
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
});

function withTempApp(generator?: OutreachDraftGenerator) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-outreach-"));
  const dbPath = path.join(dir, "jobs.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE jobs (url TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE job_events (
      event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url      TEXT,
      stage        TEXT,
      event_type   TEXT NOT NULL,
      level        TEXT NOT NULL DEFAULT 'info',
      message      TEXT,
      occurred_at  TEXT NOT NULL,
      payload_json TEXT,
      entity_kind  TEXT,
      entity_ref   TEXT
    );
  `);
  ensureOutreachTables(db);
  db.close();
  const app = buildApp({
    dbPath,
    settingsPath: path.join(dir, "dashboard.json"),
    requireHealthyWorkerForActions: false,
    ...(generator ? { outreachDraftGenerator: generator } : {}),
  });
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { app, dbPath };
}

function seedThread(
  dbPath: string,
  input: { threadId: string; contactId: string; jobUrl: string | null },
): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO outreach_threads (tenant_id, thread_id, contact_id, job_url, created_at, updated_at)
     VALUES ('local', ?, ?, ?, ?, ?)`,
  ).run(input.threadId, input.contactId, input.jobUrl, "2026-07-06T00:00:00Z", "2026-07-06T00:00:00Z");
  db.close();
}

function seedDraft(
  dbPath: string,
  input: {
    draftId: string;
    threadId: string;
    generation: number;
    kind?: string;
    status?: string;
    bodyText?: string;
    gate: OutreachDraftGateResults;
    provenance?: unknown[];
    approvedAt?: string | null;
  },
): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO outreach_drafts (
       tenant_id, draft_id, thread_id, generation, kind, status, body_text,
       gate_results_json, provenance_json, created_at, approved_at, rejected_at, reason
     ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '')`,
  ).run(
    input.draftId,
    input.threadId,
    input.generation,
    input.kind ?? "intro_request",
    input.status ?? "candidate",
    input.bodyText ?? SECRET_BODY,
    JSON.stringify(input.gate),
    JSON.stringify(input.provenance ?? []),
    "2026-07-06T00:00:01Z",
    input.approvedAt ?? null,
  );
  db.close();
}

function eventTypes(dbPath: string): string[] {
  const db = new Database(dbPath);
  const rows = db.prepare("SELECT event_type FROM job_events").all() as Array<{ event_type: string }>;
  db.close();
  return rows.map((row) => row.event_type);
}

function eventPayloads(dbPath: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath);
  const rows = db.prepare("SELECT event_type, payload_json FROM job_events").all() as Array<{
    event_type: string;
    payload_json: string | null;
  }>;
  db.close();
  return rows.map((row) => ({
    eventType: row.event_type,
    ...(JSON.parse(row.payload_json ?? "{}") as Record<string, unknown>),
  }));
}

function draftStatus(dbPath: string, draftId: string): string {
  const db = new Database(dbPath);
  const row = db
    .prepare("SELECT status FROM outreach_drafts WHERE tenant_id = 'local' AND draft_id = ?")
    .get(draftId) as { status: string } | undefined;
  db.close();
  return row?.status ?? "";
}

interface ThreadResponse {
  ok: boolean;
  error?: string;
  message?: string;
  thread: OutreachThreadDetail | null;
}

describe("outreach API", () => {
  it("returns a null thread for a contact with no outreach yet", async () => {
    const { app } = withTempApp();
    const res = await app.inject({ method: "GET", url: "/v1/contacts/contact-x/outreach" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ThreadResponse;
    expect(body.ok).toBe(true);
    expect(body.thread).toBeNull();
  });

  it("maps gateResults + provenance + body from canonical rows on read", async () => {
    const { app, dbPath } = withTempApp();
    seedThread(dbPath, { threadId: "thread-r", contactId: "contact-r", jobUrl: "https://job/9" });
    seedDraft(dbPath, {
      draftId: "draft-r1",
      threadId: "thread-r",
      generation: 1,
      gate: FAILING_GATE,
      provenance: [
        {
          claimId: "c1",
          section: "opening",
          generatedText: "boosted revenue 40%",
          contactFactIds: ["fact-1"],
          profileGrounded: false,
          rationale: SECRET_RATIONALE,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/contacts/contact-r/outreach?jobId=https%3A%2F%2Fjob%2F9",
    });
    expect(res.statusCode).toBe(200);
    const thread = (res.json() as ThreadResponse).thread!;
    expect(thread.threadId).toBe("thread-r");
    expect(thread.draftCount).toBe(1);
    expect(thread.latestStatus).toBe("candidate");
    const draft = thread.drafts[0]!;
    expect(draft.bodyText).toBe(SECRET_BODY);
    expect(draft.gateResults.passed).toBe(false);
    expect(draft.gateResults.fabrications).toHaveLength(1);
    expect(draft.gateResults.validation.errors).toContain("unverifiable metric");
    expect(draft.provenance[0]!.rationale).toBe(SECRET_RATIONALE);
    expect(draft.provenance[0]!.profileGrounded).toBe(false);
  });

  it("BLOCKS approval with 409/draft_gates_not_passed when the persisted gate did not pass (INV-5)", async () => {
    const { app, dbPath } = withTempApp();
    seedThread(dbPath, { threadId: "thread-g", contactId: "contact-g", jobUrl: null });
    seedDraft(dbPath, { draftId: "draft-g1", threadId: "thread-g", generation: 1, gate: FAILING_GATE });

    const res = await app.inject({
      method: "POST",
      url: "/v1/outreach/threads/thread-g/drafts/draft-g1/approve",
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as ThreadResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("draft_gates_not_passed");

    // The draft stays a candidate and no approval event was recorded.
    expect(draftStatus(dbPath, "draft-g1")).toBe("candidate");
    expect(eventTypes(dbPath)).not.toContain("OutreachDraftApproved");
  });

  it("approves a gate-passing candidate and supersedes the prior approved generation", async () => {
    const { app, dbPath } = withTempApp();
    seedThread(dbPath, { threadId: "thread-a", contactId: "contact-a", jobUrl: "https://job/1" });
    seedDraft(dbPath, {
      draftId: "draft-a1",
      threadId: "thread-a",
      generation: 1,
      status: "approved",
      gate: PASSING_GATE,
      approvedAt: "2026-07-06T00:01:00Z",
    });
    seedDraft(dbPath, { draftId: "draft-a2", threadId: "thread-a", generation: 2, gate: PASSING_GATE });

    const res = await app.inject({
      method: "POST",
      url: "/v1/outreach/threads/thread-a/drafts/draft-a2/approve",
    });
    expect(res.statusCode).toBe(200);
    const thread = (res.json() as ThreadResponse).thread!;
    expect(thread.hasApprovedDraft).toBe(true);
    expect(thread.approvedDraftId).toBe("draft-a2");
    expect(thread.latestStatus).toBe("approved");
    expect(draftStatus(dbPath, "draft-a1")).toBe("superseded");
    expect(draftStatus(dbPath, "draft-a2")).toBe("approved");
    expect(eventTypes(dbPath)).toContain("OutreachDraftApproved");
  });

  it("rejects a candidate but never touches an approved draft (INV-5)", async () => {
    const { app, dbPath } = withTempApp();
    seedThread(dbPath, { threadId: "thread-j", contactId: "contact-j", jobUrl: null });
    seedDraft(dbPath, {
      draftId: "draft-j1",
      threadId: "thread-j",
      generation: 1,
      status: "approved",
      gate: PASSING_GATE,
      approvedAt: "2026-07-06T00:01:00Z",
    });
    seedDraft(dbPath, { draftId: "draft-j2", threadId: "thread-j", generation: 2, gate: PASSING_GATE });

    // Rejecting the candidate leaves the previously approved draft intact.
    const reason = "off tone, references dana.lee@example.test";
    const rejectCandidate = await app.inject({
      method: "POST",
      url: "/v1/outreach/threads/thread-j/drafts/draft-j2/reject",
      payload: { reason },
    });
    expect(rejectCandidate.statusCode).toBe(200);
    expect(draftStatus(dbPath, "draft-j2")).toBe("rejected");
    expect(draftStatus(dbPath, "draft-j1")).toBe("approved");

    const db = new Database(dbPath);
    const stored = db
      .prepare("SELECT reason FROM outreach_drafts WHERE tenant_id = 'local' AND draft_id = 'draft-j2'")
      .get() as { reason: string };
    db.close();
    expect(stored.reason).toBe(reason);
    const payloads = eventPayloads(dbPath);
    expect(JSON.stringify(payloads)).not.toContain(reason);
    expect(payloads.find((payload) => payload.eventType === "OutreachDraftRejected")).toMatchObject({
      draftId: "draft-j2",
      rejectedAt: expect.any(String),
    });
    expect(payloads.find((payload) => payload.eventType === "OutreachDraftRejected")).not.toHaveProperty("reason");

    // Rejecting the approved draft is refused — only a candidate is rejectable.
    const rejectApproved = await app.inject({
      method: "POST",
      url: "/v1/outreach/threads/thread-j/drafts/draft-j1/reject",
      payload: {},
    });
    expect(rejectApproved.statusCode).toBe(400);
    expect((rejectApproved.json() as ThreadResponse).error).toBe("invalid_outreach_transition");
    expect(draftStatus(dbPath, "draft-j1")).toBe("approved");
  });

  it("returns 404 approving a draft that does not exist", async () => {
    const { app, dbPath } = withTempApp();
    seedThread(dbPath, { threadId: "thread-n", contactId: "contact-n", jobUrl: null });
    const res = await app.inject({
      method: "POST",
      url: "/v1/outreach/threads/thread-n/drafts/missing/approve",
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as ThreadResponse).error).toBe("outreach_draft_not_found");
  });

  it("reflects the thread lifecycle in the outreach_thread_projections row without leaking bodies", async () => {
    const { app, dbPath } = withTempApp();
    seedThread(dbPath, { threadId: "thread-p", contactId: "contact-p", jobUrl: "https://job/2" });
    seedDraft(dbPath, {
      draftId: "draft-p1",
      threadId: "thread-p",
      generation: 1,
      status: "superseded",
      gate: PASSING_GATE,
    });
    seedDraft(dbPath, { draftId: "draft-p2", threadId: "thread-p", generation: 2, gate: PASSING_GATE });

    // Approve to advance the lifecycle and force a projection refresh.
    await app.inject({ method: "POST", url: "/v1/outreach/threads/thread-p/drafts/draft-p2/approve" });

    const db = new Database(dbPath);
    const row = db
      .prepare("SELECT * FROM outreach_thread_projections WHERE tenant_id = 'local' AND thread_id = 'thread-p'")
      .get() as Record<string, unknown>;
    db.close();
    expect(Number(row.draft_count)).toBe(2);
    expect(Number(row.latest_generation)).toBe(2);
    expect(Number(row.has_approved_draft)).toBe(1);
    expect(row.approved_draft_id).toBe("draft-p2");
    expect(row.latest_status).toBe("approved");
    const drafts = JSON.parse(String(row.drafts_json)) as Array<{ draftId: string; gatePassed: boolean }>;
    expect(drafts.map((d) => d.draftId)).toEqual(["draft-p1", "draft-p2"]);
    expect(drafts.every((d) => d.gatePassed)).toBe(true);
    expect(JSON.stringify(row)).not.toContain(SECRET_BODY);
  });

  it("generates a draft through the injected worker generator, minting a thread id", async () => {
    const dbPathRef = { current: "" };
    const generator = vi.fn<OutreachDraftGenerator>(async (input, _context) => {
      // Simulate the worker (a separate process) persisting a gated candidate draft.
      const db = new Database(dbPathRef.current);
      db.prepare(
        `INSERT INTO outreach_threads (tenant_id, thread_id, contact_id, job_url, created_at, updated_at)
         VALUES ('local', ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, thread_id) DO NOTHING`,
      ).run(input.threadId, input.contactId ?? "", input.jobId ?? null, "2026-07-06T02:00:00Z", "2026-07-06T02:00:00Z");
      db.prepare(
        `INSERT INTO outreach_drafts (
           tenant_id, draft_id, thread_id, generation, kind, status, body_text,
           gate_results_json, provenance_json, created_at
         ) VALUES ('local', 'draft-new', ?, 1, 'intro_request', 'candidate', ?, ?, '[]', '2026-07-06T02:00:01Z')`,
      ).run(input.threadId, SECRET_BODY, JSON.stringify(PASSING_GATE));
      db.close();
      return {
        threadId: input.threadId,
        contactId: input.contactId ?? "",
        jobId: input.jobId ?? null,
        draftId: "draft-new",
        generation: 1,
        kind: "intro_request",
        status: "candidate",
        gatePassed: true,
      };
    });
    const { app, dbPath } = withTempApp(generator);
    dbPathRef.current = dbPath;

    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts/contact-gen/outreach/drafts",
      payload: { jobId: "https://job/3", kind: "intro_request" },
    });
    expect(res.statusCode).toBe(200);
    const thread = (res.json() as ThreadResponse).thread!;
    expect(thread.contactId).toBe("contact-gen");
    expect(thread.draftCount).toBe(1);
    expect(generator).toHaveBeenCalledTimes(1);
    const input = generator.mock.calls[0]![0];
    expect(input.contactId).toBe("contact-gen");
    expect(input.jobId).toBe("https://job/3");
    expect(input.threadId).toBeTruthy();
  });

  it("revises an existing thread through the injected generator with the edited body", async () => {
    const dbPathRef = { current: "" };
    const generator = vi.fn<OutreachDraftGenerator>(async (input, _context) => {
      const db = new Database(dbPathRef.current);
      db.prepare(
        `INSERT INTO outreach_drafts (
           tenant_id, draft_id, thread_id, generation, kind, status, body_text,
           gate_results_json, provenance_json, created_at
         ) VALUES ('local', 'draft-rev', ?, 2, 'intro_request', 'candidate', ?, ?, '[]', '2026-07-06T03:00:01Z')`,
      ).run(input.threadId, input.editedBodyText ?? "", JSON.stringify(PASSING_GATE));
      db.prepare("UPDATE outreach_threads SET updated_at = '2026-07-06T03:00:01Z' WHERE thread_id = ?").run(
        input.threadId,
      );
      db.close();
      return {
        threadId: input.threadId,
        contactId: "contact-e",
        jobId: null,
        draftId: "draft-rev",
        generation: 2,
        kind: "intro_request",
        status: "candidate",
        gatePassed: true,
      };
    });
    const { app, dbPath } = withTempApp(generator);
    dbPathRef.current = dbPath;
    seedThread(dbPath, { threadId: "thread-e", contactId: "contact-e", jobUrl: null });
    seedDraft(dbPath, { draftId: "draft-e1", threadId: "thread-e", generation: 1, gate: PASSING_GATE });

    const res = await app.inject({
      method: "POST",
      url: "/v1/outreach/threads/thread-e/drafts",
      payload: { editedBodyText: "A tightened, user-edited draft body." },
    });
    expect(res.statusCode).toBe(200);
    const thread = (res.json() as ThreadResponse).thread!;
    expect(thread.draftCount).toBe(2);
    expect(thread.latestGeneration).toBe(2);
    expect(generator).toHaveBeenCalledTimes(1);
    expect(generator.mock.calls[0]![0].editedBodyText).toBe("A tightened, user-edited draft body.");
  });

  it("exposes no send transport on any outreach route (INV-1)", async () => {
    const { app, dbPath } = withTempApp();
    seedThread(dbPath, { threadId: "thread-s", contactId: "contact-s", jobUrl: null });
    seedDraft(dbPath, { draftId: "draft-s1", threadId: "thread-s", generation: 1, gate: PASSING_GATE });
    const res = await app.inject({
      method: "POST",
      url: "/v1/outreach/threads/thread-s/drafts/draft-s1/send",
    });
    expect(res.statusCode).toBe(404);
  });
});
