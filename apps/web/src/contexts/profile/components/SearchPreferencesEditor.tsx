import { ProfileSchema, SEMANTIC_TAXONOMY, TargetLocationBindingSchema, type ProfileConfigResponse, type TargetLocationBinding } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { IconCheck, IconMapPin, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { z } from "zod";

import { isUnconfirmedWrite } from "../../../shared/lib/unconfirmed-write.js";
import { createScopedFormDraftStore } from "../../../shared/lib/scoped-form-drafts.js";
import type { PlaceResult, SessionPort } from "../../../shared/ports/index.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { AutosaveUndoController } from "../../../shared/ui/autosave-undo-controller.js";
import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { Empty } from "../../../shared/ui/empty.js";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { isJsonRecord, sameJson } from "../lib/json-record.js";
import { useProfileQuery } from "../hooks/useProfileQuery.js";
import { useUpdateProfileMutation } from "../hooks/useUpdateProfileMutation.js";

const locationRow = z.object({
  id: z.string(), text: z.string().max(300), models: z.array(z.string().max(100)).max(20),
  place: TargetLocationBindingSchema.nullable(),
});
const preferencesSchema = z.object({
  roles: z.array(z.string().max(300)).max(100), tracks: z.array(z.string().max(100)).max(30),
  levels: z.array(z.string().max(100)).max(30), functions: z.array(z.string().max(300)).max(100),
  specializations: z.array(z.string().max(300)).max(100), locations: z.array(locationRow).max(100),
});
type Preferences = z.infer<typeof preferencesSchema>;
type LocationRow = Preferences["locations"][number];
type Draft = { base: ProfileConfigResponse; values: Preferences; message: string; uncertain: boolean };
// Drafts are memory-only and scoped to the actual session port as well as tenant.
// They survive the Preferences ↔ Discovery handoff without persisting Profile data.
const drafts = createScopedFormDraftStore<Draft>();

export function clearSearchPreferencesDraftsForSession(session: SessionPort, tenant: string): void {
  drafts.getState().clear(session, tenant);
}

export interface SearchPreferencesState {
  readonly ready: boolean;
  readonly pending: boolean;
  readonly hasTargets: boolean;
  readonly needsModel: boolean;
  readonly profileVersion: number | null;
  readonly hasSearchLocation: boolean;
  readonly hasRemote: boolean;
  readonly hasRemoteWithLocation: boolean;
  readonly locationIssue: string | null;
}

/** Saved launch criteria and retained local edits, without mounting an editor. */
export function useSavedSearchPreferencesState(workspaceIdentity?: string) {
  const tenant = useTenantId();
  const { session } = usePorts();
  const query = useProfileQuery(workspaceIdentity);
  const retained = drafts((state) => workspaceIdentity ? state.read(session, tenant, workspaceIdentity) : undefined);
  const pending = Boolean(retained && (retained.uncertain || preferencesChanged(retained.base, retained.values)));
  const state: SearchPreferencesState = query.data
    ? describeSearchPreferences(readPreferences(query.data), {
      pending, ready: query.data.profileVersion !== null && !query.error,
      profileVersion: query.data.profileVersion,
    })
    : { ready: false, pending, hasTargets: false, needsModel: false, profileVersion: null,
      hasSearchLocation: false, hasRemote: false, hasRemoteWithLocation: false, locationIssue: null };
  return { state, loading: query.isPending || query.isFetching, error: query.error, refetch: query.refetch };
}

export function SearchPreferencesEditor({ onStateChange, workspaceIdentity }: {
  readonly onStateChange?: (state: SearchPreferencesState) => void;
  readonly workspaceIdentity?: string | undefined;
}) {
  const tenant = useTenantId(); const { session } = usePorts();
  const resetEpoch = drafts((state) => state.resetEpochs.get(session)?.get(tenant) ?? 0);
  const query = useProfileQuery(workspaceIdentity);
  return <>
    {query.error ? <Alert variant="destructive"><AlertDescription>Search preferences could not be refreshed. {query.error.message}</AlertDescription></Alert> : null}
    {query.data ? <SavedSearchPreferences key={`${workspaceIdentity ?? "unidentified"}:${resetEpoch}`} initial={query.data} onStateChange={onStateChange} workspaceIdentity={workspaceIdentity} /> : <Empty title="Loading search preferences" />}
  </>;
}

function split(value: unknown, keepEmpty = false): string[] {
  if (typeof value !== "string" || !value) return [];
  const values = value.replace(/\n/g, ";").split(";").map((item) => item.trim());
  return keepEmpty ? values : values.filter(Boolean);
}

function readPreferences(saved: ProfileConfigResponse): Preferences {
  const experience = isJsonRecord(saved.profile) && isJsonRecord(saved.profile.experience) ? saved.profile.experience : {};
  const places = z.array(TargetLocationBindingSchema).safeParse(experience.target_location_bindings ?? []);
  const bindings = places.success ? places.data : [];
  const locations = split(experience.target_locations, true);
  const models = split(experience.target_work_models, true);
  const ambiguousTexts = new Set(bindings.filter((binding) => bindings.filter((item) => item.text === binding.text).length > locations.filter((text) => text === binding.text).length).map((binding) => binding.text));
  const rows = Array.from({ length: Math.max(locations.length, models.length, 1) }, (_, index): LocationRow => ({
    id: `location-${index + 1}`, text: locations[index] ?? "", models: (models[index] ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    place: !ambiguousTexts.has(locations[index] ?? "") && bindings.filter((binding) => binding.rowIndex === index && binding.text === locations[index]).length === 1 ? bindings.find((binding) => binding.rowIndex === index && binding.text === locations[index])! : null,
  }));
  return {
    roles: split(experience.target_role).length ? split(experience.target_role) : [""],
    tracks: split(experience.target_track), levels: split(experience.target_seniority_floor),
    functions: split(experience.target_functions), specializations: split(experience.target_specializations), locations: rows,
  };
}

function withPreferences(saved: ProfileConfigResponse, values: Preferences): Record<string, unknown> {
  const profile = structuredClone(saved.profile) as Record<string, unknown>;
  const current = isJsonRecord(profile.experience) ? profile.experience : {};
  // Blank editing rows are presentation state. Preserve alignment of every
  // authored location with its work arrangements when serializing the fields.
  const rows = values.locations.filter((row) => row.text.trim() || row.models.length);
  profile.experience = {
    ...current,
    target_role: values.roles.map((value) => value.trim()).filter(Boolean).join("; "),
    target_track: values.tracks.join("; "), target_seniority_floor: values.levels.join("; "),
    target_functions: values.functions.map((value) => value.trim()).filter(Boolean).join("; "),
    target_specializations: values.specializations.map((value) => value.trim()).filter(Boolean).join("; "),
    target_locations: rows.map((row) => row.text.trim()).join("; "),
    target_work_models: rows.map((row) => row.models.join(", ")).join("; "),
    target_location_bindings: rows.flatMap((row, rowIndex) => row.place?.text === row.text.trim() ? [{ ...row.place, rowIndex }] : []),
  };
  return profile;
}

function canonicalPreferences(saved: ProfileConfigResponse, values: Preferences): unknown {
  return withPreferences(saved, values).experience;
}

function preferencesChanged(saved: ProfileConfigResponse, values: Preferences): boolean {
  return !sameJson(canonicalPreferences(saved, values), canonicalPreferences(saved, readPreferences(saved)));
}

function SavedSearchPreferences({ initial, onStateChange, workspaceIdentity }: {
  readonly initial: ProfileConfigResponse;
  readonly onStateChange?: ((state: SearchPreferencesState) => void) | undefined;
  readonly workspaceIdentity?: string | undefined;
}) {
  const tenant = useTenantId();
  const { session } = usePorts();
  const query = useProfileQuery(workspaceIdentity);
  const save = useUpdateProfileMutation({ optimistic: false, workspaceIdentity });
  const draftEpoch = useRef(drafts.getState().resetEpochs.get(session)?.get(tenant) ?? 0);
  const retained = useRef(workspaceIdentity ? drafts.getState().read(session, tenant, workspaceIdentity) : undefined);
  const base = useRef(retained.current?.base ?? initial);
  const defaults = useRef({ preferences: retained.current?.values ?? readPreferences(initial) });
  const [baseVersion, setBaseVersion] = useState(base.current.profileVersion);
  const [message, setMessage] = useState(retained.current?.message ?? "Changes save automatically.");
  const [uncertain, setUncertain] = useState(retained.current?.uncertain ?? false);
  const [resetToken, setResetToken] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const stale = initial.profileVersion !== null && (baseVersion === null || initial.profileVersion > baseVersion);
  const initialized = initial.profileVersion !== null;
  const latestDraft = useRef<Preferences>(defaults.current.preferences);
  const remember = useCallback((values: Preferences) => {
    latestDraft.current = values;
    if (!workspaceIdentity) return;
    drafts.getState().remember(session, tenant, workspaceIdentity, { base: base.current, values: structuredClone(values), message, uncertain }, draftEpoch.current);
  }, [message, session, tenant, uncertain, workspaceIdentity]);

  const form = useForm({
    defaultValues: defaults.current,
    validators: { onSubmit: ({ value }) => preferencesSchema.safeParse(value.preferences).success ? undefined : "Check the length of your search preferences." },
    onSubmit: async ({ value, formApi }) => {
      if (!initialized || stale || uncertain || save.isPending) return;
      const parsed = preferencesSchema.safeParse(value.preferences);
      if (!parsed.success) return;
      const profile = withPreferences(base.current, parsed.data);
      const validated = ProfileSchema.safeParse(profile);
      if (!validated.success) { setMessage(validated.error.issues[0]?.message ?? "Check your Profile before saving."); return; }
      if (sameJson(profile.experience, canonicalPreferences(base.current, readPreferences(base.current)))) { defaults.current = { preferences: value.preferences }; formApi.reset(defaults.current); remember(value.preferences); setMessage("Search preferences saved."); return; }
      const submitted = structuredClone(parsed.data);
      setMessage("Saving search preferences…");
      try {
        const result = await save.mutateAsync({ expectedProfileVersion: baseVersion, profileText: JSON.stringify(profile) });
        if (!sameJson((result.profile as Record<string, unknown>).experience, profile.experience)) {
          setUncertain(true); setMessage("The response did not confirm your preferences. Check the saved values before continuing."); return;
        }
        const latest = formApi.state.values.preferences;
        // reset() clears touched state and changes FormApi's defaults. Keep
        // useForm's caller-owned defaults in sync so its next options update
        // cannot reapply the old seed over this acknowledged save.
        defaults.current = { preferences: submitted };
        base.current = result;
        formApi.reset(defaults.current);
        if (!sameJson(latest, submitted)) formApi.setFieldValue("preferences", latest);
        setBaseVersion(result.profileVersion);
        remember(latest);
        setMessage(sameJson(latest, submitted) ? "Search preferences saved." : "Saved. Newer changes are waiting to save.");
      } catch (error) {
        if (isUnconfirmedWrite(error)) setUncertain(true);
        setMessage(isUnconfirmedWrite(error) ? "Saving could not be confirmed. Your draft is retained; check saved preferences before continuing." : "Search preferences could not be saved. Your draft is retained.");
      }
    },
  });

  useEffect(() => {
    if (save.isPending || preferencesChanged(base.current, form.state.values.preferences) || uncertain || initial.profileVersion === null || initial.profileVersion <= (baseVersion ?? -1)) return;
    defaults.current = { preferences: readPreferences(initial) };
    base.current = initial; setBaseVersion(initial.profileVersion);
    form.reset(defaults.current); setResetToken((value) => value + 1);
  }, [baseVersion, form, initial, save.isPending, uncertain]);
  useEffect(() => () => { remember(latestDraft.current); }, [remember]);

  const reviewSaved = async () => {
    const fresh = await query.refetch();
    if (!fresh.data || fresh.error) { setMessage("Saved preferences could not be checked. Your draft is retained."); return; }
    const before = canonicalPreferences(base.current, readPreferences(base.current)) as Record<string, unknown>;
    const local = canonicalPreferences(base.current, form.state.values.preferences) as Record<string, unknown>;
    const remote = canonicalPreferences(fresh.data, readPreferences(fresh.data)) as Record<string, unknown>;
    const keys = ["target_role", "target_track", "target_seniority_floor", "target_functions", "target_specializations", "target_locations", "target_work_models", "target_location_bindings"];
    if (keys.some((key) => !sameJson(local[key], before[key]) && !sameJson(remote[key], before[key]) && !sameJson(local[key], remote[key]))) {
      setMessage("The saved search preferences changed in the same fields as your draft. Review your draft or use the saved preferences below."); return;
    }
    const merged = { ...remote };
    for (const key of keys) if (!sameJson(local[key], before[key])) merged[key] = local[key];
    const next = readPreferences({ ...fresh.data, profile: { ...(fresh.data.profile as Record<string, unknown>), experience: merged } });
    defaults.current = { preferences: readPreferences(fresh.data) };
    base.current = fresh.data; setBaseVersion(fresh.data.profileVersion); setUncertain(false); save.reset();
    form.reset(defaults.current);
    if (!sameJson(merged, remote)) form.setFieldValue("preferences", next);
    remember(next); setResetToken((value) => value + 1);
    setMessage(sameJson(merged, remote) ? "Saved preferences checked." : "Your draft now uses the latest saved Profile. Review it and save changes.");
  };
  const useSaved = () => {
    base.current = initial; setBaseVersion(initial.profileVersion); setUncertain(false); save.reset();
    const values = readPreferences(initial); defaults.current = { preferences: values }; form.reset(defaults.current); remember(values); setResetToken((value) => value + 1); setMessage("Using saved search preferences.");
  };

  return <form className="search-preferences-editor" ref={formRef} onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
    {!initialized ? <Alert><AlertDescription>Save your first role in <Link to="/profile">My profile</Link> before saving search preferences. You can still browse and capture jobs.</AlertDescription></Alert> : null}
    <form.Field name="preferences">{(field) => <>
      <PreferenceDraftObserver values={field.state.value} remember={remember} />
      <fieldset disabled={!initialized} className="search-preferences-editable">
        <PreferenceSection title="Your next role" description="The titles, career tracks and levels you would consider.">
          <RepeatedInputs label="Target roles" values={field.state.value.roles} onChange={(roles) => field.handleChange({ ...field.state.value, roles })} placeholder="e.g. Director of Engineering" />
          <ChoiceGroup label="Career tracks" options={Object.entries(SEMANTIC_TAXONOMY.track).filter(([key]) => key !== "unknown")} values={field.state.value.tracks} onChange={(tracks) => field.handleChange({ ...field.state.value, tracks })} />
          <ChoiceGroup label="Seniority levels" options={Object.entries(SEMANTIC_TAXONOMY.seniority).filter(([key]) => key !== "unknown")} values={field.state.value.levels} onChange={(levels) => field.handleChange({ ...field.state.value, levels })} />
        </PreferenceSection>
        <PreferenceSection title="Locations" description="Select a map result and the work arrangements you would accept there.">
          <FieldGroup className="search-location-grid">
            {field.state.value.locations.map((row, index) => <TargetLocationRow key={row.id} row={row} index={index}
              onChange={(next) => field.handleChange({ ...field.state.value, locations: field.state.value.locations.map((item) => item.id === row.id ? next : item) })}
              onRemove={() => field.handleChange({ ...field.state.value, locations: field.state.value.locations.filter((item) => item.id !== row.id) })} />)}
          </FieldGroup>
          <Button type="button" size="sm" variant="outline" onClick={() => field.handleChange({ ...field.state.value, locations: [...field.state.value.locations, { id: nextRowId(field.state.value.locations.map((item) => item.id)), text: "", models: [], place: null }] })}><IconPlus data-icon="inline-start" />Add location</Button>
          <p className="search-preferences-help">Place lookup by <a href="https://github.com/komoot/photon" target="_blank" rel="noreferrer">Photon</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>. Only this location text is sent when you choose Search map. A selected place does not establish work authorization.</p>
        </PreferenceSection>
        <PreferenceSection title="Areas of interest" description="Optional functions and specializations used to prepare search queries.">
          <RepeatedInputs label="Functions" values={field.state.value.functions} onChange={(functions) => field.handleChange({ ...field.state.value, functions })} placeholder="e.g. Platform engineering" />
          <RepeatedInputs label="Specializations" values={field.state.value.specializations} onChange={(specializations) => field.handleChange({ ...field.state.value, specializations })} placeholder="e.g. Developer experience" />
        </PreferenceSection>
      </fieldset>
    </>}</form.Field>
    <form.Subscribe selector={(state) => ({ isSubmitting: state.isSubmitting, values: state.values })}>{({ isSubmitting, values }) => {
      const isDirty = preferencesChanged(base.current, values.preferences);
      return <>
      <SearchPreferencesStateObserver values={values.preferences} pending={isDirty || isSubmitting || save.isPending || uncertain || stale} ready={initialized} profileVersion={baseVersion} onStateChange={onStateChange} />
      <AutosaveUndoController formRef={formRef} isDirty={isDirty && initialized} isSubmitting={isSubmitting || uncertain || stale || Boolean(save.error)} resetToken={resetToken} restoreValues={(next) => form.setFieldValue("preferences", next.preferences)} setStatusMessage={setMessage} submit={() => form.handleSubmit()} values={values} />
      <div className="search-preferences-save" aria-live="polite"><span role="status">{isSubmitting ? "Saving search preferences…" : stale ? "The saved Profile changed. Review it before saving this draft." : message}</span>
        {isDirty ? <><Button type="submit" size="sm" disabled={isSubmitting || !initialized || stale || uncertain}>Save changes</Button><Button type="button" size="sm" variant="ghost" disabled={isSubmitting} onClick={useSaved}>Discard changes</Button></> : null}
      </div>
    </>; }}</form.Subscribe>
    <form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p role="alert">{errors.flat().filter(Boolean).join(" ")}</p> : null}</form.Subscribe>
    {save.error ? <Alert variant="destructive"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
    {stale || uncertain || save.error ? <div className="search-preferences-recovery"><Button type="button" variant="outline" size="sm" disabled={query.isFetching || save.isPending} onClick={() => { void reviewSaved(); }}>Check saved preferences</Button><Button type="button" variant="ghost" size="sm" disabled={save.isPending} onClick={useSaved}>Use saved preferences</Button></div> : null}
  </form>;
}

function PreferenceDraftObserver({ values, remember }: { values: Preferences; remember: (values: Preferences) => void }) {
  useEffect(() => { remember(values); }, [remember, values]);
  return null;
}

function describeSearchPreferences(values: Preferences, lifecycle: Pick<SearchPreferencesState, "pending" | "ready" | "profileVersion">): SearchPreferencesState {
  const hasTargets = values.roles.some((role) => Boolean(role.trim())) || values.tracks.length > 0 || values.levels.length > 0 || values.functions.some((value) => Boolean(value.trim())) || values.specializations.some((value) => Boolean(value.trim()));
  const needsModel = values.tracks.length > 0 || values.levels.length > 0 || values.functions.some((value) => Boolean(value.trim())) || values.specializations.some((value) => Boolean(value.trim()));
  // These are the literal saved work-model enum values accepted by Discovery,
  // including its retained wire aliases. No place or role meaning is inferred.
  const remote = (row: LocationRow) => row.models.some((model) => ["remote", "work_model.remote"].includes(model.toLowerCase()));
  const hasSearchLocation = values.locations.some((row) => Boolean(row.text.trim()) || remote(row));
  const hasRemote = values.locations.some(remote);
  const hasRemoteWithLocation = values.locations.some((row) => Boolean(row.text.trim()) && remote(row));
  const missingLocation = values.locations.some((row) => !row.text.trim() && row.models.some((model) => ["hybrid", "on-site", "onsite", "work_model.hybrid", "work_model.onsite"].includes(model.toLowerCase())));
  const unsupportedModel = values.locations.some((row) => row.models.some((model) => !["remote", "work_model.remote", "hybrid", "on-site", "onsite", "work_model.hybrid", "work_model.onsite"].includes(model.toLowerCase())));
  const locationIssue = missingLocation ? "Hybrid and On-site targets need an explicit location. Add a location or choose only Remote for that row." : unsupportedModel ? "A saved work arrangement is unsupported. Review the Other saved values in Locations before searching." : null;
  return { ...lifecycle, hasTargets, needsModel, hasSearchLocation, hasRemote, hasRemoteWithLocation, locationIssue };
}

function SearchPreferencesStateObserver({ values, pending, ready, profileVersion, onStateChange }: { values: Preferences; pending: boolean; ready: boolean; profileVersion: number | null; onStateChange?: ((state: SearchPreferencesState) => void) | undefined }) {
  const { hasTargets, needsModel, hasSearchLocation, hasRemote, hasRemoteWithLocation, locationIssue } = describeSearchPreferences(values, { pending, ready, profileVersion });
  useEffect(() => { onStateChange?.({ ready, pending, hasTargets, needsModel, profileVersion, hasSearchLocation, hasRemote, hasRemoteWithLocation, locationIssue }); }, [hasRemote, hasRemoteWithLocation, hasSearchLocation, hasTargets, locationIssue, needsModel, onStateChange, pending, profileVersion, ready]);
  return null;
}

function PreferenceSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="search-preferences-section"><header><h2>{title}</h2><p>{description}</p></header><FieldGroup>{children}</FieldGroup></section>;
}

function nextRowId(ids: readonly string[]): string {
  let number = ids.length + 1;
  while (ids.includes(`location-${number}`)) number += 1;
  return `location-${number}`;
}

function RepeatedInputs({ label, values, onChange, placeholder }: { label: string; values: readonly string[]; onChange: (values: string[]) => void; placeholder: string }) {
  const id = useId(); const inputs = useRef(new Map<number, HTMLInputElement>()); const focusIndex = useRef<number | null>(null);
  const rows = values.length ? values : [""];
  useEffect(() => { if (focusIndex.current !== null) { inputs.current.get(focusIndex.current)?.focus(); focusIndex.current = null; } }, [values]);
  const insert = (index: number) => { const next = [...rows]; next.splice(index + 1, 0, ""); focusIndex.current = index + 1; onChange(next); };
  return <FieldSet className="search-repeat-field"><FieldLegend variant="label">{label}</FieldLegend><FieldGroup className="search-repeat-grid">
    {rows.map((value, index) => <Field key={index} className="search-repeat-row"><FieldLabel className="sr-only" htmlFor={`${id}-${index}`}>{label} {index + 1}</FieldLabel><Input id={`${id}-${index}`} ref={(input) => { if (input) inputs.current.set(index, input); else inputs.current.delete(index); }} value={value} placeholder={placeholder} maxLength={300} onChange={(event) => { const next = [...rows]; next[index] = event.target.value; onChange(next); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); insert(index); } }} /><Button aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} type="button" size="icon" variant="ghost" onClick={() => onChange(rows.filter((_, position) => position !== index))}><IconTrash /></Button></Field>)}
    <Button type="button" variant="outline" size="sm" onClick={() => insert(rows.length - 1)}><IconPlus data-icon="inline-start" />Add {label === "Target roles" ? "role" : label === "Functions" ? "function" : "specialization"}</Button>
  </FieldGroup><FieldDescription>Press Enter to add and focus the next field.</FieldDescription></FieldSet>;
}

