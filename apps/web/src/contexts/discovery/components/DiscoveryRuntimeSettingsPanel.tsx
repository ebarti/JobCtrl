import {
  DiscoverySettingsUpdateRequestSchema,
  type DiscoverySettings,
  type DiscoverySettingsResponse,
  type DiscoverySettingsUpdateRequest,
  type EffectiveDiscoverySettings,
  type EffectiveSetting,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useCallback, useEffect, useState } from "react";

import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Empty } from "../../../shared/ui/empty.js";
import { useDiscoverySettingsQuery } from "../../operations/hooks/useDiscoverySettingsQuery.js";
import { useUpdateDiscoverySettingsMutation } from "../hooks/useUpdateDiscoverySettingsMutation.js";

const BOARD_OPTIONS: Array<{ value: DiscoverySettings["boards"][number]; label: string }> = [
  { value: "indeed", label: "Indeed" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "zip_recruiter", label: "ZipRecruiter" },
  { value: "glassdoor", label: "Glassdoor" },
];

const ROLE_FILTER_MODES: Array<{
  value: DiscoverySettings["roleFilterMode"];
  label: string;
  description: string;
}> = [
  { value: "auto", label: "Auto", description: "Use LLM filtering when a provider is ready." },
  { value: "deterministic", label: "Deterministic", description: "Use only local title rules." },
  { value: "llm", label: "LLM", description: "Require model-backed title matching." },
];

function toFormValues(response: DiscoverySettingsResponse): DiscoverySettingsUpdateRequest {
  const { settings, effectiveSettings } = response;
  const values: DiscoverySettingsUpdateRequest = {
    boards: settings.boards,
    resultsPerSite: settings.resultsPerSite,
    hoursOld: settings.hoursOld,
    schedulingEnabled: settings.schedulingEnabled,
    scheduleCron: settings.scheduleCron,
  };
  for (const field of [
    "roleFilterMode",
    "roleFilterModel",
    "maxParallelFamilies",
    "crawlUserAgentProduct",
    "crawlUserAgentContact",
  ] as const) {
    if (effectiveSettings[field].editable) {
      Object.assign(values, { [field]: settings[field] });
    }
  }
  return values;
}

export function DiscoveryRuntimeSettingsPanel() {
  const settingsQuery = useDiscoverySettingsQuery();

  return (
    <DisclosureSection
      className="discovery-runtime-settings"
      title="Runtime settings"
      description="Source execution, lookback, filtering, and schedule"
      collapsedSummary="Discovery runtime configuration"
    >
      {settingsQuery.error ? <div className="banner inline">{settingsQuery.error.message}</div> : null}
      {settingsQuery.data ? (
        <DiscoveryRuntimeSettingsForm initial={settingsQuery.data} />
      ) : (
        <Empty title="Loading runtime settings." />
      )}
    </DisclosureSection>
  );
}

