import { SettingsUpdateRequestSchema, type SettingsResponse } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../../shared/ui/button.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Field,
  FieldDescription,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import {
  SettingLabelWithHelp,
  type SettingHelpContent,
} from "../../../shared/ui/setting-help.js";
import { useSettingsPolicyQuery } from "../../operations/hooks/useSettingsPolicyQueries.js";
import { useAcknowledgedRuntimeValues } from "../../operations/hooks/useAcknowledgedRuntimeValues.js";
import { settingsKeys } from "../../operations/settingsKeys.js";
import { useUpdateApplyRuntimeSettingsMutation } from "../hooks/useUpdateApplyRuntimeSettingsMutation.js";

const APPLY_GUIDE_URL = "https://jobctrl.dev/user/apply";
const APPLY_RUNTIME_SETTING_HELP = {
  applyMaxBudgetUsd: {
    title: "Maximum AI budget per application",
    description:
      "Cap AI-agent spend for one application job. Zero is a zero-dollar cap, not unlimited, and changes apply to newly started Apply jobs.",
    href: `${APPLY_GUIDE_URL}#runtime-setting-maximum-ai-budget-per-application`,
  },
  applyTimeoutSeconds: {
    title: "Apply agent timeout",
    description:
      "Limit one application agent run. This is separate from Temporal activity timeouts and applies to newly started Apply jobs.",
    href: `${APPLY_GUIDE_URL}#runtime-setting-apply-agent-timeout`,
  },
} satisfies Record<string, SettingHelpContent>;

function toFormValues(response: SettingsResponse) {
  return {
    applyMaxBudgetUsd: response.settings.applyMaxBudgetUsd,
    applyTimeoutSeconds: response.settings.applyTimeoutSeconds,
  };
}

