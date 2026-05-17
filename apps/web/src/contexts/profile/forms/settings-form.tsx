import {
  SettingsUpdateRequestSchema,
  type SettingsUpdateRequest,
} from "@jobhunter/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";

import type { DashboardSettings } from "../../operations/types.js";
import { useUpdateSettingsMutation } from "../hooks/useUpdateSettingsMutation.js";

export interface SettingsFormProps {
  initial: DashboardSettings;
}

function toFormValues(values: DashboardSettings): SettingsUpdateRequest {
  return {
    minFitScore: values.minFitScore,
    autoApply: values.autoApply,
    applyConcurrency: values.applyConcurrency,
    targetRole: values.targetRole,
    locationFilter: values.locationFilter,
    scoreCriteria: values.scoreCriteria,
    targetCriteria: values.targetCriteria,
  };
}

export function SettingsForm({ initial }: SettingsFormProps) {
  const updateSettings = useUpdateSettingsMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const [persistedValues, setPersistedValues] = useState(() => toFormValues(initial));
  const previousInitial = useRef(initial);

  const form = useForm({
    defaultValues: persistedValues,
    validators: {
      onSubmit: ({ value }) => {
        const result = SettingsUpdateRequestSchema.safeParse(value);
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid settings");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const response = await updateSettings.mutateAsync(value);
      const nextValues = toFormValues(response.settings);
      setPersistedValues(nextValues);
      formApi.reset(nextValues);
      setStatusMessage("settings saved");
    },
  });

  useEffect(() => {
    if (previousInitial.current === initial) {
      return;
    }
    previousInitial.current = initial;
    const nextValues = toFormValues(initial);
    setPersistedValues(nextValues);
    form.reset(nextValues);
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
        form.reset(persistedValues);
        setStatusMessage("");
      }}
    >
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      <form.Field name="minFitScore">
        {(field) => (
          <label className="field">
            <span>Minimum fit score</span>
            <input
              type="number"
              min={0}
              max={10}
              step={1}
              value={field.state.value ?? 0}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(Number(event.target.value))}
            />
          </label>
        )}
      </form.Field>
      <form.Field name="applyConcurrency">
        {(field) => (
          <label className="field">
            <span>Apply concurrency</span>
            <input
              type="number"
              min={1}
              max={16}
              step={1}
              value={field.state.value ?? 1}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(Number(event.target.value))}
            />
          </label>
        )}
      </form.Field>
      <form.Field name="targetRole">
        {(field) => (
          <label className="field">
            <span>Target role</span>
            <input
              value={field.state.value ?? ""}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      <form.Field name="locationFilter">
        {(field) => (
          <label className="field">
            <span>Location filter</span>
            <input
              value={field.state.value ?? ""}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      <form.Field name="scoreCriteria">
        {(field) => (
          <label className="field wide">
            <span>Score criteria</span>
            <textarea
              placeholder="Criteria the scoring step should use when ranking jobs."
              value={field.state.value ?? ""}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      <form.Field name="targetCriteria">
        {(field) => (
          <label className="field wide">
            <span>Targeting criteria</span>
            <textarea
              placeholder="Role, company, location, seniority, and exclusion criteria for the search pipeline."
              value={field.state.value ?? ""}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      <form.Field name="autoApply">
        {(field) => (
          <label className="field check">
            <input
              type="checkbox"
              checked={field.state.value ?? false}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.checked)}
            />
            <span>Auto apply</span>
          </label>
        )}
      </form.Field>
      <form.Subscribe
        selector={(state) => ({
          canSubmit: state.canSubmit,
          isSubmitting: state.isSubmitting,
          isDirty: state.isDirty,
        })}
      >
        {({ canSubmit, isSubmitting, isDirty }) => (
          <div className="form-actions">
            <button
              className="tab on"
              type="submit"
              disabled={!canSubmit || !isDirty || isSubmitting}
            >
              {isSubmitting ? "saving" : "save"}
            </button>
            <button
              className="tab"
              type="reset"
              disabled={!isDirty || isSubmitting}
            >
              reset
            </button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
