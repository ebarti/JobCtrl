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
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
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
      collapsedSummary="Discovery runtime configuration"
      description="Source execution, lookback, filtering, and schedule"
      title="Runtime settings"
    >
      {settingsQuery.error ? (
        <Alert className="inline" variant="destructive">
          <AlertDescription>{settingsQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}
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
      {statusMessage ? (
        <div className="status-line" data-typography="metadata" role="status">
          {statusMessage}
        </div>
      ) : null}
      <div className="field-grid">
        <form.Field name="boards">
          {(field) => {
            const selected = new Set(field.state.value ?? []);
            return (
              <FieldSet className="field wide checkbox-group-field">
                <FieldLegend>Job boards</FieldLegend>
                <FieldGroup className="checkbox-options">
                  {BOARD_OPTIONS.map((option) => (
                    <Field
                      className="choice target-choice"
                      key={option.value}
                      orientation="horizontal"
                    >
                      <Checkbox
                        id={`discovery-board-${option.value}`}
                        checked={selected.has(option.value)}
                        onCheckedChange={(checked) => {
                          const next = new Set(selected);
                          checked ? next.add(option.value) : next.delete(option.value);
                          field.handleChange(
                            BOARD_OPTIONS.map(({ value }) => value).filter((value) => next.has(value)),
                          );
                        }}
                      />
                      <FieldLabel htmlFor={`discovery-board-${option.value}`}>
                        {option.label}
                      </FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
                <FieldDescription>{settingContext(effective.boards)}</FieldDescription>
              </FieldSet>
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
            <Field className="field" orientation="horizontal">
              <Checkbox
                id="discovery-scheduling-enabled"
                checked={Boolean(field.state.value)}
                onCheckedChange={(checked) => field.handleChange(checked)}
              />
              <FieldContent>
                <FieldLabel htmlFor="discovery-scheduling-enabled">
                  Enable scheduled discovery
                </FieldLabel>
                <FieldDescription>
                  {settingContext(effective.schedulingEnabled)}
                </FieldDescription>
              </FieldContent>
            </Field>
          )}
        </form.Field>
        <form.Field name="scheduleCron">
          {(field) => (
            <Field className="field">
              <FieldLabel htmlFor="discovery-schedule-cron">Schedule cron</FieldLabel>
              <Input
                id="discovery-schedule-cron"
                name="scheduleCron"
                type="text"
                value={field.state.value ?? "0 7 * * *"}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldDescription>{settingContext(effective.scheduleCron)}</FieldDescription>
            </Field>
          )}
        </form.Field>
      </div>
      <form.Subscribe selector={(state) => ({ isDirty: state.isDirty, isSubmitting: state.isSubmitting })}>
        {({ isDirty, isSubmitting }) => (
          <div className="editor-bulk-actions" data-state={isDirty ? "dirty" : "saved"}>
            <span data-typography="metadata" role="status">
              {isDirty ? "Unsaved changes" : "No unsaved changes"}
            </span>
            <Button
              type="submit"
              disabled={!isDirty || isSubmitting}
              title={!isDirty ? "No unsaved changes" : undefined}
            >
              {isSubmitting ? "Saving changes" : "Save changes"}
            </Button>
            <Button
              type="reset"
              variant="secondary"
              disabled={!isDirty || isSubmitting}
              title={!isDirty ? "No unsaved changes" : undefined}
            >
              Discard changes
            </Button>
          </div>
        )}
      </form.Subscribe>
      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors.flat().filter((entry): entry is string => typeof entry === "string").at(0);
          return message ? (
            <Alert className="inline" variant="destructive">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null;
        }}
      </form.Subscribe>
      {updateSettings.error ? (
        <Alert className="inline" variant="destructive">
          <AlertDescription>{updateSettings.error.message}</AlertDescription>
        </Alert>
      ) : null}
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
    <Field className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} name={name} type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <FieldDescription>{settingContext(metadata)}</FieldDescription>
    </Field>
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
    <Field className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} name={name} type="text" value={value} onChange={(event) => onChange(event.target.value)} />
      <FieldDescription>{optional ? "Optional. " : ""}{settingContext(metadata)}</FieldDescription>
    </Field>
  );
}

function RoleFilterModeControl({ value, metadata, onChange }: {
  value: DiscoverySettings["roleFilterMode"];
  metadata: EffectiveSetting<DiscoverySettings["roleFilterMode"]>;
  onChange: (value: DiscoverySettings["roleFilterMode"]) => void;
}) {
  return (
    <FieldSet className="field wide checkbox-group-field">
      <FieldLegend>Role title filtering</FieldLegend>
      <FieldGroup className="checkbox-options">
        {ROLE_FILTER_MODES.map((option) => (
          <Field className="choice target-choice" key={option.value} orientation="horizontal">
            <Input
              checked={value === option.value}
              disabled={!metadata.editable}
              id={`discovery-role-filter-${option.value}`}
              name="roleFilterMode"
              onChange={() => onChange(option.value)}
              type="radio"
              value={option.value}
            />
            <FieldLabel htmlFor={`discovery-role-filter-${option.value}`}>
              {option.label} — {option.description}
            </FieldLabel>
          </Field>
        ))}
      </FieldGroup>
      <FieldDescription>{settingContext(metadata)}</FieldDescription>
    </FieldSet>
  );
}

function ReadOnlyField({ id, label, value, metadata }: { id: string; label: string; value: string | number; metadata: EffectiveSetting<unknown> }) {
  return (
    <Field className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} type="text" readOnly aria-readonly="true" value={value} />
      <FieldDescription>{settingContext(metadata)}</FieldDescription>
    </Field>
  );
}

function settingContext(metadata: EffectiveSetting<unknown>): string {
  const source = metadata.source === "persisted" ? "Saved in SQLite" : "Using the default";
  const activation = metadata.activation === "restart" ? "requires a worker restart" : metadata.activation === "next_run" ? "applies to the next discovery run" : metadata.activation === "next_source_family" ? "applies to the next source family" : metadata.activation === "next_poll" ? "applies on the next worker poll" : "applies immediately";
  return `${source}; ${activation}.`;
}