export function ApplyRuntimeSettingsPanel() {
  const settingsQuery = useSettingsPolicyQuery();
  const updateSettings = useUpdateApplyRuntimeSettingsMutation();
  const tenantId = useTenantId();
  const [status, setStatus] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const response = settingsQuery.data;
  const baseline = useAcknowledgedRuntimeValues(
    settingsKeys.settings(tenantId),
    ["tenant", tenantId, "runtime-settings-baseline", "apply"],
    {
      applyMaxBudgetUsd: response?.settings.applyMaxBudgetUsd ?? 5,
      applyTimeoutSeconds: response?.settings.applyTimeoutSeconds ?? 900,
    },
    toFormValues,
  );
  const acceptedValues = useRef(baseline.values);
  const form = useForm({
    defaultValues: acceptedValues.current,
    validators: {
      onSubmit: ({ value }) =>
        SettingsUpdateRequestSchema.safeParse(value).success
          ? undefined
          : "Invalid Apply runtime settings",
    },
    onSubmit: async ({ value, formApi }) => {
      if (!response) return;
      setStatus(null);
      const submitted = { ...value };
      const budgetEdited = Boolean(formApi.getFieldMeta("applyMaxBudgetUsd")?.isDirty);
      const timeoutEdited = Boolean(formApi.getFieldMeta("applyTimeoutSeconds")?.isDirty);
      try {
        const savedValues = await baseline.runSave(async () => {
          const request = {
            ...(response.effectiveSettings.applyMaxBudgetUsd.editable && budgetEdited
              ? { applyMaxBudgetUsd: submitted.applyMaxBudgetUsd }
              : {}),
            ...(response.effectiveSettings.applyTimeoutSeconds.editable && timeoutEdited
              ? { applyTimeoutSeconds: submitted.applyTimeoutSeconds }
              : {}),
          };
          const saved = await updateSettings.mutateAsync(request);
          return baseline.acknowledge(toFormValues(saved));
        });
        const current = formApi.state.values;
        const budgetPending = current.applyMaxBudgetUsd !== submitted.applyMaxBudgetUsd
          && current.applyMaxBudgetUsd !== savedValues.applyMaxBudgetUsd;
        const timeoutPending = current.applyTimeoutSeconds !== submitted.applyTimeoutSeconds
          && current.applyTimeoutSeconds !== savedValues.applyTimeoutSeconds;
        acceptedValues.current = savedValues;
        formApi.reset(savedValues);
        if (budgetPending) formApi.setFieldValue("applyMaxBudgetUsd", current.applyMaxBudgetUsd);
        if (timeoutPending) formApi.setFieldValue("applyTimeoutSeconds", current.applyTimeoutSeconds);
        setStatus({
          kind: "success",
          message: budgetPending || timeoutPending
            ? "Saved; newer changes pending."
            : "Application runtime saved for newly started application jobs.",
        });
      } catch {
        setStatus({
          kind: "error",
          message:
            "Application runtime could not be saved. Review the fields and try again.",
        });
      }
    },
  });

  useEffect(() => {
    acceptedValues.current = baseline.values;
    if (!form.state.isDirty && !form.state.isSubmitting) form.reset(baseline.values);
  }, [form, baseline.values]);

  if (!response) {
    return (
      <DisclosureSection
        className="application-runtime-settings"
        collapsedSummary="Budget and timeout policy"
        description="Per-application AI budget and execution timeout"
        title="Application runtime"
      >
        <Empty title="Loading Apply runtime settings." />
      </DisclosureSection>
    );
  }

  const budget = response.effectiveSettings.applyMaxBudgetUsd;
  const timeout = response.effectiveSettings.applyTimeoutSeconds;

  return (
    <DisclosureSection
      className="application-runtime-settings"
      collapsedSummary="Budget and timeout policy"
      description="Per-application AI budget and execution timeout"
      title="Application runtime"
    >
      <form
        className="config-form"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        onReset={(event) => {
          event.preventDefault();
          form.reset(acceptedValues.current);
          setStatus(null);
        }}
      >
        {status ? (
          <div
            className="status-line"
            role={status.kind === "error" ? "alert" : "status"}
          >
            {status.message}
          </div>
        ) : null}
        <form.Field name="applyMaxBudgetUsd">
          {(field) => (
            <Field className="field">
              <SettingLabelWithHelp
                help={APPLY_RUNTIME_SETTING_HELP.applyMaxBudgetUsd}
                htmlFor="apply-max-budget"
              >
                Maximum AI budget per application (USD)
              </SettingLabelWithHelp>
              <Input
                id="apply-max-budget"
                name="applyMaxBudgetUsd"
                type="number"
                min={0}
                step={0.01}
                readOnly={!budget.editable}
                aria-describedby="apply-max-budget-help"
                value={field.state.value}
                onChange={(event) => {
                  setStatus(null);
                  field.handleChange(Number(event.target.value));
                }}
              />
              <FieldDescription id="apply-max-budget-help">
                0 is a zero-dollar cap, not unlimited.{" "}
                {policyContext(budget.source)}
              </FieldDescription>
            </Field>
          )}
        </form.Field>
        <form.Field name="applyTimeoutSeconds">
          {(field) => (
            <Field className="field">
              <SettingLabelWithHelp
                help={APPLY_RUNTIME_SETTING_HELP.applyTimeoutSeconds}
                htmlFor="apply-timeout"
              >
                Apply agent timeout (seconds)
              </SettingLabelWithHelp>
              <Input
                id="apply-timeout"
                name="applyTimeoutSeconds"
                type="number"
                min={60}
                max={3600}
                step={1}
                readOnly={!timeout.editable}
                aria-describedby="apply-timeout-help"
                value={field.state.value}
                onChange={(event) => {
                  setStatus(null);
                  field.handleChange(Number(event.target.value));
                }}
              />
              <FieldDescription id="apply-timeout-help">
                Per application agent; separate from Temporal activity timeouts.{" "}
                {policyContext(timeout.source)}
              </FieldDescription>
            </Field>
          )}
        </form.Field>
        <form.Subscribe
          selector={(state) => ({
            canSubmit: state.canSubmit,
            isDirty: state.isDirty,
            isSubmitting: state.isSubmitting,
          })}
        >
          {({ canSubmit, isDirty, isSubmitting }) => (
            <div
              className="form-actions settings-save-actions"
              data-save-state={
                isSubmitting ? "saving" : isDirty ? "dirty" : "saved"
              }
            >
              <Button
                type="submit"
                disabled={
                  !canSubmit ||
                  !isDirty ||
                  isSubmitting ||
                  (!budget.editable && !timeout.editable)
                }
              >
                {isSubmitting
                  ? "Saving application runtime"
                  : "Save application runtime"}
              </Button>
              <Button
                type="reset"
                variant="outline"
                disabled={!isDirty || isSubmitting}
              >
                Discard changes
              </Button>
            </div>
          )}
        </form.Subscribe>
      </form>
    </DisclosureSection>
  );
}

function policyContext(source: "persisted" | "default"): string {
  return `${source === "persisted" ? "Saved in config.json" : "Using the default"}; applies to the next Apply job.`;
}
