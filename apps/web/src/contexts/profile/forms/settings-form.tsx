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
import { Button } from "../../../shared/ui/button.js";
import { Field, FieldDescription } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import {
  SettingLabelWithHelp,
  type SettingHelpContent,
} from "../../../shared/ui/setting-help.js";

const CONFIGURATION_GUIDE_URL = "https://jobctrl.dev/user/configuration";
const EXECUTION_SETTING_HELP = {
  dailyBudgetUsd: {
    title: "Daily LLM budget",
    description:
      "Set the shared daily LLM spend ceiling. Zero means unlimited, and the saved value applies immediately.",
    href: `${CONFIGURATION_GUIDE_URL}#runtime-setting-daily-llm-budget`,
  },
  applyConcurrency: {
    title: "Concurrent applications",
    description:
      "Limit how many application jobs the standing Apply loop may process concurrently. The saved value applies on its next poll.",
    href: `${CONFIGURATION_GUIDE_URL}#runtime-setting-concurrent-applications`,
  },
  pipelineInternalConcurrency: {
    title: "Pipeline internal concurrency",
    description:
      "Set the shared parallelism used inside manual Pipeline actions and automatic profile-update preparation batches. It does not create worker activity slots.",
    href: `${CONFIGURATION_GUIDE_URL}#runtime-setting-pipeline-internal-concurrency`,
  },
  workerActivitySlots: {
    title: "Worker activity slots",
    description:
      "Set the Python worker's total Temporal activity capacity. This is separate from Pipeline internal concurrency and requires a worker restart.",
    href: `${CONFIGURATION_GUIDE_URL}#runtime-setting-worker-activity-slots`,
  },
} satisfies Record<string, SettingHelpContent>;

interface SettingsInitialProps {
  initial: JobCtrlSettings;
}

export interface SettingsFormProps extends SettingsInitialProps {
  effectiveSettings: EffectiveJobCtrlSettings;
  activeWorkerActivitySlots?: number | null;
  workerStatus?: "healthy" | "missing" | "stale" | "mismatched";
}

type ExecutionSettingsValues = Pick<
  SettingsUpdateRequest,
  "applyConcurrency" | "dailyBudgetUsd" | "pipelineInternalConcurrency"
> &
  Partial<Pick<SettingsUpdateRequest, "workerActivitySlots">>;
function toExecutionSettingsValues(
  values: JobCtrlSettings,
  effectiveSettings: EffectiveJobCtrlSettings,
): ExecutionSettingsValues {
  const result: ExecutionSettingsValues = {
    applyConcurrency: values.applyConcurrency,
    dailyBudgetUsd: values.dailyBudgetUsd,
    pipelineInternalConcurrency: values.pipelineInternalConcurrency,
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
      try {
        const response = await updateSettings.mutateAsync(value);
        if (serializeSettingsValues(formApi.state.values) === submittedValues) {
          formApi.reset(toFormValues(response.settings));
          setStatusMessage("Settings saved.");
        } else {
          setStatusMessage("Saved; newer changes pending.");
        }
      } catch {
        setStatusMessage("Could not save settings. Review the fields and try again.");
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
      {statusMessage ? <div className="status-line" role={updateSettings.isError ? "alert" : "status"}>{statusMessage}</div> : null}
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
          <Field className="field">
            <SettingLabelWithHelp
              help={EXECUTION_SETTING_HELP.dailyBudgetUsd}
              htmlFor="settings-daily-budget-usd"
            >
              Daily LLM budget (USD)
            </SettingLabelWithHelp>
            <Input
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
            <FieldDescription id="settings-daily-budget-usd-help">
              Use 0 for unlimited. {settingContext(effectiveSettings.dailyBudgetUsd)}
            </FieldDescription>
          </Field>
        )}
      </form.Field>
      <form.Field name="applyConcurrency">
        {(field) => (
          <Field className="field">
            <SettingLabelWithHelp
              help={EXECUTION_SETTING_HELP.applyConcurrency}
              htmlFor="settings-apply-concurrency"
            >
              Concurrent applications
            </SettingLabelWithHelp>
            <Input
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
            <FieldDescription id="settings-apply-concurrency-help">
              {settingContext(effectiveSettings.applyConcurrency)}
            </FieldDescription>
          </Field>
        )}
      </form.Field>
      <form.Field name="pipelineInternalConcurrency">
        {(field) => (
          <Field className="field">
            <SettingLabelWithHelp
              help={EXECUTION_SETTING_HELP.pipelineInternalConcurrency}
              htmlFor="settings-pipeline-internal-concurrency"
            >
              Pipeline internal concurrency
            </SettingLabelWithHelp>
            <Input
              id="settings-pipeline-internal-concurrency"
              name="pipelineInternalConcurrency"
              type="number"
              min={1}
              max={16}
              step={1}
              aria-describedby="settings-pipeline-internal-concurrency-help"
              value={field.state.value ?? 1}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(Number(event.target.value))}
            />
            <FieldDescription id="settings-pipeline-internal-concurrency-help">
              Shared by manual Pipeline actions and automatic profile
              preparation. {settingContext(
                effectiveSettings.pipelineInternalConcurrency,
              )}
            </FieldDescription>
          </Field>
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
          <div className="form-actions settings-save-actions" data-save-state={isSubmitting ? "saving" : isDirty ? "dirty" : "saved"}>
            <Button
              type="submit"
              disabled={!canSubmit || !isDirty || isSubmitting}
            >
              {isSubmitting ? "Saving changes" : "Save changes"}
            </Button>
            <Button
              variant="outline"
              type="reset"
              disabled={!isDirty || isSubmitting}
            >
              Discard changes
            </Button>
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
    <Field className="field">
      <SettingLabelWithHelp
        help={EXECUTION_SETTING_HELP.workerActivitySlots}
        htmlFor="settings-worker-activity-slots"
      >
        Worker activity slots
      </SettingLabelWithHelp>
      <Input
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
      <FieldDescription id="settings-worker-activity-slots-help">
        {settingContext(metadata)}
      </FieldDescription>
      <div
        id="settings-worker-activity-slots-state"
        className="status-line"
        data-typography="metadata"
      >
        Desired: {value}. Active: {activeValue ?? "not reported"}.{" "}
        {pendingRestart
          ? "Restart pending: restart the worker to activate the desired slots."
          : friendlyWorkerState(workerStatus, activeValue)}
      </div>
    </Field>
  );
}

function settingContext(metadata: EffectiveJobCtrlSettings[keyof EffectiveJobCtrlSettings]): string {
  const source = metadata.source === "persisted"
    ? "Saved in config.json"
    : "Using the built-in default";
  const activation = {
    live: "applies immediately",
    next_poll: "applies on the next worker poll",
    next_source_family: "applies to the next source family",
    next_run: "applies to the next run",
    next_analysis: "applies to the next analysis",
    next_workflow: "applies to newly started workflows",
    next_apply_job: "applies to the next Apply job",
    restart: "requires a worker restart",
  }[metadata.activation];
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
