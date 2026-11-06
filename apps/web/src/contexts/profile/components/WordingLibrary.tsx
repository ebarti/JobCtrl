import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { z } from "zod";

import { Button } from "../../../shared/ui/button.js";
import { useWordingActions, useWordingLibrary, type WordingDecision, type WordingVariant } from "../hooks/useWordingLibrary.js";

const textSchema = z.string().refine((value) => value.trim().length > 0, "Enter wording before saving a draft.");

function Variant({ variant, profileVersion, baseline }: {
  variant: WordingVariant; profileVersion: number; baseline: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const { decide, draft } = useWordingActions();
  const form = useForm({
    defaultValues: { text: variant.text },
    onSubmit: async ({ value }) => {
      const result = textSchema.safeParse(value.text);
      if (!result.success) return;
      try {
        await draft.mutateAsync({ variant, text: result.data, profileVersion });
        setEditing(false);
      } catch {
        // Keep the entered wording available for a retry or a stale-version review.
      }
    },
  });
  const pending = decide.isPending || draft.isPending;
  const decision = (value: WordingDecision) => decide.mutate({ variant, decision: value, profileVersion });
  return <article className="section" aria-label={`Wording ${variant.variant_id}`}>
    <p>{variant.text}</p>
    <p className="muted">{baseline ? "Baseline · " : ""}{variant.status} · revision {variant.revision}</p>
    <details><summary>Source references</summary>
      {variant.source_refs.length ? <ul>{variant.source_refs.map((source) => <li key={`${source.source_id}:${source.revision}`}>{source.source_id}, revision {source.revision}</li>)}</ul> : <p>No source references recorded.</p>}
    </details>
    <div className="toolbar">
      {variant.status !== "approved" && variant.status !== "stale" ? <>
        <Button type="button" disabled={pending} onClick={() => decision("approve")}>Approve exact wording</Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => decision("reject")}>Reject wording</Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => decision("defer")}>Defer wording</Button>
      </> : null}
      <Button type="button" variant="outline" disabled={pending || variant.status === "stale"} onClick={() => setEditing((current) => !current)}>Edit as new wording</Button>
    </div>
    {editing ? <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
      <form.Field name="text">{(field) => <label>Edited wording
        <textarea className="w-full" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} />
      </label>}</form.Field>
      <p className="muted">This creates a separate draft for the same achievement. Approve its exact text before it can be reused.</p>
      <Button type="submit" disabled={pending}>Save wording draft</Button>
    </form> : null}
    {decide.error || draft.error ? <p role="alert">{(decide.error ?? draft.error)?.message} The saved wording remains available; reload to review the current version.</p> : null}
  </article>;
}

export function WordingLibrary() {
  const library = useWordingLibrary();
  return <section id="profile-wording" className="card" aria-labelledby="profile-wording-title">
    <h2 id="profile-wording-title">Approved wording</h2>
    <p>Review reusable alternatives for each achievement. A proposal does not become approved until you approve its exact text.</p>
    {library.isPending ? <p>Loading wording library…</p> : null}
    {library.error ? <div role="alert"><p>{library.error.message}</p><Button type="button" variant="outline" onClick={() => void library.refetch()}>Reload wording</Button></div> : null}
    {library.data && library.data.profileVersion === null ? <p>Save a profile before reviewing wording.</p> : null}
    {library.data && library.data.profileVersion !== null ? <>
      {library.data.roles.length === 0 ? <p>No baseline achievements are available yet.</p> : null}
      {library.data.roles.map((role) => <section key={role.role_id} aria-label={`Role ${role.role_id}`}>
        <h3>Role {role.role_id}</h3>
        {role.achievements.map((achievement) => <section key={achievement.achievement_id} aria-label={`Achievement ${achievement.achievement_id}`}>
          <h4>Achievement {achievement.achievement_id}</h4>
          {library.data.variants.filter((variant) => variant.achievement_id === achievement.achievement_id).map((variant) =>
            <Variant key={`${variant.variant_id}:${variant.revision}`} variant={variant} profileVersion={library.data!.profileVersion!} baseline={variant.variant_id === achievement.baseline_variant_id} />)}
        </section>)}
      </section>)}
      {library.data.proposals.filter((proposal) => proposal.failure_code).map((proposal) => <p role="status" key={proposal.proposal_id}>Proposal {proposal.proposal_id}: {proposal.status} ({proposal.failure_code}). Existing approved wording is unchanged.</p>)}
    </> : null}
  </section>;
}
