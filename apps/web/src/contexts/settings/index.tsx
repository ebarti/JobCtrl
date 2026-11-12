import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";

import { invalidateQueriesWithOptimisticOwnership, retainLaterQueryPublication } from "../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import type { SessionPort } from "../../shared/ports/SessionPort.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { Button } from "../../shared/ui/button.js";
import { AutosaveUndoController } from "../../shared/ui/autosave-undo-controller.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/select.js";
import { useProviderCatalog } from "./credentials.js";

const settingsSchema = z.object({
  revision: z.number().int().positive(),
  defaultProvider: z.enum(["codex", "claude", "google"]),
  providerModels: z.record(z.string(), z.string()),
  dailyBudgetUsd: z.number(),
  laneTokenLimits: z.record(z.string(), z.number()),
  laneConcurrency: z.record(z.string(), z.number()),
  providerConfiguration: z.record(z.string(), z.string()),
  resumeMode: z.enum(["baseline", "tailored"]),
  aiExecutionPolicy: z.object({ enabled: z.boolean() }),
  workerActivitySlots: z.number().int(),
  applyConcurrency: z.number().int(),
  applyTimeoutSeconds: z.number().int(),
  applyMaxBudgetUsd: z.number(),
  minFitScore: z.number().int(),
  scoreCriteria: z.string(),
  targetCriteria: z.string(),
  codexReasoningEfforts: z.record(z.string(), z.enum(["low", "medium", "high", "xhigh", "max"])),
  modelAccounting: z.object({
    provider: z.string(), model: z.string().nullable(), available: z.boolean(),
    costSource: z.string().nullable(),
  }).optional(),
  modelPricingQuotes: z.record(z.string(), z.object({
    inputUsdPerMillion: z.number().nonnegative(), outputUsdPerMillion: z.number().nonnegative(),
    source: z.string().min(1).max(500), revision: z.string().min(1).max(500),
  })),
}).passthrough();
export type ApplicationSettings = z.infer<typeof settingsSchema>;
export type ApplicationSettingsPatch = Partial<Pick<ApplicationSettings,
  "defaultProvider" | "providerModels" | "dailyBudgetUsd" | "laneTokenLimits" | "laneConcurrency" |
  "providerConfiguration" | "resumeMode" | "aiExecutionPolicy" | "workerActivitySlots" |
  "applyConcurrency" | "applyTimeoutSeconds" | "applyMaxBudgetUsd" | "minFitScore" |
  "scoreCriteria" | "targetCriteria" | "codexReasoningEfforts" | "modelPricingQuotes">>;

export const applicationSettingsKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "settings"] as const,
  current: (tenantId: string) => [...applicationSettingsKeys.all(tenantId), "application"] as const,
};

function parseSettings(value: unknown): ApplicationSettings {
  const parsed = settingsSchema.safeParse(value);
  if (!parsed.success) throw new Error("The saved settings response is invalid.");
  return parsed.data;
}

export function useApplicationSettings() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  const key = applicationSettingsKeys.current(tenantId);
  return useQuery({
    queryKey: key,
    queryFn: async () => parseSettings(await http.json<unknown>("GET", "/v1/settings")),
    structuralSharing: (previous, next) => {
      const old = settingsSchema.safeParse(previous);
      const incoming = settingsSchema.safeParse(next);
      if (old.success && incoming.success && old.data.revision > incoming.data.revision) {
        const query = client.getQueryCache().find({ queryKey: key, exact: true });
        if (query) retainLaterQueryPublication(client, query, previous);
        return previous;
      }
      return next;
    },
    meta: { suppressGlobalErrorToast: true },
  });
}

export function useUpdateApplicationSettings() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ expectedRevision, patch }: { expectedRevision: number; patch: ApplicationSettingsPatch }) => {
      const path = "/v1/settings";
      const response = await http.json<unknown>("PATCH", path, { body: { expectedRevision, ...patch } });
      try { return parseSettings(response); }
      catch (error) { throw createUnconfirmedWriteError("PATCH", path, error); }
    },
    onSuccess: (saved) => client.setQueryData<ApplicationSettings>(applicationSettingsKeys.current(tenantId), (current) =>
      !current || current.revision <= saved.revision ? saved : current),
  });
}

export const applicationSettingsEvents: FeatureEventHandler = {
  eventTypes: ["SettingsUpdated"],
  handle(event, client) {
    void invalidateQueriesWithOptimisticOwnership(client, applicationSettingsKeys.all(event.tenantId));
  },
};

