import {
  SettingsUpdateRequestSchema,
  type SettingsUpdateRequest,
} from "@jobhunter/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";

import type { DashboardSettings } from "../../operations/types.js";
import { useUpdateSettingsMutation } from "../hooks/useUpdateSettingsMutation.js";
import { AutosaveUndoController } from "./autosave-undo-controller.js";

export interface SettingsFormProps {
  initial: DashboardSettings;
}

type ExecutionSettingsValues = Pick<SettingsUpdateRequest, "applyConcurrency" | "dailyBudgetUsd">;
type DiscoveryAutomationSettingsValues = Pick<
  SettingsUpdateRequest,
  "autoApply" | "minFitScore" | "applyApprovalRequired"
>;

function toExecutionSettingsValues(values: DashboardSettings): ExecutionSettingsValues {
  return {
    applyConcurrency: values.applyConcurrency,
    dailyBudgetUsd: values.dailyBudgetUsd,
  };
}

function toDiscoveryAutomationSettingsValues(values: DashboardSettings): DiscoveryAutomationSettingsValues {
  return {
    autoApply: values.autoApply,
    applyApprovalRequired: values.applyApprovalRequired,
    minFitScore: values.minFitScore,
  };
}

function validateSettingsValues(values: SettingsUpdateRequest): string | undefined {
  const result = SettingsUpdateRequestSchema.safeParse(values);
  return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid settings");
}

function serializeSettingsValues(values: SettingsUpdateRequest): string {
  return JSON.stringify(values);
}

export function SettingsForm({ initial }: SettingsFormProps) {
  const toFormValues = toExecutionSettingsValues;
  const updateSettings = useUpdateSettingsMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const [resetToken, setResetToken] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  const form = useForm({
    defaultValues: toFormValues(initial),
    validators: {
      onSubmit: ({ value }) => validateSettingsValues(value),
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const submittedValues = serializeSettingsValues(value);
      const response = await updateSettings.mutateAsync(value);
      if (serializeSettingsValues(formApi.state.values) === submittedValues) {
        formApi.reset(toFormValues(response.settings));
        setStatusMessage("settings saved");
      } else {
        setStatusMessage("saved; newer changes pending");
      }
    },
  });

  useEffect(() => {
    if (form.state.isDirty || form.state.isSubmitting) {
      return;
    }
    form.reset(toFormValues(initial));
    setResetToken((token) => token + 1);
  }, [form, initial, toFormValues]);

  return (
    <form
      className="config-form"
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
      onReset={(event) => {
        event.preventDefault();
        form.reset(toFormValues(initial));
        setResetToken((token) => token + 1);
        setStatusMessage("");
      }}
    >
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      <form.Subscribe
        selector={(state) => ({
          isDirty: state.isDirty,
          isSubmitting: state.isSubmitting,
          values: state.values,
        })}
      >
        {({ isDirty, isSubmitting, values }) => (
          <AutosaveUndoController
            formRef={formRef}
            isDirty={isDirty}
            isSubmitting={isSubmitting}
            resetToken={resetToken}
            restoreValues={(nextValues) => form.reset(nextValues, { keepDefaultValues: true })}
            setStatusMessage={setStatusMessage}
            submit={() => form.handleSubmit()}
            values={values}
          />
        )}
      </form.Subscribe>
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
      <form.Field name="dailyBudgetUsd">
        {(field) => (
          <div className="field">
            <label htmlFor="settings-daily-budget-usd">Daily LLM budget (USD)</label>
            <input
              id="settings-daily-budget-usd"
              type="number"
              min={0}
              step={0.01}
              aria-describedby="settings-daily-budget-usd-help"
              value={field.state.value ?? 0}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(Number(event.target.value))}
            />
            <small id="settings-daily-budget-usd-help">Use 0 for unlimited.</small>
          </div>
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

export function DiscoveryAutomationSettingsForm({ initial }: SettingsFormProps) {
  const toFormValues = toDiscoveryAutomationSettingsValues;
  const updateSettings = useUpdateSettingsMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const [resetToken, setResetToken] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  const form = useForm({
    defaultValues: toFormValues(initial),
    validators: {
      onSubmit: ({ value }) => validateSettingsValues(value),
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const submittedValues = serializeSettingsValues(value);
      const response = await updateSettings.mutateAsync(value);
      if (serializeSettingsValues(formApi.state.values) === submittedValues) {
        formApi.reset(toFormValues(response.settings));
        setStatusMessage("automation settings saved");
      } else {
        setStatusMessage("saved; newer changes pending");
      }
    },
  });

  useEffect(() => {
    if (form.state.isDirty || form.state.isSubmitting) {
      return;
    }
    form.reset(toFormValues(initial));
    setResetToken((token) => token + 1);
  }, [form, initial, toFormValues]);

  return (
    <form
      className="config-form discovery-automation-settings-form"
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
      onReset={(event) => {
        event.preventDefault();
        form.reset(toFormValues(initial));
        setResetToken((token) => token + 1);
        setStatusMessage("");
      }}
    >
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      <form.Subscribe
        selector={(state) => ({
          isDirty: state.isDirty,
          isSubmitting: state.isSubmitting,
          values: state.values,
        })}
      >
        {({ isDirty, isSubmitting, values }) => (
          <AutosaveUndoController
            formRef={formRef}
            isDirty={isDirty}
            isSubmitting={isSubmitting}
            resetToken={resetToken}
            restoreValues={(nextValues) => form.reset(nextValues, { keepDefaultValues: true })}
            setStatusMessage={setStatusMessage}
            submit={() => form.handleSubmit()}
            values={values}
          />
        )}
      </form.Subscribe>
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
      <form.Field name="applyApprovalRequired">
        {(field) => (
          <label className="field check">
            <input
              type="checkbox"
              checked={field.state.value ?? true}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.checked)}
            />
            <span>
              <span>Require approval before live submit</span>
              <small>
                Live (non-dry-run) applications must be approved in Apply Review before the agent may submit.
              </small>
            </span>
          </label>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.applyApprovalRequired}>
        {(applyApprovalRequired) =>
          applyApprovalRequired === false ? (
            <div className="status-line warning" role="alert">
              Approval gate is off: the agent may submit applications to employers immediately after claiming a job,
              without human review.
            </div>
          ) : null
        }
      </form.Subscribe>
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
              {isSubmitting ? "saving" : "save automation settings"}
            </button>
            <button
              className="tab"
              type="reset"
              disabled={!isDirty || isSubmitting}
            >
              discard changes
            </button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