export function DiscoveryRuntimeSettingsForm({ initial }: { initial: DiscoverySettingsResponse }) {
  const updateSettings = useUpdateDiscoverySettingsMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const toValues = useCallback((response: DiscoverySettingsResponse) => toFormValues(response), []);
  const form = useForm({
    defaultValues: toValues(initial),
    validators: {
      onSubmit: ({ value }) => {
        const result = DiscoverySettingsUpdateRequestSchema.safeParse(value);
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid runtime settings");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const scheduleChanged =
        value.schedulingEnabled !== initial.settings.schedulingEnabled ||
        value.scheduleCron !== initial.settings.scheduleCron;
      const response = await updateSettings.mutateAsync(value);
      formApi.reset(toValues(response));
      setStatusMessage(
        scheduleChanged
          ? "Runtime settings saved. Restart pending for scheduled discovery changes."
          : "Runtime settings saved.",
      );
    },
  });

  useEffect(() => {
    if (form.state.isDirty || form.state.isSubmitting) return;
    form.reset(toValues(initial));
  }, [form, initial, toValues]);

  const effective = initial.effectiveSettings;
  return (
    <form
      className="config-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
      onReset={(event) => {
        event.preventDefault();
        form.reset(toValues(initial));
        setStatusMessage("");
      }}
    >
      {statusMessage ? <div className="status-line" role="status">{statusMessage}</div> : null}
      <div className="field-grid">
        <form.Field name="boards">
          {(field) => {
            const selected = new Set(field.state.value ?? []);
            return (
              <fieldset className="field wide checkbox-group-field">
                <legend>Job boards</legend>
                <div className="checkbox-options">
                  {BOARD_OPTIONS.map((option) => (
                    <label className="choice target-choice" key={option.value}>
                      <input
                        name="boards"
                        type="checkbox"
                        checked={selected.has(option.value)}
                        onChange={(event) => {
                          const next = new Set(selected);
                          event.target.checked ? next.add(option.value) : next.delete(option.value);
                          field.handleChange(
                            BOARD_OPTIONS.map(({ value }) => value).filter((value) => next.has(value)),
                          );
                        }}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
                <small>{settingContext(effective.boards)}</small>
              </fieldset>
            );
          }}
        </form.Field>
        <form.Field name="resultsPerSite">
          {(field) => <NumberControl id="discovery-results" name="resultsPerSite" label="Results per board" min={1} max={1000} value={field.state.value ?? 50} metadata={effective.resultsPerSite} onChange={field.handleChange} />}
        </form.Field>
        <form.Field name="hoursOld">
          {(field) => <NumberControl id="discovery-lookback" name="hoursOld" label="Posting lookback hours" min={1} max={8760} value={field.state.value ?? 72} metadata={effective.hoursOld} onChange={field.handleChange} />}
        </form.Field>
        <form.Field name="roleFilterMode">
          {(field) => <RoleFilterModeControl value={field.state.value ?? initial.settings.roleFilterMode} metadata={effective.roleFilterMode} onChange={field.handleChange} />}
        </form.Field>
        <form.Field name="roleFilterModel">
          {(field) => <TextControl id="discovery-role-model" name="roleFilterModel" label="Role filter model" value={String(field.state.value ?? "")} metadata={effective.roleFilterModel} optional onChange={(value) => field.handleChange(value || null)} />}
        </form.Field>
        <form.Field name="maxParallelFamilies">
          {(field) => <NumberControl id="discovery-max-parallel" name="maxParallelFamilies" label="Parallel source families" min={1} max={4} value={field.state.value ?? initial.settings.maxParallelFamilies} metadata={effective.maxParallelFamilies} onChange={field.handleChange} />}
        </form.Field>
        <form.Field name="crawlUserAgentProduct">
          {(field) => <TextControl id="discovery-ua-product" name="crawlUserAgentProduct" label="Crawler product name" value={String(field.state.value ?? initial.settings.crawlUserAgentProduct)} metadata={effective.crawlUserAgentProduct} onChange={field.handleChange} />}
        </form.Field>
        <form.Field name="crawlUserAgentContact">
          {(field) => <TextControl id="discovery-ua-contact" name="crawlUserAgentContact" label="Crawler contact" value={String(field.state.value ?? "")} metadata={effective.crawlUserAgentContact} optional onChange={field.handleChange} />}
        </form.Field>
        <form.Field name="schedulingEnabled">
          {(field) => (
            <div className="field">
              <label className="choice target-choice">
                <input name="schedulingEnabled" type="checkbox" checked={Boolean(field.state.value)} onChange={(event) => field.handleChange(event.target.checked)} />
                <span>Enable scheduled discovery</span>
              </label>
              <small>{settingContext(effective.schedulingEnabled)}</small>
            </div>
          )}
        </form.Field>
        <form.Field name="scheduleCron">
          {(field) => (
            <div className="field">
              <label htmlFor="discovery-schedule-cron">Schedule cron</label>
              <input id="discovery-schedule-cron" name="scheduleCron" type="text" value={field.state.value ?? "0 7 * * *"} onChange={(event) => field.handleChange(event.target.value)} />
              <small>{settingContext(effective.scheduleCron)}</small>
            </div>
          )}
        </form.Field>
      </div>
      <form.Subscribe selector={(state) => ({ isDirty: state.isDirty, isSubmitting: state.isSubmitting })}>
        {({ isDirty, isSubmitting }) => (
          <div className="editor-bulk-actions">
            <button className="tab on" type="submit" disabled={!isDirty || isSubmitting}>{isSubmitting ? "saving" : "save runtime settings"}</button>
            <button className="tab" type="reset" disabled={!isDirty || isSubmitting}>discard changes</button>
          </div>
        )}
      </form.Subscribe>
      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors.flat().filter((entry): entry is string => typeof entry === "string").at(0);
          return message ? <div className="banner inline" role="alert">{message}</div> : null;
        }}
      </form.Subscribe>
      {updateSettings.error ? <div className="banner inline" role="alert">{updateSettings.error.message}</div> : null}
    </form>
  );
}

function NumberControl({ name, id, label, min, max, metadata, value, onChange }: {
  name: "resultsPerSite" | "hoursOld" | "maxParallelFamilies";
  id: string;
  label: string;
  min: number;
  max: number;
  metadata: EffectiveSetting<number>;
  value: number;
  onChange: (value: number) => void;
}) {
  if (!metadata.editable) {
    return <ReadOnlyField id={id} label={label} value={metadata.value} metadata={metadata} />;
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={name} type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <small>{settingContext(metadata)}</small>
    </div>
  );
}

function TextControl({ id, name, label, value, metadata, onChange, optional = false }: {
  id: string;
  name: "roleFilterModel" | "crawlUserAgentProduct" | "crawlUserAgentContact";
  label: string;
  value: string;
  metadata: EffectiveSetting<string | null> | EffectiveSetting<string>;
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  if (!metadata.editable) {
    return <ReadOnlyField id={id} label={label} value={metadata.value ?? ""} metadata={metadata} />;
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={name} type="text" value={value} onChange={(event) => onChange(event.target.value)} />
      <small>{optional ? "Optional. " : ""}{settingContext(metadata)}</small>
    </div>
  );
}

function RoleFilterModeControl({ value, metadata, onChange }: {
  value: DiscoverySettings["roleFilterMode"];
  metadata: EffectiveSetting<DiscoverySettings["roleFilterMode"]>;
  onChange: (value: DiscoverySettings["roleFilterMode"]) => void;
}) {
  return (
    <fieldset className="field wide checkbox-group-field">
      <legend>Role title filtering</legend>
      <div className="checkbox-options">
        {ROLE_FILTER_MODES.map((option) => (
          <label className="choice target-choice" key={option.value}>
            <input name="roleFilterMode" type="radio" value={option.value} checked={value === option.value} disabled={!metadata.editable} onChange={() => onChange(option.value)} />
            <span>{option.label} — {option.description}</span>
          </label>
        ))}
      </div>
      <small>{settingContext(metadata)}</small>
    </fieldset>
  );
}

function ReadOnlyField({ id, label, value, metadata }: { id: string; label: string; value: string | number; metadata: EffectiveSetting<unknown> }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" readOnly aria-readonly="true" value={value} />
      <small>{settingContext(metadata)}</small>
    </div>
  );
}

function settingContext(metadata: EffectiveSetting<unknown>): string {
  const source = metadata.source === "persisted" ? "Saved in SQLite" : "Using the default";
  const activation = metadata.activation === "restart" ? "requires a worker restart" : metadata.activation === "next_run" ? "applies to the next discovery run" : metadata.activation === "next_source_family" ? "applies to the next source family" : metadata.activation === "next_poll" ? "applies on the next worker poll" : "applies immediately";
  return `${source}; ${activation}.`;
}