const numericFields = [
  ["dailyBudgetUsd", "Daily LLM budget (USD)", 0, 100000],
  ["workerActivitySlots", "Worker activity slots", 1, 64],
  ["applyConcurrency", "Concurrent applications", 1, 8],
  ["applyTimeoutSeconds", "Application timeout (seconds)", 30, 7200],
  ["applyMaxBudgetUsd", "Application budget (USD)", 0, 10000],
  ["minFitScore", "Minimum fit score", 1, 10],
] as const;

const formSchema = z.object({
  defaultProvider: settingsSchema.shape.defaultProvider,
  codexModel: z.string().trim().max(200),
  claudeModel: z.string().trim().max(200),
  googleModel: z.string().trim().max(200),
  dailyBudgetUsd: z.coerce.number().min(0).max(100000),
  workerActivitySlots: z.coerce.number().int().min(1).max(64),
  applyConcurrency: z.coerce.number().int().min(1).max(8),
  applyTimeoutSeconds: z.coerce.number().int().min(30).max(7200),
  applyMaxBudgetUsd: z.coerce.number().min(0).max(10000),
  minFitScore: z.coerce.number().int().min(1).max(10),
  resumeMode: settingsSchema.shape.resumeMode,
  aiEnabled: z.boolean(),
  scoreCriteria: z.string().max(20000),
  targetCriteria: z.string().max(20000),
  laneTokenLimits: z.string(),
  laneConcurrency: z.string(),
  codexReasoningEfforts: z.string(),
  providerConfiguration: z.string(),
  modelPricingQuotes: z.string(),
});

function formValues(settings: ApplicationSettings) {
  return {
    defaultProvider: settings.defaultProvider,
    codexModel: settings.providerModels.codex ?? "",
    claudeModel: settings.providerModels.claude ?? "",
    googleModel: settings.providerModels.google ?? "",
    dailyBudgetUsd: String(settings.dailyBudgetUsd),
    workerActivitySlots: String(settings.workerActivitySlots),
    applyConcurrency: String(settings.applyConcurrency),
    applyTimeoutSeconds: String(settings.applyTimeoutSeconds),
    applyMaxBudgetUsd: String(settings.applyMaxBudgetUsd),
    minFitScore: String(settings.minFitScore),
    resumeMode: settings.resumeMode,
    aiEnabled: settings.aiExecutionPolicy.enabled,
    scoreCriteria: settings.scoreCriteria,
    targetCriteria: settings.targetCriteria,
    laneTokenLimits: JSON.stringify(settings.laneTokenLimits, null, 2),
    laneConcurrency: JSON.stringify(settings.laneConcurrency, null, 2),
    codexReasoningEfforts: JSON.stringify(settings.codexReasoningEfforts, null, 2),
    providerConfiguration: JSON.stringify(settings.providerConfiguration, null, 2),
    modelPricingQuotes: JSON.stringify(settings.modelPricingQuotes, null, 2),
  };
}

function parseMap<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type SettingsSection = "general" | "models" | "budgets" | "automation";
type SettingsFormValues = ReturnType<typeof formValues>;
type SettingsDraft = { baseline: ApplicationSettings; values: SettingsFormValues };
// A navigation-surviving, in-memory draft. Never write settings or credentials
// to browser storage; the baseline revision still governs every later save.
interface SettingsDraftBucket {
  drafts: Map<string, SettingsDraft>;
  generation: number;
  listeners: Set<() => void>;
}
const settingsDrafts = new WeakMap<SessionPort, SettingsDraftBucket>();

function draftsForSession(session: SessionPort): SettingsDraftBucket {
  let bucket = settingsDrafts.get(session);
  if (!bucket) {
    bucket = { drafts: new Map(), generation: 0, listeners: new Set() };
    settingsDrafts.set(session, bucket);
  }
  return bucket;
}

/** Clear one tenant's drafts and remount open forms when its workspace resets. */
export function clearSettingsDraftsForSession(session: SessionPort, tenant: string): void {
  const bucket = settingsDrafts.get(session);
  if (!bucket) return;
  for (const section of ["general", "models", "budgets", "automation"] as const) {
    bucket.drafts.delete(JSON.stringify([tenant, section]));
  }
  bucket.generation += 1;
  for (const listener of bucket.listeners) listener();
}

