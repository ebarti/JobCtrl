import { SettingsUpdateRequestSchema } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import { AdaptiveFieldGrid } from "../../../shared/ui/adaptive-field-grid.js";
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
      setStatus("Apply runtime settings saved for newly started application jobs.");
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

  const budget = response?.effectiveSettings.applyMaxBudgetUsd;
  const timeout = response?.effectiveSettings.applyTimeoutSeconds;

  return (
    <DisclosureSection
      className="apply-runtime-settings"
      title="Application runtime"
      description="Per-application AI budget and agent timeout"
      collapsedSummary="Limits for newly started application jobs"
    >
      {!response || !budget || !timeout ? (
        <Empty title="Loading Apply runtime settings." />
      ) : (
        <form
          className="apply-runtime-settings-form grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          {status ? <div className="status-line" role="status">{status}</div> : null}
          <AdaptiveFieldGrid columns={2} minColumnWidth={260} density="compact">
            <form.Field name="applyMaxBudgetUsd">
              {(field) => (
                <Field>
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
                    aria-readonly={!budget.editable || undefined}
                    aria-describedby="apply-max-budget-help"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(Number(event.target.value))}
                  />
                  <FieldDescription id="apply-max-budget-help">
                    0 is a zero-dollar cap, not unlimited. {policyContext(budget.source)}
                  </FieldDescription>
                </Field>
              )}
            </form.Field>
            <form.Field name="applyTimeoutSeconds">
              {(field) => (
                <Field>
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
                    aria-readonly={!timeout.editable || undefined}
                    aria-describedby="apply-timeout-help"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(Number(event.target.value))}
                  />
                  <FieldDescription id="apply-timeout-help">
                    Per application agent; separate from Temporal activity timeouts.{" "}
                    {policyContext(timeout.source)}
                  </FieldDescription>
                </Field>
              )}
            </form.Field>
          </AdaptiveFieldGrid>
          <div className="form-actions apply-runtime-settings-form__actions">
            <Button
              type="submit"
              disabled={updateSettings.isPending || (!budget.editable && !timeout.editable)}
            >
              {updateSettings.isPending ? "Saving…" : "Save Apply runtime"}
            </Button>
          </div>
        </form>
      )}
    </DisclosureSection>
  );
}

function policyContext(source: "persisted" | "default"): string {
  return `${source === "persisted" ? "Saved in config.json" : "Using the default"}; applies to the next Apply job.`;
}
