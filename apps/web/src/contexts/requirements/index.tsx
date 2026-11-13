import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import type { DomainEventEnvelope } from "../../shared/ports/EventStreamPort.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { Button } from "../../shared/ui/button.js";
import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";
import { getApiCapabilityAvailability } from "../../shared/lib/apiCapabilityAvailability.js";
import type { HttpPort } from "../../shared/ports/HttpPort.js";

export { useRequirementCatalog, useRequirementDetail, useRequirementHistory, useRequirementMeaningCorrection,
  requirementLibraryKeys, canonicalRequirementSchema } from "./library.js";
export type { CanonicalRequirement, RequirementDetail, RequirementHistory, RequirementHistoryKind,
  RequirementOccurrence, RequirementCatalog, RequirementMeaningCorrection } from "./library.js";

const requirementSchema = z.object({
  occurrence_id: z.string(), requirement_id: z.string(), requirement_revision: z.number(),
  text: z.string().optional(), definition: z.string(), contract_version: z.string().optional(),
  category: z.enum(["skill", "professional_experience"]).optional(), name: z.string().optional(),
  basis: z.enum(["explicit", "inferred", "explicit_and_inferred"]).optional(), rationale: z.string().nullable().optional(), source_note: z.string().nullable().optional(),
  scope: z.string().optional(), tier: z.string().optional(), weight: z.number().optional(),
  qualifiers: z.array(z.object({ dimension: z.string(), value: z.string() }).passthrough()).optional(),
  source_id: z.string(), source_revision: z.number(), source_hash: z.string(),
  spans: z.array(z.object({ start: z.number(), end: z.number(), quote: z.string() }).passthrough()),
  extraction_determination_id: z.string(), equivalence_determination_ids: z.array(z.string()),
}).passthrough();
const directDemandSchema = z.object({
  requirement_id: z.string(), revision: z.number(), category: z.enum(["education", "language"]),
  qualification: z.string().optional(), subjects: z.array(z.string()).optional(), alternative: z.string().nullable().optional(),
  language: z.string().optional(), proficiency: z.string().nullable().optional(), source_note: z.string().nullable().optional(),
  source_id: z.string(), source_revision: z.number(),
  spans: z.array(z.object({ start: z.number(), end: z.number(), quote: z.string() }).passthrough()),
}).passthrough();
const requirementsSchema = z.object({
  job_id: z.string(), revision: z.number(), posting_revision: z.number(), posting_hash: z.string(),
  catalog_revision: z.number(), requirements: z.array(requirementSchema), stale: z.boolean(),
  contract_version: z.string().optional(), status: z.enum(["complete", "unsupported_language"]).optional(), stale_reasons: z.array(z.string()).optional(),
  language: z.object({ classification: z.enum(["english", "non_english", "uncertain"]), reason: z.string(),
    evidence_refs: z.array(z.string()) }).passthrough().optional(),
  quotes: z.array(z.object({ evidence_id: z.string(), source_id: z.string(), quote: z.string(), start: z.number(), end: z.number() }).passthrough()).optional(),
  education: z.array(directDemandSchema).optional(), languages: z.array(directDemandSchema).optional(), unresolved: z.array(z.unknown()).optional(),
  latest_attempt: z.unknown().nullable(),
}).passthrough();
export type RequirementsSnapshot = z.infer<typeof requirementsSchema>;
export const requirementsKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "requirements"] as const,
  job: (tenantId: string, jobId: string) => [...requirementsKeys.all(tenantId), "job", jobId] as const,
  catalog: (tenantId: string, q: string) => [...requirementsKeys.all(tenantId), "catalog", q] as const,
};
function parseRequirements(value: unknown): RequirementsSnapshot {
  const parsed = requirementsSchema.safeParse(value);
  if (!parsed.success) throw new Error("The requirements response is invalid. Refresh to verify the saved snapshot.");
  if (parsed.data.contract_version !== "requirements-v2") return { ...parsed.data, stale: true,
    stale_reasons: [...new Set([...(parsed.data.stale_reasons ?? []), "contract_changed"])] };
  return parsed.data;
}
async function writeRequirements(http: HttpPort, path: string, body: unknown): Promise<RequirementsSnapshot> {
  const value = await http.json<unknown>("POST", path, { body });
  try { return parseRequirements(value); }
  catch (error) { throw createUnconfirmedWriteError("POST", path, error); }
}