function ChoiceGroup({ label, options, values, onChange }: { label: string; options: readonly (readonly [string, string])[]; values: readonly string[]; onChange: (values: string[]) => void }) {
  const id = useId();
  const selected = options.filter(([code, name]) => values.includes(code) || values.includes(name)).map(([code]) => code);
  const unknown = values.filter((value) => !options.some(([code, name]) => value === code || value === name));
  return <FieldSet className="search-choice-group"><FieldLegend variant="label">{label}</FieldLegend><FieldGroup className="search-choices">{options.map(([code, name], index) => <Field orientation="horizontal" key={code}><Checkbox id={`${id}-${index}`} checked={selected.includes(code)} onCheckedChange={(checked) => onChange([...options.map(([value]) => value).filter((value) => value === code ? checked : selected.includes(value)), ...unknown])} /><FieldLabel htmlFor={`${id}-${index}`}>{name}</FieldLabel></Field>)}</FieldGroup>{unknown.length ? <div className="search-saved-values"><span>Other saved values</span>{unknown.map((value) => <Button type="button" size="sm" variant="outline" key={value} aria-label={`Remove saved ${label.toLowerCase()} ${value}`} onClick={() => onChange(values.filter((item) => item !== value))}>{value}<IconTrash data-icon="inline-end" /></Button>)}</div> : null}</FieldSet>;
}

