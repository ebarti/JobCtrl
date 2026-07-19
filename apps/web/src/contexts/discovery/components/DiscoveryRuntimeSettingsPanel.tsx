import {
  DiscoverySettingsUpdateRequestSchema,
  type DiscoverySettings,
  type DiscoverySettingsResponse,
  type DiscoverySettingsUpdateRequest,
  type EffectiveDiscoverySettings,
  type EffectiveSetting,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Empty } from "../../../shared/ui/empty.js";
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { useDiscoverySettingsQuery } from "../../operations/hooks/useDiscoverySettingsQuery.js";
import { useUpdateDiscoverySettingsMutation } from "../hooks/useUpdateDiscoverySettingsMutation.js";
import {
  DiscoverySettingHelp,
  type DiscoverySettingHelpContent,
} from "./DiscoverySettingHelp.js";

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

const DISCOVERY_GUIDE_URL = "https://jobctrl.dev/user/discovery";

const RUNTIME_SETTING_HELP = {
  boards: {
    title: "Job boards",
    description:
      "Select which broad-board providers run for each generated target query. The next Discover run snapshots this selection.",
    href: `${DISCOVERY_GUIDE_URL}#runtime-setting-job-boards`,
  },
  resultsPerSite: {
    title: "Results per board",
    description:
      "Set the maximum results requested from each selected board for a search unit. The next Discover run snapshots the new limit.",
    href: `${DISCOVERY_GUIDE_URL}#runtime-setting-results-per-board`,
  },
  hoursOld: {
    title: "Posting lookback hours",
    description:
      "Limit broad-board discovery to postings no older than this many hours when the provider supports age filtering. The next Discover run uses the new window.",
    href: `${DISCOVERY_GUIDE_URL}#runtime-setting-posting-lookback-hours`,
  },
  roleFilterMode: {
    title: "Role title filtering",
    description:
      "Choose how returned titles are checked against target search. Auto uses a ready model when available, Deterministic uses local rules, and LLM requires model-backed matching. The next source family uses the choice.",
    href: `${DISCOVERY_GUIDE_URL}#runtime-setting-role-title-filtering`,
  },
  roleFilterModel: {
    title: "Role filter model",
    description:
      "Optionally pin the model used for model-backed title matching. Leave this blank to use configured provider routing. The next source family uses changes.",
    href: `${DISCOVERY_GUIDE_URL}#runtime-setting-role-filter-model`,
  },
  maxParallelFamilies: {
    title: "Parallel source families",
    description:
      "Limit how many source families may crawl concurrently in a Discover run. JobCtrl caps the value at four and at available worker activity slots. The next run snapshots it.",
    href: `${DISCOVERY_GUIDE_URL}#runtime-setting-parallel-source-families`,
  },
  crawlUserAgentProduct: {
    title: "Crawler product name",
    description:
      "Set the product token in JobCtrl's honest outbound user-agent identity. The next source family uses the updated identity.",
    href: `${DISCOVERY_GUIDE_URL}#runtime-setting-crawler-product-name`,
  },
  crawlUserAgentContact: {
    title: "Crawler contact",
    description:
      "Optionally add a contact URL or address to the outbound user-agent identity. The next source family uses the updated identity.",
    href: `${DISCOVERY_GUIDE_URL}#runtime-setting-crawler-contact`,
  },
  schedulingEnabled: {
    title: "Enable scheduled discovery",
    description:
      "Control whether worker startup reconciles a recurring Temporal Discover schedule. Restart the worker after changing this setting.",
    href: `${DISCOVERY_GUIDE_URL}#runtime-setting-enable-scheduled-discovery`,
  },
  scheduleCron: {
    title: "Schedule cron",
    description:
      "Define the local recurring schedule with a five-field cron expression. It is used only when scheduled discovery is enabled, and changes require a worker restart.",
    href: `${DISCOVERY_GUIDE_URL}#runtime-setting-schedule-cron`,
  },
} satisfies Record<string, DiscoverySettingHelpContent>;

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
              <FieldSet aria-label="Job boards" className="field wide checkbox-group-field">
                <FieldLegend>
                  <DiscoverySettingLegend help={RUNTIME_SETTING_HELP.boards}>
                    Job boards
                  </DiscoverySettingLegend>
                </FieldLegend>
                <FieldGroup className="checkbox-options discovery-board-options">
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
              </FieldSet>
            );
          }}
        </form.Field>
        <form.Field name="resultsPerSite">
          {(field) => <NumberControl help={RUNTIME_SETTING_HELP.resultsPerSite} id="discovery-results" name="resultsPerSite" label="Results per board" min={1} max={1000} value={field.state.value ?? 50} metadata={effective.resultsPerSite} onChange={field.handleChange} />}
        </form.Field>
        <form.Field name="hoursOld">
          {(field) => <NumberControl help={RUNTIME_SETTING_HELP.hoursOld} id="discovery-lookback" name="hoursOld" label="Posting lookback hours" min={1} max={8760} value={field.state.value ?? 72} metadata={effective.hoursOld} onChange={field.handleChange} />}
        </form.Field>
        <form.Field name="roleFilterMode">
          {(field) => <RoleFilterModeControl help={RUNTIME_SETTING_HELP.roleFilterMode} value={field.state.value ?? initial.settings.roleFilterMode} metadata={effective.roleFilterMode} onChange={field.handleChange} />}
        </form.Field>
        <form.Field name="roleFilterModel">
          {(field) => <TextControl help={RUNTIME_SETTING_HELP.roleFilterModel} id="discovery-role-model" name="roleFilterModel" label="Role filter model" value={String(field.state.value ?? "")} metadata={effective.roleFilterModel} optional onChange={(value) => field.handleChange(value || null)} />}
        </form.Field>
        <form.Field name="maxParallelFamilies">
          {(field) => <NumberControl help={RUNTIME_SETTING_HELP.maxParallelFamilies} id="discovery-max-parallel" name="maxParallelFamilies" label="Parallel source families" min={1} max={4} value={field.state.value ?? initial.settings.maxParallelFamilies} metadata={effective.maxParallelFamilies} onChange={field.handleChange} />}
        </form.Field>
        <form.Field name="crawlUserAgentProduct">
          {(field) => <TextControl help={RUNTIME_SETTING_HELP.crawlUserAgentProduct} id="discovery-ua-product" name="crawlUserAgentProduct" label="Crawler product name" value={String(field.state.value ?? initial.settings.crawlUserAgentProduct)} metadata={effective.crawlUserAgentProduct} onChange={field.handleChange} />}
        </form.Field>
        <form.Field name="crawlUserAgentContact">
          {(field) => <TextControl help={RUNTIME_SETTING_HELP.crawlUserAgentContact} id="discovery-ua-contact" name="crawlUserAgentContact" label="Crawler contact" value={String(field.state.value ?? "")} metadata={effective.crawlUserAgentContact} optional onChange={field.handleChange} />}
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
                <DiscoverySettingLabel
                  help={RUNTIME_SETTING_HELP.schedulingEnabled}
                  htmlFor="discovery-scheduling-enabled"
                >
                  Enable scheduled discovery
                </DiscoverySettingLabel>
              </FieldContent>
            </Field>
          )}
        </form.Field>
        <form.Field name="scheduleCron">
          {(field) => (
            <Field className="field">
              <DiscoverySettingLabel
                help={RUNTIME_SETTING_HELP.scheduleCron}
                htmlFor="discovery-schedule-cron"
              >
                Schedule cron
              </DiscoverySettingLabel>
              <Input
                id="discovery-schedule-cron"
                name="scheduleCron"
                type="text"
                value={field.state.value ?? "0 7 * * *"}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>
      </div>
      <form.Subscribe selector={(state) => ({ isDirty: state.isDirty, isSubmitting: state.isSubmitting })}>
        {({ isDirty, isSubmitting }) =>
          isDirty || isSubmitting ? (
            <div className="editor-bulk-actions" data-state="dirty">
              <span data-typography="metadata" role="status">
                {isSubmitting ? "Saving changes" : "Unsaved changes"}
              </span>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving changes" : "Save changes"}
              </Button>
              <Button type="reset" variant="secondary" disabled={isSubmitting}>
                Discard changes
              </Button>
            </div>
          ) : null
        }
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

function DiscoverySettingLabel({
  children,
  help,
  htmlFor,
  optional = false,
}: {
  children: ReactNode;
  help: DiscoverySettingHelpContent;
  htmlFor: string;
  optional?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <FieldLabel htmlFor={htmlFor}>{children}</FieldLabel>
      {optional ? (
        <span className="text-muted-foreground" data-typography="metadata">
          Optional
        </span>
      ) : null}
      <DiscoverySettingHelp {...help} />
    </div>
  );
}

function DiscoverySettingLegend({
  children,
  help,
}: {
  children: ReactNode;
  help: DiscoverySettingHelpContent;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {children}
      <DiscoverySettingHelp {...help} />
    </span>
  );
}

function NumberControl({ help, name, id, label, min, max, metadata, value, onChange }: {
  help: DiscoverySettingHelpContent;
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
    return <ReadOnlyField help={help} id={id} label={label} value={metadata.value} />;
  }
  return (
    <Field className="field">
      <DiscoverySettingLabel help={help} htmlFor={id}>{label}</DiscoverySettingLabel>
      <Input id={id} name={name} type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </Field>
  );
}

function TextControl({ help, id, name, label, value, metadata, onChange, optional = false }: {
  help: DiscoverySettingHelpContent;
  id: string;
  name: "roleFilterModel" | "crawlUserAgentProduct" | "crawlUserAgentContact";
  label: string;
  value: string;
  metadata: EffectiveSetting<string | null> | EffectiveSetting<string>;
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  if (!metadata.editable) {
    return <ReadOnlyField help={help} id={id} label={label} value={metadata.value ?? ""} />;
  }
  return (
    <Field className="field">
      <DiscoverySettingLabel help={help} htmlFor={id} optional={optional}>{label}</DiscoverySettingLabel>
      <Input id={id} name={name} type="text" value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function RoleFilterModeControl({ help, value, metadata, onChange }: {
  help: DiscoverySettingHelpContent;
  value: DiscoverySettings["roleFilterMode"];
  metadata: EffectiveSetting<DiscoverySettings["roleFilterMode"]>;
  onChange: (value: DiscoverySettings["roleFilterMode"]) => void;
}) {
  return (
    <FieldSet aria-label="Role title filtering" className="field wide checkbox-group-field">
      <FieldLegend>
        <DiscoverySettingLegend help={help}>Role title filtering</DiscoverySettingLegend>
      </FieldLegend>
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
    </FieldSet>
  );
}

function ReadOnlyField({ help, id, label, value }: { help: DiscoverySettingHelpContent; id: string; label: string; value: string | number }) {
  return (
    <Field className="field">
      <DiscoverySettingLabel help={help} htmlFor={id}>{label}</DiscoverySettingLabel>
      <Input id={id} type="text" readOnly aria-readonly="true" value={value} />
    </Field>
  );
}
