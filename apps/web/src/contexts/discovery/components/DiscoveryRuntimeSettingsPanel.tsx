import {
  DiscoverySettingsUpdateRequestSchema,
  type DiscoverySettings,
  type DiscoverySettingsUpdateRequest,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { useDiscoverySettingsQuery } from "../hooks/useDiscoverySettingsQuery.js";
import { useUpdateDiscoverySettingsMutation } from "../hooks/useUpdateDiscoverySettingsMutation.js";

const BOARD_OPTIONS: Array<{ value: DiscoverySettings["boards"][number]; label: string }> = [
  { value: "indeed", label: "Indeed" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "zip_recruiter", label: "ZipRecruiter" },
  { value: "glassdoor", label: "Glassdoor" },
];

function toFormValues(settings: DiscoverySettings): DiscoverySettingsUpdateRequest {
  return {
    boards: settings.boards,
    resultsPerSite: settings.resultsPerSite,
    hoursOld: settings.hoursOld,
    schedulingEnabled: settings.schedulingEnabled,
    scheduleCron: settings.scheduleCron,
  };
}

export function DiscoveryRuntimeSettingsPanel() {
  const settingsQuery = useDiscoverySettingsQuery();

  return (
    <section className="card full discovery-runtime-settings">
      <CardHeader title="Runtime settings" meta="discovery config" />
      {settingsQuery.error ? <div className="banner inline">{settingsQuery.error.message}</div> : null}
      {settingsQuery.data ? (
        <DiscoveryRuntimeSettingsForm initial={settingsQuery.data.settings} />
      ) : (
        <Empty title="Loading runtime settings." />
      )}
    </section>
  );
}

function DiscoveryRuntimeSettingsForm({ initial }: { initial: DiscoverySettings }) {
  const updateSettings = useUpdateDiscoverySettingsMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const form = useForm({
    defaultValues: toFormValues(initial),
    validators: {
      onSubmit: ({ value }) => {
        const result = DiscoverySettingsUpdateRequestSchema.safeParse(value);
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid runtime settings");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const response = await updateSettings.mutateAsync(value);
      formApi.reset(toFormValues(response.settings));
      setStatusMessage("runtime settings saved");
    },
  });

  useEffect(() => {
    if (form.state.isDirty || form.state.isSubmitting) {
      return;
    }
    form.reset(toFormValues(initial));
  }, [form, initial]);

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
        form.reset(toFormValues(initial));
        setStatusMessage("");
      }}
    >
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      <div className="field-grid">
        <form.Field name="boards">
          {(field) => {
            const selected = new Set(field.state.value ?? []);
            const toggleBoard = (value: DiscoverySettings["boards"][number], checked: boolean) => {
              const next = new Set(selected);
              if (checked) {
                next.add(value);
              } else {
                next.delete(value);
              }
              field.handleChange(BOARD_OPTIONS.map((option) => option.value).filter((option) => next.has(option)));
            };
            return (
              <fieldset className="field wide checkbox-group-field">
                <legend>Job boards</legend>
                <div className="checkbox-options">
                  {BOARD_OPTIONS.map((option) => (
                    <label className="choice target-choice" key={option.value}>
                      <input
                        type="checkbox"
                        checked={selected.has(option.value)}
                        onChange={(event) => toggleBoard(option.value, event.target.checked)}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          }}
        </form.Field>
        <form.Field name="resultsPerSite">
          {(field) => (
            <label className="field">
              <span>Results per board</span>
              <input
                type="number"
                min={1}
                max={1000}
                value={field.state.value ?? 50}
                onChange={(event) => field.handleChange(Number(event.target.value))}
              />
            </label>
          )}
        </form.Field>
        <form.Field name="hoursOld">
          {(field) => (
            <label className="field">
              <span>Posting lookback hours</span>
              <input
                type="number"
                min={1}
                max={8760}
                value={field.state.value ?? 72}
                onChange={(event) => field.handleChange(Number(event.target.value))}
              />
            </label>
          )}
        </form.Field>
        <form.Field name="schedulingEnabled">
          {(field) => (
            <label className="choice target-choice">
              <input
                type="checkbox"
                checked={Boolean(field.state.value)}
                onChange={(event) => field.handleChange(event.target.checked)}
              />
              <span>Enable scheduled discovery</span>
            </label>
          )}
        </form.Field>
        <form.Field name="scheduleCron">
          {(field) => (
            <label className="field">
              <span>Schedule cron</span>
              <input
                type="text"
                value={field.state.value ?? "0 7 * * *"}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </label>
          )}
        </form.Field>
      </div>
      <form.Subscribe selector={(state) => ({ isDirty: state.isDirty, isSubmitting: state.isSubmitting })}>
        {({ isDirty, isSubmitting }) => (
          <div className="editor-bulk-actions">
            <button className="tab on" type="submit" disabled={!isDirty || isSubmitting}>
              {isSubmitting ? "saving" : "save runtime settings"}
            </button>
            <button className="tab" type="reset" disabled={!isDirty || isSubmitting}>
              discard changes
            </button>
          </div>
        )}
      </form.Subscribe>
      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors
            .flat()
            .filter((entry): entry is string => typeof entry === "string")
            .at(0);
          return message ? <div className="banner inline">{message}</div> : null;
        }}
      </form.Subscribe>
      {updateSettings.error ? <div className="banner inline">{updateSettings.error.message}</div> : null}
    </form>
  );
}