function SettingsDraftKeeper({ drafts, draftKey, baseline, values, isDirty }: {
  readonly drafts: Map<string, SettingsDraft>; readonly draftKey: string; readonly baseline: ApplicationSettings;
  readonly values: SettingsFormValues; readonly isDirty: boolean;
}) {
  useEffect(() => {
    if (isDirty) drafts.set(draftKey, { baseline, values });
    else drafts.delete(draftKey);
  }, [drafts, draftKey, baseline, values, isDirty]);
  return null;
}

function SettingsForm({ saved, section, active, refresh }: { readonly saved: ApplicationSettings; readonly section: SettingsSection; readonly active: boolean; readonly refresh: () => void }) {
  const tenantId = useTenantId();
  const { session } = usePorts();
  const drafts = draftsForSession(session).drafts;
  const draftKey = JSON.stringify([tenantId, section]);
  const [initialDraft] = useState(() => drafts.get(draftKey));
  const update = useUpdateApplicationSettings();
  // Browsing settings is read-only. Loading models may invoke external providers,
  // so it only runs after the user explicitly requests a refresh.
  const catalog = useProviderCatalog({ enabled: false });
  const [baseline, setBaseline] = useState(initialDraft?.baseline ?? saved);
  const [validation, setValidation] = useState("");
  const [status, setStatus] = useState("");
  const [resetToken, setResetToken] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const form = useForm({
    defaultValues: formValues(initialDraft?.baseline ?? saved),
    onSubmit: async ({ value }) => {
      const result = formSchema.safeParse(value);
      if (!result.success) { setValidation("Check the model names and numeric limits before saving."); return; }
      const v = result.data;
      const models = { ...baseline.providerModels };
      for (const [provider, model] of Object.entries({ codex: v.codexModel, claude: v.claudeModel, google: v.googleModel })) {
        if (model === (baseline.providerModels[provider] ?? "")) continue;
        if (model) models[provider] = model;
        else delete models[provider];
      }
      const modelSelectionChanged = v.defaultProvider !== baseline.defaultProvider || JSON.stringify(models) !== JSON.stringify(baseline.providerModels);
      if (modelSelectionChanged && !models[v.defaultProvider]) { setValidation("Choose a model for the default provider."); return; }
      const tokenLimits = parseMap(v.laneTokenLimits, z.record(z.string(), z.number().int().min(0).max(1000000000)));
      const concurrency = parseMap(v.laneConcurrency, z.record(z.string(), z.number().int().min(1).max(32)));
      const efforts = parseMap(v.codexReasoningEfforts, settingsSchema.shape.codexReasoningEfforts);
      const configuration = parseMap(v.providerConfiguration, settingsSchema.shape.providerConfiguration);
      const pricing = parseMap(v.modelPricingQuotes, settingsSchema.shape.modelPricingQuotes);
      if (!tokenLimits || !concurrency || !efforts || !configuration || !pricing) {
        setValidation("Advanced settings must be valid JSON objects with values of the indicated type.");
        return;
      }
      setValidation("");
      try {
        const candidate: ApplicationSettingsPatch = {
          defaultProvider: v.defaultProvider,
          providerModels: models,
          dailyBudgetUsd: v.dailyBudgetUsd, workerActivitySlots: v.workerActivitySlots,
          applyConcurrency: v.applyConcurrency, applyTimeoutSeconds: v.applyTimeoutSeconds,
          applyMaxBudgetUsd: v.applyMaxBudgetUsd, minFitScore: v.minFitScore,
          resumeMode: v.resumeMode, aiExecutionPolicy: { enabled: v.aiEnabled },
          scoreCriteria: v.scoreCriteria, targetCriteria: v.targetCriteria,
          laneTokenLimits: tokenLimits, laneConcurrency: concurrency,
          codexReasoningEfforts: efforts, providerConfiguration: configuration,
          modelPricingQuotes: pricing,
        };
        const patch = Object.fromEntries(Object.entries(candidate).filter(([key, next]) =>
          JSON.stringify(baseline[key]) !== JSON.stringify(next))) as ApplicationSettingsPatch;
        if (!Object.keys(patch).length) { setValidation("No settings have changed."); return; }
        const result = await update.mutateAsync({ expectedRevision: baseline.revision, patch });
        // A later section may already hold a newer draft when this request
        // settles. Only clear the snapshot that this request actually saved.
        const pendingDraft = drafts.get(draftKey);
        if (pendingDraft?.baseline.revision === baseline.revision && JSON.stringify(pendingDraft.values) === JSON.stringify(value)) {
          drafts.delete(draftKey);
        }
        setBaseline(result);
        form.reset(formValues(result));
        setStatus("Settings saved.");
      } catch { /* Keep the edited values for review and retry. */ }
    },
  });
  const restoreDraftValues = (values: SettingsFormValues) => {
    // reset() clears field dirty state even with keepDefaultValues. Reapply
    // changed fields so autosave and stale-revision protection see the draft.
    const original = formValues(baseline);
    form.reset(original);
    for (const key of Object.keys(values) as Array<keyof SettingsFormValues>) {
      if (values[key] !== original[key]) {
        form.setFieldValue(key, values[key], { dontRunListeners: true, dontValidate: true });
      }
    }
  };
  useEffect(() => {
    if (initialDraft) restoreDraftValues(initialDraft.values);
    // Restore once for this mount; subsequent changes belong to the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (saved.revision !== baseline.revision && !form.state.isDirty && !form.state.isSubmitting) {
      form.reset(formValues(saved));
      setBaseline(saved);
      setResetToken((token) => token + 1);
    }
  }, [saved, baseline.revision, form]);
  const stale = saved.revision !== baseline.revision;
  return <form className="settings-application-form" ref={formRef} onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
    {stale ? <p role="alert">Settings changed elsewhere. Your edits remain here; load the saved version before editing against it.</p> : null}
    {stale ? <Button type="button" variant="outline" onClick={() => { form.reset(formValues(saved)); setBaseline(saved); setResetToken((token) => token + 1); setStatus(""); }}>Discard draft and load saved settings</Button> : null}
    <form.Subscribe selector={(state) => ({ isDirty: state.isDirty, isSubmitting: state.isSubmitting, values: state.values })}>
      {({ isDirty, isSubmitting, values }) => <>
        <SettingsDraftKeeper drafts={drafts} draftKey={draftKey} baseline={baseline} values={values} isDirty={isDirty} />
        <AutosaveUndoController
          formRef={formRef} isDirty={isDirty} isSubmitting={isSubmitting || stale || !active} resetToken={resetToken}
          restoreValues={restoreDraftValues}
          setStatusMessage={setStatus} submit={() => form.handleSubmit()} values={values} />
      </>}
    </form.Subscribe>
    {status ? <p role="status">{status}</p> : null}
    <fieldset disabled={update.isPending}>
      {section === "models" ? <>
      <p>Saved selections are shown below. Refresh the catalog to check the available models with your providers.</p>
      <Button type="button" variant="outline" disabled={catalog.isFetching} onClick={() => { void catalog.refetch(); }}>{catalog.isFetching ? "Refreshing models…" : "Refresh model catalog"}</Button>
      {catalog.error ? <div role="alert"><p>The live model catalog could not be refreshed: {catalog.error.message}. Saved selections remain unchanged.</p><Button type="button" variant="outline" onClick={() => { void catalog.refetch(); }}>Retry catalog</Button></div> : null}
      <form.Field name="defaultProvider">{(field) => <div><label htmlFor="settings-default-provider">Default provider</label><Select value={field.state.value} disabled={update.isPending} onValueChange={(value) => { if (value) field.handleChange(value as ApplicationSettings["defaultProvider"]); }}>
        <SelectTrigger id="settings-default-provider" onBlur={field.handleBlur}><SelectValue>{({ codex: "Codex", claude: "Claude", google: "Google" } as const)[field.state.value]}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="codex">Codex</SelectItem><SelectItem value="claude">Claude</SelectItem><SelectItem value="google">Google</SelectItem></SelectContent>
      </Select></div>}</form.Field>
      {(["codexModel", "claudeModel", "googleModel"] as const).map((name) => {
        const providerId = name === "codexModel" ? "codex" : name === "claudeModel" ? "claude" : "google";
        const provider = catalog.data?.providers.find((item) => item.provider === providerId);
        const models = provider?.models.filter((model) => model.capabilities.includes("structured_json")) ?? [];
        return <form.Field key={name} name={name}>{(field) => <div>
          <label htmlFor={`settings-${providerId}-model`}>{providerId === "codex" ? "Codex model" : providerId === "claude" ? "Claude model" : "Google model"}</label>
          <Select value={field.state.value} disabled={update.isPending || !provider?.ready || !models.length} onValueChange={(value) => { if (value !== null) field.handleChange(value); }}>
            <SelectTrigger id={`settings-${providerId}-model`} onBlur={field.handleBlur}><SelectValue>{models.find((model) => model.id === field.state.value)?.displayName ?? (field.state.value ? `${field.state.value}${catalog.data ? " (saved; not in the catalog)" : " (saved)"}` : "No model configured")}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="">No model configured</SelectItem>
              {field.state.value && !models.some((model) => model.id === field.state.value) ? <SelectItem value={field.state.value}>{field.state.value} (saved; not in the live catalog)</SelectItem> : null}
              {models.map((model) => <SelectItem key={model.id} value={model.id}>{model.displayName}{model.isDefault ? " (provider default)" : ""}</SelectItem>)}
            </SelectContent>
          </Select>
          <p>{provider?.message ?? (provider?.ready ? "Model catalog available." : catalog.data ? "Provider catalog unavailable; saved selection retained." : "Refresh the catalog to choose a model.")}</p>
          {models.find((model) => model.id === field.state.value)?.supportedReasoningEfforts?.length ? <p>Reported reasoning options: {models.find((model) => model.id === field.state.value)!.supportedReasoningEfforts!.map((effort) => effort.reasoningEffort).join(", ")}.</p> : null}
        </div>}</form.Field>;
      })}
      <form.Subscribe selector={(state) => state.values.codexModel}>{(modelId) => {
        const model = catalog.data?.providers.find((provider) => provider.provider === "codex")?.models.find((item) => item.id === modelId);
        const options = (model?.supportedReasoningEfforts ?? []).filter((item) => ["low", "medium", "high", "xhigh", "max"].includes(item.reasoningEffort));
        if (!modelId || !options.length) return null;
        return <form.Field name="codexReasoningEfforts">{(field) => {
          const choices = parseMap(field.state.value, settingsSchema.shape.codexReasoningEfforts);
          return <div><label htmlFor="settings-codex-effort">Codex reasoning effort for {modelId}</label><Select value={choices?.[modelId] ?? ""} disabled={update.isPending || !choices} onValueChange={(value) => {
            if (!choices || value === null) return;
            const next = { ...choices };
            if (value) next[modelId] = value as "low" | "medium" | "high" | "xhigh" | "max";
            else delete next[modelId];
            field.handleChange(JSON.stringify(next, null, 2));
          }}><SelectTrigger id="settings-codex-effort" onBlur={field.handleBlur}><SelectValue>{choices?.[modelId] ?? "Provider default"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="">Provider default</SelectItem>{choices?.[modelId] && !options.some((option) => option.reasoningEffort === choices[modelId]) ? <SelectItem value={choices[modelId]}>{choices[modelId]} (saved; not currently reported)</SelectItem> : null}{options.map((option) => <SelectItem key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}{option.description ? ` — ${option.description}` : ""}</SelectItem>)}</SelectContent></Select></div>;
        }}</form.Field>;
      }}</form.Subscribe>
      <form.Field name="aiEnabled">{(field) => <label><input type="checkbox" checked={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.checked)} /> Enable AI actions</label>}</form.Field>
      </> : <>
      {section === "automation" ? <form.Field name="aiEnabled">{(field) => <label><input type="checkbox" checked={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.checked)} /> Enable AI actions</label>}</form.Field> : null}
      {numericFields.filter(([name]) => section === "budgets" ? name === "dailyBudgetUsd" || name === "applyMaxBudgetUsd" : section === "automation" ? name === "minFitScore" : name === "dailyBudgetUsd" || name === "applyMaxBudgetUsd" || name === "minFitScore").map(([name, label, min, max]) => <form.Field key={name} name={name}>{(field) => <label>{label}<input type="number" min={min} max={max} step={name.endsWith("Usd") ? "0.01" : "1"} value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></label>}</form.Field>)}
      {section !== "automation" ? <p>A zero daily budget means no daily cap. A zero application budget is a $0 cap.</p> : null}
      {section !== "budgets" ? <>
      <form.Field name="resumeMode">{(field) => <div><label htmlFor="settings-resume-mode">Default resume mode</label><Select value={field.state.value} disabled={update.isPending} onValueChange={(value) => { if (value) field.handleChange(value as ApplicationSettings["resumeMode"]); }}><SelectTrigger id="settings-resume-mode" onBlur={field.handleBlur}><SelectValue>{field.state.value === "baseline" ? "Copy approved baseline" : "Tailored"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="baseline">Copy approved baseline</SelectItem><SelectItem value="tailored">Tailored</SelectItem></SelectContent></Select></div>}</form.Field>
      {(["scoreCriteria", "targetCriteria"] as const).map((name) => <form.Field key={name} name={name}>{(field) => <label>{name === "scoreCriteria" ? "Scoring criteria" : "Target criteria"}<textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></label>}</form.Field>)}
      </> : null}
      </>}
      {section !== "budgets" ? <details><summary>Runtime and provider limits</summary>
        {section !== "models" ? <>
          <p>Worker activity slot changes take effect after the worker restarts.</p>
          {numericFields.filter(([name]) => name === "workerActivitySlots" || name === "applyConcurrency" || name === "applyTimeoutSeconds").map(([name, label, min, max]) => <form.Field key={name} name={name}>{(field) => <label>{label}<input type="number" min={min} max={max} step="1" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></label>}</form.Field>)}
        </> : null}
        <p>Enter JSON objects. Lane limits and concurrency use numbers; reasoning efforts and provider configuration use strings.</p>
        {(section === "models" ? ["codexReasoningEfforts", "providerConfiguration"] as const : ["laneTokenLimits", "laneConcurrency"] as const).map((name) => <form.Field key={name} name={name}>{(field) => <label>{({ laneTokenLimits: "Lane token limits", laneConcurrency: "Lane concurrency", codexReasoningEfforts: "Codex reasoning by model", providerConfiguration: "Provider configuration (non-secret)" })[name]}<textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></label>}</form.Field>)}
      </details> : null}
      {section === "models" || section === "budgets" ? <details open={section === "budgets" && saved.dailyBudgetUsd > 0 && saved.modelAccounting?.available === false ? true : undefined}><summary>Model pricing quotes</summary>
        <p>Selected model: <strong>{saved.defaultProvider}:{saved.providerModels[saved.defaultProvider] ?? "no model selected"}</strong>. {saved.dailyBudgetUsd > 0 ? `Your daily model budget is $${saved.dailyBudgetUsd}.` : "No daily monetary cap is configured."} Saving a quote preserves your selected model and budget. Cost tracking does not verify provider sign-in or live availability.</p>
        {saved.dailyBudgetUsd > 0 && saved.modelAccounting?.available === false ? <p>Before this model can prepare search queries, enter its exact sourced input and output token prices below. Use only pricing that applies to this exact model and account; a subscription price does not establish token prices.</p> : null}
        <p>For a finite daily budget, add a sourced quote for each Codex or Google model you use. Each JSON key is the exact provider:model identifier; each value has inputUsdPerMillion, outputUsdPerMillion, source and revision. Quotes are supplied by you and are not guessed.</p>
        <form.Field name="modelPricingQuotes">{(field) => <label>Model pricing quotes<textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></label>}</form.Field>
      </details> : null}
      <Button type="submit" disabled={stale || update.isPending}>{update.isPending ? "Saving…" : "Save settings"}</Button>
    </fieldset>
    {validation ? <p role="alert">{validation}</p> : null}
    {update.error ? <div role="alert"><p>{update.error.message} Your edits remain available; check saved settings before retrying.</p><Button type="button" variant="outline" onClick={refresh}>Check saved settings</Button></div> : null}
  </form>;
}

