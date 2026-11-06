import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import type { Value } from "platejs";
import { z } from "zod";

import { ResumeStandalonePlateEditor } from "../materials/components/ResumeStandalonePlateEditor.js";
import { isPlateValue } from "../materials/lib/resume-document.js";
import type { ResumePlateSemanticTextChange } from "../materials/lib/resume-editor-types.js";
import { Button } from "../../shared/ui/button.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { getApiCapabilityAvailability } from "../../shared/lib/apiCapabilityAvailability.js";
import { useResumeActions, useResumeHtml, useResumes, type Resume, type ResumeDocument } from "./client.js";

// Renderer IDs are stable source identities. Never infer a field from text.
function applyTextChanges(document: ResumeDocument, changes: readonly ResumePlateSemanticTextChange[]): ResumeDocument {
  const next = structuredClone(document);
  for (const change of changes) {
    if (change.plateTexts.length > 1) throw new Error("This edit splits a source field. Edit that field in Profile and compose again.");
    const text = change.plateTexts[0] ?? "";
    let matched = false;
    if (change.semanticId === "personal:full_name") { next.personal.full_name = text; matched = true; }
    if (change.semanticId === "personal:address") { next.personal.address = text; matched = true; }
    if (change.semanticId === "executive_profile#0") { next.summary = text; matched = true; }
    for (const role of next.experience) {
      for (const field of ["title", "company", "location", "date_range", "summary"] as const) {
        if (change.semanticId === `experience:${role.id}:${field}`) { role[field] = text; matched = true; }
      }
      for (const bullet of role.bullets) {
        if (change.semanticId === bullet.id) { bullet.text = text; matched = true; }
      }
    }
    for (const row of next.education) {
      for (const field of ["degree", "institution", "location", "date", "details"] as const) {
        if (change.semanticId === `education:${row.id}:${field}`) { row[field] = text; matched = true; }
      }
    }
    if (!matched) throw new Error("This edit changes a combined or unrecognized field. Edit that field in Profile and compose again; your local edits are still here.");
  }
  return next;
}

