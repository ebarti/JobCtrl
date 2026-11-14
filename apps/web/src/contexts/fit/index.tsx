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
import "../../styles/redesign-fit.css";
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
  definition: z.string(), contract_version: z.string().optional(), category: z.enum(["skill", "professional_experience", "education", "language"]).optional(), name: z.string().optional(),
  scope: z.string().optional(), tier: z.string().optional(), weight: z.number().optional(),
  evidence_route: z.enum(["education", "equivalent_experience"]).nullable().optional(),
  wording_support: z.enum(["section", "achievement", "none"]).optional(), source_note: z.string().nullable().optional(),
  kind: z.enum(["matched", "transferable", "missing", "blocked", "not_assessed"]),
  strength: z.string().nullable(), confidence: z.string(), rationale: z.string(), evidence_refs: z.array(evidenceSchema),
  achievement_ids: z.array(z.string()), determination_id: z.string(), origin: z.string(),
  eligibility: z.enum(["eligible", "warning", "blocked", "unknown"]), blocker_category: z.string().nullable(), warning_category: z.string().nullable(),
  contribution: z.object({ max_points: z.number(), awarded_points: z.number() }).passthrough(),
}).passthrough();
const scoreSchema = z.object({
  revision: z.number(), score: z.number().nullable(), computed_score: z.number().nullable(), fit_band: z.string().nullable(), confidence: z.string().nullable(),
  contract_version: z.string().optional(), formula_version: z.string().optional(), policy_version: z.string().optional(),
  summary: z.object({ qualification_coverage: z.number().nullable().optional(), assessed_count: z.number().int().nonnegative().optional(), supported_count: z.number().int().nonnegative().optional(), blocker_count: z.number().int().nonnegative().optional() }).passthrough().optional(),
  eligibility: z.object({ status: z.string(), blockers: z.array(z.object({ requirement_id: z.string(), rationale: z.string(), evidence_refs: z.array(evidenceSchema) }).passthrough()), warnings: z.array(z.object({ requirement_id: z.string(), rationale: z.string(), evidence_refs: z.array(evidenceSchema) }).passthrough()) }).passthrough(),
  assessments: z.array(assessmentSchema),
  source_binding: z.object({ profile_revision: z.number(), fact_semantics_version: z.number(), requirements_revision: z.number(), posting_revision: z.number() }).passthrough(),
}).passthrough();
const coverageSchema = z.object({
  status: z.string(),
  contract_version: z.string().optional(), section_support: z.array(z.object({ requirement_id: z.string(), assessment_id: z.string(), category: z.string(), evidence_refs: z.array(evidenceSchema) }).passthrough()).optional(),
  relations: z.array(z.object({ requirement_id: z.string(), achievement_id: z.string(), variant_id: z.string(), status: z.string(), determination_id: z.string().nullable() }).passthrough()),
  wording_gaps: z.array(z.object({ requirement_id: z.string(), status: z.string(), proposal_id: z.string().nullable().optional(), proposal_status: z.string().nullable().optional() }).passthrough()),
}).passthrough();
const fitSchema = z.object({
  job_id: z.string(), current: z.boolean(), stale_reasons: z.array(z.string()),
  contract_version: z.string().optional(), synthetic: z.boolean().optional(),
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
    category: z.string().optional(), name: z.string().optional(), tier: z.string().optional(), weight: z.number().optional(), rationale: z.string(), determination_id: z.string() }).passthrough()),
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
  if (parsed.data.score && (parsed.data.score.contract_version !== "requirements-v2" || parsed.data.score.formula_version !== "requirement-fit-v3-equal")) {
    return { ...parsed.data, current: false, stale_reasons: [...new Set([...parsed.data.stale_reasons, "contract_changed"])] };
  }
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
      return Object.fromEntries(Object.entries(response.data.summaries).map(([id, snapshot]) => [id, parseFit(snapshot)]));
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

function fitStatusLabel(value: string): string {
  const labels: Record<string, string> = { must_have: "Must-have", nice_to_have: "Nice-to-have", skill: "Skill", professional_experience: "Professional experience",
    language: "Language", education: "Education", not_assessed: "Unknown", contract_changed: "Requirements contract changed" };
  const words = value.replaceAll("_", " ");
  return labels[value] ?? (words ? words[0]!.toLocaleUpperCase() + words.slice(1) : words);
}