export function ApplicationSettingsPanel({ section = "general", active = true }: { readonly section?: SettingsSection; readonly active?: boolean }) {
  const query = useApplicationSettings();
  const { session } = usePorts();
  const bucket = draftsForSession(session);
  const subscribe = useCallback((listener: () => void) => {
    bucket.listeners.add(listener);
    return () => { bucket.listeners.delete(listener); };
  }, [bucket]);
  const getGeneration = useCallback(() => bucket.generation, [bucket]);
  const generation = useSyncExternalStore(subscribe, getGeneration, getGeneration);
  const titleId = `application-settings-${section}-title`;
  return <section className="card settings-application-panel" aria-labelledby={titleId}>
    <h2 id={titleId}>{({ models: "Models and providers", budgets: "Budgets and pricing", automation: "Automation", general: "Application settings" } as const)[section]}</h2>
    {query.error ? <p role="alert">Settings could not be refreshed: {query.error.message}{query.data ? " The last loaded settings remain below." : ""}</p> : null}
    {query.data ? <SettingsForm key={`${section}:${generation}`} saved={query.data} section={section} active={active} refresh={() => { void query.refetch(); }} /> : query.isPending ? <p>Loading settings…</p> : null}
  </section>;
}

export { AppearanceSettingsPanel } from "./AppearanceSettingsPanel.js";
