import {
  SettingsUpdateRequestSchema,
  type EffectiveJobCtrlSettings,
  type SettingsUpdateRequest,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useCallback, useEffect, useRef, useState } from "react";

import type { JobCtrlSettings } from "../../operations/types.js";
import { useUpdateSettingsMutation } from "../hooks/useUpdateSettingsMutation.js";
import { AutosaveUndoController } from "../../../shared/ui/autosave-undo-controller.js";

interface SettingsInitialProps {
  initial: JobCtrlSettings;
}

export interface SettingsFormProps extends SettingsInitialProps {
  effectiveSettings: EffectiveJobCtrlSettings;
  activeWorkerActivitySlots?: number | null;
  workerStatus?: "healthy" | "missing" | "stale" | "mismatched";
}

type ExecutionSettingsValues = Pick<SettingsUpdateRequest, "applyConcurrency" | "dailyBudgetUsd"> &
  Partial<Pick<SettingsUpdateRequest, "workerActivitySlots">>;
function toExecutionSettingsValues(
  values: JobCtrlSettings,
  effectiveSettings: EffectiveJobCtrlSettings,
): ExecutionSettingsValues {
  const result: ExecutionSettingsValues = {
    applyConcurrency: values.applyConcurrency,
    dailyBudgetUsd: values.dailyBudgetUsd,
  };
  if (effectiveSettings.workerActivitySlots.editable) {
    result.workerActivitySlots = values.workerActivitySlots;
  }
  return result;
}

function validateSettingsValues(values: SettingsUpdateRequest): string | undefined {
  const result = SettingsUpdateRequestSchema.safeParse(values);
  return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid settings");
}

function serializeSettingsValues(values: SettingsUpdateRequest): string {
  return JSON.stringify(values);
}

export function SettingsForm({
  initial,
  effectiveSettings,
  activeWorkerActivitySlots = null,
  workerStatus = "missing",
}: SettingsFormProps) {
  const toFormValues = useCallback(
    (values: JobCtrlSettings) => toExecutionSettingsValues(values, effectiveSettings),
    [effectiveSettings],
  );
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
      {statusMessage ? <div className="status-line" role="status">{statusMessage}</div> : null}
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
      <form.Field name="dailyBudgetUsd">
        {(field) => (
          <div className="field">
            <label htmlFor="settings-daily-budget-usd">Daily LLM budget (USD)</label>
            <input
              id="settings-daily-budget-usd"
              name="dailyBudgetUsd"
              type="number"
              min={0}
              step={0.01}
              aria-describedby="settings-daily-budget-usd-help"
              value={field.state.value ?? 0}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(Number(event.target.value))}
            />
            <small id="settings-daily-budget-usd-help">
              Use 0 for unlimited. {settingContext(effectiveSettings.dailyBudgetUsd)}
            </small>
          </div>
        )}
      </form.Field>
      <form.Field name="applyConcurrency">
        {(field) => (
          <div className="field">
            <label htmlFor="settings-apply-concurrency">Concurrent applications</label>
            <input
              id="settings-apply-concurrency"
              name="applyConcurrency"
              type="number"
              min={1}
              max={16}
              step={1}
              aria-describedby="settings-apply-concurrency-help"
              value={field.state.value ?? 1}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(Number(event.target.value))}
            />
            <small id="settings-apply-concurrency-help">
              {settingContext(effectiveSettings.applyConcurrency)}
            </small>
          </div>
        )}
      </form.Field>
      {effectiveSettings.workerActivitySlots.editable ? (
        <form.Field name="workerActivitySlots">
          {(field) => (
            <WorkerActivitySlotsField
              value={field.state.value ?? initial.workerActivitySlots}
              onBlur={field.handleBlur}
              onChange={field.handleChange}
              metadata={effectiveSettings.workerActivitySlots}
              activeValue={activeWorkerActivitySlots}
              workerStatus={workerStatus}
            />
          )}
        </form.Field>
      ) : (
        <WorkerActivitySlotsField
          value={effectiveSettings.workerActivitySlots.value}
          metadata={effectiveSettings.workerActivitySlots}
          activeValue={activeWorkerActivitySlots}
          workerStatus={workerStatus}
        />
      )}
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

function WorkerActivitySlotsField({
  value,
  metadata,
  activeValue,
  workerStatus,
  onBlur,
  onChange,
}: {
  value: number;
  metadata: EffectiveJobCtrlSettings["workerActivitySlots"];
  activeValue: number | null;
  workerStatus: "healthy" | "missing" | "stale" | "mismatched";
  onBlur?: () => void;
  onChange?: (value: number) => void;
}) {
  const pendingRestart = activeValue !== null && activeValue !== value;
  return (
    <div className="field">
      <label htmlFor="settings-worker-activity-slots">Worker activity slots</label>
      <input
        id="settings-worker-activity-slots"
        name={metadata.editable ? "workerActivitySlots" : undefined}
        type="number"
        min={1}
        max={64}
        step={1}
        readOnly={!metadata.editable}
        aria-readonly={!metadata.editable || undefined}
        aria-describedby="settings-worker-activity-slots-help settings-worker-activity-slots-state"
        value={value}
        onBlur={onBlur}
        onChange={onChange ? (event) => onChange(Number(event.target.value)) : undefined}
      />
      <small id="settings-worker-activity-slots-help">{settingContext(metadata)}</small>
      <div id="settings-worker-activity-slots-state" className="status-line">
        Desired: {value}. Active: {activeValue ?? "not reported"}.{" "}
        {pendingRestart
          ? "Restart pending: restart the worker to activate the desired slots."
          : friendlyWorkerState(workerStatus, activeValue)}
      </div>
    </div>
  );
}

function settingContext(metadata: EffectiveJobCtrlSettings[keyof EffectiveJobCtrlSettings]): string {
  const source = metadata.source === "persisted"
    ? "Saved in config.json"
    : "Using the built-in default";
  const activation = metadata.activation === "live"
    ? "applies immediately"
    : metadata.activation === "next_poll"
      ? "applies on the next worker poll"
      : "requires a worker restart";
  return `${source}; ${activation}.`;
}

function friendlyWorkerState(
  status: "healthy" | "missing" | "stale" | "mismatched",
  activeValue: number | null,
): string {
  if (status === "healthy" && activeValue !== null) return "Worker ready.";
  if (status === "stale") return "Worker heartbeat is delayed.";
  if (status === "mismatched") return "Worker is connected to a different local runtime.";
  return "Worker is not running yet.";
}