const catalogSchema = z.object({ catalog_revision: z.number(), total: z.number(), requirements: z.array(z.object({
  requirement_id: z.string(), revision: z.number(), definition: z.string(), contract_version: z.literal("requirements-v2"),
  category: z.enum(["skill", "professional_experience"]), name: z.string(),
}).passthrough()) }).passthrough();
const correctionSchema = z.object({ requirementId: z.string().min(1), reason: z.string().trim().min(1) });
function BindingCorrection({ jobId, postingRevision, snapshot, occurrenceId }: {
  jobId: string; postingRevision: number; snapshot: RequirementsSnapshot; occurrenceId: string;
}) {
  const tenantId = useTenantId(); const { http, featureFlags } = usePorts(); const client = useQueryClient();
  const availability = getApiCapabilityAvailability(featureFlags, "rescoreJob");
  const [draftSearch, setDraftSearch] = useState(""); const [search, setSearch] = useState(""); const [open, setOpen] = useState(false); const [validation, setValidation] = useState("");
  const catalog = useQuery({ queryKey: requirementsKeys.catalog(tenantId, search), enabled: open && availability.available,
    queryFn: async () => {
      const parsed = catalogSchema.safeParse(await http.json<unknown>("GET", "/v1/requirements", { query: { q: search, limit: 50, offset: 0 } }));
      if (!parsed.success) throw new Error("The requirement catalog response is invalid.");
      return parsed.data;
    }, meta: { suppressGlobalErrorToast: true },
  });
  const correct = useMutation({ mutationFn: async (body: { requirement_id: string; requirement_revision: number; reason: string }) =>
    writeRequirements(http, `/v1/jobs/${encodeURIComponent(jobId)}/requirements/${encodeURIComponent(occurrenceId)}/binding`, {
      ...body, expected_revision: snapshot.revision, expected_posting_revision: postingRevision,
    }), onSuccess: (updated) => { client.setQueryData<RequirementsSnapshot | null>(requirementsKeys.job(tenantId, jobId), (current) => current && current.revision > updated.revision ? current : updated); },
  });
  const form = useForm({ defaultValues: { requirementId: "", reason: "" }, onSubmit: ({ value }) => {
    if (!availability.available) return;
    const parsed = correctionSchema.safeParse(value);
    const meaning = catalog.data?.requirements.find((item) => item.requirement_id === value.requirementId);
    if (!parsed.success || !meaning) { setValidation("Choose a catalog meaning and enter a reason."); return; }
    setValidation(""); correct.mutate({ requirement_id: meaning.requirement_id, requirement_revision: meaning.revision, reason: parsed.data.reason });
  } });
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Correct catalog binding</summary>
    <p>Select an existing meaning after reviewing its category and definition. The correction records your reason and preserves the previous snapshot.</p>
    {!availability.available ? <p>{availability.reason}</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); if (availability.available) setSearch(draftSearch); }}><label>Search catalog<input value={draftSearch} onChange={(event) => setDraftSearch(event.currentTarget.value)} disabled={!availability.available} /></label><Button type="submit" variant="outline" disabled={!availability.available}>Search catalog</Button></form>
    {catalog.error ? <p role="alert">{catalog.error.message}</p> : null}
    {catalog.data ? <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
      <p>{catalog.data.total} matching meanings; showing up to 50.</p>
      <form.Field name="requirementId">{(field) => <label>Qualified meaning<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}><option value="">Select a meaning</option>
        {catalog.data!.requirements.map((item) => <option key={item.requirement_id} value={item.requirement_id}>{item.name} — {item.category === "skill" ? "Skill" : "Professional experience"}: {item.definition}</option>)}
      </select></label>}</form.Field>
      <form.Field name="reason">{(field) => <label>Reason<textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
      <Button type="submit" disabled={correct.isPending}>Save binding correction</Button>
    </form> : null}
    {validation ? <p role="alert">{validation}</p> : null}
    {correct.error ? <p role="alert">{correct.error.message} The last accepted snapshot remains available.</p> : null}
  </details>;
}
export function useJobRequirements(jobId: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: requirementsKeys.job(tenantId, jobId),
    queryFn: async () => {
      const value = await http.json<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/requirements`);
      return value === null ? null : parseRequirements(value);
    },
    meta: { suppressGlobalErrorToast: true },
  });
}
export function useExtractRequirements(jobId: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: { expected_posting_revision: number; expected_revision: number; force?: boolean }) =>
      writeRequirements(http, `/v1/jobs/${encodeURIComponent(jobId)}/requirements`, body),
    onSuccess: (snapshot) => { client.setQueryData<RequirementsSnapshot | null>(requirementsKeys.job(tenantId, jobId), (current) => current && current.revision > snapshot.revision ? current : snapshot); },
  });
}

function categoryLabel(category: string | undefined) {
  return category === "skill" ? "Skill" : category === "professional_experience" ? "Professional experience"
    : category === "education" ? "Education" : category === "language" ? "Language" : "Historical requirement";
}

export function RequirementsPanel({ jobId, postingRevision }: { jobId: string; postingRevision: number | null }) {
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "rescoreJob");
  const query = useJobRequirements(jobId);
  const extract = useExtractRequirements(jobId);
  const snapshot = query.data;
  const revision = postingRevision ?? snapshot?.posting_revision ?? null;
  const historical = Boolean(snapshot && snapshot.contract_version !== "requirements-v2");
  const directDemands = [...(snapshot?.education ?? []), ...(snapshot?.languages ?? [])];
  return <section className="section" aria-labelledby="requirements-title">
    <h3 id="requirements-title">Posting requirements</h3>
    <p>Skills and professional experience use the reusable catalog. Education and languages stay with this job and use their matching Profile sections.</p>
    {query.isPending ? <p>Loading requirements…</p> : null}
    {query.error ? <p role="alert">{query.error.message} {snapshot ? "The last accepted snapshot remains below." : ""}</p> : null}
    {historical ? <p role="status">The requirements contract changed. This historical snapshot is retained for inspection. Refresh requirements manually to extract the current categories.</p>
      : snapshot?.stale ? <p role="status">This snapshot belongs to earlier saved inputs. Refresh requirements manually to assess the current posting.</p> : null}
    {snapshot ? <>
      <p className="muted">Snapshot {snapshot.revision} · posting revision {snapshot.posting_revision} · catalog revision {snapshot.catalog_revision}{historical ? " · historical contract" : ""}</p>
      {snapshot.status === "unsupported_language" ? <p role="status">This posting was skipped because its recorded language is not English. Requirement extraction and person-fit scoring did not run.</p> : null}
      {snapshot.language ? <details><summary>Posting language and source evidence</summary>
        <p>{snapshot.language.classification === "english" ? "English" : snapshot.language.classification === "non_english" ? "Non-English" : "Language uncertain"}: {snapshot.language.reason}</p>
        {snapshot.language.evidence_refs.map((id) => { const quote = snapshot.quotes?.find((item) => item.evidence_id === id);
          return quote ? <blockquote key={id}>{quote.quote}<footer>Posting source {quote.source_id}</footer></blockquote> : <p key={id}>Recorded evidence {id}; its source quote is unavailable in this snapshot.</p>;
        })}
      </details> : null}
      {snapshot.requirements.length ? <><h4>Reusable skills and professional experience</h4><ul>{snapshot.requirements.map((requirement) => <li key={requirement.occurrence_id}>
        <strong>{requirement.name ?? requirement.text ?? requirement.definition}</strong> <span>· {categoryLabel(requirement.category)}</span>
        <p>{requirement.definition}</p>
        {requirement.basis ? <p className="muted">Posting basis: {requirement.basis.replaceAll("_", " ")}</p> : null}
        {requirement.rationale ? <p>{requirement.rationale}</p> : null}
        {requirement.source_note ? <p>Posting context: {requirement.source_note}</p> : null}
        {historical && (requirement.tier || requirement.weight !== undefined) ? <p className="muted">Historical metadata: {requirement.tier?.replaceAll("_", " ")}{requirement.weight !== undefined ? ` · weight ${requirement.weight}` : ""}. This is not current scoring policy.</p> : null}
        <details><summary>Posting source and catalog binding</summary><p>Extracted meaning: {requirement.definition}</p><p>Requirement {requirement.requirement_id}, revision {requirement.requirement_revision}; source {requirement.source_id}, revision {requirement.source_revision}.</p>
          {requirement.spans.map((span, index) => <blockquote key={`${span.start}:${span.end}:${index}`}>{span.quote}</blockquote>)}
          <p>Extraction {requirement.extraction_determination_id}{requirement.equivalence_determination_ids.length ? `; equivalence ${requirement.equivalence_determination_ids.join(", ")}` : ""}</p>
        </details>
        {!historical && revision !== null ? <BindingCorrection jobId={jobId} postingRevision={revision} snapshot={snapshot} occurrenceId={requirement.occurrence_id} /> : null}
      </li>)}</ul></> : snapshot.status !== "unsupported_language" ? <p>No reusable skills or professional-experience requirements were recorded.</p> : null}
      {directDemands.length ? <><h4>Education and language demands</h4><p>Each demand counts once toward person fit. These demands do not enter the reusable catalog or request achievement wording.</p>
        <ul>{directDemands.map((demand) => <li key={demand.requirement_id}>
          <strong>{demand.category === "education" ? demand.qualification : demand.language}</strong> <span>· {categoryLabel(demand.category)}</span>
          {demand.category === "education" ? <>
            {demand.subjects?.length ? <p>Subjects: {demand.subjects.join("; ")}</p> : null}
            {demand.alternative ? <p>Posting permits an alternative: {demand.alternative}. An experience route does not assert a degree.</p> : null}
            <p className="muted">Evidence section: Education{demand.alternative ? "; professional experience for the stated alternative" : ""}.</p>
          </> : <><p>Required proficiency: {demand.proficiency ?? "Not specified in the posting"}.</p><p className="muted">Evidence section: Languages / Proficiency.</p></>}
          {demand.source_note ? <p>Posting context: {demand.source_note}</p> : null}
          <details><summary>Posting source</summary><p>Job-local demand {demand.requirement_id}, revision {demand.revision}; source {demand.source_id}, revision {demand.source_revision}.</p>
            {demand.spans.map((span, index) => <blockquote key={`${span.start}:${span.end}:${index}`}>{span.quote}</blockquote>)}
          </details>
        </li>)}</ul></> : null}
      {snapshot.unresolved?.length ? <details><summary>Unresolved posting ambiguities ({snapshot.unresolved.length})</summary><pre>{JSON.stringify(snapshot.unresolved, null, 2)}</pre></details> : null}
    </> : !query.isPending && !query.error ? <p>No requirements have been extracted for this posting.</p> : null}
    <Button type="button" disabled={!availability.available || revision === null || extract.isPending || query.isPending} onClick={() => {
      if (availability.available && revision !== null) extract.mutate({ expected_posting_revision: revision, expected_revision: snapshot?.revision ?? 0 });
    }}>{extract.isPending ? "Extracting requirements…" : snapshot ? "Refresh requirements" : "Extract requirements"}</Button>
    {!availability.available ? <p>{availability.reason}</p> : null}
    {revision === null ? <p>Posting revision is unavailable; reload the job before extracting.</p> : null}
    {extract.error ? <p role="alert">{extract.error.message} {snapshot ? "The last accepted snapshot remains available above." : "No snapshot is shown."}</p> : null}
  </section>;
}

export const requirementsInvalidation = {
  eventTypes: ["RequirementBindingCorrected", "RequirementsUpdated", "RequirementMeaningRevised", "JobCaptured", "JobSourceObserved", "JobUpdated"] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) {
    void invalidateQueriesWithOptimisticOwnership(client, requirementsKeys.all(event.tenantId));
  },
};
