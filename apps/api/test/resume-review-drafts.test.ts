import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureResumeReviewTables,
} from "../src/resume-review-drafts.js";
import { buildApp, type BuildAppOptions } from "../src/server.js";
import type { ActionDispatcher, ActionDispatchResult } from "../src/local-actions.js";

const JOB_KEY = "https://example.com/jobs/live-editor";
const NOW = "2026-06-24T09:00:00.000Z";

let tempDir = "";
let options: BuildAppOptions;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-resume-review-"));
  options = {
    dbPath: path.join(tempDir, "jobhunter.db"),
    settingsPath: path.join(tempDir, "dashboard.json"),
    actionDispatcher: vi.fn(async (): Promise<ActionDispatchResult> => ({
      status: "queued",
      runId: "unexpected-run",
    })) as ReturnType<typeof vi.fn> & ActionDispatcher,
  };
  seedDatabase(options.dbPath);
});

afterEach(() => {
  fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("resume review draft API", () => {
  it("creates a draft from approved resume materials without mutating artifacts in place", async () => {
    const app = buildApp(options);

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(JOB_KEY)}/resume-review/draft`,
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.draft).toMatchObject({
      jobKey: JOB_KEY,
      baseGeneration: 2,
      baseResumeTextArtifactId: "resume-text-v2",
      baseResumePdfArtifactId: "resume-pdf-v2",
      rendererFormat: "html_pdf",
      state: "active",
      latestRevision: null,
    });
    expect(JSON.stringify(body)).not.toContain(tempDir);

    const db = new Database(options.dbPath);
    try {
      const artifactRows = db
        .prepare("SELECT artifact_id, status FROM job_materials_artifacts ORDER BY artifact_id")
        .all() as Array<{ artifact_id: string; status: string }>;
      expect(artifactRows).toEqual([
        { artifact_id: "resume-pdf-v1", status: "approved" },
        { artifact_id: "resume-pdf-v2", status: "approved" },
        { artifact_id: "resume-text-v1", status: "approved" },
        { artifact_id: "resume-text-v2", status: "approved" },
      ]);
    } finally {
      db.close();
    }

    await app.close();
  });

  it("saves a reloadable draft revision with structured deltas and feedback signals", async () => {
    const app = buildApp(options);
    const createResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(JOB_KEY)}/resume-review/draft`,
      payload: {},
    });
    const draftId = createResponse.json().draft.draftId as string;

    const revisionResponse = await app.inject({
      method: "POST",
      url: `/v1/resume-review/drafts/${encodeURIComponent(draftId)}/revisions`,
      payload: {
        editedText: "Led platform reliability work across 3 critical services.",
        plateDocument: [{ type: "p", children: [{ text: "Led platform reliability." }] }],
        editDeltas: [
          {
            kind: "replace_text",
            section: "experience",
            semanticId: "experience:acme:bullet:1",
            lineAnchor: {
              semanticId: "experience:acme:bullet:1",
              lineNumber: 6,
              pageNumber: 1,
              textHash: "hash-before",
            },
            beforeText: "Led platform reliability work.",
            afterText: "Led platform reliability work across 3 critical services.",
          },
        ],
      },
    });

    expect(revisionResponse.statusCode, revisionResponse.body).toBe(200);
    const revisionBody = revisionResponse.json();
    expect(revisionBody.revision).toMatchObject({
      draftId,
      revisionNumber: 1,
      editedText: "Led platform reliability work across 3 critical services.",
      editDeltas: [
        {
          kind: "replace_text",
          section: "experience",
          semanticId: "experience:acme:bullet:1",
          beforeText: "Led platform reliability work.",
          afterText: "Led platform reliability work across 3 critical services.",
        },
      ],
    });
    expect(revisionBody.draft.feedbackSignals).toHaveLength(1);
    expect(revisionBody.draft.feedbackSignals[0]).toMatchObject({
      jobKey: JOB_KEY,
      draftId,
      sourceKind: "edit_delta",
      kind: "factual_correction",
      status: "candidate",
      semanticId: "experience:acme:bullet:1",
    });
    expect(revisionBody.draft.feedbackSignals[0].signalId).toMatch(/^resume_feedback_/);
    expect(revisionBody.draft.feedbackSignals[0].sourceId).toMatch(/^resume_delta_/);
    expect(revisionBody.draft.feedbackSignals[0].summary.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(revisionBody)).not.toContain(tempDir);

    const reloadResponse = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(JOB_KEY)}/resume-review/draft`,
    });
    expect(reloadResponse.statusCode, reloadResponse.body).toBe(200);
    expect(reloadResponse.json().draft.latestRevision).toMatchObject({
      draftId,
      revisionNumber: 1,
      editedText: "Led platform reliability work across 3 critical services.",
    });

    const feedbackResponse = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(JOB_KEY)}/resume-review/feedback`,
    });
    expect(feedbackResponse.statusCode, feedbackResponse.body).toBe(200);
    expect(feedbackResponse.json().feedbackSignals).toHaveLength(1);
    expect(JSON.stringify(feedbackResponse.json())).not.toContain(tempDir);
    expect(options.actionDispatcher).not.toHaveBeenCalled();

    await app.close();
  });

  it("persists comment replies as safe feedback without changing approved artifacts", async () => {
    const app = buildApp(options);
    const createResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(JOB_KEY)}/resume-review/draft`,
      payload: {},
    });
    const draftId = createResponse.json().draft.draftId as string;
    const threadId = "thread-provenance-warning";

    const db = new Database(options.dbPath);
    try {
      ensureResumeReviewTables(db);
      db.prepare(
        `INSERT INTO resume_review_comment_threads (
           tenant_id, thread_id, draft_id, job_key, base_artifact_id, semantic_id,
           line_anchor_json, source_pin_id, risk_label, comment_body,
           lifecycle_state, anchor_resolved, created_at, updated_at
         ) VALUES (
           'local', ?, ?, ?, 'resume-pdf-v2', 'experience:acme:bullet:1',
           ?, 'pin-1', 'missing_provenance', 'Check the provenance for this claim.',
           'open', 1, ?, ?
         )`,
      ).run(
        threadId,
        draftId,
        JOB_KEY,
        JSON.stringify({ semanticId: "experience:acme:bullet:1", lineNumber: 6, pageNumber: 1 }),
        NOW,
        NOW,
      );
    } finally {
      db.close();
    }

    const replyResponse = await app.inject({
      method: "POST",
      url: `/v1/resume-review/comment-threads/${encodeURIComponent(threadId)}/replies`,
      payload: {
        decision: "rejected",
        body: "This warning is not valid; the line is backed by profile evidence.",
      },
    });

    expect(replyResponse.statusCode, replyResponse.body).toBe(200);
    const body = replyResponse.json();
    expect(body.thread).toMatchObject({
      threadId,
      state: "user_replied",
      riskLabel: "missing_provenance",
      replies: [
        {
          decision: "rejected",
          body: "This warning is not valid; the line is backed by profile evidence.",
        },
      ],
    });
    expect(body.feedbackSignal).toMatchObject({
      sourceKind: "comment_reply",
      kind: "provenance_dispute",
      status: "candidate",
      semanticId: "experience:acme:bullet:1",
    });
    expect(body.feedbackSignal.signalId).toMatch(/^resume_feedback_/);
    expect(body.feedbackSignal.sourceId).toMatch(/^resume_reply_/);
    expect(body.feedbackSignal.summary.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(body)).not.toContain(tempDir);

    const verifyDb = new Database(options.dbPath);
    try {
      const statuses = verifyDb
        .prepare("SELECT DISTINCT status FROM job_materials_artifacts ORDER BY status")
        .all() as Array<{ status: string }>;
      expect(statuses).toEqual([{ status: "approved" }]);
    } finally {
      verifyDb.close();
    }
    expect(options.actionDispatcher).not.toHaveBeenCalled();

    await app.close();
  });
});

function seedDatabase(dbPath: string): void {
  const resumeV1Path = path.join(path.dirname(dbPath), "resume-v1.txt");
  const resumeV2Path = path.join(path.dirname(dbPath), "resume-v2.txt");
  const pdfV1Path = path.join(path.dirname(dbPath), "resume-v1.pdf");
  const pdfV2Path = path.join(path.dirname(dbPath), "resume-v2.pdf");
  fs.writeFileSync(resumeV1Path, "Earlier approved resume text.");
  fs.writeFileSync(resumeV2Path, "Led platform reliability work.");
  fs.writeFileSync(pdfV1Path, "%PDF v1");
  fs.writeFileSync(pdfV2Path, "%PDF v2");

  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE job_materials_artifacts (
        job_url TEXT NOT NULL,
        generation INTEGER NOT NULL,
        artifact_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        status TEXT NOT NULL,
        path TEXT NOT NULL,
        render_format TEXT,
        created_at TEXT NOT NULL,
        size_bytes INTEGER,
        metadata_json TEXT
      );
    `);
    const insert = db.prepare(
      `INSERT INTO job_materials_artifacts (
         job_url, generation, artifact_id, artifact_type, status, path,
         render_format, created_at, size_bytes, metadata_json
       ) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, '{}')`,
    );
    insert.run(JOB_KEY, 1, "resume-text-v1", "tailored_resume", resumeV1Path, "text", NOW, 25);
    insert.run(JOB_KEY, 1, "resume-pdf-v1", "resume_pdf", pdfV1Path, "legacy_pdf", NOW, 7);
    insert.run(JOB_KEY, 2, "resume-text-v2", "tailored_resume", resumeV2Path, "text", NOW, 31);
    insert.run(JOB_KEY, 2, "resume-pdf-v2", "resume_pdf", pdfV2Path, "html_pdf", NOW, 7);
  } finally {
    db.close();
  }
}
