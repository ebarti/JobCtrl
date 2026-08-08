import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUILT_IN_RESUME_TEMPLATE_THEME,
  createResumeTemplateVersion,
  ensureCurrentResumeTemplateMaterials,
  getResumeTemplateDetail,
  listResumeTemplates,
  resolveCurrentResumeArtifactIdForOpen,
  ResumeTemplateInputError,
  resumeTemplateStateForJob,
  setDefaultResumeTemplate,
  setJobResumeTemplateAssignment,
} from "../src/resume-templates.js";
import type { ResumeHtmlPdfRenderer } from "../src/resume-pdf-render.js";

const JOB_ID = "11111111-1111-4111-8111-11111111111a";
const JOB_URL = "https://example.com/jobs/template-engineer";
const UUID_SHAPED_URL = "22222222-2222-4222-8222-222222222222";
const UUID_SHAPED_URL_OWNER_JOB_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-06-24T10:00:00.000Z";

// Stand-in for the Playwright HTML-to-PDF subprocess: it renders the exact HTML
// the refresh built, so tests inspect the full resume content instead of spawning
// a browser.
const renderHtmlToPdf: ResumeHtmlPdfRenderer = async ({ htmlPath, pdfPath }) => {
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
  it("saves style-only template versions, default selection, and per-job overrides", async () => {
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

    const assignment = setJobResumeTemplateAssignment(db, JOB_ID, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });
    expect(assignment.overrideTemplate).toMatchObject({
      assignmentSource: "job_override",
      templateId: saved.template.templateId,
    });
    expect(assignment.templateState?.state).toBe("template_stale");
  });

  it("returns the exact pinned default version when a newer version exists", async () => {
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

  it("rejects template payloads that contain profile or job facts", async () => {
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

  it("lazily creates a render-only generation when the effective template changes", async () => {
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

    const refresh = await ensureCurrentResumeTemplateMaterials(db, JOB_ID, {}, renderHtmlToPdf);
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

  it("opens the refreshed resume artifact when a stale artifact id is requested", async () => {
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

    const resolved = await resolveCurrentResumeArtifactIdForOpen(db, "resume-pdf-v1", renderHtmlToPdf);
    expect(resolved).not.toBe("resume-pdf-v1");
    expect(resolved).toMatch(/^template_refresh_pdf_/);
  });

  it("reports refresh unavailable without hiding the last accepted artifact", async () => {
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

    const refresh = await ensureCurrentResumeTemplateMaterials(db, JOB_ID, {}, renderHtmlToPdf);
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

  it("renders every line of a long resume across the refreshed PDF without truncation", async () => {
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

    const refresh = await ensureCurrentResumeTemplateMaterials(db, JOB_ID, {}, renderHtmlToPdf);
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

  it("keeps the last accepted resume artifact when the PDF render fails", async () => {
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
    const refresh = await ensureCurrentResumeTemplateMaterials(db, JOB_ID, {}, failingRenderer);
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

  it("uses exact-v7 tenant and JobId keys for assignments, materials, layout, attempts, and events", async () => {
    const saved = createResumeTemplateVersion(db, {
      displayName: "Tenant-isolated template",
      theme: { ...BUILT_IN_RESUME_TEMPLATE_THEME, fontFamily: "serif" },
      layout: {},
    });
    setJobResumeTemplateAssignment(db, JOB_ID, {
      templateId: saved.template.templateId,
      versionId: saved.template.activeVersion.versionId,
    });
    db.prepare(
      `INSERT INTO job_resume_template_assignments (
         tenant_id, job_id, template_id, version_id, updated_at
       ) VALUES ('other', ?, 'built_in:modern-html', 'built_in:modern-html:v1', ?)`,
    ).run(JOB_ID, NOW);

    expect(resumeTemplateStateForJob(db, JOB_ID)?.effective.templateId).toBe(saved.template.templateId);
    const refresh = await ensureCurrentResumeTemplateMaterials(db, JOB_ID, {}, renderHtmlToPdf);
    expect(refresh.status).toBe("completed");

    expect(
      db.prepare(
        "SELECT tenant_id, job_id FROM job_resume_template_assignments WHERE job_id = ? ORDER BY tenant_id",
      ).all(JOB_ID),
    ).toEqual([
      { tenant_id: "local", job_id: JOB_ID },
      { tenant_id: "other", job_id: JOB_ID },
    ]);
    expect(
      db.prepare(
        "SELECT DISTINCT tenant_id, job_id FROM resume_template_refresh_attempts ORDER BY tenant_id, job_id",
      ).all(),
    ).toEqual([{ tenant_id: "local", job_id: JOB_ID }]);
    expect(
      db.prepare(
        "SELECT DISTINCT tenant_id, job_id FROM job_material_layout_boxes ORDER BY tenant_id, job_id",
      ).all(),
    ).toEqual([{ tenant_id: "local", job_id: JOB_ID }]);
    expect(
      db.prepare(
        "SELECT tenant_id, job_id, identity_version FROM job_events WHERE job_id = ?",
      ).all(JOB_ID),
    ).toEqual([
      { tenant_id: "local", job_id: JOB_ID, identity_version: 1 },
      { tenant_id: "local", job_id: JOB_ID, identity_version: 1 },
    ]);
  });

  it("refuses invalid UUIDs and never treats posting or application URLs as identity", async () => {
    expect(() => setJobResumeTemplateAssignment(db, JOB_URL, { templateId: null })).toThrow(
      "jobId must be a canonical lowercase UUID",
    );
    expect(() => resumeTemplateStateForJob(db, JOB_ID.toUpperCase())).toThrow(
      "jobId must be a canonical lowercase UUID",
    );
    await expect(ensureCurrentResumeTemplateMaterials(db, UUID_SHAPED_URL, {}, renderHtmlToPdf)).rejects.toThrow(
      `Job not found: ${UUID_SHAPED_URL}`,
    );
  });
});

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
      tenant_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      company TEXT,
      application_url TEXT,
      discovered_at TEXT,
      PRIMARY KEY (tenant_id, job_id),
      UNIQUE (tenant_id, url)
    );
    CREATE TABLE candidate_profiles (
      tenant_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      personal_full_name TEXT NOT NULL DEFAULT '',
      personal_email TEXT NOT NULL DEFAULT '',
      personal_phone TEXT NOT NULL DEFAULT '',
      personal_linkedin_url TEXT NOT NULL DEFAULT '',
      personal_github_url TEXT NOT NULL DEFAULT '',
      personal_portfolio_url TEXT NOT NULL DEFAULT '',
      personal_website_url TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant_id, profile_id)
    );
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      job_id TEXT,
      identity_version INTEGER NOT NULL,
      stage TEXT,
      event_type TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT,
      entity_kind TEXT,
      entity_ref TEXT,
      idempotency_key TEXT,
      FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
    CREATE TABLE job_materials (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_validation_json TEXT,
      last_verdict_json TEXT,
      metadata_json TEXT,
      PRIMARY KEY (tenant_id, job_id, generation),
      FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
    CREATE TABLE job_materials_artifacts (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
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
        REFERENCES job_materials(tenant_id, job_id, generation) ON DELETE CASCADE
    );
    CREATE TABLE job_material_layout_boxes (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
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
      PRIMARY KEY (tenant_id, job_id, generation, artifact_id, box_index),
      FOREIGN KEY (tenant_id, job_id, generation)
        REFERENCES job_materials(tenant_id, job_id, generation) ON DELETE CASCADE
    );
    CREATE TABLE resume_templates (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      template_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      built_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, template_id)
    );
    CREATE TABLE resume_template_versions (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      version_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      theme_json TEXT NOT NULL,
      layout_json TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, version_id),
      UNIQUE (tenant_id, template_id, version_number)
    );
    CREATE TABLE resume_template_defaults (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      profile_id TEXT NOT NULL DEFAULT 'default',
      template_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, profile_id)
    );
    CREATE TABLE job_resume_template_assignments (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_id),
      FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
    CREATE TABLE resume_template_refresh_attempts (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      attempt_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      from_generation INTEGER,
      to_generation INTEGER,
      template_id TEXT,
      template_version_id TEXT,
      template_hash TEXT,
      error_message TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (tenant_id, attempt_id),
      FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
  `);
  database.pragma("foreign_keys = ON");
  database
    .prepare(
      "INSERT INTO jobs (tenant_id, job_id, url, title, company, application_url, discovered_at) VALUES ('local', ?, ?, ?, ?, ?, ?)",
    )
    .run(JOB_ID, JOB_URL, "Senior Platform Engineer", "Globex Infrastructure", "https://apply.example.com/globex", NOW);
  database
    .prepare(
      "INSERT INTO jobs (tenant_id, job_id, url, title, company, application_url, discovered_at) VALUES ('local', ?, ?, ?, ?, ?, ?)",
    )
    .run(UUID_SHAPED_URL_OWNER_JOB_ID, UUID_SHAPED_URL, "URL-shaped locator", "Example", "https://apply.example.com/uuid", NOW);
  database
    .prepare(
      "INSERT INTO jobs (tenant_id, job_id, url, title, company, application_url, discovered_at) VALUES ('other', ?, ?, ?, ?, ?, ?)",
    )
    .run(JOB_ID, "https://other.example/jobs/template-engineer", "Other tenant job", "Other", "https://other.example/apply", NOW);
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
         tenant_id, job_id, generation, status, created_at, updated_at,
         last_validation_json, last_verdict_json, metadata_json
       ) VALUES ('local', ?, 1, 'resume_approved', ?, ?, ?, ?, ?)`,
    )
    .run(
      JOB_ID,
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
         tenant_id, job_id, generation, artifact_type, artifact_id, status, path, render_format,
         size_bytes, metadata_json, created_at, superseded_at
       ) VALUES ('local', ?, 1, ?, ?, 'approved', ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      JOB_ID,
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
         tenant_id, job_id, generation, artifact_type, artifact_id, status, path, render_format,
         size_bytes, metadata_json, created_at, superseded_at
       ) VALUES ('local', ?, 1, ?, ?, 'approved', ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      JOB_ID,
      "resume_pdf",
      "resume-pdf-v1",
      pdfPath,
      "html_pdf",
      fs.statSync(pdfPath).size,
      JSON.stringify({ resume_template: { templateId: "built_in:modern-html", templateVersionId: "built_in:modern-html:v1", templateVersionNumber: 1, templateName: "Modern HTML", templateHash: "seed-hash", assignmentSource: "built_in" } }),
      NOW,
    );
  seedBuiltInTemplate(database);
}

function seedBuiltInTemplate(database: Database.Database): void {
  database
    .prepare(
      `INSERT INTO resume_templates (
         tenant_id, template_id, display_name, status, built_in, created_at, updated_at
       ) VALUES ('local', 'built_in:modern-html', 'Modern HTML', 'active', 1, ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO resume_template_versions (
         tenant_id, version_id, template_id, version_number, display_name, status,
         theme_json, layout_json, content_hash, created_at
       ) VALUES ('local', 'built_in:modern-html:v1', 'built_in:modern-html', 1,
                 'Modern HTML', 'active', ?, '{}', 'seed-hash', ?)`,
    )
    .run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME), NOW);
}
