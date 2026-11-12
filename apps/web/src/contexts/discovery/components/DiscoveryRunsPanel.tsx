import { useForm } from "@tanstack/react-form";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { useDiscoverySearchController } from "../hooks/useDiscoverySearchController.js";
import { DiscoverySearchSetup } from "./DiscoverySearchSetup.js";
import { DiscoverySearchFeedback } from "./DiscoverySearchFeedback.js";

export function DiscoveryRunsPanel({ compact = false, disabledReason, readiness, profileVersion, workspaceIdentity, accountingSetupReason, spendingAction }: {
  readonly compact?: boolean;
  readonly accountingSetupReason?: string | undefined;
  readonly spendingAction?: ReactNode;
  readonly disabledReason?: string | undefined;
  readonly readiness?: ReactNode;
  readonly profileVersion?: number | null | undefined;
  readonly workspaceIdentity?: string | undefined;
} = {}) {
  const controller = useDiscoverySearchController({ disabledReason, profileVersion, workspaceIdentity, savedPreferences: compact });
  const [setupOpen, setSetupOpen] = useState(false);
  const { recovery, pendingBody } = controller;
  const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
  const schema = z.object({ queries: z.string().max(10000), locations: z.string().max(10000), remoteOnly: z.boolean() });
  const form = useForm({
    defaultValues: { queries: pendingBody?.queries?.join("\n") ?? "", locations: pendingBody?.locations?.map((item) => item.location).filter(Boolean).join("\n") ?? "", remoteOnly: pendingBody?.locations?.some((item) => item.remote) ?? false },
    validators: { onSubmit: ({ value }) => schema.safeParse(value).success ? undefined : "Search inputs are too long." },
    onSubmit: ({ value }) => {
      if (accountingSetupReason && !controller.recovery.record) { setSetupOpen(true); return; }
      const parsed = schema.safeParse(value); if (!parsed.success) return;
      const queries = lines(parsed.data.queries); const locations = lines(parsed.data.locations);
      controller.launch({ ...(queries.length ? { queries } : {}),
        ...(locations.length || parsed.data.remoteOnly ? { locations: (locations.length ? locations : [""]).map((location) => ({ location, remote: parsed.data.remoteOnly })) } : {}) });
    },
  });
  return <section className={compact ? "search-preferences-section search-launch-section" : "card full p-4 discovery-runs-panel"} aria-label="Search for jobs">
    <header><h2>{compact ? "Search for jobs" : "Discovery runs"}</h2><p>{compact ? "Search with the preferences and settings you've saved." : "Run a search using your saved targets. Optional lines below apply only to this run; they do not replace saved targets."}</p></header>
    {!compact ? readiness : null}
    <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      <div hidden={compact} className="search-run-overrides">
        <p>These overrides apply only to this search. Your saved preferences stay available.</p>
        <form.Field name="queries">{(field) => <Field><FieldLabel htmlFor={compact ? "search-previous-queries" : "discovery-run-queries"}>Search queries, one per line (optional)</FieldLabel><Textarea id={compact ? "search-previous-queries" : "discovery-run-queries"} rows={3} value={field.state.value} disabled={controller.uncertain} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></Field>}</form.Field>
        <form.Field name="locations">{(field) => <Field><FieldLabel htmlFor={compact ? "search-previous-locations" : "discovery-run-locations"}>Locations, one per line (optional)</FieldLabel><Textarea id={compact ? "search-previous-locations" : "discovery-run-locations"} rows={2} value={field.state.value} disabled={controller.uncertain} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></Field>}</form.Field>
        <form.Field name="remoteOnly">{(field) => <Field orientation="horizontal" className="search-tool-choice"><Checkbox id={compact ? "search-previous-remote" : "discovery-run-remote"} checked={field.state.value} disabled={controller.uncertain} onCheckedChange={field.handleChange} /><FieldLabel htmlFor={compact ? "search-previous-remote" : "discovery-run-remote"}>Remote only for this run</FieldLabel></Field>}</form.Field>
      </div>
      <form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p role="alert">{errors.join(" ")}</p> : null}</form.Subscribe>
      <div className="search-launch-action"><Button type="submit" disabled={!controller.canStart}>{controller.isPending ? "Queueing search…" : recovery.record && recovery.canRetry ? "Retry the same request" : compact ? "Start search" : "Run discovery"}</Button>{compact ? readiness : null}</div>
    </form>
    <DiscoverySearchFeedback controller={controller} spendingAction={spendingAction} />
    <DiscoverySearchSetup open={setupOpen} onOpenChange={setSetupOpen} reason={accountingSetupReason} action={spendingAction} />
    <details className="search-run-history"><summary>Recent searches{controller.history.length ? ` (${controller.history.length})` : ""}</summary>
      {!controller.history.length && !controller.historyError ? <p>{controller.historyLoading ? "Loading searches…" : "No searches have been started yet."}</p> : null}
      <ul>{controller.history.map((run) => <li key={run.runId}>{run.status} · {run.newJobs} new, {run.observedJobs} observed · {run.createdAt}{run.failureCode ? ` · ${run.failureCode}` : ""}</li>)}</ul>
    </details>
  </section>;
}
