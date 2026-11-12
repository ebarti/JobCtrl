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
  text: z.string(), definition: z.string(), scope: z.string(), tier: z.string(), weight: z.number(),
  qualifiers: z.array(z.object({ dimension: z.string(), value: z.string() }).passthrough()),
  source_id: z.string(), source_revision: z.number(), source_hash: z.string(),
  spans: z.array(z.object({ start: z.number(), end: z.number(), quote: z.string() }).passthrough()),
  extraction_determination_id: z.string(), equivalence_determination_ids: z.array(z.string()),
}).passthrough();
const requirementsSchema = z.object({
  job_id: z.string(), revision: z.number(), posting_revision: z.number(), posting_hash: z.string(),
  catalog_revision: z.number(), requirements: z.array(requirementSchema), stale: z.boolean(),
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
  return parsed.data;
}
async function writeRequirements(http: HttpPort, path: string, body: unknown): Promise<RequirementsSnapshot> {
  const value = await http.json<unknown>("POST", path, { body });
  try { return parseRequirements(value); }
  catch (error) { throw createUnconfirmedWriteError("POST", path, error); }
}

const catalogSchema = z.object({ catalog_revision: z.number(), total: z.number(), requirements: z.array(z.object({
  requirement_id: z.string(), revision: z.number(), definition: z.string(), scope: z.string(),
  qualifiers: z.array(z.object({ dimension: z.string(), value: z.string() })),
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
    <p>Select an existing qualified meaning after reviewing its definition and scope. The correction records your reason and preserves the previous snapshot.</p>
    {!availability.available ? <p>{availability.reason}</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); if (availability.available) setSearch(draftSearch); }}><label>Search catalog<input value={draftSearch} onChange={(event) => setDraftSearch(event.currentTarget.value)} disabled={!availability.available} /></label><Button type="submit" variant="outline" disabled={!availability.available}>Search catalog</Button></form>
    {catalog.error ? <p role="alert">{catalog.error.message}</p> : null}
    {catalog.data ? <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
      <p>{catalog.data.total} matching meanings; showing up to 50.</p>
      <form.Field name="requirementId">{(field) => <label>Qualified meaning<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}><option value="">Select a meaning</option>
        {catalog.data!.requirements.map((item) => <option key={item.requirement_id} value={item.requirement_id}>{item.definition} — {item.scope}{item.qualifiers.length ? ` (${item.qualifiers.map((q) => `${q.dimension}: ${q.value}`).join("; ")})` : ""}</option>)}
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

export function RequirementsPanel({ jobId, postingRevision }: { jobId: string; postingRevision: number | null }) {
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "rescoreJob");
  const query = useJobRequirements(jobId);
  const extract = useExtractRequirements(jobId);
  const snapshot = query.data;
  const revision = postingRevision ?? snapshot?.posting_revision ?? null;
  return <section className="section" aria-labelledby="requirements-title">
    <h3 id="requirements-title">Requirements</h3>
    <p>Requirements are bound to the captured posting and their recorded source spans.</p>
    {query.isPending ? <p>Loading requirements…</p> : null}
    {query.error ? <p role="alert">{query.error.message} {snapshot ? "The last accepted snapshot remains below." : ""}</p> : null}
    {snapshot?.stale ? <p role="status">This snapshot belongs to an earlier posting or catalog revision. Refresh to assess the current posting.</p> : null}
    {snapshot ? <>
      <p className="muted">Snapshot {snapshot.revision} · posting revision {snapshot.posting_revision} · catalog revision {snapshot.catalog_revision}</p>
      {snapshot.requirements.length ? <ul>{snapshot.requirements.map((requirement) => <li key={requirement.occurrence_id}>
        <strong>{requirement.text}</strong> <span>({requirement.tier}, weight {requirement.weight})</span>
        <p>{requirement.definition}</p>
        {requirement.qualifiers.length ? <p>Qualifiers: {requirement.qualifiers.map((qualifier) => `${qualifier.dimension}: ${qualifier.value}`).join("; ")}</p> : null}
        <details><summary>Source and determination</summary><p>Requirement {requirement.requirement_id}, revision {requirement.requirement_revision}; source {requirement.source_id}, revision {requirement.source_revision}.</p>
          {requirement.spans.map((span, index) => <blockquote key={`${span.start}:${span.end}:${index}`}>{span.quote}</blockquote>)}
          <p>Extraction {requirement.extraction_determination_id}{requirement.equivalence_determination_ids.length ? `; equivalence ${requirement.equivalence_determination_ids.join(", ")}` : ""}</p>
        </details>
        {revision !== null ? <BindingCorrection jobId={jobId} postingRevision={revision} snapshot={snapshot} occurrenceId={requirement.occurrence_id} /> : null}
      </li>)}</ul> : <p>No requirements were recorded in this snapshot.</p>}
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
