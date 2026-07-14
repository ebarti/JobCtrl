import {
  DiscoverySettingsUpdateRequestSchema,
  type DiscoverySettingsResponse,
  type DiscoverySettingsUpdateRequest,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";

import { AutosaveUndoController } from "../../../shared/ui/autosave-undo-controller.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Empty } from "../../../shared/ui/empty.js";
import { useDiscoverySettingsQuery } from "../../operations/hooks/useDiscoverySettingsQuery.js";
import { useUpdateDiscoverySettingsMutation } from "../hooks/useUpdateDiscoverySettingsMutation.js";

type AutomationValues = Pick<
  DiscoverySettingsUpdateRequest,
  "autoApply" | "minFitScore" | "applyApprovalRequired"
>;

function toFormValues(response: DiscoverySettingsResponse): AutomationValues {
  return {
    autoApply: response.settings.autoApply,
    minFitScore: response.settings.minFitScore,
    applyApprovalRequired: response.settings.applyApprovalRequired,
  };
}

export function DiscoveryAutomationSettingsPanel() {
  const settingsQuery = useDiscoverySettingsQuery();

  return (
    <DisclosureSection
      className="discovery-automation-settings"
      title="Automation settings"
      description="Scoring threshold and supervised apply policy"
      collapsedSummary="SQLite-backed scoring and apply controls"
    >
      {settingsQuery.error ? <div className="banner inline">{settingsQuery.error.message}</div> : null}
      {settingsQuery.data ? (
        <DiscoveryAutomationSettingsForm initial={settingsQuery.data} />
      ) : (
        <Empty title="Loading automation settings." />
      )}
    </DisclosureSection>
  );
}

export function DiscoveryAutomationSettingsForm({
  initial,
}: {
  initial: DiscoverySettingsResponse;
}) {
  const updateSettings = useUpdateDiscoverySettingsMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const [resetToken, setResetToken] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const form = useForm({
    defaultValues: toFormValues(initial),
    validators: {
      onSubmit: ({ value }) => {
        const result = DiscoverySettingsUpdateRequestSchema.safeParse(value);
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid automation settings");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const submittedValues = JSON.stringify(value);
      const response = await updateSettings.mutateAsync(value);
      if (JSON.stringify(formApi.state.values) === submittedValues) {
        formApi.reset(toFormValues(response));
        setStatusMessage("automation settings saved in SQLite");
      } else {
        setStatusMessage("saved; newer changes pending");
      }
    },
  });

  useEffect(() => {
    if (form.state.isDirty || form.state.isSubmitting) return;
    form.reset(toFormValues(initial));
    setResetToken((token) => token + 1);
  }, [form, initial]);

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
                aria-describedby="discovery-auto-apply-help"
                checked={field.state.value ?? false}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.checked)}
              />
              <span>Auto apply</span>
            </label>
            <small id="discovery-auto-apply-help" className="field-hint">
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
                aria-describedby="discovery-apply-approval-help"
                checked={field.state.value ?? true}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.checked)}
              />
              <span>Require approval before live submit</span>
            </label>
            <small id="discovery-apply-approval-help" className="field-hint">
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
          const summary = applyAutomationSummary({
            autoApply: Boolean(autoApply),
            applyApprovalRequired: applyApprovalRequired !== false,
          });
          return (
            <div
              className={`status-line ${summary.warning ? "warning" : "info"}`}
              role={summary.warning ? "alert" : "status"}
            >
              {summary.text}
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
            <button className="tab on" type="submit" disabled={!canSubmit || !isDirty || isSubmitting}>
              {isSubmitting ? "saving" : "save automation settings"}
            </button>
            <button className="tab" type="reset" disabled={!isDirty || isSubmitting}>
              discard changes
            </button>
          </div>
        )}
      </form.Subscribe>
      {updateSettings.error ? <div className="banner inline" role="alert">{updateSettings.error.message}</div> : null}
    </form>
  );
}

function applyAutomationSummary(values: {
  autoApply: boolean;
  applyApprovalRequired: boolean;
}): { text: string; warning: boolean } {
  if (values.autoApply && values.applyApprovalRequired) {
    return {
      text: "Auto apply is supervised: the standing loop polls eligible jobs, and live submit waits for Apply Review approval.",
      warning: false,
    };
  }
  if (values.autoApply && !values.applyApprovalRequired) {
    return {
      text: "Autonomous submit mode: the standing loop may submit eligible jobs without human review, while score, budget, at-most-once, dry-run, and CAPTCHA safeguards remain enforced.",
      warning: true,
    };
  }
  if (!values.autoApply && !values.applyApprovalRequired) {
    return {
      text: "Auto apply is off. Manually started live apply runs may submit without Apply Review approval.",
      warning: true,
    };
  }
  return {
    text: "Default supervised mode: no standing apply loop runs, and live submit requires Apply Review approval.",
    warning: false,
  };
}
