import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { z } from "zod";

import { createUnconfirmedWriteError, isUnconfirmedWrite } from "../../../shared/lib/unconfirmed-write.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Field, FieldGroup, FieldLabel } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { discoveryKeys } from "../queryKeys.js";

const Query = z.union([z.string(), z.object({ query: z.string(), source_scope: z.array(z.string()).optional(), tier: z.number().optional() }).passthrough()]);
const Location = z.union([z.string(), z.object({ location: z.string(), remote: z.boolean() }).passthrough()]);
const Settings = z.object({ ok: z.literal(true), revision: z.number().int().nonnegative(),
  settings: z.object({ queries: z.array(Query), locations: z.array(Location) }).passthrough() }).passthrough();
const NewTarget = z.object({ query: z.string().trim().max(300), location: z.string().trim().max(300), remote: z.boolean() });
type SavedTargets = z.infer<typeof Settings>;

export function DiscoveryExplicitTargets({ defaultOpen = true }: { readonly defaultOpen?: boolean } = {}) {
  const tenantId = useTenantId(); const { http } = usePorts(); const client = useQueryClient();
  const id = useId();
  const [uncertain, setUncertain] = useState(false);
  const [freshForReview, setFreshForReview] = useState(false);
  const query = useQuery({ queryKey: discoveryKeys.settings(tenantId),
    queryFn: async () => Settings.parse(await http.json<unknown>("GET", "/v1/discovery/settings")) });
  const save = useMutation({
    mutationFn: async ({ current, queries, locations }: { current: SavedTargets; queries: SavedTargets["settings"]["queries"]; locations: SavedTargets["settings"]["locations"] }) => {
      const response = await http.json<unknown>("PATCH", "/v1/discovery/settings", { body: { expectedRevision: current.revision, queries, locations } });
      const parsed = Settings.safeParse(response);
      if (!parsed.success || parsed.data.revision !== current.revision + 1
          || JSON.stringify(parsed.data.settings.queries) !== JSON.stringify(queries)
          || JSON.stringify(parsed.data.settings.locations) !== JSON.stringify(locations)) {
        throw createUnconfirmedWriteError("PATCH", "/v1/discovery/settings", new Error("Settings response did not confirm the submitted targets."));
      }
      return parsed.data;
    },
    onError: (error) => { if (isUnconfirmedWrite(error)) { setUncertain(true); setFreshForReview(false); } },
    onSettled: () => { void client.invalidateQueries({ queryKey: discoveryKeys.settings(tenantId) }); },
  });
  const form = useForm({ defaultValues: { query: "", location: "", remote: false },
    validators: { onSubmit: ({ value }) => {
      const parsed = NewTarget.safeParse(value);
      return parsed.success && (parsed.data.query || parsed.data.location || parsed.data.remote) ? undefined : "Enter a query, a location, or select remote.";
    } },
    onSubmit: async ({ value, formApi }) => {
      const parsed = NewTarget.safeParse(value); const current = query.data;
      if (!parsed.success || !current || uncertain || save.isPending || !(parsed.data.query || parsed.data.location || parsed.data.remote)) return;
      const submitted = JSON.stringify(value);
      try {
        await save.mutateAsync({ current,
          queries: parsed.data.query ? [...current.settings.queries, parsed.data.query] : current.settings.queries,
          locations: parsed.data.location || parsed.data.remote ? [...current.settings.locations, { location: parsed.data.location, remote: parsed.data.remote }] : current.settings.locations });
        if (JSON.stringify(formApi.state.values) === submitted) formApi.reset();
      } catch { /* Preserve typed targets until the saved revision is known. */ }
    } });
  const remove = (kind: "queries" | "locations", index: number) => {
    const current = query.data; if (!current || save.isPending || uncertain) return;
    save.mutate({ current, queries: kind === "queries" ? current.settings.queries.filter((_, i) => i !== index) : current.settings.queries,
      locations: kind === "locations" ? current.settings.locations.filter((_, i) => i !== index) : current.settings.locations });
  };
  return <DisclosureSection className="discovery-explicit-targets" aria-label="Explicit discovery targets" title="Explicit search targets" defaultOpen={defaultOpen} description="Saved literal queries and locations for independent discovery and scheduled work.">
    <p>These targets remain separate from Search preferences. Existing source-specific settings are retained.</p>
    {query.error ? <p role="alert">Saved targets could not be refreshed. {query.data ? "The last loaded targets remain visible." : ""}</p> : null}
    {save.error ? <p role="alert">Target change could not be confirmed: {save.error.message}. Refresh before retrying.</p> : null}
    {uncertain ? <div className="search-preferences-recovery" role="group" aria-label="Unconfirmed target change">
      <p>The earlier change may have been saved. Refresh and review the current targets before making another change; your typed input remains below.</p>
      <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => { void query.refetch().then((result) => setFreshForReview(result.isSuccess)); }}>Refresh saved targets</Button>
      <Button type="button" variant="outline" disabled={!freshForReview || query.isFetching} onClick={() => { setUncertain(false); setFreshForReview(false); }}>I reviewed the saved targets</Button>
    </div> : null}
    {query.data ? <>
      <div className="search-explicit-saved">
      <section aria-label="Saved explicit queries"><h3>Saved queries</h3>{query.data.settings.queries.length ? <ul>{query.data.settings.queries.map((item, index) => <li key={index}>
        <span>{typeof item === "string" ? item : item.query}{typeof item !== "string" && item.source_scope?.length ? ` · sources: ${item.source_scope.join(", ")}` : ""}</span>
        <Button type="button" size="sm" variant="ghost" disabled={save.isPending || uncertain} aria-label={`Remove query ${index + 1}`} onClick={() => remove("queries", index)}>Remove</Button>
      </li>)}</ul> : <p>No saved queries.</p>}</section>
      <section aria-label="Saved explicit locations"><h3>Saved locations</h3>{query.data.settings.locations.length ? <ul>{query.data.settings.locations.map((item, index) => <li key={index}>
        <span>{typeof item === "string" ? item : `${item.location || "Any location"}${item.remote ? " · remote" : ""}`}</span>
        <Button type="button" size="sm" variant="ghost" disabled={save.isPending || uncertain} aria-label={`Remove location ${index + 1}`} onClick={() => remove("locations", index)}>Remove</Button>
      </li>)}</ul> : <p>No saved locations.</p>}</section>
      </div>
      <form className="search-explicit-form" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
        <FieldGroup className="search-explicit-fields">
        <form.Field name="query">{(field) => <Field><FieldLabel htmlFor={`${id}-query`}>Add literal query</FieldLabel><Input id={`${id}-query`} value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></Field>}</form.Field>
        <form.Field name="location">{(field) => <Field><FieldLabel htmlFor={`${id}-location`}>Add location</FieldLabel><Input id={`${id}-location`} value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></Field>}</form.Field>
        </FieldGroup>
        <form.Field name="remote">{(field) => <Field orientation="horizontal" className="search-tool-choice"><Checkbox id={`${id}-remote`} checked={field.state.value} onCheckedChange={field.handleChange} /><FieldLabel htmlFor={`${id}-remote`}>Remote location</FieldLabel></Field>}</form.Field>
        <form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p role="alert">{errors.join(" ")}</p> : null}</form.Subscribe>
        <Button type="submit" size="sm" variant="outline" disabled={save.isPending || uncertain}>{save.isPending ? "Saving…" : "Add targets"}</Button>
      </form>
    </> : query.isPending ? <p>Loading saved targets.</p> : null}
  </DisclosureSection>;
}
