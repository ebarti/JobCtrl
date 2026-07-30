import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  createOrLoadResumeReviewDraft,
  renderResumeReviewDraft,
  saveResumeReviewDraftRevision,
} from "../src/resume-review-drafts.js";
import type { ResumeHtmlPdfRenderer } from "../src/resume-pdf-render.js";
import {
  BUILT_IN_RESUME_TEMPLATE_THEME,
  createResumeTemplateVersion,
  ensureCurrentResumeTemplateMaterials,
  setDefaultResumeTemplate,
  templateMetadataForMaterial,
  templateMetadataPayload,
} from "../src/resume-templates.js";
import { jobReferencePredicateForUrl } from "../src/db.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

const UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111";
const URL_OWNER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const ID_TEXT_OWNER_URL = "https://example.com/jobs/id-text-owner";

function createStableMaterialsSchema(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.pragma("user_version = 15");
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      title TEXT,
      company TEXT,
      application_url TEXT,
      discovered_at TEXT,
      apply_status TEXT,
      apply_error TEXT,
      applied_at TEXT,
      UNIQUE (tenant_id, job_id)
    );
    CREATE TABLE job_materials (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_validation_json TEXT,
      last_verdict_json TEXT,
      metadata_json TEXT,
      PRIMARY KEY (tenant_id, job_id, generation),
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
    CREATE TABLE job_materials_artifacts (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      artifact_type TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      status TEXT NOT NULL,
      path TEXT NOT NULL,
      render_format TEXT NOT NULL,
      size_bytes INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      superseded_at TEXT,
      PRIMARY KEY (tenant_id, job_id, generation, artifact_type),
      FOREIGN KEY (tenant_id, job_id, generation)
        REFERENCES job_materials(tenant_id, job_id, generation)
        ON DELETE CASCADE
    );
    CREATE TABLE job_material_layout_boxes (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      artifact_id TEXT NOT NULL,
      box_index INTEGER NOT NULL,
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
      PRIMARY KEY (
        tenant_id, job_id, generation, artifact_id, box_index
      ),
      FOREIGN KEY (tenant_id, job_id, generation)
        REFERENCES job_materials(tenant_id, job_id, generation)
        ON DELETE CASCADE
    );
    CREATE TABLE job_bullet_provenance (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      bullet_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      section TEXT NOT NULL,
      source_id TEXT,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      requirement_ids_json TEXT NOT NULL DEFAULT '[]',
      matched_keywords_json TEXT NOT NULL DEFAULT '[]',
      transform_type TEXT NOT NULL,
      control TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      generated_text TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      coverage_json TEXT,
      voice_json TEXT,
      PRIMARY KEY (tenant_id, job_id, generation, bullet_id),
      FOREIGN KEY (tenant_id, job_id, generation)
        REFERENCES job_materials(tenant_id, job_id, generation)
        ON DELETE CASCADE
    );
  `);
}

function seedJobAndMaterials(
  db: Database.Database,
  input: {
    url: string;
    jobId: string;
    artifactPrefix: string;
    artifactPath?: string;
  },
): void {
  const {
    url,
    jobId,
    artifactPrefix,
    artifactPath = `/tmp/${input.artifactPrefix}.txt`,
  } = input;
  const now = "2026-07-29T10:00:00.000Z";
  db.prepare(
    `INSERT INTO jobs (url, tenant_id, job_id, title, company)
     VALUES (?, 'local', ?, 'Platform Engineer', 'Example')`,
  ).run(url, jobId);
  db.prepare(
    `INSERT INTO job_materials (
       tenant_id, job_id, generation, status, created_at, updated_at,
       last_validation_json, last_verdict_json, metadata_json
     ) VALUES ('local', ?, 1, 'resume_approved', ?, ?, '{}', '{}', ?)`,
  ).run(
    jobId,
    now,
    now,
    JSON.stringify({
      resume_template: {
        templateId: "built_in:modern-html",
        templateVersionId: "built_in:modern-html:v1",
        templateVersionNumber: 1,
        templateName: "Modern HTML",
        templateHash: "seed-hash",
        assignmentSource: "built_in",
      },
    }),
  );
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       tenant_id, job_id, generation, artifact_type, artifact_id, status,
       path, render_format, size_bytes, metadata_json, created_at
     ) VALUES ('local', ?, 1, 'tailored_resume', ?, 'approved', ?,
               'text', 10, '{}', ?)`,
  ).run(jobId, `${artifactPrefix}-text`, artifactPath, now);
  db.prepare(
    `INSERT INTO job_material_layout_boxes (
       tenant_id, job_id, generation, artifact_id, box_index, semantic_id,
       page_number, line_number, text_excerpt, left_pct, top_pct, width_pct,
       height_pct, audit_target_json, created_at
     ) VALUES ('local', ?, 1, ?, 0, 'line:1', 1, 1, 'Platform Engineer',
               1, 2, 3, 4, '{}', ?)`,
  ).run(jobId, `${artifactPrefix}-text`, now);
  db.prepare(
    `INSERT INTO job_bullet_provenance (
       tenant_id, job_id, generation, bullet_id, artifact_id, section,
       transform_type, control, generated_text, created_at
     ) VALUES ('local', ?, 1, 'bullet:1', ?, 'experience', 'unchanged',
               'preserve', 'Platform Engineer', ?)`,
  ).run(jobId, `${artifactPrefix}-text`, now);
}

