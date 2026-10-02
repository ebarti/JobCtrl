import {
  GenerateInterviewPrepRequestSchema, INTERVIEW_FORMATS, INTERVIEW_ROLE_LENSES, INTERVIEW_STAGES,
  MAX_INTERVIEW_SELECTED_QUESTIONS, type InterviewCatalog, type InterviewGenerationContext,
} from "../../operations/types.js";
import { useForm } from "@tanstack/react-form";
import { useEffect, useId } from "react";
import { JobCtrlApiError } from "@jobctrl/api-client";
import { z } from "zod";

import { getApiCapabilityAvailability, LOCAL_INSTALL_GUIDE_URL } from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../shared/ui/select.js";
import { useGenerateInterviewPrepMutation } from "../hooks/useGenerateInterviewPrepMutation.js";
import type { InterviewSelectionDraft } from "../stores/interview-drafts.js";
import { useInterviewSelectionDraft } from "../hooks/useInterviewSelectionDraft.js";
import { useInterviewEvidenceChoices } from "../../operations/hooks/useInterviewQueries.js";

type ContextValues = Pick<InterviewSelectionDraft, "interviewStage" | "interviewFormat" | "responsibilityLens" | "roleResponsibilities" | "knownCriteria" | "selectionReason">;

function lines(text: string): string[] { return text.split("\n").map((line) => line.trim()).filter(Boolean); }
function label(value: string): string { return value.replaceAll("_", " "); }

