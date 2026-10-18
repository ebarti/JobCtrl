import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEndpointMethods } from "@jobctrl/api-client";
import { DEFAULT_COVER_LETTER_SETTINGS, type CoverLetterRenderRequest } from "@jobctrl/contracts";
import { initializeExactDatabase } from "./exact-schema.js";
import { acceptCoverLetterPreview, coverLetterAccepted, renderCoverLetterPreview, requireCoverLetterApproval, type CoverLetterPdfRenderer } from "../src/cover-letter-review.js";
import { recordApplyReviewDecision } from "../src/application-feedback.js";
import { buildApp } from "../src/server.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { createOrLoadResumeReviewDraft, saveResumeReviewDraftRevision } from "../src/resume-review-drafts.js";
import { bindDecision, recordModelDecision } from "./semantic-fixtures.js";
import { readArtifactLineAnchors } from "../src/semantic-determinations.js";

const jobId = "00000000-0000-4000-8000-000000001042";
const otherJob = "00000000-0000-4000-8000-000000001043";
const now = "2026-10-18T12:00:00Z";
const pdf = Buffer.from("%PDF-1.4\nsynthetic renderer output\n%%EOF");
let directory: string;
let db: Database.Database;
let textPath: string;
let render: CoverLetterPdfRenderer;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-cover-letter-owned-"));
  const dbPath = path.join(directory, "jobs.db");
  initializeExactDatabase(dbPath);
  db = new Database(dbPath);
  db.pragma("foreign_keys=ON");
  db.prepare(`INSERT INTO resume_templates (tenant_id,template_id,display_name,status,built_in,created_at,updated_at)
    VALUES ('local','built_in:modern-html','Modern HTML','active',1,?,?)`).run(now,now);
  db.prepare(`INSERT INTO resume_template_versions (tenant_id,version_id,template_id,version_number,display_name,status,theme_json,layout_json,content_hash,created_at)
    VALUES ('local','built_in:modern-html:v1','built_in:modern-html',1,'Modern HTML','active',?,'{}','qa',?)`).run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME),now);
  for (const [tenant, id] of [["local", jobId], ["local", otherJob], ["foreign", jobId]]) {
    db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,company,discovered_at) VALUES (?,?,?,'Synthetic','QA',?)")
      .run(tenant, id, `https://example.test/${tenant}/${id}`, now);
  }
  db.prepare("INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at,metadata_json) VALUES ('local',?,1,'complete',?,?,?)")
    .run(jobId, now, now, JSON.stringify({ provenance: "retained", __jobctrl_materials_lineage_id: "old" }));
  textPath = path.join(directory, "source.txt");
  fs.writeFileSync(textPath, "Dear QA,\n\n" + "Full synthetic letter & <escaped>.\n\n".repeat(500) + "END OF FULL LETTER");
  for (const [type, id, file] of [["cover_letter", "cover-text", textPath], ["cover_letter_pdf", "old-cover", path.join(directory, "old.pdf")], ["resume_pdf", "resume-pdf", path.join(directory, "resume.pdf")], ["tailored_resume", "resume-text", path.join(directory, "resume.txt")]]) {
    if (file !== textPath) fs.writeFileSync(file!, type!.includes("pdf") ? pdf : "Synthetic resume");
    db.prepare(`INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,size_bytes,metadata_json,created_at)
      VALUES ('local',?,1,?,?,'approved',?,?,?,'{"original":"preserve"}',?)`)
      .run(jobId, type, id, file, type!.includes("pdf") ? "html_pdf" : "text", fs.statSync(file!).size, now);
  }
  render = vi.fn(async input => { expect(fs.readFileSync(input.sourcePath, "utf8")).toContain("END OF FULL LETTER"); fs.writeFileSync(input.pdfPath, pdf); });
});
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
function request(): CoverLetterRenderRequest {
  const accepted = coverLetterAccepted(db, jobId)!;
  return { source: accepted.source, expectedAcceptedVersion: accepted.acceptedVersion,
    settings: { ...DEFAULT_COVER_LETTER_SETTINGS, paper: "A4", marginMm: 8 } };
}
function acceptedRows() { return db.prepare("SELECT * FROM job_materials_artifacts ORDER BY generation,artifact_type").all(); }