function ResumeWorkspace({ latest, onDirtyChange, onProfileChanged }: { latest: Resume; onDirtyChange: (dirty: boolean) => void; onProfileChanged?: () => void }) {
  const { featureFlags } = usePorts();
  const tailoring = getApiCapabilityAvailability(featureFlags, "tailorJob");
  const translation = getApiCapabilityAvailability(featureFlags, "materialLocaleVariants");
  const docx = getApiCapabilityAvailability(featureFlags, "downloadMaterialDocx");
  const [session, setSession] = useState(latest);
  const [dirty, setDirty] = useState(false);
  const [plate, setPlate] = useState<Value | null>(null);
  const [changes, setChanges] = useState<readonly ResumePlateSemanticTextChange[]>([]);
  const [editError, setEditError] = useState("");
  const { action, exportFile } = useResumeActions(latest.job_id);
  const revision = session.revisions.find((item) => item.revision_id === session.current_revision);
  const html = useResumeHtml(session);
  const busy = action.isPending || exportFile.isPending;
  const savedPlate = useMemo(() => {
    const value = revision?.edit_draft?.plate_document;
    return isPlateValue(value) ? value : null;
  }, [revision?.edit_draft?.plate_document]);
  const updateDirty = useCallback((value: boolean) => { setDirty(value); onDirtyChange(value); }, [onDirtyChange]);
  useEffect(() => {
    if (!dirty && !busy && latest.version !== session.version) {
      setSession(latest); setPlate(null); setChanges([]); setEditError("");
    }
  }, [busy, dirty, latest, session.version]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  if (!revision) return <p role="alert">The current resume revision was not found.</p>;
  const latestChanged = latest.version !== session.version;
  const rendered = revision.renders.at(-1);
  const readyToAccept = revision.mechanical.status === "valid" && Boolean(rendered) && !(rendered?.layout_conflicts?.length);
  const changedBullets = revision.document.experience.flatMap((role) => role.bullets.filter((bullet) => {
    const selected = revision.selected_variants.find((variant) => variant.achievement_id === (bullet.achievement_id ?? bullet.id));
    return !selected || selected.text !== bullet.text;
  }));
  const actionError = action.error?.message ?? exportFile.error?.message ?? editError;
  const run = (name: string, body: Record<string, unknown>) => {
    action.mutate({ resumeId: session.resume_id, action: name, body: { expected_version: session.version, ...body } }, {
      onSuccess: (next) => { setSession(next); setPlate(null); setChanges([]); updateDirty(false); setEditError(""); if (name === "approve-edits") onProfileChanged?.(); },
    });
  };
  const save = () => {
    if (!plate) return;
    try {
      const document = applyTextChanges(revision.document, changes);
      setEditError("");
      run("edit", { document, plate_document: plate });
    } catch (error) { setEditError(error instanceof Error ? error.message : "The edit could not be mapped to its source."); }
  };
  const acceptance = session.acceptances.findLast((item) => item.revision_id === session.accepted_revision_id);
  const renderFailure = revision.render_attempts.at(-1);
  return <div>
    <p>Revision {revision.number} · {revision.mode === "baseline_copy" ? "Baseline copy" : "Composed resume"} · profile revision {revision.profile_revision}</p>
    {revision.mode === "baseline_copy" ? <p>Baseline copy retains the complete saved profile. Creating and reviewing this copy makes no resume model calls.</p> : <p>Composition keeps every baseline role and achievement and chooses one approved wording for each.</p>}
    {session.accepted_revision_id ? <p role="status">Accepted revision {session.accepted_revision_id === session.current_revision ? "is current" : "is retained separately"}{acceptance ? `; review ${acceptance.review_status}${acceptance.review_override ? " with explicit override" : ""}` : ""}.</p> : <p>No resume has been accepted yet.</p>}
    <ResumeTemplateAssignment disabled={busy || dirty || latestChanged} run={run} />
    {latestChanged ? <div role="alert"><p>The saved resume changed while this editor was open. Your local edits remain here; saving against the older version will be rejected.</p><Button type="button" variant="outline" onClick={() => { setSession(latest); setPlate(null); setChanges([]); updateDirty(false); setEditError(""); }}>Discard local edits and load saved version</Button></div> : null}
    <div inert={busy} aria-busy={busy}>
      {html.isPending ? <p>Loading the saved resume editor…</p> : null}
      {html.error ? <p role="alert">{html.error.message}</p> : null}
      {html.data ? <ResumeStandalonePlateEditor key={revision.revision_id}
        html={html.data} htmlUrl={null} savedPlateValue={savedPlate} enableLocalPdfExport={false}
        pdfFilename="resume.pdf" title="Resume" onDirtyChange={updateDirty}
        onPlateValueChange={setPlate} onSemanticTextChange={setChanges} /> : null}
    </div>
    <p className="muted">Text edits save as a draft. Changed achievement wording needs explicit approval before acceptance; change other profile facts in Profile. Formatting stays with the saved draft.</p>
    <div className="toolbar"><Button type="button" disabled={!dirty || !plate || busy || latestChanged} onClick={save}>Save resume</Button></div>
    <p>Mechanical check: {revision.mechanical.status}{revision.mechanical.failures.length ? ` — ${revision.mechanical.failures.join(", ")}` : ""}</p>
    {revision.mechanical.status === "invalid" && changedBullets.length ? <section aria-label="Approve edited wording">
      <h4>Review edited wording</h4><p>Approve these exact changes for their original achievements before reuse or acceptance:</p>
      <ul>{changedBullets.map((bullet) => <li key={bullet.id}>{bullet.text}</li>)}</ul>
      <Button type="button" disabled={busy || dirty || latestChanged} onClick={() => run("approve-edits", { user_confirmed: true })}>Approve these exact edits</Button>
    </section> : null}
    <h4>Document coverage</h4><p>Status: {revision.coverage_manifest.status ?? "recorded"}. Coverage describes the chosen document wording, not person fit.</p>
    {revision.coverage_manifest.requirements?.length ? <ul>{revision.coverage_manifest.requirements.map((item, index) => {
      const row = item as { requirement_id?: string; covered?: boolean; weight?: number };
      return <li key={`${row.requirement_id ?? "requirement"}:${index}`}>{row.requirement_id ?? "Requirement"}: {row.covered ? "covered" : "not covered"}{row.weight === undefined ? "" : `, weight ${row.weight}`}</li>;
    })}</ul> : null}
    <h4>Advisory coherence review</h4><p>Status: {revision.review.status}{revision.review.failure_code ? ` (${revision.review.failure_code})` : ""}.</p>
    {revision.review.findings.length ? <ul>{revision.review.findings.map((finding, index) => <li key={index}>{finding.detail}</li>)}</ul> : null}
    {revision.mode !== "baseline_copy" ? <><Button type="button" variant="outline" disabled={!tailoring.available || busy || dirty || latestChanged || revision.mechanical.status !== "valid" || revision.review.status !== "pending"} onClick={() => run("review", {})}>Review coherence</Button>{!tailoring.available ? <p>{tailoring.reason}</p> : null}</> : null}
    <div className="toolbar">
      <Button type="button" variant="outline" disabled={busy || dirty || latestChanged || revision.mechanical.status !== "valid"} onClick={() => run("render", {})}>Render resume</Button>
      <Button type="button" disabled={busy || dirty || latestChanged || !readyToAccept || !["pass", "not_applicable"].includes(revision.review.status)} onClick={() => run("accept", { override_review: false })}>Accept resume</Button>
      {["findings", "timeout", "failed"].includes(revision.review.status) ? <Button type="button" variant="outline" disabled={busy || dirty || latestChanged || !readyToAccept} onClick={() => run("accept", { override_review: true })}>Accept with review override</Button> : null}
      <Button type="button" variant="outline" disabled={busy || !session.accepted_revision_id} onClick={() => { if (session.accepted_revision_id) exportFile.mutate({ resumeId: session.resume_id, revisionId: session.accepted_revision_id, format: "pdf" }); }}>Export accepted PDF</Button>
      <Button type="button" variant="outline" disabled={!docx.available || busy || !session.accepted_revision_id} onClick={() => { if (session.accepted_revision_id) exportFile.mutate({ resumeId: session.resume_id, revisionId: session.accepted_revision_id, format: "docx" }); }}>Export accepted DOCX</Button>
    </div>
    {!docx.available ? <p>{docx.reason}</p> : null}
    {renderFailure?.status === "failed" ? <p role="alert">Render failed{renderFailure.failure_code ? `: ${renderFailure.failure_code}` : ""}. The accepted resume is unchanged.</p> : null}
    {rendered?.layout_conflicts?.length ? <p role="alert">The rendered document has {rendered.layout_conflicts.length} layout conflict(s). Resolve them before acceptance.</p> : null}
    <ResumeLocales resume={session} disabled={busy || dirty || latestChanged} translationAvailable={translation.available} translationReason={translation.reason} docxAvailable={docx.available} run={run} exportLocale={(localeId, format) => exportFile.mutate({ resumeId: session.resume_id, localeId, format })} />
    {actionError ? <p role="alert">{actionError} Your existing accepted resume remains available.</p> : null}
  </div>;
}

const templateVersionSchema = z.object({ templateId: z.string(), versionId: z.string(), versionNumber: z.number(), displayName: z.string() }).passthrough();
const templatesSchema = z.object({ templates: z.array(z.object({ templateId: z.string(), displayName: z.string(), activeVersion: templateVersionSchema,
  versions: z.array(templateVersionSchema).optional() }).passthrough()) }).passthrough();
function ResumeTemplateAssignment({ disabled, run }: { disabled: boolean; run: (name: string, body: Record<string, unknown>) => void }) {
  const { http } = usePorts(); const tenantId = useTenantId(); const [versionId, setVersionId] = useState("");
  const query = useQuery({ queryKey: ["tenant", tenantId, "resumes", "templates"], queryFn: async () => {
    const parsed = templatesSchema.safeParse(await http.json<unknown>("GET", "/v1/resume-templates"));
    if (!parsed.success) throw new Error("The resume templates response is invalid.");
    return parsed.data;
  }, meta: { suppressGlobalErrorToast: true } });
  const versions = query.data?.templates.flatMap((template) => template.versions?.length ? template.versions : [template.activeVersion]) ?? [];
  const selected = versions.find((version) => version.versionId === versionId);
  return <details><summary>Resume template</summary>
    <p>Choose a saved template version. It changes the layout without replacing the resume content or the accepted copy.</p>
    {query.error ? <p role="alert">{query.error.message}</p> : null}
    {versions.length ? <><label>Template version<select value={versionId} onChange={(event) => setVersionId(event.currentTarget.value)}><option value="">Select a template</option>
      {versions.map((version) => <option key={version.versionId} value={version.versionId}>{version.displayName} · version {version.versionNumber}</option>)}
    </select></label><Button type="button" variant="outline" disabled={disabled || !selected} onClick={() => { if (selected) run("template", { template_id: selected.templateId, template_version: selected.versionId }); }}>Apply template</Button></> : !query.isPending && !query.error ? <p>No saved templates are available.</p> : null}
  </details>;
}

const languages = ["en", "es", "fr", "de", "it", "pt", "ca"] as const;
const localeInput = z.object({ source: z.enum(languages), target: z.enum(languages) }).refine((value) => value.source !== value.target);
function ResumeLocales({ resume, disabled, translationAvailable, translationReason, docxAvailable, run, exportLocale }: {
  resume: Resume; disabled: boolean; run: (name: string, body: Record<string, unknown>) => void;
  translationAvailable: boolean; translationReason: string | null; docxAvailable: boolean;
  exportLocale: (localeId: string, format: "pdf" | "docx") => void;
}) {
  const [validation, setValidation] = useState("");
  const form = useForm({ defaultValues: { source: "en", target: "es" }, onSubmit: ({ value }) => {
    const parsed = localeInput.safeParse(value);
    if (!parsed.success) { setValidation("Choose two different supported languages."); return; }
    setValidation(""); run("locales/generate", { source_locale: parsed.data.source, target_locale: parsed.data.target });
  } });
  return <details><summary>Resume translations</summary>
    <p>Translate an accepted resume, review the result independently, then accept and export the translation separately.</p>
    <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
      <form.Field name="source">{(field) => <label>Source language<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}>{languages.map((lang) => <option key={lang} value={lang}>{lang}</option>)}</select></label>}</form.Field>
      <form.Field name="target">{(field) => <label>Target language<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}>{languages.map((lang) => <option key={lang} value={lang}>{lang}</option>)}</select></label>}</form.Field>
      <Button type="submit" variant="outline" disabled={!translationAvailable || disabled || !resume.accepted_revision_id}>Translate resume</Button>
    </form>
    {!translationAvailable ? <p>{translationReason}</p> : null}
    {validation ? <p role="alert">{validation}</p> : null}
    {resume.locales.map((item) => <section key={item.locale_id} aria-label={`Translation ${item.locale_id}`}>
      <h4>{item.source_locale} → {item.target_locale}: {item.status}</h4>
      <p>Independent review: {item.review.status}{item.failure_code ? `; ${item.failure_code}` : ""}{item.review.failure_code ? `; ${item.review.failure_code}` : ""}</p>
      {[...item.findings, ...item.review.findings].map((finding, index) => <p key={index}>{finding.detail}</p>)}
      {item.document ? <details><summary>Review translated resume</summary><TranslatedResume document={item.document} /></details> : null}
      <div className="toolbar">
        <Button type="button" variant="outline" disabled={!translationAvailable || disabled || item.status !== "generated" || item.review.status !== "pending"} onClick={() => run(`locales/${encodeURIComponent(item.locale_id)}/review`, {})}>Review translation</Button>
        <Button type="button" disabled={disabled || item.status !== "generated" || item.review.status !== "pass" || item.findings.length > 0} onClick={() => run(`locales/${encodeURIComponent(item.locale_id)}/accept`, { user_confirmed: true })}>Accept translation</Button>
        <Button type="button" variant="outline" disabled={disabled || item.status !== "accepted"} onClick={() => exportLocale(item.locale_id, "pdf")}>Export translation PDF</Button>
        <Button type="button" variant="outline" disabled={!docxAvailable || disabled || item.status !== "accepted"} onClick={() => exportLocale(item.locale_id, "docx")}>Export translation DOCX</Button>
      </div>
    </section>)}
  </details>;
}