const educationDefinitionSchema = z.object({ qualification: z.string(), subjects: z.array(z.string()), alternative: z.string().nullable(), source_note: z.string().nullable() });
const languageDefinitionSchema = z.object({ language: z.string(), proficiency: z.string().nullable(), source_note: z.string().nullable() });
function requirementDefinitionText(assessment: z.infer<typeof assessmentSchema>): string {
  if (assessment.category !== "education" && assessment.category !== "language") return assessment.definition;
  let value: unknown;
  try { value = JSON.parse(assessment.definition); } catch { return assessment.definition; }
  const parsed = assessment.category === "education" ? educationDefinitionSchema.safeParse(value) : languageDefinitionSchema.safeParse(value);
  if (!parsed.success) return assessment.definition;
  const demand = parsed.data;
  const note = demand.source_note && demand.source_note !== assessment.source_note ? demand.source_note : null;
  return "qualification" in demand
    ? [demand.qualification, demand.subjects.length ? `Subjects: ${demand.subjects.join("; ")}` : null,
      demand.alternative ? `Alternative: ${demand.alternative}` : null, note].filter(Boolean).join(" · ")
    : [demand.language, `Proficiency: ${demand.proficiency ?? "Not specified in the posting"}`, note].filter(Boolean).join(" · ");
}

