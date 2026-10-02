import { SaveInterviewQuestionNoteRequestSchema, type InterviewNoteBindings, type InterviewQuestionNote } from "../../operations/types.js";
import { useForm } from "@tanstack/react-form";
import { useEffect, useId, useState } from "react";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { useInterviewNotesQuery } from "../../operations/hooks/useInterviewQueries.js";
import { useSaveInterviewNoteMutation } from "../hooks/useSaveInterviewNoteMutation.js";
import { interviewDraftKey, useInterviewDraftStore } from "../stores/interview-drafts.js";

export function InterviewNoteForm({ jobId, questionId, sourceGeneration, bindings, allowNewNote = true }: {
  readonly jobId: string; readonly questionId: string; readonly sourceGeneration?: number | null;
  readonly bindings?: InterviewNoteBindings | null;
  readonly allowNewNote?: boolean;
}) {
  const tenantId = useTenantId();
  const key = interviewDraftKey(tenantId, jobId, questionId);
  const notes = useInterviewNotesQuery(jobId, questionId);
  const note = notes.data?.notes[0];
  const [historyPage, setHistoryPage] = useState(1);
  const history = useInterviewNotesQuery(jobId, questionId, true, historyPage);
  const draft = useInterviewDraftStore((state) => state.notes.get(key));
  const initialize = useInterviewDraftStore((state) => state.initializeNote);
  const edit = useInterviewDraftStore((state) => state.editNote);
  const rebase = useInterviewDraftStore((state) => state.rebaseNote);
  const mutation = useSaveInterviewNoteMutation(jobId, questionId);
  const id = useId();
  useEffect(() => {
    if (!notes.data || mutation.isPending) return;
    initialize(key, note?.noteText ?? "", note?.revision ?? 0);
  }, [notes.data, note, initialize, key, mutation.isPending]);
  const form = useForm({
    defaultValues: { noteText: draft?.text ?? "" },
    validators: { onSubmit: ({ value }) => {
      const parsed = SaveInterviewQuestionNoteRequestSchema.safeParse({ questionId, expectedRevision: draft?.expectedRevision ?? 0, noteText: value.noteText });
      return parsed.success ? undefined : parsed.error.issues[0]?.message ?? "Review this note.";
    } },
    onSubmit: async ({ value }) => {
      const current = useInterviewDraftStore.getState().notes.get(key);
      if (!current || current.conflictRevision !== null || mutation.isPending || !allowNewNote && !note) return;
      const parsed = SaveInterviewQuestionNoteRequestSchema.safeParse({
        questionId, expectedRevision: current.expectedRevision, noteText: value.noteText,
        factualSupport: "unverified_user_statement",
        // Existing notes keep their own retained origin through preparation
        // replacement. The server revalidates and derives its bindings.
        ...(note ? {} : { sourceGeneration: sourceGeneration ?? null, bindings: bindings ?? null }),
      });
      if (!parsed.success) return;
      try { await mutation.mutateAsync({ body: parsed.data, editVersion: current.editVersion }); } catch { /* Preserve the draft. */ }
    },
  });
  useEffect(() => {
    if (draft && form.getFieldValue("noteText") !== draft.text) form.setFieldValue("noteText", draft.text);
  }, [draft?.text, form]);
  const conflict = draft?.conflictRevision !== null && draft?.conflictRevision !== undefined;
  const savedNote = note && !(notes.data as { pendingEditVersion?: number }).pendingEditVersion ? note : null;
  const reviewableConflict = conflict && savedNote && savedNote.revision >= (draft?.conflictRevision ?? Infinity);
  return (
    <section className="section" aria-label="Independent user notes">
      <h3 data-typography="component-title">Your notes</h3>
      <p>Notes and new recollections are unverified user statements. Saving them does not change your Profile or inherit a preparation audit.</p>
      <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }} className="grid gap-3">
        <form.Field name="noteText">{(field) => <Field><FieldLabel htmlFor={id}>Notes for {questionId}</FieldLabel><Textarea id={id} rows={7} maxLength={20_000} disabled={!allowNewNote && !note} value={field.state.value} onBlur={field.handleBlur} onChange={(event) => { field.handleChange(event.target.value); edit(key, event.target.value); }} /></Field>}</form.Field>
        {notes.data && !allowNewNote && !note ? <p>No saved note exists for this unavailable question. Choose an active question to start a new note.</p> : null}
        <p className="muted" role="status">{mutation.isPending ? "Saving submitted version; you can keep editing." : draft && draft.editVersion !== draft.savedVersion ? "Unsaved changes preserved in this session." : `Saved baseline revision ${draft?.expectedRevision ?? 0}.`}</p>
        <form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p role="alert">{errors.flat().filter((error): error is string => typeof error === "string").join(" ")}</p> : null}</form.Subscribe>
        {notes.error ? <p role="alert">Saved notes could not be loaded. Your local text remains available.</p> : null}
        {mutation.error ? <p role="alert">{conflict ? "Another saved revision exists. Review it before saving your retained text." : "Note save failed. Your text has been preserved."}</p> : null}
        {conflict ? <div className="banner inline"><p>Save conflict. Your edited text is above.</p>{reviewableConflict ? <><SavedNote note={savedNote} /><Button type="button" variant="outline" onClick={() => rebase(key, savedNote.revision)}>Keep my text and use revision {savedNote.revision} as the saved baseline</Button></> : <p>Loading the current saved revision for review…</p>}</div> : null}
        <Button type="submit" disabled={!notes.data || mutation.isPending || conflict || !draft || !allowNewNote && !note || draft.editVersion === draft.savedVersion}>Save unverified note</Button>
      </form>
      <details className="section"><summary>Saved note revision history</summary>{history.data?.notes.map((entry) => <SavedNote key={entry.revision} note={entry} />)}{history.error ? <p>Note history unavailable.</p> : null}{history.data ? <div className="flex flex-wrap gap-2"><span>Page {historyPage}; {history.data.total} revisions</span><Button type="button" variant="outline" disabled={historyPage === 1} onClick={() => setHistoryPage((page) => page - 1)}>Newer note revisions</Button><Button type="button" variant="outline" disabled={historyPage * history.data.pageSize >= history.data.total} onClick={() => setHistoryPage((page) => page + 1)}>Older note revisions</Button></div> : null}</details>
    </section>
  );
}

function SavedNote({ note }: { readonly note: InterviewQuestionNote }) {
  return <article className="border p-3"><p>Revision {note.revision} · {note.updatedAt} · {note.factualSupport.replaceAll("_", " ")}</p><p className="whitespace-pre-wrap break-words">{note.noteText}</p><p className="muted">Source preparation generation: {note.sourceGeneration ?? "unbound"}</p></article>;
}
