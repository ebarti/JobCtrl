import { DiscoverySettingsUpdateRequestSchema, type DiscoverySettingsResponse } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { isUnconfirmedWrite } from "../../../shared/lib/unconfirmed-write.js";
import { createScopedFormDraftStore } from "../../../shared/lib/scoped-form-drafts.js";
import type { SessionPort } from "../../../shared/ports/index.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { AutosaveUndoController } from "../../../shared/ui/autosave-undo-controller.js";
import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { Empty } from "../../../shared/ui/empty.js";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { useDiscoverySettingsQuery } from "../hooks/useDiscoverySettingsQuery.js";
import { useUpdateDiscoverySettingsMutation } from "../hooks/useUpdateDiscoverySettingsMutation.js";

const inputSchema = z.object({ boards: z.array(z.string().max(100)).max(30), newJobLimit: z.string(), resultsPerSite: z.string(), hoursOld: z.string() });
type Inputs = z.infer<typeof inputSchema>;
type Saved = DiscoverySettingsResponse & { revision: number; policyRevision: number };
type Draft = { base: Saved; values: Inputs; uncertain: boolean };
const drafts = createScopedFormDraftStore<Draft>();
export function clearDiscoverySearchSettingsDraftsForSession(session: SessionPort, tenant: string): void {
  drafts.getState().clear(session, tenant);
}
const BOARD_OPTIONS = [["indeed", "Indeed"], ["linkedin", "LinkedIn"], ["zip_recruiter", "ZipRecruiter"], ["glassdoor", "Glassdoor"]] as const;

export interface DiscoverySearchSettingsState {
  readonly ready: boolean;
  readonly pending: boolean;
  readonly boards: readonly string[];
  readonly hoursOld: number;
}

export function DiscoverySearchSettings({ onStateChange, onManageSources, workspaceIdentity }: {
  readonly onStateChange?: ((state: DiscoverySearchSettingsState) => void) | undefined;
  readonly onManageSources: () => void;
  readonly workspaceIdentity?: string | undefined;
}) {
  const tenant = useTenantId(); const { session } = usePorts();
  const resetEpoch = drafts((state) => state.resetEpochs.get(session)?.get(tenant) ?? 0);
  const query = useDiscoverySettingsQuery();
  return <section className="search-preferences-section search-settings-section" aria-labelledby="search-settings-heading">
    <header><h2 id="search-settings-heading">Search settings</h2><p>Choose where to search and how many new jobs to bring back.</p></header>
    {query.error ? <Alert variant="destructive"><AlertDescription>Search settings could not be refreshed. {query.error.message}</AlertDescription></Alert> : null}
    {query.data ? <SavedDiscoverySearchSettings key={`${workspaceIdentity ?? "unidentified"}:${resetEpoch}`} initial={query.data} onStateChange={onStateChange} workspaceIdentity={workspaceIdentity} /> : <Empty title="Loading search settings" />}
    <Button type="button" size="sm" variant="outline" onClick={onManageSources}>Manage search sources</Button>
  </section>;
}

