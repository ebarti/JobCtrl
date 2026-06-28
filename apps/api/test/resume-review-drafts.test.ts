import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureResumeReviewTables,
} from "../src/resume-review-drafts.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
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

  it("creates a draft from legacy artifact tables without render_format", async () => {
    const db = new Database(options.dbPath);
    try {
      db.exec(`
        ALTER TABLE job_materials_artifacts RENAME TO job_materials_artifacts_with_render_format;
        CREATE TABLE job_materials_artifacts (
          job_url TEXT NOT NULL,
          generation INTEGER NOT NULL,
          artifact_id TEXT NOT NULL,
          artifact_type TEXT NOT NULL,
          status TEXT NOT NULL,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          size_bytes INTEGER,
          metadata_json TEXT,
          superseded_at TEXT,
          PRIMARY KEY (job_url, generation, artifact_type)
        );
        INSERT INTO job_materials_artifacts (
          job_url, generation, artifact_id, artifact_type, status, path,
          created_at, size_bytes, metadata_json, superseded_at
        )
        SELECT job_url, generation, artifact_id, artifact_type, status, path,
               created_at, size_bytes, metadata_json, superseded_at
          FROM job_materials_artifacts_with_render_format;
        DROP TABLE job_materials_artifacts_with_render_format;
      `);
    } finally {
      db.close();
    }

    const app = buildApp(options);
    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(JOB_KEY)}/resume-review/draft`,
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().draft).toMatchObject({
      jobKey: JOB_KEY,
      baseGeneration: 2,
      baseResumeTextArtifactId: "resume-text-v2",
      baseResumePdfArtifactId: "resume-pdf-v2",
      rendererFormat: "unknown",
    });

    await app.close();
  });

  it("does not create a current draft when lazy template refresh is unavailable", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare("DELETE FROM job_materials_artifacts WHERE artifact_type = 'tailored_resume'").run();
    } finally {
      db.close();
    }

    const app = buildApp(options);
    const saveTemplateResponse = await app.inject({
      method: "POST",
      url: "/v1/resume-templates",
      payload: {
        displayName: "Style-only refresh gate",
        theme: {
          ...BUILT_IN_RESUME_TEMPLATE_THEME,
          fontFamily: "serif",
        },
        layout: {},
      },
    });
    expect(saveTemplateResponse.statusCode, saveTemplateResponse.body).toBe(200);
    const savedTemplate = saveTemplateResponse.json().template;
    const defaultResponse = await app.inject({
      method: "PATCH",
      url: "/v1/resume-templates/default",
      payload: {
        templateId: savedTemplate.templateId,
        versionId: savedTemplate.activeVersion.versionId,
      },
    });
    expect(defaultResponse.statusCode, defaultResponse.body).toBe(200);

    const draftResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(JOB_KEY)}/resume-review/draft`,
      payload: {},
    });

    expect(draftResponse.statusCode, draftResponse.body).toBe(404);
    expect(draftResponse.json()).toMatchObject({
      ok: false,
      error: "not_found",
      message: "Latest accepted resume has no reusable text source for render-only refresh.",
    });

    const verifyDb = new Database(options.dbPath);
    try {
      const draftCount = verifyDb
        .prepare("SELECT COUNT(*) AS count FROM resume_review_drafts")
        .get() as { count: number };
      const artifactRows = verifyDb
        .prepare("SELECT artifact_id, status FROM job_materials_artifacts ORDER BY artifact_id")
        .all() as Array<{ artifact_id: string; status: string }>;
      expect(draftCount.count).toBe(0);
      expect(artifactRows).toEqual([
        { artifact_id: "resume-pdf-v1", status: "approved" },
        { artifact_id: "resume-pdf-v2", status: "approved" },
      ]);
    } finally {
      verifyDb.close();
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

  it("seeds comment threads idempotently and marks edited anchors as superseded", async () => {
    const app = buildApp(options);
    const createResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(JOB_KEY)}/resume-review/draft`,
      payload: {},
    });
    const draftId = createResponse.json().draft.draftId as string;

    const seedPayload = {
      threads: [
        {
          baseArtifactId: "resume-text-v2",
          semanticId: "experience:acme:bullet:1",
          lineAnchor: {
            semanticId: "experience:acme:bullet:1",
            lineNumber: 6,
            pageNumber: 1,
            textHash: "hash-before",
          },
          sourcePinId: "pin-experience-1",
          riskLabel: "claim risk",
          commentBody: "Check the quantified reliability claim against profile evidence.",
        },
      ],
    };
    const seedResponse = await app.inject({
      method: "POST",
      url: `/v1/resume-review/drafts/${encodeURIComponent(draftId)}/comment-threads`,
      payload: seedPayload,
    });
    expect(seedResponse.statusCode, seedResponse.body).toBe(200);
    expect(seedResponse.json()).toMatchObject({
      seededCount: 1,
      updatedCount: 0,
      commentThreads: [
        {
          state: "open",
          riskLabel: "claim risk",
          sourcePinId: "pin-experience-1",
          anchorResolved: true,
        },
      ],
    });

    const repeatSeedResponse = await app.inject({
      method: "POST",
      url: `/v1/resume-review/drafts/${encodeURIComponent(draftId)}/comment-threads`,
      payload: seedPayload,
    });
    expect(repeatSeedResponse.statusCode, repeatSeedResponse.body).toBe(200);
    expect(repeatSeedResponse.json()).toMatchObject({
      seededCount: 0,
      updatedCount: 1,
    });

    const saveResponse = await app.inject({
      method: "POST",
      url: `/v1/resume-review/drafts/${encodeURIComponent(draftId)}/revisions`,
      payload: {
        editedText: "Led platform reliability work across 3 critical services.",
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
    expect(saveResponse.statusCode, saveResponse.body).toBe(200);
    expect(saveResponse.json().draft.commentThreads).toMatchObject([
      {
        state: "superseded_by_edit",
        anchorResolved: true,
        semanticId: "experience:acme:bullet:1",
      },
    ]);
    expect(JSON.stringify(saveResponse.json())).not.toContain(tempDir);

    await app.close();
  });

  it("rejects invalid edited drafts without creating replacement artifacts", async () => {
    const app = buildApp(options);
    const createResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(JOB_KEY)}/resume-review/draft`,
      payload: {},
    });
    const draftId = createResponse.json().draft.draftId as string;
    const saveResponse = await app.inject({
      method: "POST",
      url: `/v1/resume-review/drafts/${encodeURIComponent(draftId)}/revisions`,
      payload: {
        editedText: "One line only",
        editDeltas: [],
      },
    });
    expect(saveResponse.statusCode, saveResponse.body).toBe(200);

    const renderResponse = await app.inject({
      method: "POST",
      url: `/v1/resume-review/drafts/${encodeURIComponent(draftId)}/render`,
      payload: {},
    });
    expect(renderResponse.statusCode, renderResponse.body).toBe(200);
    expect(renderResponse.json()).toMatchObject({
      ok: false,
      error: "resume_review_draft_invalid",
      validation: {
        passed: false,
      },
      draft: {
        state: "active",
      },
    });
    expect(renderResponse.json().validation.errors).toContain(
      "Edited resume text needs at least three non-empty lines before rendering.",
    );

    const db = new Database(options.dbPath);
    try {
      const artifactCount = db
        .prepare("SELECT COUNT(*) AS count FROM job_materials_artifacts")
        .get() as { count: number };
      expect(artifactCount.count).toBe(4);
    } finally {
      db.close();
    }

    await app.close();
  });

  it("renders valid edited drafts into a promoted replacement generation with layout boxes", async () => {
    const app = buildApp(options);
    const createResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(JOB_KEY)}/resume-review/draft`,
      payload: {},
    });
    const draftId = createResponse.json().draft.draftId as string;
    const saveResponse = await app.inject({
      method: "POST",
      url: `/v1/resume-review/drafts/${encodeURIComponent(draftId)}/revisions`,
      payload: {
        editedText: [
          "Eloi Example",
          "Experience",
          "- Led platform reliability work across 3 critical services.",
          "Skills",
          "- TypeScript, Python, Temporal",
        ].join("\n"),
        plateDocument: [{ type: "p", children: [{ text: "Eloi Example" }] }],
        editDeltas: [
          {
            kind: "replace_text",
            section: "experience",
            beforeText: "Led platform reliability work.",
            afterText: "Led platform reliability work across 3 critical services.",
          },
        ],
      },
    });
    expect(saveResponse.statusCode, saveResponse.body).toBe(200);
    const revisionId = saveResponse.json().revision.revisionId as string;

    const renderResponse = await app.inject({
      method: "POST",
      url: `/v1/resume-review/drafts/${encodeURIComponent(draftId)}/render`,
      payload: { draftRevisionId: revisionId },
    });
    expect(renderResponse.statusCode, renderResponse.body).toBe(200);
    const body = renderResponse.json();
    expect(body).toMatchObject({
      ok: true,
      draft: {
        state: "promoted",
      },
      artifacts: {
        resumeText: {
          artifactType: "tailored_resume",
          generation: 3,
          renderFormat: "text",
        },
        resumePdf: {
          artifactType: "resume_pdf",
          generation: 3,
          renderFormat: "html_pdf",
        },
      },
      validation: {
        passed: true,
      },
      layoutBoxCount: 5,
    });
    expect(JSON.stringify(body)).not.toContain(tempDir);

    const db = new Database(options.dbPath);
    try {
      const artifacts = db
        .prepare(
          `SELECT generation, artifact_id, artifact_type, status, path, render_format, metadata_json
             FROM job_materials_artifacts
            WHERE job_url = ?
            ORDER BY generation, artifact_type`,
        )
        .all(JOB_KEY) as Array<{
        artifact_id: string;
        artifact_type: string;
        generation: number;
        metadata_json: string | null;
        path: string;
        render_format: string;
        status: string;
      }>;
      expect(artifacts.filter((artifact) => artifact.generation < 3).every((artifact) => artifact.status === "approved")).toBe(
        true,
      );
      const replacementPdf = artifacts.find((artifact) => artifact.artifact_id === body.artifacts.resumePdf.artifactId);
      const replacementText = artifacts.find((artifact) => artifact.artifact_id === body.artifacts.resumeText.artifactId);
      expect(replacementPdf).toMatchObject({
        artifact_type: "resume_pdf",
        generation: 3,
        render_format: "html_pdf",
        status: "approved",
      });
      expect(replacementText).toMatchObject({
        artifact_type: "tailored_resume",
        generation: 3,
        render_format: "text",
        status: "approved",
      });
      expect(replacementPdf?.metadata_json).toContain("html_path");
      const replacementPdfMetadata = JSON.parse(replacementPdf?.metadata_json ?? "{}") as { html_path?: string };
      const replacementHtml = fs.readFileSync(replacementPdfMetadata.html_path ?? "", "utf8");
      expect(replacementHtml).toContain('class="resume-page"');
      expect(replacementHtml).toContain('class="resume-name"');
      expect(replacementHtml).toContain('class="resume-section-title"');
      expect(replacementHtml).not.toContain('class="resume-document"');
      expect(replacementPdf?.path.endsWith(".pdf")).toBe(true);
      expect(replacementText?.path.endsWith(".txt")).toBe(true);
      expect(fs.existsSync(replacementPdf?.path ?? "")).toBe(true);
      expect(fs.existsSync(replacementText?.path ?? "")).toBe(true);

      const boxes = db
        .prepare("SELECT semantic_id, line_number, text_excerpt FROM job_material_layout_boxes WHERE artifact_id = ?")
        .all(body.artifacts.resumePdf.artifactId) as Array<{
        line_number: number;
        semantic_id: string;
        text_excerpt: string;
      }>;
      expect(boxes).toHaveLength(5);
      expect(boxes[2]).toMatchObject({
        semantic_id: "edited:line:3",
        line_number: 3,
        text_excerpt: "- Led platform reliability work across 3 critical services.",
      });
    } finally {
      db.close();
    }

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
      CREATE TABLE job_materials (
        job_url TEXT NOT NULL,
        generation INTEGER NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_validation_json TEXT,
        last_verdict_json TEXT,
        metadata_json TEXT,
        PRIMARY KEY (job_url, generation)
      );
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
        metadata_json TEXT,
        superseded_at TEXT,
        PRIMARY KEY (job_url, generation, artifact_type)
      );
      CREATE TABLE job_material_layout_boxes (
        job_url TEXT NOT NULL,
        generation INTEGER NOT NULL,
        artifact_id TEXT NOT NULL,
        box_index INTEGER NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        semantic_id TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        line_number INTEGER,
        text_excerpt TEXT NOT NULL,
        left_pct REAL NOT NULL,
        top_pct REAL NOT NULL,
        width_pct REAL NOT NULL,
        height_pct REAL NOT NULL,
        audit_target_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_url, generation, artifact_id, box_index)
      );
    `);
    db.prepare(
      `INSERT INTO job_materials (
         job_url, generation, tenant_id, status, created_at, updated_at,
         last_validation_json, last_verdict_json, metadata_json
       ) VALUES (?, ?, 'local', 'resume_approved', ?, ?, '{}', '{}', '{}')`,
    ).run(JOB_KEY, 1, NOW, NOW);
    db.prepare(
      `INSERT INTO job_materials (
         job_url, generation, tenant_id, status, created_at, updated_at,
         last_validation_json, last_verdict_json, metadata_json
       ) VALUES (?, ?, 'local', 'resume_approved', ?, ?, '{}', '{}', '{}')`,
    ).run(JOB_KEY, 2, NOW, NOW);
    const insert = db.prepare(
      `INSERT INTO job_materials_artifacts (
         job_url, generation, artifact_id, artifact_type, status, path,
         render_format, created_at, size_bytes, metadata_json, superseded_at
       ) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, '{}', NULL)`,
    );
    insert.run(JOB_KEY, 1, "resume-text-v1", "tailored_resume", resumeV1Path, "text", NOW, 25);
    insert.run(JOB_KEY, 1, "resume-pdf-v1", "resume_pdf", pdfV1Path, "legacy_pdf", NOW, 7);
    insert.run(JOB_KEY, 2, "resume-text-v2", "tailored_resume", resumeV2Path, "text", NOW, 31);
    insert.run(JOB_KEY, 2, "resume-pdf-v2", "resume_pdf", pdfV2Path, "html_pdf", NOW, 7);
  } finally {
    db.close();
  }
}
