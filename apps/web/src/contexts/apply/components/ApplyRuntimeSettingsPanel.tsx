import { SettingsUpdateRequestSchema } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import { CardHeader } from "../../../shared/ui/card-header.js";
import { Button } from "../../../shared/ui/button.js";
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
  const [status, setStatus] = useState("");
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
      const request = {
        ...(response.effectiveSettings.applyMaxBudgetUsd.editable
          ? { applyMaxBudgetUsd: value.applyMaxBudgetUsd }
          : {}),
        ...(response.effectiveSettings.applyTimeoutSeconds.editable
          ? { applyTimeoutSeconds: value.applyTimeoutSeconds }
          : {}),
      };
      const saved = await updateSettings.mutateAsync(request);
      formApi.reset({
        applyMaxBudgetUsd: saved.settings.applyMaxBudgetUsd,
        applyTimeoutSeconds: saved.settings.applyTimeoutSeconds,
      });
      setStatus(
        "Apply runtime settings saved for newly started application jobs.",
      );
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
      <section className="card full">
        <CardHeader title="Application runtime" />
        <Empty title="Loading Apply runtime settings." />
      </section>
    );
  }

  const budget = response.effectiveSettings.applyMaxBudgetUsd;
  const timeout = response.effectiveSettings.applyTimeoutSeconds;

  return (
    <section className="card full">
      <CardHeader title="Application runtime" />
      <form
        className="config-form"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        {status ? (
          <div className="status-line" role="status">
            {status}
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
                onChange={(event) =>
                  field.handleChange(Number(event.target.value))
                }
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
                onChange={(event) =>
                  field.handleChange(Number(event.target.value))
                }
              />
              <FieldDescription id="apply-timeout-help">
                Per application agent; separate from Temporal activity timeouts.{" "}
                {policyContext(timeout.source)}
              </FieldDescription>
            </Field>
          )}
        </form.Field>
        <div className="form-actions">
          <Button
            type="submit"
            disabled={
              updateSettings.isPending ||
              (!budget.editable && !timeout.editable)
            }
          >
            {updateSettings.isPending
              ? "Saving application runtime"
              : "Save application runtime"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function policyContext(source: "persisted" | "default"): string {
  return `${source === "persisted" ? "Saved in config.json" : "Using the default"}; applies to the next Apply job.`;
}