function CorrectionForm({ score, revision, onSave, pending }: {
  score: number; revision: number; onSave: (body: { expected_revision: number; score: number; rationale: string }) => void; pending: boolean;
}) {
  const form = useForm({ defaultValues: { score: String(score), rationale: "" }, onSubmit: ({ value }) => {
    const parsed = correctionSchema.safeParse(value);
    if (parsed.success) onSave({ expected_revision: revision, ...parsed.data });
  } });
  return <details className="fit-correction"><summary>Correct this assessment</summary><form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
    <form.Field name="score">{(field) => <label>Corrected score (1–10)<input type="number" min="1" max="10" step="1" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
    <form.Field name="rationale">{(field) => <label>Reason for correction<textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
    <Button type="submit" disabled={pending}>Save correction</Button>
  </form></details>;
}

type EvidenceOption = { source_id: string; revision: number; text: string; kind: string; confirmation: string; path?: unknown; role_id?: unknown; achievement_id?: unknown };
type AchievementOption = { achievement_id: string; source_refs?: readonly { source_id: string; revision: number }[] };
function isCorrectionSectionSource(source: EvidenceOption) {
  return source.kind === "role" || source.kind === "fact" && Array.isArray(source.path)
    && source.path[0] === "resume" && source.path[1] === "skill_categories";
}
function permittedCorrectionSource(source: EvidenceOption, category: string | undefined) {
  if (["role", "authored_achievement", "evidence"].includes(source.kind) && typeof source.role_id === "string") return true;
  return category === "skill" && source.kind === "fact" && Array.isArray(source.path)
    && source.path[0] === "resume" && source.path[1] === "skill_categories";
}
function RequirementCorrection({ assessment, factVersion, sources, achievements, disabled, unavailableReason, onSave }: {
  assessment: z.infer<typeof assessmentSchema>; factVersion: number; sources: readonly EvidenceOption[];
  achievements: readonly AchievementOption[]; disabled: boolean; unavailableReason: string | null;
  onSave: (requirementId: string, body: Record<string, unknown>) => void;
}) {
  const [validation, setValidation] = useState("");
  const permittedSources = sources.filter((source) => permittedCorrectionSource(source, assessment.category));
  const form = useForm({ defaultValues: {
    kind: assessment.kind as string, strength: assessment.strength ?? "direct", confidence: assessment.confidence,
    rationale: assessment.rationale, evidence: {} as Record<string, string>,
    retainedRefs: assessment.evidence_refs.map((_, index) => index),
    achievementIds: assessment.achievement_ids,
    supportRoute: assessment.wording_support === "section" || assessment.wording_support === "achievement" ? assessment.wording_support as string : "",
  }, onSubmit: ({ value }) => {
    if (disabled) return;
    const schema = z.object({ kind: z.enum(["matched", "transferable", "missing", "blocked", "not_assessed"]),
      strength: z.enum(["direct", "strong"]), confidence: z.enum(["high", "medium", "low"]), rationale: z.string().refine((text) => text.trim().length > 0),
      evidence: z.record(z.string(), z.string()), retainedRefs: z.array(z.number().int().nonnegative()), achievementIds: z.array(z.string()),
      supportRoute: z.enum(["", "section", "achievement"]),
    });
    const parsed = schema.safeParse(value);
    if (!parsed.success) { setValidation("Choose a valid determination and provide a reason."); return; }
    const supported = parsed.data.kind === "matched" || parsed.data.kind === "transferable";
    if (supported && !parsed.data.supportRoute) { setValidation("Choose whether the factual support comes from a Profile section or an achievement."); return; }
    const refs: Array<{ source_id: string; revision: number | string; quote: string }> = [];
    for (const index of parsed.data.retainedRefs) {
      const reference = assessment.evidence_refs[index];
      if (!reference) { setValidation("A selected evidence reference is unavailable. Reload the assessment."); return; }
      if (!permittedSources.some((source) => source.source_id === reference.source_id && source.revision === reference.revision)) {
        setValidation("A previously selected source is unavailable, changed, or outside this category. Deselect it and cite current permitted evidence."); return;
      }
      refs.push(reference);
    }
    for (const [id, quote] of Object.entries(parsed.data.evidence)) {
      if (!quote.trim()) continue;
      const source = permittedSources.find((item) => item.source_id === id);
      if (source && source.text.includes(quote)) refs.push({ source_id: id, revision: source.revision, quote });
      else { setValidation("Each evidence quote must match its saved source exactly."); return; }
    }
    const route = supported ? parsed.data.supportRoute : "none";
    const achievementIds = route === "achievement" ? parsed.data.achievementIds : [];
    if (supported && !refs.length) { setValidation("Supported qualifications need at least one exact quote from the permitted saved sources."); return; }
    if (route === "section" && !refs.some((ref) => permittedSources.some((source) => source.source_id === ref.source_id && isCorrectionSectionSource(source)))) {
      setValidation("Profile section support needs a quote from a structured Skills section or professional role record. Choose Achievement when the support comes from an achievement."); return;
    }
    if (route === "achievement" && (!achievementIds.length || achievementIds.some((id) => !achievements.some((item) => item.achievement_id === id
      && item.source_refs?.some((source) => refs.some((ref) => source.source_id === ref.source_id && source.revision === ref.revision)))))) {
      setValidation("Choose supported achievements and cite at least one of each achievement’s current saved sources."); return;
    }
    setValidation("");
    onSave(assessment.requirement_id, { expected_assessment_id: assessment.assessment_id, expected_fact_semantics_version: factVersion,
      requirement_revision: assessment.requirement_revision, kind: parsed.data.kind,
      strength: parsed.data.kind === "matched" ? parsed.data.strength : null, confidence: parsed.data.confidence,
      rationale: parsed.data.rationale, evidence_refs: refs, achievement_ids: achievementIds,
      wording_support: route, evidence_route: null,
      eligibility: "unknown", blocker_category: null, warning_category: null, profile_id: "default" });
  } });
  return <details className="fit-correction"><summary>Correct this requirement assessment</summary>
    <p>Choose a determination and cite the exact saved evidence. This records your correction; use Update affected matches afterward to recalculate the score.</p>
    <p>{assessment.category === "skill" ? "Skill support can use structured Profile Skills or factual professional roles, achievements and evidence." : "Professional-experience support uses factual professional roles, achievements and evidence."} Education and Languages do not support this category.</p>
    {unavailableReason ? <p>{unavailableReason}</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
      <form.Field name="kind">{(field) => <label>Qualification<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}>{["matched", "transferable", "missing", "blocked", "not_assessed"].map((value) => <option key={value} value={value}>{fitStatusLabel(value)}</option>)}</select></label>}</form.Field>
      <form.Subscribe selector={(state) => state.values.kind}>{(kind) => kind === "matched" || kind === "transferable" ? <form.Field name="supportRoute">{(field) => <label>Factual support route<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}>
        <option value="">Choose the supporting source</option><option value="section">Profile section</option><option value="achievement">Achievement</option>
      </select><span className="muted">Profile section requires a structured Skills or professional role quote. Achievement requires selected achievement IDs and their exact saved sources.</span></label>}</form.Field>
        : <p className="muted">This qualification records no supported wording route or achievement links. Your evidence selections remain available while you edit.</p>}</form.Subscribe>
      <form.Field name="strength">{(field) => <label>Matched strength<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}><option value="direct">Direct</option><option value="strong">Strong</option></select></label>}</form.Field>
      <form.Field name="confidence">{(field) => <label>Confidence<select value={field.state.value} onChange={(event) => field.handleChange(event.currentTarget.value)}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>}</form.Field>
      <form.Field name="rationale">{(field) => <label>Reason<textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
      <form.Field name="retainedRefs">{(field) => <fieldset><legend>Previously recorded evidence</legend>{assessment.evidence_refs.map((ref, index) => <label key={`${ref.source_id}:${index}`}><input type="checkbox" checked={field.state.value.includes(index)} onChange={(event) => field.handleChange(event.currentTarget.checked ? [...field.state.value, index] : field.state.value.filter((item) => item !== index))} /> {ref.source_id}, revision {ref.revision}: {ref.quote}</label>)}</fieldset>}</form.Field>
      <form.Field name="evidence">{(field) => <fieldset><legend>Add exact evidence quotes</legend>
        {permittedSources.map((source) => <details key={source.source_id}><summary>{evidenceSection(source)} · {source.source_id} · {fitStatusLabel(source.confirmation)}</summary><p>{source.text}</p><label>Quote from this source<textarea value={field.state.value[source.source_id] ?? ""} onChange={(event) => field.handleChange({ ...field.state.value, [source.source_id]: event.currentTarget.value })} /></label></details>)}
        {!permittedSources.length ? <p>No current permitted sources are available. Reload the saved Profile evidence before correcting a supported qualification.</p> : null}
      </fieldset>}</form.Field>
      <form.Subscribe selector={(state) => [state.values.kind, state.values.supportRoute] as const}>{([kind, route]) => (kind === "matched" || kind === "transferable") && route === "achievement" ? <form.Field name="achievementIds">{(field) => <fieldset><legend>Supported achievements</legend>{achievements.map((item) => <label key={item.achievement_id}><input type="checkbox" checked={field.state.value.includes(item.achievement_id)} onChange={(event) => field.handleChange(event.currentTarget.checked ? [...field.state.value, item.achievement_id] : field.state.value.filter((id) => id !== item.achievement_id))} /> {sources.find((source) => source.achievement_id === item.achievement_id)?.text ?? item.achievement_id}</label>)}</fieldset>}</form.Field> : null}</form.Subscribe>
      <Button type="submit" disabled={disabled}>Save requirement correction</Button>
    </form>
    {validation ? <p role="alert">{validation}</p> : null}
  </details>;
}

function evidenceSection(source: EvidenceOption | undefined) {
  const path = source?.path;
  if (Array.isArray(path) && path[0] === "resume") {
    if (path[1] === "skill_categories") return "Profile · Skills";
    if (path[1] === "education_entries") return "Profile · Education";
    if (path[1] === "language_entries") return "Profile · Languages / Proficiency";
    if (path[1] === "experience_entries") return "Profile · Professional experience";
  }
  if (source?.kind === "authored_achievement") return "Profile · Experience achievement";
  if (source?.kind === "role") return "Profile · Professional role";
  if (source?.kind === "evidence") return "Profile · Experience evidence";
  return source ? fitStatusLabel(source.kind) : "Recorded source";
}

export function PersonFitPanel({ jobId, sources = [], achievements = [], defaultMode = null, managedPreparation = false, requirementsStatus }: {
  jobId: string; sources?: readonly EvidenceOption[]; achievements?: readonly AchievementOption[]; defaultMode?: "baseline" | "tailored" | null;
  managedPreparation?: boolean; requirementsStatus?: "complete" | "unsupported_language" | undefined;
}) {
  const { featureFlags } = usePorts();
  const assessmentAvailability = getApiCapabilityAvailability(featureFlags, "rescoreJob");
  const query = useJobFit(jobId);
  const { assess, correct, correctRequirement } = useFitActions(jobId);
  const fit = query.data;
  const busy = assess.isPending || correct.isPending || correctRequirement.isPending;
  const unsupportedLanguage = requirementsStatus === "unsupported_language";
  const historical = Boolean(fit?.score && fit.stale_reasons.includes("contract_changed"));
  const sourcesById = new Map(sources.map((source) => [source.source_id, source]));
  const sections = fit?.coverage?.section_support ?? [];
  const runAssessment = () => { if (assessmentAvailability.available && !unsupportedLanguage) assess.mutate({ profile_id: "default", expected_revision: fit?.score?.revision ?? 0,
    prepare_wording: false, prepare_coverage: defaultMode === "tailored" }); };
  const evidence = (refs: z.infer<typeof evidenceSchema>[]) => refs.length ? refs.map((ref, index) => <blockquote key={`${ref.source_id}:${ref.revision}:${index}`}>
    {ref.quote}<footer>{evidenceSection(sourcesById.get(ref.source_id))} · {ref.source_id}, revision {ref.revision}</footer>
  </blockquote>) : <p>No supporting source evidence was recorded. This remains unknown or unsupported as shown in the determination.</p>;
  return <section className="section person-fit-panel" aria-labelledby="person-fit-title">
    <h3 id="person-fit-title">Person fit</h3>
    <p>This assessment compares saved Profile evidence with the role. Approved achievement wording is assessed separately.</p>
    {fit?.synthetic ? <p role="note">Synthetic illustration: these bundled examples show categories, source sections and equal-item arithmetic. No model assessment ran, and edits do not create new judgments.</p> : null}
    {query.isPending ? <p>Loading person fit…</p> : null}
    {query.error ? <p role="alert">{query.error.message} {fit?.score ? "The last accepted assessment remains below." : ""}</p> : null}
    {unsupportedLanguage ? <p role="status">Person fit was skipped because this posting was identified as non-English. No zero score was assigned. Review the posting-language evidence in requirement details.</p> : null}
    {historical ? <p role="status">The requirements contract changed. This historical result cannot establish current fit or resume readiness. Refresh requirements, then manually update affected matches to obtain a current assessment.</p>
      : fit && !fit.current && fit.score ? <p role="status">This assessment is out of date: {fit.stale_reasons.map(fitStatusLabel).join("; ") || "a source changed"}. Update affected matches manually; the prior assessment remains available.</p> : null}
    {fit?.score ? <>
      <div className="fit-score-summary" aria-label={historical || unsupportedLanguage ? "Historical person-fit result" : "Saved person-fit result"}>
        <div className="fit-score-summary__score">{historical || unsupportedLanguage ? <span>Historical assessment</span> : null}
          {fit.score.score === null ? <strong data-typography="section-title">No score</strong> : <strong data-typography="page-title"><span>Score </span>{fit.score.score}<span>/10</span></strong>}
        </div>
        <dl className="fit-score-summary__facts">
          <div><dt>Fit</dt><dd>{fit.score.fit_band ? fitStatusLabel(fit.score.fit_band) : "Not calculated"}</dd></div>
          <div><dt>Confidence</dt><dd>{fit.score.confidence ? fitStatusLabel(fit.score.confidence) : "Not assessed"}</dd></div>
          {historical ? <div><dt>Eligibility</dt><dd>{fitStatusLabel(fit.score.eligibility.status)}</dd></div> : null}
          {fit.score.summary?.assessed_count !== undefined ? <div><dt>Distinct demands</dt><dd>{fit.score.summary.assessed_count}</dd></div> : null}
          {fit.score.summary?.qualification_coverage !== undefined && fit.score.summary.qualification_coverage !== null ? <div><dt>Qualification coverage</dt><dd>{new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 }).format(fit.score.summary.qualification_coverage)}</dd></div> : null}
        </dl>
      </div>
      {fit.score.score === null ? <p>No eligible demands were extracted, so no person-fit score was calculated. This does not indicate zero qualification.</p> : null}
      <details className="fit-audit"><summary>{historical ? "Historical scoring policy" : "How this score is calculated"}</summary>
        {historical ? <p>This result used {fit.score.formula_version ?? "an earlier scoring policy"}. Its stored contributions are retained below for inspection.</p>
          : <p>Every distinct skill, professional-experience requirement, education demand and language demand counts once. An alternatives group is one demand. Direct support earns 1, strong support 0.85, transferable support 0.6 and missing or blocked support 0. The average maps to 1–10; no demands means no score.</p>}
        <p className="muted">Formula: {fit.score.formula_version ?? "Not recorded"}.</p>
      </details>
      {historical && (fit.score.eligibility.blockers.length || fit.score.eligibility.warnings.length) ? <details className="fit-audit"><summary>Eligibility reasons</summary>
        {[...fit.score.eligibility.blockers, ...fit.score.eligibility.warnings].map((item, index) => <div key={`${item.requirement_id}:${index}`}><p>{item.rationale}</p>{evidence(item.evidence_refs)}</div>)}
      </details> : null}
      <details className="fit-audit"><summary>Assessment source versions</summary><p className="muted">Profile revision {fit.score.source_binding.profile_revision} · requirements revision {fit.score.source_binding.requirements_revision} · posting revision {fit.score.source_binding.posting_revision}</p></details>
      <ul className="fit-requirements" aria-label="Requirement assessments">{fit.score.assessments.map((assessment, index) => {
        const direct = assessment.category === "education" || assessment.category === "language";
        const definition = requirementDefinitionText(assessment);
        return <li key={assessment.assessment_id}>
          <article className="fit-requirement" aria-label={`Requirement ${index + 1}`}>
            <div className="fit-requirement__heading"><h4 className="fit-requirement__text">{assessment.name ?? assessment.text}</h4><span className="fit-requirement__status" data-kind={assessment.kind}>{fitStatusLabel(assessment.kind)}</span></div>
            <p className="fit-requirement__contribution">{assessment.category ? fitStatusLabel(assessment.category) : "Historical requirement"} · {historical ? "Stored contribution: " : "Support credit: "}{assessment.contribution.awarded_points}/{assessment.contribution.max_points}{direct ? " · job-local demand" : ""}</p>
            {definition !== (assessment.name ?? assessment.text) ? <p>{definition}</p> : null}
            {assessment.source_note ? <p>Posting context: {assessment.source_note}</p> : null}
            {assessment.evidence_route === "equivalent_experience" ? <p>Matched through the posting’s equivalent-experience alternative. This does not assert a degree.</p>
              : assessment.evidence_route === "education" ? <p>Evidence route: Profile Education.</p>
              : assessment.category === "language" ? <p>Evidence section: Profile Languages / Proficiency. Other Profile sections do not establish language proficiency.</p> : null}
            {assessment.wording_support === "section" && !direct ? <p>Supported from a Profile section. Achievement wording is not needed for this support.</p> : null}
            <p className="fit-requirement__rationale">{assessment.rationale}</p>
            <details className="fit-requirement__details"><summary>Evidence and assessment details</summary>
              {evidence(assessment.evidence_refs)}
              <p>Requirement {assessment.requirement_id}, revision {assessment.requirement_revision}; determination {assessment.determination_id}; {fitStatusLabel(assessment.origin)}; confidence {fitStatusLabel(assessment.confidence)}.</p>
              {direct ? <p>This demand belongs to this job. Update saved evidence in the matching Profile section, then start Update affected matches manually.</p>
                : !historical && !unsupportedLanguage ? <RequirementCorrection assessment={assessment} factVersion={fit.score!.source_binding.fact_semantics_version} sources={sources} achievements={achievements} disabled={!assessmentAvailability.available || busy || !fit.current} unavailableReason={assessmentAvailability.available ? null : assessmentAvailability.reason} onSave={(requirementId, body) => correctRequirement.mutate({ requirementId, body })} /> : null}
            </details>
          </article>
        </li>;
      })}</ul>
      {!historical && !unsupportedLanguage && fit.current && fit.score.score !== null ? <CorrectionForm key={fit.score.revision} score={fit.score.score} revision={fit.score.revision} pending={busy} onSave={(body) => correct.mutate(body)} /> : null}
    </> : fit && !unsupportedLanguage ? <p>No person-fit assessment has been recorded yet.</p> : null}
    {fit && !fit.score && !managedPreparation && !unsupportedLanguage ? <div className="toolbar">
      <Button type="button" disabled={!assessmentAvailability.available || busy || query.isPending} onClick={runAssessment}>{assess.isPending ? "Assessing…" : "Assess person fit"}</Button>
    </div> : null}
    {!assessmentAvailability.available ? <p>{assessmentAvailability.reason}</p> : null}
    {assess.error || correct.error || correctRequirement.error ? <p role="alert">{(assess.error ?? correct.error ?? correctRequirement.error)?.message} {fit?.score ? "The previously loaded assessment remains available above." : "No assessment is shown."}</p> : null}
    {correctRequirement.isSuccess ? <p role="status">Requirement correction recorded. Use Update affected matches to recalculate this job's score.</p> : null}
    <section className="fit-wording-coverage" aria-labelledby="fit-wording-title">
      <h4 id="fit-wording-title">Approved wording coverage</h4>
      <p>Skills supported from Profile sections, education and languages do not need achievement rewrites. Existing approved wording is reused wherever its recorded coverage applies.</p>
      {fit?.coverage && !unsupportedLanguage ? <>
        <p className="fit-wording-coverage__status">{historical ? "Historical coverage" : "Status"}: {fitStatusLabel(fit.coverage.status)}</p>
        {sections.length ? <details className="fit-audit"><summary>Profile section support ({sections.length})</summary><ul>{sections.map((item) => <li key={item.requirement_id}><strong>{fit.score?.assessments.find((assessment) => assessment.requirement_id === item.requirement_id)?.name ?? fit.score?.assessments.find((assessment) => assessment.requirement_id === item.requirement_id)?.text ?? item.requirement_id}</strong><p>Supported without achievement wording.</p>{evidence(item.evidence_refs)}</li>)}</ul></details> : null}
        {!fit.coverage.relations.length && !sections.length && !fit.coverage.wording_gaps.length ? <p className="fit-wording-coverage__empty">No approved achievement-wording coverage has been recorded for this result. This does not establish a wording gap.</p> : null}
        {fit.coverage.wording_gaps.length ? <details className="fit-audit"><summary>Wording gap details ({fit.coverage.wording_gaps.length})</summary><ul>{fit.coverage.wording_gaps.map((gap) => <li key={gap.requirement_id}><strong>{fit.score?.assessments.find((assessment) => assessment.requirement_id === gap.requirement_id)?.text ?? "Requirement details unavailable"}</strong><p>{fitStatusLabel(gap.status)}{gap.proposal_status ? ` · Proposal ${fitStatusLabel(gap.proposal_status)}` : ""}</p></li>)}</ul></details> : fit.coverage.relations.length || sections.length ? <p>No wording gaps recorded.</p> : null}
        {fit.coverage.relations.length ? <details className="fit-audit"><summary>Recorded wording relations</summary><ul>{fit.coverage.relations.map((relation) => <li key={`${relation.requirement_id}:${relation.variant_id}`}>Requirement {relation.requirement_id}: {fitStatusLabel(relation.status)}, achievement {relation.achievement_id}, wording {relation.variant_id}{relation.determination_id ? `, determination ${relation.determination_id}` : "; no determination recorded"}</li>)}</ul></details> : null}
      </> : <p>{unsupportedLanguage ? "Wording was not assessed for this skipped posting." : "Wording coverage has not been assessed for this result."}</p>}
    </section>
  </section>;
}

export const fitInvalidation = {
  eventTypes: ["FitAssessed", "FitCorrected", "FitRequirementCorrected", "FitCoverageUpdated", "FitRefreshUpdated", "FitAssociationUpdated", "FitCurrentWordingUpdated", "ProfileUpdated", "ProfileWordingUpdated", "ProfileSourceUpdated", "JobCaptured", "JobSourceObserved", "JobUpdated", "RequirementBindingCorrected", "RequirementsUpdated", "RequirementMeaningRevised"] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) { void invalidateQueriesWithOptimisticOwnership(client, fitKeys.all(event.tenantId)); },
};
