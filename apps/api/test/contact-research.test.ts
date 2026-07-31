/**
 * Supervised contact research — TS API routes + candidate confirmation (R6 Phase 2).
 *
 * Covers: the read model (list + detail with candidate values + provenance,
 * INV-2), the start route dispatching to the injected worker starter, and the
 * confirm route as the explicit user command that promotes a needs_review
 * candidate into a stored Contact fact (INV-4) while preserving research
 * provenance. Also asserts candidate VALUES never leak into event payloads and
 * that no route exposes a send transport (INV-1).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConfirmContactCandidateResponse,
  ContactResearchDetailResponse,
  ContactResearchListResponse,
} from "../src/contracts.js";
import type { ContactResearchStarter } from "../src/local-actions.js";
import { buildApp } from "../src/server.js";
import { initializeExactV7Database } from "./v7-schema.js";

const SECRET_NAME = "Dana Hiring-Manager";
const SECRET_EMAIL = "dana@acme.example";
const TEAM_URL = "https://acme.example/team";
const JOB_ID_ONE = "00000000-0000-4000-8000-000000000021";
const JOB_ID_TWO = "00000000-0000-4000-8000-000000000022";
const JOB_URL_ONE = "https://jobs.example.test/research-one";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
});

function withTempApp(starter?: ContactResearchStarter) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-research-"));
  const dbPath = path.join(dir, "jobs.db");
  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const insertJob = db.prepare(
    `INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at)
     VALUES ('local', ?, ?, 'Fixture job', '2026-07-31T12:00:00Z')`,
  );
  insertJob.run(JOB_ID_ONE, JOB_URL_ONE);
  insertJob.run(JOB_ID_TWO, "https://jobs.example.test/research-two");
  db.close();
  const app = buildApp({
    dbPath,
    configPath: path.join(dir, "config.json"),
    requireHealthyWorkerForActions: false,
    ...(starter ? { contactResearchStarter: starter } : {}),
  });
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { app, dbPath };
}

function seedNeedsReviewTask(dbPath: string): { taskId: string; candidateId: string } {
  const db = new Database(dbPath);
  const taskId = "task-seed";
  const candidateId = "cand-seed";
  db.prepare(
    `INSERT INTO contact_research_tasks (
       tenant_id, task_id, employer, job_id, status, source_attempts_json,
       started_at, updated_at, needs_review_at
     ) VALUES ('local', ?, 'Acme', ?, 'needs_review', ?, ?, ?, ?)`,
  ).run(
    taskId,
    JOB_ID_ONE,
    JSON.stringify([
      {
        sourceKind: "public_web_page",
        sourceRef: TEAM_URL,
        outcome: "allowed",
        attemptedAt: "2026-07-06T00:00:00Z",
        detail: "proposed:1",
      },
    ]),
    "2026-07-06T00:00:00Z",
    "2026-07-06T00:00:02Z",
    "2026-07-06T00:00:02Z",
  );
  const provenance = {
    source_kind: "public_web_page",
    source_ref: TEAM_URL,
    capture_method: "llm_assisted",
    captured_at: "2026-07-06T00:00:00Z",
    confidence: 0.8,
    user_confirmed: false,
  };
  db.prepare(
    `INSERT INTO contact_candidates (
       tenant_id, candidate_id, task_id, role, attributes_json,
       source_kind, source_ref, capture_method, confidence, status, proposed_at
     ) VALUES ('local', ?, ?, 'hiring_manager', ?, 'public_web_page', ?, 'llm_assisted', 0.8, 'needs_review', ?)`,
  ).run(
    candidateId,
    taskId,
    JSON.stringify([
      { attributeId: "attr-1", kind: "name", value: SECRET_NAME, provenance },
      { attributeId: "attr-2", kind: "email", value: SECRET_EMAIL, provenance },
    ]),
    TEAM_URL,
    "2026-07-06T00:00:00Z",
  );
  db.close();
  return { taskId, candidateId };
}

function eventTypes(dbPath: string): string[] {
  const db = new Database(dbPath);
  const rows = db.prepare("SELECT event_type FROM job_events").all() as Array<{ event_type: string }>;
  db.close();
  return rows.map((row) => row.event_type);
}

function researchEvents(dbPath: string): Array<{
  tenant_id: string;
  job_id: string | null;
  identity_version: number;
  event_type: string;
}> {
  const db = new Database(dbPath);
  const rows = db
    .prepare("SELECT tenant_id, job_id, identity_version, event_type FROM job_events")
    .all() as Array<{
    tenant_id: string;
    job_id: string | null;
    identity_version: number;
    event_type: string;
  }>;
  db.close();
  return rows;
}

function eventPayloadBlob(dbPath: string): string {
  const db = new Database(dbPath);
  const rows = db.prepare("SELECT payload_json FROM job_events").all() as Array<{
    payload_json: string | null;
  }>;
  db.close();
  return rows.map((row) => row.payload_json ?? "").join(" ");
}

describe("contact research API", () => {
  it("starts a supervised run via the worker starter and returns the task id", async () => {
    const starter = vi.fn<ContactResearchStarter>(async () => ({
      runId: "run-1",
      workflowId: "contact-research-x",
      firstExecutionRunId: "run-1",
      status: "queued",
    }));
    const { app, dbPath } = withTempApp(starter);

    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts/research",
      payload: {
        employer: "Acme",
        jobId: JOB_ID_ONE,
        sources: [{ category: "public_web_page", url: TEAM_URL }],
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { ok: boolean; taskId: string; runId: string };
    expect(body.ok).toBe(true);
    expect(body.taskId).toBeTruthy();
    expect(starter).toHaveBeenCalledTimes(1);
    const input = starter.mock.calls[0]![0];
    expect(input.taskId).toBe(body.taskId);
    expect(input.jobUrl).toBe(JOB_URL_ONE);
    expect(input.sources).toEqual([{ category: "public_web_page", url: TEAM_URL, label: "" }]);

    // The queued task is readable immediately and emitted a start event.
    const list = (
      await app.inject({ method: "GET", url: "/v1/contacts/research" })
    ).json() as ContactResearchListResponse;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.taskId).toBe(body.taskId);
    expect(list.items[0]!.jobId).toBe(JOB_ID_ONE);
    expect(list.items[0]!.status).toBe("queued");
    expect(eventTypes(dbPath)).toContain("ContactResearchTaskStarted");
    expect(researchEvents(dbPath)).toContainEqual({
      tenant_id: "local",
      job_id: JOB_ID_ONE,
      identity_version: 1,
      event_type: "ContactResearchTaskStarted",
    });
  });

  it("rejects a run scoped to neither employer nor jobId", async () => {
    const { app } = withTempApp(async () => ({
      runId: null,
      workflowId: null,
      firstExecutionRunId: null,
      status: "queued",
    }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts/research",
      payload: { sources: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a URL-shaped JobId before research rows or events are written", async () => {
    const { app, dbPath } = withTempApp(async () => ({
      runId: null,
      workflowId: null,
      firstExecutionRunId: null,
      status: "queued",
    }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts/research",
      payload: { employer: "Acme", jobId: "https://jobs.example.test/not-an-id" },
    });
    expect(res.statusCode).toBe(400);
    const db = new Database(dbPath, { readonly: true });
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM contact_research_tasks").get() as { count: number })
        .count,
    ).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count).toBe(0);
    db.close();
  });

  it("rejects noncanonical JobId list filters before opening the database", async () => {
    const { app } = withTempApp();
    for (const jobId of [
      "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
      "https://jobs.example.test/not-an-id",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/contacts/research?jobId=${encodeURIComponent(jobId)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: "invalid_contact_research_query" });
    }
  });

  it("renders each candidate's attributes with provenance and the source attempts (INV-2)", async () => {
    const { app, dbPath } = withTempApp();
    const { taskId } = seedNeedsReviewTask(dbPath);

    const detail = (
      await app.inject({ method: "GET", url: `/v1/contacts/research/${encodeURIComponent(taskId)}` })
    ).json() as ContactResearchDetailResponse;

    expect(detail.task.status).toBe("needs_review");
    expect(detail.task.candidateCount).toBe(1);
    expect(detail.task.sourceAttempts).toHaveLength(1);
    expect(detail.task.sourceAttempts[0]!.outcome).toBe("allowed");
    const candidate = detail.task.candidates[0]!;
    expect(candidate.status).toBe("needs_review");
    expect(candidate.provenance.sourceKind).toBe("public_web_page");
    const nameAttr = candidate.attributes.find((attr) => attr.kind === "name");
    expect(nameAttr?.value).toBe(SECRET_NAME);
    expect(nameAttr?.provenance.captureMethod).toBe("llm_assisted");
    expect(nameAttr?.provenance.userConfirmed).toBe(false);
  });

  it("confirms a candidate into a stored contact (INV-4) preserving provenance", async () => {
    const { app, dbPath } = withTempApp();
    const { taskId, candidateId } = seedNeedsReviewTask(dbPath);

    // INV-4: nothing is a stored contact until the confirm command runs.
    const beforeContacts = (
      await app.inject({ method: "GET", url: "/v1/contacts" })
    ).json() as { items: unknown[] };
    expect(beforeContacts.items).toHaveLength(0);

    const res = await app.inject({
      method: "POST",
      url: `/v1/contacts/research/${encodeURIComponent(taskId)}/candidates/${encodeURIComponent(candidateId)}/confirm`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ConfirmContactCandidateResponse;
    expect(body.ok).toBe(true);
    const nameAttr = body.contact.attributes.find((attr) => attr.kind === "name");
    expect(nameAttr?.value).toBe(SECRET_NAME);
    expect(nameAttr?.provenance.sourceKind).toBe("public_web_page");
    expect(nameAttr?.provenance.userConfirmed).toBe(true);
    expect(body.task.status).toBe("completed");
    expect(body.task.confirmedCount).toBe(1);
    expect(eventTypes(dbPath)).toContain("ContactResearchTaskCompleted");

    // Re-confirming the now-confirmed candidate is rejected.
    const again = await app.inject({
      method: "POST",
      url: `/v1/contacts/research/${encodeURIComponent(taskId)}/candidates/${encodeURIComponent(candidateId)}/confirm`,
      payload: {},
    });
    expect(again.statusCode).toBe(400);
  });

  it("never leaks a candidate value into event payloads (sensitivity)", async () => {
    const { app, dbPath } = withTempApp();
    const { taskId, candidateId } = seedNeedsReviewTask(dbPath);
    await app.inject({
      method: "POST",
      url: `/v1/contacts/research/${encodeURIComponent(taskId)}/candidates/${encodeURIComponent(candidateId)}/confirm`,
      payload: {},
    });
    const blob = eventPayloadBlob(dbPath);
    expect(blob).not.toContain(SECRET_NAME);
    expect(blob).not.toContain(SECRET_EMAIL);
  });
});