describe("exact cover-letter review", () => {
  it("does not change accepted identity for a rejected attempt, and allocates beyond it", async () => {
    const before = coverLetterAccepted(db, jobId);
    db.prepare("INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at) VALUES ('local',?,7,'rejected',?,?)").run(jobId,now,now);
    expect(coverLetterAccepted(db, jobId)).toEqual(before);
    const { preview } = await renderCoverLetterPreview(db,directory,jobId,request(),render);
    acceptCoverLetterPreview(db,directory,jobId,{previewId:preview.previewId,expectedAcceptedVersion:preview.expectedAcceptedVersion});
    expect(db.prepare("SELECT max(generation) n FROM job_materials").get()).toEqual({n:8});
  });
  it.each([true, false])("derives PDF metadata from accepted text with prior PDF=%s", async priorPdf => {
    if (!priorPdf) db.prepare("DELETE FROM job_materials_artifacts WHERE artifact_type='cover_letter_pdf'").run();
    const sourceMetadata = { claim_verification_id: "current-text-authority", locale: "fr-FR", line_anchors: [{line_id:"line-1"}] };
    db.prepare("UPDATE job_materials_artifacts SET metadata_json=? WHERE artifact_id='cover-text'").run(JSON.stringify(sourceMetadata));
    const { preview } = await renderCoverLetterPreview(db,directory,jobId,request(),render);
    const { accepted } = acceptCoverLetterPreview(db,directory,jobId,{previewId:preview.previewId,expectedAcceptedVersion:preview.expectedAcceptedVersion});
    const row = db.prepare("SELECT metadata_json FROM job_materials_artifacts WHERE artifact_id=?").get(accepted.pdfArtifactId) as {metadata_json:string};
    expect(JSON.parse(row.metadata_json)).toEqual({...sourceMetadata,cover_letter_review:preview});
  });
  it("retains the accepted receipt and PDF when its canonical source becomes unreadable, while refusing saves", async () => {
    const source = fs.readFileSync(textPath);
    const {preview} = await renderCoverLetterPreview(db,directory,jobId,request(),render);
    const saved = acceptCoverLetterPreview(db,directory,jobId,{previewId:preview.previewId,expectedAcceptedVersion:preview.expectedAcceptedVersion});
    const next = await renderCoverLetterPreview(db,directory,jobId,request(),render);
    fs.rmSync(textPath);
    expect(coverLetterAccepted(db,jobId)).toEqual({...saved.accepted,pdfSourceCurrent:false});
    expect(() => acceptCoverLetterPreview(db,directory,jobId,{previewId:next.preview.previewId,expectedAcceptedVersion:next.preview.expectedAcceptedVersion})).toThrow("cover_letter_source_unreadable_or_oversized");
    expect(() => requireCoverLetterApproval(db,jobId)).toThrow("approval_stale_materials");
    fs.writeFileSync(textPath,source);
    expect(coverLetterAccepted(db,jobId)).toEqual(saved.accepted);
  });
  it("preserves an open resume draft, layout and recorded provenance across a cover-only generation", async () => {
    const authority = recordModelDecision(db, "claim_verification", jobId, { verdict: "pass", lines: [{line_id:"line-1",verdict:"pass",served_requirements:[],source_evidence:[],claims:[],findings:[]}], rationale: "Explicit synthetic model verdict" });
    bindDecision(db, "artifact", "cover-text", "1", "claim_verification", authority);
    db.prepare("INSERT INTO artifact_line_anchors VALUES ('local','cover_letter','cover-text',1,'line-1','[]','[]','verbatim','Synthetic source',?)").run(authority);
    db.prepare(`INSERT INTO job_material_layout_boxes (tenant_id,job_id,generation,artifact_id,box_index,semantic_id,page_number,text_excerpt,left_pct,top_pct,width_pct,height_pct,created_at)
      VALUES ('local',?,1,'resume-pdf',0,'resume-line',1,'Synthetic resume',10,10,80,2,?)`).run(jobId,now);
    db.prepare(`INSERT INTO job_bullet_provenance (tenant_id,job_id,generation,bullet_id,artifact_id,section,transform_type,control,generated_text,created_at)
      VALUES ('local',?,1,'resume-line','resume-text','experience','verbatim','required','Synthetic resume',?)`).run(jobId,now);
    const original = await createOrLoadResumeReviewDraft(db, jobId);
    const edited = saveResumeReviewDraftRevision(db, original.draft.draftId, { editedText: "Synthetic edited resume", editDeltas: [] });
    const { preview } = await renderCoverLetterPreview(db, directory, jobId, request(), render);
    const result = acceptCoverLetterPreview(db, directory, jobId, { previewId: preview.previewId, expectedAcceptedVersion: preview.expectedAcceptedVersion });
    const reloaded = await createOrLoadResumeReviewDraft(db, jobId);
    expect(reloaded.draft).toEqual(edited.draft);
    expect(db.prepare("SELECT artifact_id,determination_id FROM artifact_line_anchors WHERE generation=2 ORDER BY artifact_id").all())
      .toEqual(expect.arrayContaining([{ artifact_id: result.accepted.pdfArtifactId, determination_id: authority }, { artifact_id: "cover-text", determination_id: authority }]));
    expect(db.prepare("SELECT determination_id FROM semantic_entity_bindings WHERE entity_id=? AND entity_version='2'").get(result.accepted.pdfArtifactId)).toEqual({ determination_id: authority });
    expect(readArtifactLineAnchors(db,"local","cover_letter_pdf",result.accepted.pdfArtifactId!,2,jobId).get("line-1")?.determinationId).toBe(authority);
    expect(db.prepare("SELECT artifact_id FROM job_material_layout_boxes WHERE generation=2").get()).toEqual({ artifact_id: "resume-pdf" });
    expect(db.prepare("SELECT artifact_id FROM job_bullet_provenance WHERE generation=2").get()).toEqual({ artifact_id: "resume-text" });
    // A second formatting save carries the complete material set again.
    const next = await renderCoverLetterPreview(db,directory,jobId,request(),render);
    acceptCoverLetterPreview(db,directory,jobId,{previewId:next.preview.previewId,expectedAcceptedVersion:next.preview.expectedAcceptedVersion});
    expect(db.prepare("SELECT count(*) n FROM job_material_layout_boxes WHERE artifact_id='resume-pdf'").get()).toEqual({n:3});
    const app = buildApp({appDir:directory,dbPath:path.join(directory,"jobs.db"),configPath:path.join(directory,"config.json")});
    try {
      await app.inject({method:"GET",url:"/v1/artifacts"});
      const layout = db.prepare("SELECT generation,layout_boxes_json FROM artifact_list_projections WHERE artifact_id='resume-pdf'").get() as {generation:number;layout_boxes_json:string};
      const provenance = db.prepare("SELECT generation,bullet_provenance_json FROM artifact_list_projections WHERE artifact_id='resume-text'").get() as {generation:number;bullet_provenance_json:string};
      expect(layout.generation).toBe(3);
      expect(provenance.generation).toBe(3);
      expect(JSON.parse(layout.layout_boxes_json)).toHaveLength(1);
      expect(JSON.parse(provenance.bullet_provenance_json)).toHaveLength(1);
    } finally { await app.close(); }
  });
  it("fences approval for same-generation source drift and preserves manual decisions on unreadable sources", async () => {
    const { preview } = await renderCoverLetterPreview(db, directory, jobId, request(), render);
    const saved = acceptCoverLetterPreview(db, directory, jobId, { previewId: preview.previewId, expectedAcceptedVersion: preview.expectedAcceptedVersion });
    expect(requireCoverLetterApproval(db, jobId)).toEqual(saved.accepted);
    fs.appendFileSync(textPath, "content replacement");
    expect(coverLetterAccepted(db, jobId)?.pdfSourceCurrent).toBe(false);
    expect(() => requireCoverLetterApproval(db, jobId)).toThrow("approval_stale_materials");
    fs.rmSync(textPath);
    expect(recordApplyReviewDecision(db, jobId, { decision: "defer", decidedBy: "synthetic" }).ok).toBe(true);
    expect(recordApplyReviewDecision(db, jobId, { decision: "decline", decidedBy: "synthetic" }).ok).toBe(true);
  });
  it("previews without writes; accepts the very same file, retains all slots/history and reloads identities", async () => {
    const before = acceptedRows();
    const old = coverLetterAccepted(db, jobId)!;
    const { preview } = await renderCoverLetterPreview(db, directory, jobId, request(), render);
    expect(acceptedRows()).toEqual(before);
    expect(coverLetterAccepted(db, jobId)).toEqual(old);
    const result = acceptCoverLetterPreview(db, directory, jobId, { previewId: preview.previewId, expectedAcceptedVersion: old.acceptedVersion });
    expect(result.accepted.pdfSha256).toBe(preview.pdfSha256);
    const parent = db.prepare("SELECT metadata_json FROM job_materials WHERE generation=2").get() as {metadata_json:string};
    expect(JSON.parse(parent.metadata_json).__jobctrl_materials_lineage_id).toMatch(/^[a-f0-9]{32}$/);
    expect(result.accepted.acceptedVersion).not.toBe(old.acceptedVersion);
    expect(result.accepted.source).toEqual(old.source);
    expect(result.accepted.settings).toEqual(preview.settings);
    expect(result.accepted.rendererVersion).toBe(preview.rendererVersion);
    expect(acceptedRows().slice(0, 4)).toEqual(before);
    const slots = db.prepare("SELECT artifact_id,path,metadata_json FROM job_materials_artifacts WHERE generation=2 ORDER BY artifact_type").all() as Array<{ artifact_id: string; path: string; metadata_json: string }>;
    expect(slots.map(row => row.artifact_id)).toEqual(["cover-text", `cover_pdf_${preview.previewId}`, "resume-pdf", "resume-text"]);
    expect(fs.readFileSync(slots[1]!.path)).toEqual(pdf);
    expect(JSON.parse(slots[2]!.metadata_json)).toEqual({ original: "preserve" });
    const reopened = new Database(path.join(directory, "jobs.db"));
    expect(coverLetterAccepted(reopened, jobId)).toEqual(result.accepted);
    reopened.close();
    expect(acceptCoverLetterPreview(db, directory, jobId, { previewId: preview.previewId, expectedAcceptedVersion: old.acceptedVersion })).toEqual(result);
    expect(db.prepare("SELECT count(*) n FROM job_materials").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT count(*) n FROM job_events WHERE event_type='PdfRendered'").get()).toEqual({n:1});
  });

  it("fences concurrent saves and source hash changes in the same generation", async () => {
    const snapshot = request();
    const a = await renderCoverLetterPreview(db, directory, jobId, snapshot, render);
    const b = await renderCoverLetterPreview(db, directory, jobId, snapshot, render);
    acceptCoverLetterPreview(db, directory, jobId, { previewId: b.preview.previewId, expectedAcceptedVersion: snapshot.expectedAcceptedVersion });
    const accepted = coverLetterAccepted(db, jobId);
    expect(() => acceptCoverLetterPreview(db, directory, jobId, { previewId: a.preview.previewId, expectedAcceptedVersion: snapshot.expectedAcceptedVersion })).toThrow("cover_letter_version_conflict");
    expect(coverLetterAccepted(db, jobId)).toEqual(accepted);
    const c = await renderCoverLetterPreview(db, directory, jobId, request(), render);
    fs.appendFileSync(textPath, "same generation replacement");
    expect(() => acceptCoverLetterPreview(db, directory, jobId, { previewId: c.preview.previewId, expectedAcceptedVersion: c.preview.expectedAcceptedVersion })).toThrow("cover_letter_version_conflict");
    expect(fs.readFileSync(path.join(directory, "old.pdf"))).toEqual(pdf);
  });

  it("rejects a source changed while rendering and removes only that losing attempt", async () => {
    const before = acceptedRows();
    await expect(renderCoverLetterPreview(db, directory, jobId, request(), async input => {
      fs.writeFileSync(input.pdfPath, pdf); fs.appendFileSync(textPath, "changed");
    })).rejects.toThrow("cover_letter_version_conflict");
    expect(acceptedRows()).toEqual(before);
    expect(fs.readdirSync(path.join(directory, "generated", "cover-letter-previews"))).toEqual([]);
  });

  it.each(["missing", "invalid", "changed-hash"])("refuses a %s preview at save without altering accepted state", async failure => {
    const before = acceptedRows();
    const accepted = coverLetterAccepted(db,jobId);
    const {preview} = await renderCoverLetterPreview(db,directory,jobId,request(),render);
    const file = path.join(directory,"generated","cover-letter-previews",preview.previewId,"letter.pdf");
    if (failure === "missing") fs.rmSync(file);
    else fs.writeFileSync(file,failure === "invalid" ? Buffer.from("invalid") : Buffer.from("%PDF-1.4\nchanged\n%%EOF"));
    expect(() => acceptCoverLetterPreview(db,directory,jobId,{previewId:preview.previewId,expectedAcceptedVersion:preview.expectedAcceptedVersion})).toThrow(failure === "changed-hash" ? "cover_letter_preview_corrupt" : "cover_letter_pdf_missing_or_invalid");
    expect(acceptedRows()).toEqual(before);
    expect(coverLetterAccepted(db,jobId)).toEqual(accepted);
  });

  it("rejects a newer source generation even when the text bytes are unchanged", async () => {
    const {preview} = await renderCoverLetterPreview(db,directory,jobId,request(),render);
    db.prepare("INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at) VALUES ('local',?,2,'complete',?,?)").run(jobId,now,now);
    db.prepare(`INSERT INTO job_materials_artifacts
      SELECT tenant_id,job_id,2,artifact_type,'new-cover-source',status,path,render_format,size_bytes,metadata_json,created_at,superseded_at
      FROM job_materials_artifacts WHERE artifact_id='cover-text'`).run();
    const before = acceptedRows();
    expect(() => acceptCoverLetterPreview(db,directory,jobId,{previewId:preview.previewId,expectedAcceptedVersion:preview.expectedAcceptedVersion})).toThrow("cover_letter_version_conflict");
    expect(acceptedRows()).toEqual(before);
    expect(coverLetterAccepted(db,jobId)?.pdfSourceCurrent).toBe(false);
  });

  it.each(["renderer", "invalid-pdf", "persistence", "event-persistence"])("preserves accepted state after %s failure and permits retry", async mode => {
    const before = acceptedRows();
    const accepted = coverLetterAccepted(db, jobId);
    if (mode !== "persistence" && mode !== "event-persistence") {
      await expect(renderCoverLetterPreview(db, directory, jobId, request(), async input => {
        if (mode === "renderer") throw new Error("renderer unavailable");
        fs.writeFileSync(input.pdfPath, "corrupt");
      })).rejects.toThrow();
    } else {
      const { preview } = await renderCoverLetterPreview(db, directory, jobId, request(), render);
      db.exec(mode === "event-persistence"
        ? "CREATE TEMP TRIGGER fail_cover BEFORE INSERT ON job_events WHEN NEW.event_type='PdfRendered' BEGIN SELECT RAISE(ABORT,'owned failure'); END"
        : "CREATE TEMP TRIGGER fail_cover BEFORE INSERT ON job_materials_artifacts WHEN NEW.generation=2 BEGIN SELECT RAISE(ABORT,'owned failure'); END");
      expect(() => acceptCoverLetterPreview(db, directory, jobId, { previewId: preview.previewId, expectedAcceptedVersion: preview.expectedAcceptedVersion })).toThrow("owned failure");
      db.exec("DROP TRIGGER fail_cover");
      expect(coverLetterAccepted(db, jobId)).toEqual(accepted);
      expect(acceptedRows()).toEqual(before);
      expect(db.prepare("SELECT count(*) n FROM job_events WHERE event_type='PdfRendered'").get()).toEqual({n:0});
      expect(acceptCoverLetterPreview(db, directory, jobId, { previewId: preview.previewId, expectedAcceptedVersion: preview.expectedAcceptedVersion }).ok).toBe(true);
      return;
    }
    expect(coverLetterAccepted(db, jobId)).toEqual(accepted);
    expect(acceptedRows()).toEqual(before);
  });

  it("checks generated-client/registered-route behavior, identical preview/download bytes, ownership and invalid settings", async () => {
    const app = buildApp({ appDir: directory, dbPath: path.join(directory, "jobs.db"), configPath: path.join(directory, "config.json"), coverLetterPdfRenderer: render });
    try {
      const client = createEndpointMethods(async (method, url, body) => {
        const response = await app.inject({ method, url, payload: body as object });
        if (response.statusCode !== 200) throw new Error(response.body);
        return response.json();
      });
      const before = coverLetterAccepted(db, jobId);
      // Product reads have already populated projections before a review save.
      expect((await app.inject({method:"GET",url:"/v1/artifacts"})).statusCode).toBe(200);
      const { preview } = await client.renderCoverLetterPreview(jobId, request());
      const url = `/v1/jobs/${jobId}/cover-letter/previews/${preview.previewId}.pdf`;
      const viewed = await app.inject({ method: "GET", url });
      expect(viewed.statusCode).toBe(200);
      expect(viewed.rawPayload).toEqual(pdf);
      expect((await app.inject({ method: "GET", url: url.replace(jobId, otherJob) })).statusCode).toBe(404);
      expect(coverLetterAccepted(db, jobId)).toEqual(before);
      await client.acceptCoverLetterPreview(jobId, { previewId: preview.previewId, expectedAcceptedVersion: preview.expectedAcceptedVersion });
      const downloaded = await app.inject({ method: "GET", url: `/v1/artifacts/cover_pdf_${preview.previewId}/preview.pdf` });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.rawPayload).toEqual(viewed.rawPayload);
      for (const value of [7, 29, "8mm", null]) {
        const bad = await app.inject({ method: "POST", url: `/v1/jobs/${jobId}/cover-letter/preview`, payload: { ...request(), settings: { ...request().settings, marginMm: value } } });
        expect(bad.statusCode).toBe(400);
      }
    } finally { await app.close(); }
  });

  it.each(["rpc-error", "transport", "invalid-result"])("maps %s to a failed render without accepted writes", async failure => {
    const call = vi.fn(async () => {
      if (failure === "transport") throw new Error("owned transport failure");
      return failure === "rpc-error" ? { jsonrpc: "2.0" as const, id: 1, error: { code: -32603, message: "owned renderer failure" } }
        : { jsonrpc: "2.0" as const, id: 1, result: { status: "invalid" } };
    });
    const app = buildApp({ appDir: directory, dbPath: path.join(directory,"jobs.db"), configPath: path.join(directory,"config.json"), providerDispatcher: { call, close: async () => {} } });
    try {
      const accepted = coverLetterAccepted(db, jobId);
      const response = await app.inject({ method: "POST", url: `/v1/jobs/${jobId}/cover-letter/preview`, payload: request() });
      expect(response.statusCode).toBe(502);
      expect(response.json().error).toBe("cover_letter_render_failed");
      expect(call).toHaveBeenCalledWith("render_cover_letter_pdf", expect.objectContaining({ settings: request().settings, textSha256: request().source.textSha256 }));
      expect(coverLetterAccepted(db, jobId)).toEqual(accepted);
      expect(db.prepare("SELECT count(*) n FROM job_materials").get()).toEqual({n:1});
    } finally { await app.close(); }
  });

  it.each(["missing", "oversized", "invalid-utf8"])("rejects %s sources explicitly", async mode => {
    const snapshot = request();
    if (mode === "missing") fs.rmSync(textPath);
    if (mode === "oversized") fs.writeFileSync(textPath, "a".repeat(512_001));
    if (mode === "invalid-utf8") fs.writeFileSync(textPath, Buffer.from([255]));
    await expect(renderCoverLetterPreview(db, directory, jobId, snapshot, render)).rejects.toThrow("cover_letter_source_unreadable_or_oversized");
    expect(render).not.toHaveBeenCalled();
  });
});
