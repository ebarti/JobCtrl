import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { z } from "zod";

import { Button } from "../../../shared/ui/button.js";
import { useProfileSourceActions, useProfileSources } from "../hooks/useProfileSources.js";

const textSchema = z.string().refine((value) => value.trim().length > 0);
export function ProfileEvidencePanel({ search = "", focusSourceId = "" }: { search?: string; focusSourceId?: string }) {
  const query = useProfileSources(); const { add, decide } = useProfileSourceActions(); const [validation, setValidation] = useState("");
  const needle = search.trim().toLocaleLowerCase();
  const visibleSources = query.data?.sources.filter((source) =>
    (!focusSourceId || source.source_id === focusSourceId)
    && (!needle || `${source.text}\n${source.source_id}\n${source.kind}`.toLocaleLowerCase().includes(needle))) ?? [];
  const form = useForm({ defaultValues: { text: "" }, onSubmit: async ({ value }) => {
    const parsed = textSchema.safeParse(value.text);
    if (!parsed.success || !query.data || query.data.profileVersion === null) { setValidation("Enter a source and save a profile first."); return; }
    setValidation("");
    try { await add.mutateAsync({ expectedProfileVersion: query.data.profileVersion, source: { kind: "attachment", text: parsed.data } }); form.reset(); } catch { /* Retain source text for retry. */ }
  } });
  return <section className="card" aria-labelledby="profile-evidence-title">
    <h2 id="profile-evidence-title">Profile sources</h2>
    <p>Review the recorded evidence and its confirmation. Save changed Profile evidence first; saving alone does not confirm it. Confirming a source is an explicit decision about its exact saved text and revision.</p>
    {query.isPending ? <p>Loading sources…</p> : null}
    {query.error ? <p role="alert">{query.error.message}</p> : null}
    {query.data === null || query.data?.profileVersion === null ? <p>Save a profile before adding or reviewing sources.</p> : null}
    {query.data && query.data.profileVersion !== null ? <>
      {visibleSources.length ? <ul>{visibleSources.map((source) => <li key={source.source_id} id={`source-${source.source_id}`}>
        <h3>{source.kind} · {source.confirmation}</h3><p>{source.text}</p>
        <p className="muted">Source {source.source_id}, revision {source.revision}{source.origin ? ` · ${source.origin}` : ""}</p>
        <div className="toolbar">
          <Button type="button" disabled={decide.isPending || source.confirmation === "confirmed"} onClick={() => decide.mutate({ source, profileVersion: query.data!.profileVersion!, decision: "confirm" })}>Confirm exact source</Button>
          <Button type="button" variant="outline" disabled={decide.isPending || source.confirmation === "rejected"} onClick={() => decide.mutate({ source, profileVersion: query.data!.profileVersion!, decision: "reject" })}>Reject source</Button>
          <Button type="button" variant="outline" disabled={decide.isPending || source.confirmation === "deferred"} onClick={() => decide.mutate({ source, profileVersion: query.data!.profileVersion!, decision: "defer" })}>Defer source</Button>
        </div>
      </li>)}</ul> : <p>{search || focusSourceId ? "No sources match this filter or source ID." : "No sources recorded."}</p>}
      <details><summary>Add supporting source</summary><form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
        <form.Field name="text">{(field) => <label>Source text<textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
        <Button type="submit" disabled={add.isPending}>Add source</Button>
      </form></details>
    </> : null}
    {validation ? <p role="alert">{validation}</p> : null}
    {add.error || decide.error ? <p role="alert">{(add.error ?? decide.error)?.message} Saved sources remain available; reload before retrying a stale decision.</p> : null}
  </section>;
}