function TranslatedResume({ document }: { document: ResumeDocument }) {
  return <article aria-label="Translated resume text">
    <h5>{document.personal.full_name}</h5><p>{document.personal.address}</p>
    {document.personal.contact_items.map((item, index) => {
      const contact = item as { label?: unknown };
      return typeof contact.label === "string" ? <p key={index}>{contact.label}</p> : null;
    })}
    <p>{document.summary}</p>
    {document.experience.map((role) => <section key={role.id}><h6>{role.title} · {role.company}</h6><p>{role.location} {role.date_range}</p><p>{role.summary}</p><ul>{role.bullets.map((bullet) => <li key={bullet.id}>{bullet.text}</li>)}</ul></section>)}
    {document.education.map((entry) => <p key={entry.id}>{[entry.degree, entry.institution, entry.location, entry.date, entry.details].filter(Boolean).join(" · ")}</p>)}
    {document.skills.map((item, index) => { const category = item as { label?: unknown; items?: unknown };
      return <p key={index}>{typeof category.label === "string" ? category.label : ""}: {Array.isArray(category.items) ? category.items.filter((value): value is string => typeof value === "string").join(", ") : ""}</p>;
    })}
  </article>;
}

export function ResumePanel({ jobId, profileVersion, defaultMode, onProfileChanged }: { jobId: string; profileVersion: number | null; defaultMode: "baseline" | "tailored" | null; onProfileChanged?: () => void }) {
  const { featureFlags } = usePorts();
  const tailoring = getApiCapabilityAvailability(featureFlags, "tailorJob");
  const list = useResumes(jobId);
  const { compose } = useResumeActions(jobId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const selected = list.data?.find((item) => item.resume_id === selectedId) ?? list.data?.[0] ?? null;
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);
  const start = (mode: "tailored" | "baseline_copy") => {
    if (profileVersion === null || (mode === "tailored" && !tailoring.available)) return;
    compose.mutate({ job_id: jobId, profile_id: "default", expected_profile_revision: profileVersion, mode }, { onSuccess: (saved) => setSelectedId(saved.resume_id) });
  };
  return <section className="section" aria-labelledby="resume-title">
    <h3 id="resume-title">Resume</h3>
    <p>Compose from approved wording, or make an editable copy of the full baseline.</p>
    <p>Saved default: {defaultMode === null ? "unavailable" : defaultMode === "baseline" ? "copy baseline" : "tailored composition"}.</p>
    <div className="toolbar"><Button type="button" disabled={profileVersion === null || defaultMode === null || (defaultMode === "tailored" && !tailoring.available) || compose.isPending || dirty} onClick={() => { if (defaultMode) start(defaultMode === "baseline" ? "baseline_copy" : "tailored"); }}>Compose resume</Button>
      <Button type="button" variant="outline" disabled={!tailoring.available || profileVersion === null || compose.isPending || dirty} onClick={() => start("tailored")}>Compose tailored resume</Button>
      <Button type="button" variant="outline" disabled={profileVersion === null || compose.isPending || dirty} onClick={() => start("baseline_copy")}>Copy baseline</Button></div>
    {!tailoring.available ? <p>{tailoring.reason}</p> : null}
    {profileVersion === null ? <p>Save a profile before composing a resume.</p> : null}
    {compose.error ? <p role="alert">{compose.error.message} Previously accepted resumes remain available.</p> : null}
    {list.isPending ? <p>Loading resumes…</p> : null}
    {list.error ? <p role="alert">{list.error.message}</p> : null}
    {list.data && list.data.length > 1 ? <label>Saved resume<select disabled={dirty} value={selected?.resume_id ?? ""} onChange={(event) => setSelectedId(event.currentTarget.value)}>
      {list.data.map((item) => <option value={item.resume_id} key={item.resume_id}>{item.resume_id}{item.accepted_revision_id ? " · accepted" : " · draft"}</option>)}
    </select></label> : null}
    {selected ? <ResumeWorkspace key={selected.resume_id} latest={selected} onDirtyChange={onDirtyChange} {...(onProfileChanged ? { onProfileChanged } : {})} /> : !list.isPending && !list.error ? <p>No resume has been composed for this job.</p> : null}
  </section>;
}
