import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUILT_IN_RESUME_TEMPLATE_THEME,
  createResumeTemplateVersion,
  ensureCurrentResumeTemplateMaterials,
  ensureResumeTemplateTables,
  getResumeTemplateDetail,
  listResumeTemplates,
  resolveCurrentResumeArtifactIdForOpen,
  ResumeTemplateInputError,
  setDefaultResumeTemplate,
  setJobResumeTemplateAssignment,
} from "../src/resume-templates.js";
import type { ResumeHtmlPdfRenderer } from "../src/resume-pdf-render.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

const JOB_KEY = "https://example.com/jobs/template-engineer";
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const UUID_URL_OWNER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-06-24T10:00:00.000Z";

// Stand-in for the Playwright HTML-to-PDF subprocess: it renders the exact HTML
// the refresh built, so tests inspect the full resume content instead of spawning
// a browser.
const renderHtmlToPdf: ResumeHtmlPdfRenderer = ({ htmlPath, pdfPath }) => {
  fs.writeFileSync(pdfPath, `%PDF-1.4 rendered\n${fs.readFileSync(htmlPath, "utf8")}`);
};

let tempDir = "";
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-resume-template-"));
  db = new Database(path.join(tempDir, "jobctrl.db"));
  seedDatabase(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("resume template service", () => {
  it("saves style-only template versions, default selection, and per-job overrides", () => {
    ensureResumeTemplateTables(db);
    const initial = listResumeTemplates(db);
    expect(initial.templates).toHaveLength(1);
    expect(initial.templates[0]).toMatchObject({ builtIn: true, displayName: "Modern HTML" });

    const saved = createResumeTemplateVersion(db, {
      displayName: "Compact Garamond",
      theme: {
        ...BUILT_IN_RESUME_TEMPLATE_THEME,
        fontFamily: "garamond",
        density: "compact",
        accentColor: "#222222",
      },
      layout: {},
    });
    expect(saved.template).toMatchObject({ displayName: "Compact Garamond", builtIn: false });
    expect(getResumeTemplateDetail(db, saved.template.templateId)?.template.activeVersion.versionId).toBe(
      saved.template.activeVersion.versionId,
    );

    const selectedDefault = setDefaultResumeTemplate(db, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });
    expect(selectedDefault.defaultTemplate).toMatchObject({
      assignmentSource: "profile_default",
      templateId: saved.template.templateId,
    });

    const assignment = setJobResumeTemplateAssignment(db, JOB_KEY, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });
    expect(assignment.overrideTemplate).toMatchObject({
      assignmentSource: "job_override",
      templateId: saved.template.templateId,
    });
    expect(assignment.templateState?.state).toBe("template_stale");
  });

  it("returns the exact pinned default version when a newer version exists", () => {
    const first = createResumeTemplateVersion(db, {
      displayName: "Pinned template",
      theme: {
        ...BUILT_IN_RESUME_TEMPLATE_THEME,
        accentColor: "#123456",
        fontFamily: "georgia",
      },
      layout: {},
    }).template;
    const second = createResumeTemplateVersion(db, {
      templateId: first.templateId,
      displayName: "Pinned template",
      theme: {
        ...BUILT_IN_RESUME_TEMPLATE_THEME,
        accentColor: "#654321",
        fontFamily: "sans",
      },
      layout: {},
    }).template;

    setDefaultResumeTemplate(db, {
      templateId: first.templateId,
      versionId: first.activeVersion.versionId,
    });

    const listed = listResumeTemplates(db);
    expect(listed.templates.find((template) => template.templateId === first.templateId)?.activeVersion.versionId).toBe(
      second.activeVersion.versionId,
    );
    expect(listed.effectiveDefaultVersion).toMatchObject({
      versionId: first.activeVersion.versionId,
      theme: {
        accentColor: "#123456",
        fontFamily: "georgia",
      },
    });
  });

  it("rejects template payloads that contain profile or job facts", () => {
    expect(() =>
      createResumeTemplateVersion(db, {
        displayName: "Jordan Candidate",
        theme: BUILT_IN_RESUME_TEMPLATE_THEME,
        layout: {},
      }),
    ).toThrow(ResumeTemplateInputError);

    expect(() =>
      createResumeTemplateVersion(db, {
        displayName: "Globex Infrastructure",
        theme: BUILT_IN_RESUME_TEMPLATE_THEME,
        layout: {},
      }),
    ).toThrow(ResumeTemplateInputError);
  });

  it("lazily creates a render-only generation when the effective template changes", () => {
    const saved = createResumeTemplateVersion(db, {
      displayName: "Spacious serif",
      theme: {
        ...BUILT_IN_RESUME_TEMPLATE_THEME,
        fontFamily: "serif",
        density: "spacious",
        accentColor: "#333333",
      },
      layout: {},
    });
    setDefaultResumeTemplate(db, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });

    const refresh = ensureCurrentResumeTemplateMaterials(db, JOB_KEY, {}, renderHtmlToPdf);
    expect(refresh.status).toBe("completed");
    expect(refresh.generation).toBe(2);
    expect(refresh.templateState?.state).toBe("template_current");

    const materials = db
      .prepare("SELECT generation, status, metadata_json FROM job_materials ORDER BY generation")
      .all() as Array<{ generation: number; status: string; metadata_json: string }>;
    expect(materials.map((row) => ({ generation: row.generation, status: row.status }))).toEqual([
      { generation: 1, status: "resume_approved" },
      { generation: 2, status: "resume_approved" },
    ]);
    expect(materials[0]!.metadata_json).toContain("built_in:modern-html");
    expect(materials[1]!.metadata_json).toContain(saved.template.activeVersion.versionId);

    const artifacts = db
      .prepare("SELECT generation, artifact_type, artifact_id, status, path FROM job_materials_artifacts ORDER BY generation, artifact_type")
      .all() as Array<{ generation: number; artifact_type: string; artifact_id: string; status: string; path: string }>;
    expect(artifacts).toHaveLength(4);
    expect(artifacts.filter((row) => row.generation === 1).map((row) => row.status)).toEqual(["approved", "approved"]);
    const refreshedPdf = artifacts.find((row) => row.generation === 2 && row.artifact_type === "resume_pdf");
    expect(refreshedPdf?.artifact_id).toMatch(/^template_refresh_pdf_/);
    expect(refreshedPdf?.path && fs.existsSync(refreshedPdf.path)).toBe(true);

    const event = db
      .prepare("SELECT event_type, payload_json FROM job_events WHERE event_type = 'ResumeTemplateRefreshCompleted'")
      .get() as { event_type: string; payload_json: string } | undefined;
    expect(event?.payload_json).toContain(saved.template.activeVersion.versionId);
  });

  it("opens the refreshed resume artifact when a stale artifact id is requested", () => {
    const saved = createResumeTemplateVersion(db, {
      displayName: "Current open template",
      theme: {
        ...BUILT_IN_RESUME_TEMPLATE_THEME,
        fontScale: 1.08,
      },
      layout: {},
    });
    setDefaultResumeTemplate(db, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });

    const resolved = resolveCurrentResumeArtifactIdForOpen(db, "resume-pdf-v1", renderHtmlToPdf);
    expect(resolved).not.toBe("resume-pdf-v1");
    expect(resolved).toMatch(/^template_refresh_pdf_/);
  });

  it("reports refresh unavailable without hiding the last accepted artifact", () => {
    db.prepare("DELETE FROM job_materials_artifacts WHERE artifact_type = 'tailored_resume'").run();
    const saved = createResumeTemplateVersion(db, {
      displayName: "Unavailable refresh template",
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

    const refresh = ensureCurrentResumeTemplateMaterials(db, JOB_KEY, {}, renderHtmlToPdf);
    expect(refresh.status).toBe("unavailable");
    expect(refresh.generation).toBeNull();
    expect(refresh.templateState?.state).toBe("refresh_unavailable");

    const materials = db.prepare("SELECT generation, status FROM job_materials ORDER BY generation").all() as Array<{
      generation: number;
      status: string;
    }>;
    expect(materials).toEqual([{ generation: 1, status: "resume_approved" }]);
    const pdf = db
      .prepare("SELECT artifact_id, status FROM job_materials_artifacts WHERE artifact_type = 'resume_pdf'")
      .get() as { artifact_id: string; status: string } | undefined;
    expect(pdf).toEqual({ artifact_id: "resume-pdf-v1", status: "approved" });

    const event = db
      .prepare("SELECT payload_json FROM job_events WHERE event_type = 'ResumeTemplateRefreshFailed'")
      .get() as { payload_json: string } | undefined;
    expect(event?.payload_json).toContain("unavailable");
  });

  it("renders every line of a long resume across the refreshed PDF without truncation", () => {
    const longBullet =
      "- Drove a company-wide reliability program spanning ingestion, streaming, and storage tiers while mentoring a distributed platform and product engineering team.";
    const lines = ["Jordan Candidate", "Platform Engineering Leader", "Experience"];
    for (let index = 1; index <= 70; index += 1) {
      lines.push(
        index === 42 ? longBullet : `- Delivered measurable platform outcome number ${index} for critical services.`,
      );
    }
    fs.writeFileSync(path.join(tempDir, "resume-v1.txt"), lines.join("\n"));

    const saved = createResumeTemplateVersion(db, {
      displayName: "Long resume refresh",
      theme: { ...BUILT_IN_RESUME_TEMPLATE_THEME, fontFamily: "serif" },
      layout: {},
    });
    setDefaultResumeTemplate(db, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });

    const refresh = ensureCurrentResumeTemplateMaterials(db, JOB_KEY, {}, renderHtmlToPdf);
    expect(refresh.status).toBe("completed");

    const refreshedPdf = db
      .prepare("SELECT path FROM job_materials_artifacts WHERE artifact_type = 'resume_pdf' AND generation = ?")
      .get(refresh.generation) as { path: string } | undefined;
    const pdf = fs.readFileSync(refreshedPdf?.path ?? "", "utf8");
    expect(pdf).toContain("Delivered measurable platform outcome number 70 for critical services.");
    expect(pdf).toContain(longBullet.replace(/^- /, ""));
    expect(pdf.length).toBeGreaterThan(longBullet.length);
    // The deleted hand-rolled writer emitted a fixed single-page text stream.
    expect(pdf).not.toContain("72 750 Td");
  });

  it("keeps the last accepted resume artifact when the PDF render fails", () => {
    const saved = createResumeTemplateVersion(db, {
      displayName: "Failing render template",
      theme: { ...BUILT_IN_RESUME_TEMPLATE_THEME, fontFamily: "serif" },
      layout: {},
    });
    setDefaultResumeTemplate(db, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });

    const failingRenderer: ResumeHtmlPdfRenderer = () => {
      throw new Error("chromium unavailable");
    };
    const refresh = ensureCurrentResumeTemplateMaterials(db, JOB_KEY, {}, failingRenderer);
    expect(refresh.status).toBe("failed");
    expect(refresh.generation).toBeNull();
    expect(refresh.templateState?.state).toBe("refresh_failed");

    const materials = db
      .prepare("SELECT generation FROM job_materials ORDER BY generation")
      .all() as Array<{ generation: number }>;
    expect(materials).toEqual([{ generation: 1 }]);
    const pdf = db
      .prepare("SELECT artifact_id, status FROM job_materials_artifacts WHERE artifact_type = 'resume_pdf'")
      .get() as { artifact_id: string; status: string } | undefined;
    expect(pdf).toEqual({ artifact_id: "resume-pdf-v1", status: "approved" });

    const failedEvent = db
      .prepare("SELECT payload_json FROM job_events WHERE event_type = 'ResumeTemplateRefreshFailed'")
      .get() as { payload_json: string } | undefined;
    expect(failedEvent?.payload_json).toContain("failed");
  });

  it("persists v17 assignments and refresh attempts by stable JobId", () => {
    upgradeJobFixtureToV17(db);
    const saved = createResumeTemplateVersion(db, {
      displayName: "Stable identity template",
      theme: {
        ...BUILT_IN_RESUME_TEMPLATE_THEME,
        fontFamily: "serif",
      },
      layout: {},
    });

    setJobResumeTemplateAssignment(db, JOB_KEY, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });
    const refresh = ensureCurrentResumeTemplateMaterials(
      db,
      JOB_KEY,
      {},
      renderHtmlToPdf,
    );

    expect(refresh.status).toBe("completed");
    expect(refresh.attempt?.jobKey).toBe(JOB_KEY);
    expect(
      db.prepare(
        "SELECT job_id FROM job_resume_template_assignments",
      ).get(),
    ).toEqual({ job_id: JOB_ID });
    expect(
      db.prepare(
        "SELECT DISTINCT job_id FROM resume_template_refresh_attempts",
      ).all(),
    ).toEqual([{ job_id: JOB_ID }]);
    expect(
      db.prepare(
        "SELECT name FROM pragma_table_info('job_resume_template_assignments')",
      ).all(),
    ).toContainEqual({ name: "job_id" });
  });

  it("assigns a UUID-shaped posting URL to its URL owner", () => {
    upgradeJobFixtureToV17(db);
    db.prepare(
      `INSERT INTO jobs (
         url, tenant_id, job_id, title, company, discovered_at
       ) VALUES (?, 'local', ?, 'URL owner', 'Example', ?)`,
    ).run(JOB_ID, UUID_URL_OWNER_JOB_ID, NOW);
    const saved = createResumeTemplateVersion(db, {
      displayName: "Slate serif",
      theme: {
        ...BUILT_IN_RESUME_TEMPLATE_THEME,
        fontFamily: "serif",
      },
      layout: {},
    });

    setJobResumeTemplateAssignment(db, JOB_ID, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });

    expect(
      db.prepare(
        "SELECT job_id FROM job_resume_template_assignments",
      ).all(),
    ).toEqual([{ job_id: UUID_URL_OWNER_JOB_ID }]);
  });

  it("permanently deletes stable template configuration without FK cascades", () => {
    upgradeJobFixtureToV17(db);
    db.pragma("foreign_keys = OFF");
    const saved = createResumeTemplateVersion(db, {
      displayName: "Delete template",
      theme: {
        ...BUILT_IN_RESUME_TEMPLATE_THEME,
        fontFamily: "serif",
      },
      layout: {},
    });
    setJobResumeTemplateAssignment(db, JOB_KEY, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });
    ensureCurrentResumeTemplateMaterials(
      db,
      JOB_KEY,
      {},
      renderHtmlToPdf,
    );

    expect(permanentlyDeleteJob(db, JOB_KEY)).toMatchObject({
      ok: true,
      count: 1,
    });

    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM job_resume_template_assignments",
      ).get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM resume_template_refresh_attempts",
      ).get(),
    ).toEqual({ count: 0 });
  });
});