describe("schema-v15 generated-material writes", () => {
  it("permanently deletes only the UUID-shaped URL owner's material graph", () => {
    const db = new Database(":memory:");
    createStableMaterialsSchema(db);
    seedJobAndMaterials(
      db,
      {
        url: UUID_SHAPED_URL,
        jobId: URL_OWNER_JOB_ID,
        artifactPrefix: "url-owner",
      },
    );
    seedJobAndMaterials(
      db,
      {
        url: ID_TEXT_OWNER_URL,
        jobId: UUID_SHAPED_URL,
        artifactPrefix: "id-owner",
      },
    );

    expect(
      jobReferencePredicateForUrl(
        db,
        "job_materials_artifacts",
        UUID_SHAPED_URL,
      ),
    ).toEqual({
      sql: "tenant_id = ? AND job_id = ?",
      params: ["local", URL_OWNER_JOB_ID],
    });

    expect(permanentlyDeleteJob(db, UUID_SHAPED_URL)).toEqual({
      ok: true,
      count: 1,
      jobKeys: [UUID_SHAPED_URL],
    });
    expect(
      db.prepare("SELECT url FROM jobs ORDER BY url").all(),
    ).toEqual([{ url: ID_TEXT_OWNER_URL }]);
    for (const tableName of [
      "job_materials",
      "job_materials_artifacts",
      "job_material_layout_boxes",
      "job_bullet_provenance",
    ]) {
      expect(
        db.prepare(
          `SELECT DISTINCT job_id FROM ${tableName}`,
        ).all(),
      ).toEqual([{ job_id: UUID_SHAPED_URL }]);
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("promotes an edited resume into a new stable-ID material generation", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jobctrl-materials-v15-review-"),
    );
    const resumePath = path.join(tempDir, "resume.txt");
    fs.writeFileSync(resumePath, "Jordan Candidate\nExperience\nLed platform work.");
    const db = new Database(":memory:");
    createStableMaterialsSchema(db);
    seedJobAndMaterials(
      db,
      {
        url: UUID_SHAPED_URL,
        jobId: URL_OWNER_JOB_ID,
        artifactPrefix: "base",
        artifactPath: resumePath,
      },
    );
    const renderPdf: ResumeHtmlPdfRenderer = ({ htmlPath, pdfPath }) => {
      fs.writeFileSync(
        pdfPath,
        `%PDF-1.4 rendered\n${fs.readFileSync(htmlPath, "utf8")}`,
      );
    };
    const currentTemplate = templateMetadataForMaterial(
      db,
      UUID_SHAPED_URL,
    );
    db.prepare(
      `UPDATE job_materials
          SET metadata_json = ?
        WHERE tenant_id = 'local' AND job_id = ? AND generation = 1`,
    ).run(
      JSON.stringify({
        resume_template: templateMetadataPayload(currentTemplate),
      }),
      URL_OWNER_JOB_ID,
    );

    const created = createOrLoadResumeReviewDraft(
      db,
      UUID_SHAPED_URL,
      {},
      renderPdf,
    );
    const saved = saveResumeReviewDraftRevision(
      db,
      created.draft.draftId,
      {
        editedText: [
          "Jordan Candidate",
          "Experience",
          "Led platform reliability across critical services.",
        ].join("\n"),
        editDeltas: [],
      },
    );
    const rendered = renderResumeReviewDraft(
      db,
      created.draft.draftId,
      { draftRevisionId: saved.revision.revisionId },
      renderPdf,
    );

    expect(rendered.ok).toBe(true);
    expect(
      db.prepare(
        `SELECT generation, job_id
           FROM job_materials
          ORDER BY generation`,
      ).all(),
    ).toEqual([
      { generation: 1, job_id: URL_OWNER_JOB_ID },
      { generation: 2, job_id: URL_OWNER_JOB_ID },
    ]);
    expect(
      db.prepare(
        `SELECT artifact_type, job_id
           FROM job_materials_artifacts
          WHERE generation = 2
          ORDER BY artifact_type`,
      ).all(),
    ).toEqual([
      { artifact_type: "resume_pdf", job_id: URL_OWNER_JOB_ID },
      { artifact_type: "tailored_resume", job_id: URL_OWNER_JOB_ID },
    ]);
    expect(
      db.prepare(
        `SELECT DISTINCT job_id
           FROM job_material_layout_boxes
          WHERE generation = 2`,
      ).all(),
    ).toEqual([{ job_id: URL_OWNER_JOB_ID }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("refreshes a resume template into stable-ID material and layout rows", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jobctrl-materials-v15-template-"),
    );
    const resumePath = path.join(tempDir, "resume.txt");
    fs.writeFileSync(resumePath, "Jordan Candidate\nExperience\nLed platform work.");
    const db = new Database(":memory:");
    createStableMaterialsSchema(db);
    seedJobAndMaterials(
      db,
      {
        url: UUID_SHAPED_URL,
        jobId: URL_OWNER_JOB_ID,
        artifactPrefix: "base",
        artifactPath: resumePath,
      },
    );
    const saved = createResumeTemplateVersion(db, {
      displayName: "Stable-ID serif",
      theme: {
        ...BUILT_IN_RESUME_TEMPLATE_THEME,
        fontFamily: "serif",
      },
      layout: {},
    });
    setDefaultResumeTemplate(db, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });
    const renderPdf: ResumeHtmlPdfRenderer = ({ htmlPath, pdfPath }) => {
      fs.writeFileSync(
        pdfPath,
        `%PDF-1.4 rendered\n${fs.readFileSync(htmlPath, "utf8")}`,
      );
    };

    const refreshed = ensureCurrentResumeTemplateMaterials(
      db,
      UUID_SHAPED_URL,
      {},
      renderPdf,
    );

    expect(refreshed).toMatchObject({
      ok: true,
      status: "completed",
      generation: 2,
    });
    expect(
      db.prepare(
        `SELECT DISTINCT job_id
           FROM job_materials
          WHERE generation = 2`,
      ).all(),
    ).toEqual([{ job_id: URL_OWNER_JOB_ID }]);
    expect(
      db.prepare(
        `SELECT DISTINCT job_id
           FROM job_materials_artifacts
          WHERE generation = 2`,
      ).all(),
    ).toEqual([{ job_id: URL_OWNER_JOB_ID }]);
    expect(
      db.prepare(
        `SELECT DISTINCT job_id
           FROM job_material_layout_boxes
          WHERE generation = 2`,
      ).all(),
    ).toEqual([{ job_id: URL_OWNER_JOB_ID }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
