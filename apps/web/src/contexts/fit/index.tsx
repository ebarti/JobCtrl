export { AssociationStateAction, RequirementAssociationPicker, requirementQualifierText, achievementChoices, type AchievementChoice, type LibraryRequirement, type UserAssociation } from "./components/RequirementAssociationPicker.js";
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
export { AffectedMatchesPanel } from "./refresh.js";
export { useRequirementLibrary, useRequirementAssociationActions, useRequirementAssociationHistory,
  requirementRelationshipKeys, useCurrentWordingActions, useCurrentWordingHistory } from "./requirement-library.js";
export type { RequirementLibrary, RequirementLibraryEntry, RequirementAssociation, RequirementAssessment,
  RequirementCoverage, RequirementAssociationHistory, CreateRequirementAssociation, ReviseRequirementAssociation,
  CurrentWordingAssignment, CurrentWordingHistory, SetCurrentWording } from "./requirement-library.js";

const evidenceSchema = z.object({ source_id: z.string(), revision: z.union([z.number(), z.string()]), quote: z.string() }).passthrough();
const assessmentSchema = z.object({
  assessment_id: z.string(), requirement_id: z.string(), requirement_revision: z.number(), text: z.string(),
  definition: z.string(), scope: z.string(), tier: z.string(), weight: z.number(),
  kind: z.enum(["matched", "transferable", "missing", "blocked", "not_assessed"]),
  strength: z.string().nullable(), confidence: z.string(), rationale: z.string(), evidence_refs: z.array(evidenceSchema),
  achievement_ids: z.array(z.string()), determination_id: z.string(), origin: z.string(),
  eligibility: z.enum(["eligible", "warning", "blocked", "unknown"]), blocker_category: z.string().nullable(), warning_category: z.string().nullable(),
  contribution: z.object({ max_points: z.number(), awarded_points: z.number() }).passthrough(),
}).passthrough();
const scoreSchema = z.object({
  revision: z.number(), score: z.number(), computed_score: z.number(), fit_band: z.string(), confidence: z.string(),
  eligibility: z.object({ status: z.string(), blockers: z.array(z.object({ requirement_id: z.string(), rationale: z.string(), evidence_refs: z.array(evidenceSchema) }).passthrough()), warnings: z.array(z.object({ requirement_id: z.string(), rationale: z.string(), evidence_refs: z.array(evidenceSchema) }).passthrough()) }).passthrough(),
  assessments: z.array(assessmentSchema),
  source_binding: z.object({ profile_revision: z.number(), fact_semantics_version: z.number(), requirements_revision: z.number(), posting_revision: z.number() }).passthrough(),
}).passthrough();
const coverageSchema = z.object({
  status: z.string(),
  relations: z.array(z.object({ requirement_id: z.string(), achievement_id: z.string(), variant_id: z.string(), status: z.string(), determination_id: z.string().nullable() }).passthrough()),
  wording_gaps: z.array(z.object({ requirement_id: z.string(), status: z.string(), proposal_id: z.string().nullable().optional(), proposal_status: z.string().nullable().optional() }).passthrough()),
}).passthrough();
const fitSchema = z.object({
  job_id: z.string(), current: z.boolean(), stale_reasons: z.array(z.string()),
  score: scoreSchema.nullable(), coverage: coverageSchema.nullable(),
}).passthrough();
const evidenceUsageSchema = z.object({
  job_id: z.string(), score_revision: z.number(), requirement_id: z.string(), kind: z.string(),
  evidence_ref: evidenceSchema, determination_id: z.string(), current: z.boolean(),
}).passthrough();
const evidenceMapSchema = z.object({
  profile_id: z.string(),
  sources: z.array(z.object({ source_id: z.string(), usages: z.array(evidenceUsageSchema) }).passthrough()),
  gaps: z.array(z.object({ job_id: z.string(), current: z.boolean(), score_revision: z.number(),
    requirement_id: z.string(), requirement_revision: z.number(), text: z.string(), kind: z.string(),
    tier: z.string(), weight: z.number(), rationale: z.string(), determination_id: z.string() }).passthrough()),
  coverage: z.array(z.object({ job_id: z.string(), current: z.boolean(), score_revision: z.number(),
    requirement_id: z.string(), requirement_revision: z.number(), achievement_id: z.string(), variant_id: z.string(),
    variant_revision: z.number(), status: z.string(), covered: z.boolean(), determination_id: z.string().nullable(),
    source_refs: z.array(z.object({ source_id: z.string(), revision: z.union([z.number(), z.string()]) }).passthrough()),
  }).passthrough()),
  wording_gaps: z.array(z.object({ job_id: z.string(), current: z.boolean(), score_revision: z.number(),
    requirement_id: z.string(), requirement_revision: z.number(), status: z.string(), person_qualification: z.string(),
  }).passthrough()),
}).passthrough();
const correctionSchema = z.object({ score: z.coerce.number().int().min(1).max(10), rationale: z.string().trim().min(1) });
export type FitSnapshot = z.infer<typeof fitSchema>;
export type FitEvidenceMap = z.infer<typeof evidenceMapSchema>;
export const fitKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "fit"] as const,
  job: (tenantId: string, jobId: string) => [...fitKeys.all(tenantId), "job", jobId] as const,
};
function parseFit(value: unknown): FitSnapshot {
  const parsed = fitSchema.safeParse(value);
  if (!parsed.success) throw new Error("The fit response is invalid. Refresh to verify the saved assessment.");
  return parsed.data;
}
async function writeFit(http: HttpPort, path: string, body: unknown): Promise<FitSnapshot> {
  const value = await http.json<unknown>("POST", path, { body });
  try { return parseFit(value); }
  catch (error) { throw createUnconfirmedWriteError("POST", path, error); }
}
export function useJobFit(jobId: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({ queryKey: fitKeys.job(tenantId, jobId),
    queryFn: async () => parseFit(await http.json<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/fit`)),
    meta: { suppressGlobalErrorToast: true },
  });
}
export function useFitEvidenceMap() {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: [...fitKeys.all(tenantId), "evidence-map"], queryFn: async () => {
    const result = evidenceMapSchema.safeParse(await http.json<unknown>("GET", "/v1/fit/evidence-map"));
    if (!result.success) throw new Error("The recorded evidence map response is invalid. Refresh to verify the saved connections.");
    return result.data;
  }, meta: { suppressGlobalErrorToast: true } });
}
export function useFitSummaries(jobIds: readonly string[]) {
  const tenantId = useTenantId(); const { http } = usePorts();
  const ids = [...new Set(jobIds)].sort();
  return useQuery({ queryKey: [...fitKeys.all(tenantId), "summaries", ids], enabled: ids.length > 0,
    queryFn: async () => {
      const response = z.object({ summaries: z.record(z.string(), fitSchema) }).safeParse(await http.json<unknown>("POST", "/v1/fit/summaries", { body: { job_ids: ids } }));
      if (!response.success) throw new Error("The person-fit summaries response is invalid.");
      return response.data.summaries;
    }, meta: { suppressGlobalErrorToast: true },
  });
}
function useFitActions(jobId: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  const accept = () => client.invalidateQueries({ queryKey: fitKeys.job(tenantId, jobId) });
  const assess = useMutation({
    mutationFn: async (body: { profile_id: string; expected_revision: number; prepare_wording?: boolean; prepare_coverage?: boolean }) =>
      writeFit(http, `/v1/jobs/${encodeURIComponent(jobId)}/fit/assess`, body),
    onSuccess: accept,
  });
  const correct = useMutation({
    mutationFn: async (body: { expected_revision: number; score: number; rationale: string }) =>
      writeFit(http, `/v1/jobs/${encodeURIComponent(jobId)}/fit/correct`, body),
    onSuccess: accept,
  });
  const correctRequirement = useMutation({
    mutationFn: ({ requirementId, body }: { requirementId: string; body: Record<string, unknown> }) =>
      http.json<unknown>("POST", `/v1/fit/requirements/${encodeURIComponent(requirementId)}/correct`, { body }),
    onSuccess: () => client.invalidateQueries({ queryKey: fitKeys.job(tenantId, jobId) }),
  });
  return { assess, correct, correctRequirement };
}

function CorrectionForm({ score, revision, onSave, pending }: {
  score: number; revision: number; onSave: (body: { expected_revision: number; score: number; rationale: string }) => void; pending: boolean;
}) {
  const form = useForm({ defaultValues: { score: String(score), rationale: "" }, onSubmit: ({ value }) => {
    const parsed = correctionSchema.safeParse(value);
    if (parsed.success) onSave({ expected_revision: revision, ...parsed.data });
  } });
  return <details><summary>Correct this assessment</summary><form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
    <form.Field name="score">{(field) => <label>Corrected score (1–10)<input type="number" min="1" max="10" step="1" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
    <form.Field name="rationale">{(field) => <label>Reason for correction<textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
    <Button type="submit" disabled={pending}>Save correction</Button>
  </form></details>;
}

type EvidenceOption = { source_id: string; revision: number; text: string; kind: string; confirmation: string };
type AchievementOption = { achievement_id: string };
function RequirementCorrection({ assessment, factVersion, sources, achievements, disabled, unavailableReason, onSave }: {
  assessment: z.infer<typeof assessmentSchema>; factVersion: number; sources: readonly EvidenceOption[];
  achievements: readonly AchievementOption[]; disabled: boolean; unavailableReason: string | null;
  onSave: (requirementId: string, body: Record<string, unknown>) => void;
}) {
  const [validation, setValidation] = useState("");
  const form = useForm({ defaultValues: {
    kind: assessment.kind as string, strength: assessment.strength ?? "direct", confidence: assessment.confidence,
    rationale: assessment.rationale, eligibility: assessment.eligibility, blocker: assessment.blocker_category ?? "qualification",
    warning: assessment.warning_category ?? "other", evidence: {} as Record<string, string>,
    retainedRefs: assessment.evidence_refs.map((_, index) => index),
    achievementIds: assessment.achievement_ids,
  }, onSubmit: ({ value }) => {
    if (disabled) return;
    const schema = z.object({ kind: z.enum(["matched", "transferable", "missing", "blocked", "not_assessed"]),
      strength: z.enum(["direct", "strong"]), confidence: z.enum(["high", "medium", "low"]), rationale: z.string().refine((text) => text.trim().length > 0),
      eligibility: z.enum(["eligible", "warning", "blocked", "unknown"]), blocker: z.string(), warning: z.string(),
      evidence: z.record(z.string(), z.string()), retainedRefs: z.array(z.number().int().nonnegative()), achievementIds: z.array(z.string()),
    });
    const parsed = schema.safeParse(value);
    if (!parsed.success) { setValidation("Choose a valid determination and provide a reason."); return; }
    const refs: Array<{ source_id: string; revision: number | string; quote: string }> = [];
    for (const index of parsed.data.retainedRefs) {
      const reference = assessment.evidence_refs[index];
      if (!reference) { setValidation("A selected evidence reference is unavailable. Reload the assessment."); return; }
      refs.push(reference);
    }
    for (const [id, quote] of Object.entries(parsed.data.evidence)) {
      if (!quote.trim()) continue;
      const source = sources.find((item) => item.source_id === id);
      if (source && source.text.includes(quote)) refs.push({ source_id: id, revision: source.revision, quote });
      else { setValidation("Each evidence quote must match its saved source exactly."); return; }
    }
    setValidation("");
    onSave(assessment.requirement_id, { expected_assessment_id: assessment.assessment_id, expected_fact_semantics_version: factVersion,
      requirement_revision: assessment.requirement_revision, kind: parsed.data.kind,
      strength: parsed.data.kind === "matched" ? parsed.data.strength : null, confidence: parsed.data.confidence,
      rationale: parsed.data.rationale, evidence_refs: refs, achievement_ids: parsed.data.achievementIds,
      eligibility: parsed.data.eligibility, blocker_category: parsed.data.eligibility === "blocked" ? parsed.data.blocker : null,
      warning_category: parsed.data.eligibility === "warning" ? parsed.data.warning : null, profile_id: "default" });
  } });
  return <details><summary>Correct this requirement assessment</summary>
    <p>Choose a determination and cite the exact saved evidence. This records your correction; use Update affected matches afterward to recalculate the score.</p>
    {unavailableReason ? <p>{unavailableReason}</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
      <form.Field name="kind">{(field) => <label>Qualification<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}>{["matched", "transferable", "missing", "blocked", "not_assessed"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>}</form.Field>
      <form.Field name="strength">{(field) => <label>Matched strength<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}><option value="direct">Direct</option><option value="strong">Strong</option></select></label>}</form.Field>
      <form.Field name="confidence">{(field) => <label>Confidence<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>}</form.Field>
      <form.Field name="eligibility">{(field) => <label>Eligibility<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value as typeof field.state.value)}>{["unknown", "eligible", "warning", "blocked"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}</form.Field>
      <form.Field name="blocker">{(field) => <label>Blocker category (if blocked)<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}>{["work_authorization", "application_language", "seniority", "explicit_exclusion", "clearance", "citizenship", "qualification"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>}</form.Field>
      <form.Field name="warning">{(field) => <label>Warning category (if warning)<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}>{["compensation_preference", "location_preference", "work_model_preference", "uncertain_constraint", "other"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>}</form.Field>
      <form.Field name="rationale">{(field) => <label>Reason<textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
      <form.Field name="retainedRefs">{(field) => <fieldset><legend>Previously recorded evidence</legend>{assessment.evidence_refs.map((ref, index) => <label key={`${ref.source_id}:${index}`}><input type="checkbox" checked={field.state.value.includes(index)} onChange={(event) => field.handleChange(event.currentTarget.checked ? [...field.state.value, index] : field.state.value.filter((item) => item !== index))} /> {ref.source_id}, revision {ref.revision}: {ref.quote}</label>)}</fieldset>}</form.Field>
      <form.Field name="evidence">{(field) => <fieldset><legend>Add exact evidence quotes</legend>
        {sources.map((source) => <details key={source.source_id}><summary>{source.kind} · {source.source_id} · {source.confirmation}</summary><p>{source.text}</p><label>Quote from this source<textarea value={field.state.value[source.source_id] ?? ""} onChange={(event) => field.handleChange({ ...field.state.value, [source.source_id]: event.currentTarget.value })} /></label></details>)}
      </fieldset>}</form.Field>
      <form.Field name="achievementIds">{(field) => <fieldset><legend>Supported achievements</legend>{achievements.map((item) => <label key={item.achievement_id}><input type="checkbox" checked={field.state.value.includes(item.achievement_id)} onChange={(event) => field.handleChange(event.currentTarget.checked ? [...field.state.value, item.achievement_id] : field.state.value.filter((id) => id !== item.achievement_id))} /> {item.achievement_id}</label>)}</fieldset>}</form.Field>
      <Button type="submit" disabled={disabled}>Save requirement correction</Button>
    </form>
    {validation ? <p role="alert">{validation}</p> : null}
  </details>;
}

export function PersonFitPanel({ jobId, sources = [], achievements = [], defaultMode = null, managedPreparation = false }: { jobId: string; sources?: readonly EvidenceOption[]; achievements?: readonly AchievementOption[]; defaultMode?: "baseline" | "tailored" | null; managedPreparation?: boolean }) {
  const { featureFlags } = usePorts();
  const assessmentAvailability = getApiCapabilityAvailability(featureFlags, "rescoreJob");
  const query = useJobFit(jobId);
  const { assess, correct, correctRequirement } = useFitActions(jobId);
  const fit = query.data;
  const busy = assess.isPending || correct.isPending || correctRequirement.isPending;
  const runAssessment = () => { if (assessmentAvailability.available) assess.mutate({ profile_id: "default", expected_revision: fit?.score?.revision ?? 0,
    prepare_wording: false, prepare_coverage: defaultMode === "tailored" }); };
  return <section className="section" aria-labelledby="person-fit-title">
    <h3 id="person-fit-title">Person fit</h3>
    <p>This assessment describes your evidence against the role. Missing approved wording does not lower person fit.</p>
    {query.isPending ? <p>Loading person fit…</p> : null}
    {query.error ? <p role="alert">{query.error.message} {fit?.score ? "The last accepted assessment remains below." : ""}</p> : null}
    {fit && !fit.current && fit.score ? <p role="status">This assessment is out of date: {fit.stale_reasons.join("; ") || "a source changed"}. The prior assessment remains available.</p> : null}
    {fit?.score ? <>
      <p><strong>Score {fit.score.score}/10</strong> · {fit.score.fit_band} · confidence {fit.score.confidence} · eligibility {fit.score.eligibility.status}</p>
      {fit.score.eligibility.blockers.length || fit.score.eligibility.warnings.length ? <details><summary>Eligibility reasons</summary>
        {[...fit.score.eligibility.blockers, ...fit.score.eligibility.warnings].map((item, index) => <div key={`${item.requirement_id}:${index}`}><p>{item.requirement_id}: {item.rationale}</p>{item.evidence_refs.map((ref, refIndex) => <blockquote key={`${ref.source_id}:${refIndex}`}>{ref.quote}<footer>{ref.source_id}, revision {ref.revision}</footer></blockquote>)}</div>)}
      </details> : null}
      <details><summary>Assessment source versions</summary><p className="muted">Profile revision {fit.score.source_binding.profile_revision} · requirements revision {fit.score.source_binding.requirements_revision} · posting revision {fit.score.source_binding.posting_revision}</p></details>
      <ul>{fit.score.assessments.map((assessment) => <li key={assessment.assessment_id}>
        <strong>{assessment.text}</strong> — {assessment.kind}; {assessment.contribution.awarded_points}/{assessment.contribution.max_points} points.
        <p>{assessment.rationale}</p>
        <details><summary>Evidence and provenance</summary>
          <p>Requirement {assessment.requirement_id}, revision {assessment.requirement_revision}; determination {assessment.determination_id}; {assessment.origin}; confidence {assessment.confidence}.</p>
          {assessment.evidence_refs.length ? assessment.evidence_refs.map((ref, index) => <blockquote key={`${ref.source_id}:${ref.revision}:${index}`}>{ref.quote}<footer>{ref.source_id}, revision {ref.revision}</footer></blockquote>) : <p>No source evidence recorded.</p>}
        </details>
        <RequirementCorrection assessment={assessment} factVersion={fit.score!.source_binding.fact_semantics_version} sources={sources} achievements={achievements} disabled={!assessmentAvailability.available || busy || !fit.current} unavailableReason={assessmentAvailability.available ? null : assessmentAvailability.reason} onSave={(requirementId, body) => correctRequirement.mutate({ requirementId, body })} />
      </li>)}</ul>
      <CorrectionForm key={fit.score.revision} score={fit.score.score} revision={fit.score.revision} pending={busy} onSave={(body) => correct.mutate(body)} />
    </> : fit ? <p>No person-fit assessment has been recorded yet.</p> : null}
    {fit && !fit.score && !managedPreparation ? <div className="toolbar">
      <Button type="button" disabled={!assessmentAvailability.available || busy || query.isPending} onClick={runAssessment}>{assess.isPending ? "Assessing…" : "Assess person fit"}</Button>
    </div> : null}
    {!assessmentAvailability.available ? <p>{assessmentAvailability.reason}</p> : null}
    {assess.error || correct.error || correctRequirement.error ? <p role="alert">{(assess.error ?? correct.error ?? correctRequirement.error)?.message} {fit?.score ? "The previously loaded assessment remains available above." : "No assessment is shown."}</p> : null}
    {correctRequirement.isSuccess ? <p role="status">Requirement correction recorded. Use Update affected matches to recalculate this job's score.</p> : null}
    <h4>Approved wording coverage</h4>
    <p>This records whether approved wording expresses requirements; it is separate from your person-fit score.</p>
    {fit?.coverage ? <>
      <p>Status: {fit.coverage.status}</p>
      {fit.coverage.wording_gaps.length ? <ul>{fit.coverage.wording_gaps.map((gap) => <li key={gap.requirement_id}>{fit.score?.assessments.find((assessment) => assessment.requirement_id === gap.requirement_id)?.text ?? "Requirement details unavailable"}: {gap.status.replaceAll("_", " ")}{gap.proposal_status ? `; proposal ${gap.proposal_status}` : ""}</li>)}</ul> : <p>No wording gaps recorded.</p>}
      {fit.coverage.relations.length ? <details><summary>Recorded wording relations</summary><ul>{fit.coverage.relations.map((relation) => <li key={`${relation.requirement_id}:${relation.variant_id}`}>Requirement {relation.requirement_id}: {relation.status}, achievement {relation.achievement_id}, wording {relation.variant_id}{relation.determination_id ? `, determination ${relation.determination_id}` : "; no determination recorded"}</li>)}</ul></details> : null}
    </> : <p>Wording coverage has not been recorded.</p>}
  </section>;
}

export const fitInvalidation = {
  eventTypes: ["FitAssessed", "FitCorrected", "FitRequirementCorrected", "FitCoverageUpdated", "FitRefreshUpdated", "FitAssociationUpdated", "FitCurrentWordingUpdated", "ProfileUpdated", "ProfileWordingUpdated", "ProfileSourceUpdated", "JobCaptured", "JobSourceObserved", "JobUpdated", "RequirementBindingCorrected", "RequirementsUpdated", "RequirementMeaningRevised"] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) { void invalidateQueriesWithOptimisticOwnership(client, fitKeys.all(event.tenantId)); },
};