export function InterviewContextForm({ jobId, catalog, questionId, context }: {
  readonly jobId: string; readonly catalog: InterviewCatalog; readonly questionId: string;
  readonly context?: InterviewGenerationContext | null | undefined;
}) {
  const { draft, update, toggle, move } = useInterviewSelectionDraft(jobId, context);
  const mutation = useGenerateInterviewPrepMutation();
  const evidence = useInterviewEvidenceChoices(jobId);
  const explicitChoices = draft.selectedQuestionIds.filter((selectedId) => Object.hasOwn(draft.evidenceSelections, selectedId));
  const staleEvidence = explicitChoices.length > 0 && draft.evidenceProfileVersion !== evidence.profileVersion;
  const invalidEvidence = explicitChoices.flatMap((selectedId) => (draft.evidenceSelections[selectedId] ?? []).filter((evidenceId) => !evidence.choices.some((choice) => choice.evidenceId === evidenceId)));
  const parsedFailure = mutation.error instanceof JobCtrlApiError ? z.object({ error: z.string() }).safeParse(mutation.error.responseBody) : null;
  const rejectedEvidence = parsedFailure?.success && ["evidence_profile_changed", "invalid_evidence_selection"].includes(parsedFailure.data.error);
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "generateInterviewPrep");
  const invalidSelected = draft.selectedQuestionIds.filter((id) => !catalog.questions.some((question) => question.id === id));
  const id = useId();
  const form = useForm({
    defaultValues: {
      interviewStage: draft.interviewStage, interviewFormat: draft.interviewFormat,
      responsibilityLens: draft.responsibilityLens, roleResponsibilities: draft.roleResponsibilities,
      knownCriteria: draft.knownCriteria, selectionReason: draft.selectionReason,
    },
    validators: { onSubmit: ({ value }) => {
      if (invalidSelected.length) return "Remove unavailable or retired questions before generating.";
      const result = GenerateInterviewPrepRequestSchema.safeParse(request(value));
      return result.success ? undefined : result.error.issues[0]?.message ?? "Review preparation context.";
    } },
    onSubmit: async ({ value }) => {
      if (!availability.available || invalidSelected.length || staleEvidence || invalidEvidence.length || rejectedEvidence) return;
      const result = GenerateInterviewPrepRequestSchema.safeParse(request(value));
      if (!result.success) return;
      try { await mutation.mutateAsync({ jobId, body: result.data }); } catch { /* Preserve form, selection and accepted prep. */ }
    },
  });
  function request(value: ContextValues) {
    return {
      selectedQuestionIds: [...draft.selectedQuestionIds],
      catalogBinding: { catalogRevision: catalog.catalogRevision, catalogDigest: catalog.catalogDigest },
      ...(explicitChoices.length ? { evidenceSelections: explicitChoices.map((questionId) => ({ questionId, evidenceIds: [...draft.evidenceSelections[questionId]!] })), evidenceProfileVersion: draft.evidenceProfileVersion } : {}),
      interviewStage: value.interviewStage,
      ...(value.interviewFormat === "unknown" ? {} : { interviewFormat: value.interviewFormat }),
      ...(value.responsibilityLens ? { roleLens: value.responsibilityLens } : {}),
      roleResponsibilities: lines(value.roleResponsibilities), knownCriteria: lines(value.knownCriteria), selectionRationale: value.selectionReason,
    };
  }
  useEffect(() => {
    const keys = ["interviewStage", "interviewFormat", "responsibilityLens", "roleResponsibilities", "knownCriteria", "selectionReason"] as const;
    for (const key of keys) if (form.getFieldValue(key) !== draft[key]) form.setFieldValue(key, draft[key]);
  }, [draft, form]);
  const question = catalog.questions.find((card) => card.id === questionId);
  const blockedSelection = !draft.selectedQuestionIds.includes(questionId) && draft.selectedQuestionIds.length >= MAX_INTERVIEW_SELECTED_QUESTIONS;
  function chooseEvidence(selectedId: string, ids: readonly string[] | null) {
    const choices = { ...draft.evidenceSelections };
    if (ids === null) delete choices[selectedId]; else choices[selectedId] = ids;
    update({ evidenceSelections: choices, evidenceProfileVersion: draft.evidenceProfileVersion ?? evidence.profileVersion });
  }
  return (
    <section className="section interview-context" aria-label="Question selection and interview context">
      <h3 data-typography="component-title">Prepare selected questions</h3>
      <p>Choose questions for the responsibilities you expect. Personal claims use saved profile evidence; missing experience produces questions and gaps.</p>
      {question ? <Button type="button" variant="outline" disabled={blockedSelection} onClick={() => toggle(questionId)}>{draft.selectedQuestionIds.includes(questionId) ? "Remove question from preparation" : "Add question to preparation"}</Button> : null}
      <p aria-live="polite">{draft.selectedQuestionIds.length} of {MAX_INTERVIEW_SELECTED_QUESTIONS} questions selected</p>
      <ol className="grid gap-2" aria-label="Selected question order">{draft.selectedQuestionIds.map((selectedId, index) => <li key={selectedId} className="flex flex-wrap items-center gap-2">
        <span>{catalog.questions.find((card) => card.id === selectedId)?.title ?? `${selectedId} — unavailable in current catalog`}</span>
        <Button type="button" size="sm" variant="ghost" aria-label={`Move ${selectedId} earlier`} disabled={index === 0} onClick={() => move(selectedId, -1)}>Earlier</Button>
        <Button type="button" size="sm" variant="ghost" aria-label={`Move ${selectedId} later`} disabled={index === draft.selectedQuestionIds.length - 1} onClick={() => move(selectedId, 1)}>Later</Button>
        <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${selectedId}`} onClick={() => toggle(selectedId)}>Remove</Button>
      </li>)}</ol>
      {draft.selectedQuestionIds.length ? <section aria-label="Canonical evidence choices" className="grid gap-3">
        <h4>Choose saved profile evidence</h4>
        <p>Saved Profile version {evidence.profileVersion ?? "unavailable"}. Confirmed supported or verified achievements only. Supported means saved personal support, and does not imply external verification. Notes and declared skills cannot be selected.</p>
        {evidence.isPending ? <p role="status">Refreshing saved Profile evidence…</p> : null}
        {evidence.error ? <p role="alert">Saved evidence could not be loaded. Explicit choices are retained.</p> : null}
        {draft.selectedQuestionIds.map((selectedId) => {
          const selected = draft.evidenceSelections[selectedId];
          return <details key={selectedId}><summary>Evidence for {selectedId}: {selected ? `${selected.length} explicitly selected` : "automatic selection"}</summary>
            <p>{selected ? "Only these chosen facts may be used; an empty choice produces gaps." : "The preparation service may choose relevant accepted profile facts."}</p>
            <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!evidence.profileVersion || evidence.isPending} onClick={() => chooseEvidence(selectedId, [])}>Use no evidence for {selectedId}</Button><Button type="button" variant="ghost" onClick={() => chooseEvidence(selectedId, null)}>Use automatic evidence for {selectedId}</Button></div>
            {selected?.length ? <ol aria-label={`Evidence order for ${selectedId}`}>{selected.map((evidenceId, index) => <li key={evidenceId}>{evidence.choices.find((choice) => choice.evidenceId === evidenceId)?.title ?? evidenceId} <Button type="button" size="sm" variant="ghost" aria-label={`Move evidence ${index + 1} earlier for ${selectedId}`} disabled={index === 0} onClick={() => { const ids = [...selected]; [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]; chooseEvidence(selectedId, ids); }}>Earlier</Button><Button type="button" size="sm" variant="ghost" aria-label={`Move evidence ${index + 1} later for ${selectedId}`} disabled={index === selected.length - 1} onClick={() => { const ids = [...selected]; [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!]; chooseEvidence(selectedId, ids); }}>Later</Button></li>)}</ol> : null}
            {evidence.choices.map((choice) => <label key={choice.evidenceId} className="block border p-3"><input type="checkbox" aria-label={`Use ${choice.title} for ${selectedId}`} checked={selected?.includes(choice.evidenceId) ?? false} disabled={!evidence.profileVersion || evidence.isPending || Boolean(selected && selected.length >= 8 && !selected.includes(choice.evidenceId))} onChange={(event) => chooseEvidence(selectedId, event.target.checked ? [...(selected ?? []), choice.evidenceId] : (selected ?? []).filter((evidenceId) => evidenceId !== choice.evidenceId))} /> <strong>{choice.title}</strong><p>{choice.excerpt}</p><p className="muted">{choice.scope} experience · {choice.strength} · Profile version {evidence.profileVersion}</p></label>)}
            {selected?.filter((evidenceId) => !evidence.choices.some((choice) => choice.evidenceId === evidenceId)).map((evidenceId) => <p key={evidenceId}>Unavailable saved choice: {evidenceId} <Button type="button" variant="ghost" onClick={() => chooseEvidence(selectedId, selected.filter((id) => id !== evidenceId))}>Remove unavailable evidence</Button></p>)}
            {!evidence.isPending && !evidence.choices.length ? <p>No accepted achievement evidence is available. Use no evidence to prepare clarifying questions.</p> : null}
          </details>;
        })}
        {staleEvidence || rejectedEvidence ? <div role="alert"><p>The saved Profile or accepted evidence changed. Your choices are retained at version {draft.evidenceProfileVersion ?? "unknown"}. Review the current excerpts, remove unavailable choices, then confirm this selection.</p><Button type="button" variant="outline" disabled={!evidence.profileVersion || evidence.isPending || Boolean(invalidEvidence.length)} onClick={() => { update({ evidenceProfileVersion: evidence.profileVersion }); mutation.reset(); }}>Confirm reviewed evidence at Profile version {evidence.profileVersion}</Button><Button type="button" variant="ghost" onClick={() => void evidence.refetch()}>Refresh saved evidence</Button></div> : null}
      </section> : null}
      <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }} className="grid gap-4">
        {([
          ["interviewStage", "Interview stage", ["unknown", ...INTERVIEW_STAGES]],
          ["interviewFormat", "Interview format", ["unknown", ...INTERVIEW_FORMATS]],
          ["responsibilityLens", "Responsibility lens", ["", ...INTERVIEW_ROLE_LENSES]],
        ] as const).map(([name, title, values]) => <form.Field key={name} name={name}>{(field) => <Field><FieldLabel htmlFor={`${id}-${name}`}>{title}</FieldLabel><Select value={field.state.value} onValueChange={(value) => { const next = value ?? ""; field.handleChange(next); update({ [name]: next }); }}><SelectTrigger id={`${id}-${name}`} aria-label={title} className="w-full"><SelectValue>{field.state.value ? label(field.state.value) : "Unspecified"}</SelectValue></SelectTrigger><SelectContent>{[...new Set(values)].map((value) => <SelectItem key={value} value={value}>{value ? label(value) : "Unspecified"}</SelectItem>)}</SelectContent></Select></Field>}</form.Field>)}
        {([ ["roleResponsibilities", "Expected responsibilities (one per line)"], ["knownCriteria", "Known interview criteria (one per line)"], ["selectionReason", "Why these questions?"] ] as const).map(([name, title]) => <form.Field key={name} name={name}>{(field) => <Field><FieldLabel htmlFor={`${id}-${name}`}>{title}</FieldLabel><Textarea id={`${id}-${name}`} rows={3} value={field.state.value} onBlur={field.handleBlur} onChange={(event) => { field.handleChange(event.target.value); update({ [name]: event.target.value }); }} /></Field>}</form.Field>)}
        <form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p role="alert">{errors.flat().filter((error): error is string => typeof error === "string").join(" ")}</p> : null}</form.Subscribe>
        {mutation.error ? <p role="alert">Preparation failed: {mutation.error.message}. Your selection and the last accepted preparation remain available.</p> : null}
        {mutation.isSuccess ? <p role="status">Preparation queued. The last accepted generation remains available while this run completes.</p> : null}
        <Button type="submit" disabled={mutation.isPending || !draft.selectedQuestionIds.length || Boolean(invalidSelected.length) || (explicitChoices.length > 0 && (evidence.isPending || Boolean(evidence.error))) || staleEvidence || Boolean(rejectedEvidence) || Boolean(invalidEvidence.length) || !availability.available}>{mutation.isPending ? "Queueing preparation…" : "Generate selected preparation"}</Button>
        {!availability.available ? <p>Preparation generation is available in the local app. <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.</p> : null}
        {invalidSelected.length ? <p role="alert">Unavailable selected questions: {invalidSelected.join(", ")}. Remove them to prepare.</p> : null}
        <p className="muted">Generation explicitly uses your configured model and existing spend controls.</p>
      </form>
    </section>
  );
}