function toInputs(saved: Saved): Inputs {
  return { boards: saved.settings.boards, newJobLimit: String(saved.settings.newJobLimit ?? 100), resultsPerSite: String(saved.settings.resultsPerSite), hoursOld: String(saved.settings.hoursOld) };
}
function toBody(values: Inputs) {
  return DiscoverySettingsUpdateRequestSchema.safeParse({ boards: values.boards, newJobLimit: values.newJobLimit === "" ? NaN : Number(values.newJobLimit), resultsPerSite: values.resultsPerSite === "" ? NaN : Number(values.resultsPerSite), hoursOld: values.hoursOld === "" ? NaN : Number(values.hoursOld) });
}
function equal(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
function settingsChanged(saved: Saved, values: Inputs): boolean {
  const next = toBody(values); const previous = toBody(toInputs(saved));
  return !next.success || !previous.success || !equal(next.data, previous.data);
}

function SavedDiscoverySearchSettings({ initial, onStateChange, workspaceIdentity }: { initial: Saved; onStateChange?: ((state: DiscoverySearchSettingsState) => void) | undefined; workspaceIdentity?: string | undefined }) {
  const tenant = useTenantId(); const { session } = usePorts(); const query = useDiscoverySettingsQuery(); const save = useUpdateDiscoverySettingsMutation();
  const draftEpoch = useRef(drafts.getState().resetEpochs.get(session)?.get(tenant) ?? 0);
  const retained = useRef(workspaceIdentity ? drafts.getState().read(session, tenant, workspaceIdentity) : undefined); const base = useRef(retained.current?.base ?? initial);
  const defaults = useRef(retained.current?.values ?? toInputs(initial)); const [baseRevision, setBaseRevision] = useState(base.current.revision);
  const [uncertain, setUncertain] = useState(retained.current?.uncertain ?? false); const [message, setMessage] = useState("Changes save automatically."); const [resetToken, setResetToken] = useState(0); const formRef = useRef<HTMLFormElement>(null); const latest = useRef(defaults.current);
  const stale = initial.revision > baseRevision;
  const remember = useCallback((values: Inputs) => {
    latest.current = values; if (!workspaceIdentity) return;
    drafts.getState().remember(session, tenant, workspaceIdentity, { base: base.current, values: structuredClone(values), uncertain }, draftEpoch.current);
  }, [session, tenant, uncertain, workspaceIdentity]);
  const form = useForm({ defaultValues: defaults.current,
    validators: { onSubmit: ({ value }) => toBody(value).success ? undefined : "Use whole numbers: 1–10,000 new jobs, 1–1,000 results per board, and 0–8,760 posting-age hours." },
    onSubmit: async ({ value, formApi }) => {
      const parsed = toBody(value); if (!parsed.success || stale || uncertain || save.isPending) return;
      if (equal(toInputs(base.current), value)) { setMessage("Search settings saved."); return; }
      const submitted = structuredClone(value); setMessage("Saving search settings…");
      try {
        const result = await save.mutateAsync(parsed.data); const current = formApi.state.values;
        // Keep the hook's defaults aligned with reset() before touched state
        // is cleared, then put any newer in-flight edits back on that baseline.
        defaults.current = submitted;
        base.current = result; formApi.reset(defaults.current); setBaseRevision(result.revision);
        if (!equal(current, submitted)) { for (const key of ["boards", "newJobLimit", "resultsPerSite", "hoursOld"] as const) { if (key === "boards") formApi.setFieldValue("boards", current.boards); else formApi.setFieldValue(key, current[key]); } }
        remember(current); setMessage(equal(current, submitted) ? "Search settings saved." : "Saved. Newer settings are waiting to save.");
      } catch (error) { if (isUnconfirmedWrite(error)) setUncertain(true); setMessage(isUnconfirmedWrite(error) ? "Saving could not be confirmed. Check the saved settings before continuing." : "Search settings could not be saved. Your draft is retained."); }
    },
  });
  useEffect(() => {
    if (save.isPending || settingsChanged(base.current, form.state.values) || uncertain || initial.revision <= baseRevision) return;
    defaults.current = toInputs(initial);
    base.current = initial; setBaseRevision(initial.revision); form.reset(defaults.current); setResetToken((token) => token + 1);
  }, [baseRevision, form, initial, save.isPending, uncertain]);
  useEffect(() => () => { remember(latest.current); }, [remember]);
  const check = async () => {
    const fresh = await query.refetch(); if (!fresh.data || fresh.error) { setMessage("Saved settings are unavailable. Your draft is retained."); return; }
    const current = form.state.values; const saved = toInputs(fresh.data);
    defaults.current = saved;
    base.current = fresh.data; setBaseRevision(fresh.data.revision); setUncertain(false); save.reset(); form.reset(defaults.current);
    if (!equal(current, saved)) { form.setFieldValue("boards", current.boards); form.setFieldValue("newJobLimit", current.newJobLimit); form.setFieldValue("resultsPerSite", current.resultsPerSite); form.setFieldValue("hoursOld", current.hoursOld); }
    remember(current); setResetToken((token) => token + 1);
    setMessage(equal(current, saved) ? "Saved search settings checked." : `Saved settings: ${saved.boards.join(", ") || "no boards"}, ${saved.newJobLimit} new jobs, ${saved.resultsPerSite} results per board, ${saved.hoursOld} posting-age hours. Your draft is retained for review.`);
  };
  const useSaved = () => { base.current = initial; setBaseRevision(initial.revision); setUncertain(false); save.reset(); const values = toInputs(initial); defaults.current = values; form.reset(defaults.current); remember(values); setResetToken((token) => token + 1); setMessage("Using saved search settings."); };
  return <form className="search-settings-form" ref={formRef} onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
    <FieldGroup>
      <form.Field name="boards">{(field) => <FieldSet className="search-choice-group"><FieldLegend variant="label">Job boards</FieldLegend><FieldGroup className="search-choices">{[...BOARD_OPTIONS, ...field.state.value.filter((value) => !BOARD_OPTIONS.some(([code]) => value === code)).map((value) => [value, value] as const)].map(([value, label]) => <Field key={value} orientation="horizontal"><Checkbox id={`search-board-${value}`} checked={field.state.value.includes(value)} disabled={!initial.effectiveSettings.boards.editable} onCheckedChange={(checked) => field.handleChange(checked ? [...field.state.value, value] : field.state.value.filter((board) => board !== value))} /><FieldLabel htmlFor={`search-board-${value}`}>{label}</FieldLabel></Field>)}</FieldGroup><FieldDescription>Employer sources you enabled are searched alongside these boards.</FieldDescription></FieldSet>}</form.Field>
      <FieldGroup className="search-limit-grid">
        <form.Field name="newJobLimit">{(field) => <Field><FieldLabel htmlFor="search-new-job-limit">Maximum new jobs</FieldLabel><Input id="search-new-job-limit" type="number" min={1} max={10000} step={1} inputMode="numeric" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} /><FieldDescription>Maximum new jobs added by each search.</FieldDescription></Field>}</form.Field>
        <form.Field name="hoursOld">{(field) => <Field><FieldLabel htmlFor="search-posting-age">Posting age</FieldLabel><Input id="search-posting-age" type="number" min={0} max={8760} step={1} inputMode="numeric" value={field.state.value} disabled={!initial.effectiveSettings.hoursOld.editable} onChange={(event) => field.handleChange(event.target.value)} /><FieldDescription>Hours. 0 means no age cutoff; provider support varies.</FieldDescription></Field>}</form.Field>
        <form.Field name="resultsPerSite">{(field) => <Field><FieldLabel htmlFor="search-results-per-board">Results per board</FieldLabel><Input id="search-results-per-board" type="number" min={1} max={1000} step={1} inputMode="numeric" value={field.state.value} disabled={!initial.effectiveSettings.resultsPerSite.editable} onChange={(event) => field.handleChange(event.target.value)} /><FieldDescription>Maximum requested for each query and location.</FieldDescription></Field>}</form.Field>
      </FieldGroup>
    </FieldGroup>
    <form.Subscribe selector={(state) => ({ values: state.values, isSubmitting: state.isSubmitting })}>{({ values, isSubmitting }) => {
      const isDirty = settingsChanged(base.current, values);
      return <>
      <SettingsObserver values={values} remember={remember} onStateChange={onStateChange} pending={isDirty || isSubmitting || stale || uncertain || save.isPending} />
      <AutosaveUndoController formRef={formRef} isDirty={isDirty} isSubmitting={isSubmitting || stale || uncertain || Boolean(save.error)} resetToken={resetToken} restoreValues={(next) => { form.setFieldValue("boards", next.boards); form.setFieldValue("newJobLimit", next.newJobLimit); form.setFieldValue("hoursOld", next.hoursOld); form.setFieldValue("resultsPerSite", next.resultsPerSite); }} setStatusMessage={setMessage} submit={() => form.handleSubmit()} values={values} />
      <div className="search-preferences-save" aria-live="polite"><span role="status">{isSubmitting ? "Saving search settings…" : stale ? "Saved search settings changed. Check them before saving this draft." : message}</span>{isDirty ? <><Button type="submit" size="sm" disabled={isSubmitting || stale || uncertain}>Save search settings</Button><Button type="button" variant="ghost" size="sm" disabled={isSubmitting} onClick={useSaved}>Discard changes</Button></> : null}</div>
    </>; }}</form.Subscribe>
    <form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p role="alert">{errors.flat().filter(Boolean).join(" ")}</p> : null}</form.Subscribe>
    {save.error ? <Alert variant="destructive"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
    {stale || uncertain || save.error ? <div className="search-preferences-recovery"><Button type="button" variant="outline" size="sm" disabled={query.isFetching || save.isPending} onClick={() => { void check(); }}>Check saved search settings</Button><Button type="button" variant="ghost" size="sm" onClick={useSaved}>Use saved search settings</Button></div> : null}
  </form>;
}

function SettingsObserver({ values, remember, onStateChange, pending }: { values: Inputs; remember: (values: Inputs) => void; onStateChange?: ((state: DiscoverySearchSettingsState) => void) | undefined; pending: boolean }) {
  const valid = toBody(values).success;
  useEffect(() => { remember(values); }, [remember, values]);
  useEffect(() => { onStateChange?.({ ready: valid, pending, boards: values.boards, hoursOld: Number(values.hoursOld) }); }, [onStateChange, pending, valid, values.boards, values.hoursOld]);
  return null;
}
