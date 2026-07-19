import { SettingsUpdateRequestSchema } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import { Button } from "../../../shared/ui/button.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { useSettingsPolicyQuery } from "../../operations/hooks/useSettingsPolicyQueries.js";
import { useUpdateApplyRuntimeSettingsMutation } from "../hooks/useUpdateApplyRuntimeSettingsMutation.js";

export function ApplyRuntimeSettingsPanel() {
  const settingsQuery = useSettingsPolicyQuery();
  const updateSettings = useUpdateApplyRuntimeSettingsMutation();
  const [status, setStatus] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const response = settingsQuery.data;
  const form = useForm({
    defaultValues: {
      applyMaxBudgetUsd: response?.settings.applyMaxBudgetUsd ?? 5,
      applyTimeoutSeconds: response?.settings.applyTimeoutSeconds ?? 900,
    },
    validators: {
      onSubmit: ({ value }) =>
        SettingsUpdateRequestSchema.safeParse(value).success
          ? undefined
          : "Invalid Apply runtime settings",
    },
    onSubmit: async ({ value, formApi }) => {
      if (!response) return;
      setStatus(null);
      const request = {
        ...(response.effectiveSettings.applyMaxBudgetUsd.editable
          ? { applyMaxBudgetUsd: value.applyMaxBudgetUsd }
          : {}),
        ...(response.effectiveSettings.applyTimeoutSeconds.editable
          ? { applyTimeoutSeconds: value.applyTimeoutSeconds }
          : {}),
      };
      try {
        const saved = await updateSettings.mutateAsync(request);
        formApi.reset({
          applyMaxBudgetUsd: saved.settings.applyMaxBudgetUsd,
          applyTimeoutSeconds: saved.settings.applyTimeoutSeconds,
        });
        setStatus({
          kind: "success",
          message:
            "Application runtime saved for newly started application jobs.",
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
    if (response && !form.state.isDirty) {
      form.reset({
        applyMaxBudgetUsd: response.settings.applyMaxBudgetUsd,
        applyTimeoutSeconds: response.settings.applyTimeoutSeconds,
      });
    }
  }, [form, response]);

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
          form.reset({
            applyMaxBudgetUsd: response.settings.applyMaxBudgetUsd,
            applyTimeoutSeconds: response.settings.applyTimeoutSeconds,
          });
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
              <FieldLabel htmlFor="apply-max-budget">
                Maximum AI budget per application (USD)
              </FieldLabel>
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
              <FieldLabel htmlFor="apply-timeout">
                Apply agent timeout (seconds)
              </FieldLabel>
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