function upgradeJobFixtureToV17(database: Database.Database): void {
  database.exec(`
    ALTER TABLE jobs
      ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE jobs ADD COLUMN job_id TEXT;
  `);
  database.prepare(
    "UPDATE jobs SET job_id = ? WHERE url = ?",
  ).run(JOB_ID, JOB_KEY);
  database.exec(`
    CREATE UNIQUE INDEX idx_jobs_tenant_job_id_template_fixture
      ON jobs(tenant_id, job_id);
    PRAGMA user_version = 17;
  `);
}

function seedDatabase(database: Database.Database): void {
  const resumePath = path.join(tempDir, "resume-v1.txt");
  const pdfPath = path.join(tempDir, "resume-v1.pdf");
  fs.writeFileSync(
    resumePath,
    [
      "Jordan Candidate",
      "Platform Engineering Leader",
      "Experience",
      "- Led platform reliability improvements across critical services.",
    ].join("\n"),
  );
  fs.writeFileSync(pdfPath, "%PDF-1.4\n% template test\n");
  database.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      title TEXT,
      company TEXT,
      application_url TEXT,
      discovered_at TEXT
    );
    CREATE TABLE candidate_profiles (
      tenant_id TEXT,
      profile_id TEXT,
      personal_full_name TEXT,
      personal_email TEXT,
      personal_phone TEXT,
      personal_linkedin_url TEXT,
      personal_github_url TEXT,
      personal_portfolio_url TEXT,
      personal_website_url TEXT,
      PRIMARY KEY (tenant_id, profile_id)
    );
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      stage TEXT,
      event_type TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT
    );
    CREATE TABLE job_materials (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      tenant_id TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      last_validation_json TEXT,
      last_verdict_json TEXT,
      metadata_json TEXT,
      PRIMARY KEY (job_url, generation)
    );
    CREATE TABLE job_materials_artifacts (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      artifact_type TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      status TEXT,
      path TEXT,
      render_format TEXT,
      size_bytes INTEGER,
      metadata_json TEXT,
      created_at TEXT,
      superseded_at TEXT,
      PRIMARY KEY (job_url, generation, artifact_id)
    );
    CREATE TABLE job_material_layout_boxes (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      artifact_id TEXT NOT NULL,
      box_index INTEGER NOT NULL,
      tenant_id TEXT,
      semantic_id TEXT,
      page_number INTEGER,
      line_number INTEGER,
      text_excerpt TEXT,
      left_pct REAL,
      top_pct REAL,
      width_pct REAL,
      height_pct REAL,
      audit_target_json TEXT,
      created_at TEXT,
      PRIMARY KEY (job_url, generation, artifact_id, box_index)
    );
  `);
  database
    .prepare("INSERT INTO jobs (url, title, company, application_url, discovered_at) VALUES (?, ?, ?, ?, ?)")
    .run(JOB_KEY, "Senior Platform Engineer", "Globex Infrastructure", "https://apply.example.com/globex", NOW);
  database
    .prepare(
      `INSERT INTO candidate_profiles (
         tenant_id, profile_id, personal_full_name, personal_email
       ) VALUES ('local', 'default', ?, ?)`,
    )
    .run("Jordan Candidate", "jordan@example.com");
  database
    .prepare(
      `INSERT INTO job_materials (
         job_url, generation, tenant_id, status, created_at, updated_at,
         last_validation_json, last_verdict_json, metadata_json
       ) VALUES (?, 1, 'local', 'resume_approved', ?, ?, ?, ?, ?)`,
    )
    .run(
      JOB_KEY,
      NOW,
      NOW,
      JSON.stringify({ passed: true, errors: [], warnings: [] }),
      JSON.stringify({ approved: true }),
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
  database
    .prepare(
      `INSERT INTO job_materials_artifacts (
         job_url, generation, artifact_type, artifact_id, status, path, render_format,
         size_bytes, metadata_json, created_at, superseded_at
       ) VALUES (?, 1, ?, ?, 'approved', ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      JOB_KEY,
      "tailored_resume",
      "resume-text-v1",
      resumePath,
      "text",
      fs.statSync(resumePath).size,
      JSON.stringify({ resume_template: { templateId: "built_in:modern-html", templateVersionId: "built_in:modern-html:v1", templateVersionNumber: 1, templateName: "Modern HTML", templateHash: "seed-hash", assignmentSource: "built_in" } }),
      NOW,
    );
  database
    .prepare(
      `INSERT INTO job_materials_artifacts (
         job_url, generation, artifact_type, artifact_id, status, path, render_format,
         size_bytes, metadata_json, created_at, superseded_at
       ) VALUES (?, 1, ?, ?, 'approved', ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      JOB_KEY,
      "resume_pdf",
      "resume-pdf-v1",
      pdfPath,
      "html_pdf",
      fs.statSync(pdfPath).size,
      JSON.stringify({ resume_template: { templateId: "built_in:modern-html", templateVersionId: "built_in:modern-html:v1", templateVersionNumber: 1, templateName: "Modern HTML", templateHash: "seed-hash", assignmentSource: "built_in" } }),
      NOW,
    );
}