function TargetLocationRow({ row, index, onChange, onRemove }: { row: LocationRow; index: number; onChange: (row: LocationRow) => void; onRemove: () => void }) {
  const { places } = usePorts(); const id = useId(); const controller = useRef<AbortController | null>(null); const request = useRef(0);
  const [options, setOptions] = useState<readonly PlaceResult[]>([]); const [status, setStatus] = useState<"idle" | "busy" | "results" | "empty" | "error">("idle"); const [error, setError] = useState("");
  useEffect(() => () => { controller.current?.abort(); }, []);
  const search = async () => {
    controller.current?.abort(); const current = ++request.current; const abort = new AbortController(); controller.current = abort; setStatus("busy"); setOptions([]); setError("");
    try { const results = await places.search(row.text.trim(), { signal: abort.signal }); if (current !== request.current || abort.signal.aborted) return; setOptions(results); setStatus(results.length ? "results" : "empty"); }
    catch (cause) { if (current !== request.current || abort.signal.aborted) return; setStatus("error"); setError(cause instanceof Error ? cause.message : "Place lookup is unavailable. Your text remains unverified."); }
  };
  const verified = row.place?.text === row.text.trim();
  return <FieldSet className="search-location-row"><FieldLegend variant="label">Location {index + 1}</FieldLegend><FieldGroup>
    <Field><FieldLabel className="sr-only" htmlFor={`${id}-text`}>Target location {index + 1}</FieldLabel><div className="search-location-input"><Input id={`${id}-text`} value={row.text} placeholder="City, region or country" maxLength={300} aria-describedby={`${id}-status`} onChange={(event) => { controller.current?.abort(); request.current += 1; setOptions([]); setStatus("idle"); onChange({ ...row, text: event.target.value, place: null }); }} /><Button type="button" variant="outline" size="sm" disabled={!row.text.trim() || status === "busy"} onClick={() => { void search(); }}><IconSearch data-icon="inline-start" />{status === "busy" ? "Looking up…" : "Search map"}</Button><Button type="button" variant="ghost" size="icon" aria-label={`Remove target location ${index + 1}`} onClick={onRemove}><IconTrash /></Button></div>
      <FieldDescription id={`${id}-status`} role="status">{status === "busy" ? "Looking up this location…" : verified ? <><IconCheck aria-hidden="true" />Verified place · {row.place?.displayName}</> : row.text ? "Unverified location. Choose a map result to bind this location." : "Enter a location, or choose Remote below for a location-free search."}</FieldDescription>
    </Field>
    {status === "results" ? <div className="search-place-results" role="group" aria-label={`Map results for location ${index + 1}`}>{options.map((place) => <Button key={place.placeId} type="button" variant="ghost" size="content" onClick={() => { onChange({ ...row, text: place.displayName, place: { ...place, rowIndex: index, text: place.displayName, selectedAt: new Date().toISOString(), provenance: "user_selected" } satisfies TargetLocationBinding }); setOptions([]); setStatus("idle"); }}><IconMapPin data-icon="inline-start" /><span>{place.displayName}</span></Button>)}</div> : null}
    {status === "empty" ? <p role="status">No places found. Try a more specific city, region or country. Your text remains unverified.</p> : null}
    {status === "error" ? <p role="alert">{error}</p> : null}
    <ChoiceGroup label={`Work arrangements for location ${index + 1}`} options={Object.entries(SEMANTIC_TAXONOMY.workModel).filter(([key]) => key !== "unknown")} values={row.models} onChange={(models) => onChange({ ...row, models })} />
    {verified ? <details className="search-place-provenance"><summary>Selected map place</summary><p>{row.place?.provider} · {row.place?.placeId}</p><p>{row.place?.latitude}, {row.place?.longitude} · selected {row.place?.selectedAt}</p></details> : null}
  </FieldGroup></FieldSet>;
}
