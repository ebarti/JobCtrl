import {
  SettingsUpdateRequestSchema,
  type EffectiveDashboardSettings,
  type SettingsUpdateRequest,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DashboardSettings } from "../../operations/types.js";
import { useUpdateSettingsMutation } from "../hooks/useUpdateSettingsMutation.js";
import { AutosaveUndoController } from "./autosave-undo-controller.js";

interface SettingsInitialProps {
  initial: DashboardSettings;
}

export interface SettingsFormProps extends SettingsInitialProps {
  effectiveSettings: EffectiveDashboardSettings;
  activeWorkerActivitySlots?: number | null;
  workerStatus?: "healthy" | "missing" | "stale" | "mismatched";
}

type ExecutionSettingsValues = Pick<SettingsUpdateRequest, "applyConcurrency" | "dailyBudgetUsd"> &
  Partial<Pick<SettingsUpdateRequest, "workerActivitySlots">>;
type DiscoveryAutomationSettingsValues = Pick<
  SettingsUpdateRequest,
  "autoApply" | "minFitScore" | "applyApprovalRequired"
>;

function toExecutionSettingsValues(
  values: DashboardSettings,
  effectiveSettings: EffectiveDashboardSettings,
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

export function SettingsForm({
  initial,
  effectiveSettings,
  activeWorkerActivitySlots = null,
  workerStatus = "missing",
}: SettingsFormProps) {
  const toFormValues = useCallback(
    (values: DashboardSettings) => toExecutionSettingsValues(values, effectiveSettings),
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
  metadata: EffectiveDashboardSettings["workerActivitySlots"];
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

function settingContext(metadata: EffectiveDashboardSettings[keyof EffectiveDashboardSettings]): string {
  const source = metadata.source === "environment"
    ? "Managed by the launch environment"
    : metadata.source === "persisted"
      ? "Saved in General settings"
      : "Using the default";
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

export function DiscoveryAutomationSettingsForm({ initial }: SettingsInitialProps) {
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
          <>
            <label className="field check">
              <input
                type="checkbox"
                aria-describedby="settings-auto-apply-help"
                checked={field.state.value ?? false}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.checked)}
              />
              <span>Auto apply</span>
            </label>
            <small id="settings-auto-apply-help" className="field-hint">
              Keep one standing apply loop running for eligible prepared jobs.
            </small>
          </>
        )}
      </form.Field>
      <form.Field name="applyApprovalRequired">
        {(field) => (
          <>
            <label className="field check">
              <input
                type="checkbox"
                aria-describedby="settings-apply-approval-required-help"
                checked={field.state.value ?? true}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.checked)}
              />
              <span>Require approval before live submit</span>
            </label>
            <small id="settings-apply-approval-required-help" className="field-hint">
              Live submissions wait for Apply Review approval; dry-runs can still run.
            </small>
          </>
        )}
      </form.Field>
      <form.Subscribe
        selector={(state) => ({
          autoApply: state.values.autoApply,
          applyApprovalRequired: state.values.applyApprovalRequired,
        })}
      >
        {({ autoApply, applyApprovalRequired }) => {
          const message = applyAutomationSummary({
            autoApply: Boolean(autoApply),
            applyApprovalRequired: applyApprovalRequired !== false,
          });
          return (
            <div
              className={`status-line ${message.warning ? "warning" : "info"}`}
              role={message.warning ? "alert" : "status"}
            >
              {message.text}
            </div>
          );
        }}
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

function applyAutomationSummary(values: {
  autoApply: boolean;
  applyApprovalRequired: boolean;
}): { text: string; warning: boolean } {
  if (values.autoApply && values.applyApprovalRequired) {
    return {
      text:
        "Auto apply is supervised: a standing loop polls eligible jobs, and live submit waits for Apply Review approval.",
      warning: false,
    };
  }
  if (values.autoApply && !values.applyApprovalRequired) {
    return {
      text:
        "Autonomous submit mode: the standing loop may submit eligible jobs without human review, while min score, budget, at-most-once, dry-run, and CAPTCHA safeguards remain enforced.",
      warning: true,
    };
  }
  if (!values.autoApply && !values.applyApprovalRequired) {
    return {
      text:
        "Auto apply is off. Manually started live apply runs may submit without Apply Review approval.",
      warning: true,
    };
  }
  return {
    text:
      "Default supervised mode: no standing apply loop runs, and live submit requires Apply Review approval.",
    warning: false,
  };
}
