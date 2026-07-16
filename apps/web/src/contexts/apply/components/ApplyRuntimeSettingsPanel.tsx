import { SettingsUpdateRequestSchema } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import { useSettingsPolicyQuery } from "../../operations/hooks/useSettingsPolicyQueries.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
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
    validators: { onSubmit: ({ value }) => SettingsUpdateRequestSchema.safeParse(value).success ? undefined : "Invalid Apply runtime settings" },
    onSubmit: async ({ value, formApi }) => {
      if (!response) return;
      const request = {
        ...(response.effectiveSettings.applyMaxBudgetUsd.editable ? { applyMaxBudgetUsd: value.applyMaxBudgetUsd } : {}),
        ...(response.effectiveSettings.applyTimeoutSeconds.editable ? { applyTimeoutSeconds: value.applyTimeoutSeconds } : {}),
      };
      const saved = await updateSettings.mutateAsync(request);
      formApi.reset({ applyMaxBudgetUsd: saved.settings.applyMaxBudgetUsd, applyTimeoutSeconds: saved.settings.applyTimeoutSeconds });
      setStatus("Apply runtime settings saved for newly started application jobs.");
    },
  });
  useEffect(() => {
    if (response && !form.state.isDirty) form.reset({ applyMaxBudgetUsd: response.settings.applyMaxBudgetUsd, applyTimeoutSeconds: response.settings.applyTimeoutSeconds });
  }, [form, response]);
  if (!response) return <section className="card full"><CardHeader title="Application runtime" /><Empty title="Loading Apply runtime settings." /></section>;
  const budget = response.effectiveSettings.applyMaxBudgetUsd;
  const timeout = response.effectiveSettings.applyTimeoutSeconds;
  return (
    <section className="card full">
      <CardHeader title="Application runtime" />
      <form className="config-form" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
        {status ? <div className="status-line" role="status">{status}</div> : null}
        <form.Field name="applyMaxBudgetUsd">{(field) => <div className="field"><label htmlFor="apply-max-budget">Maximum AI budget per application (USD)</label><input id="apply-max-budget" name="applyMaxBudgetUsd" type="number" min={0} step={0.01} readOnly={!budget.editable} aria-describedby="apply-max-budget-help" value={field.state.value} onChange={(event) => field.handleChange(Number(event.target.value))} /><small id="apply-max-budget-help">0 is a zero-dollar cap, not unlimited. {policyContext(budget.source)}</small></div>}</form.Field>
        <form.Field name="applyTimeoutSeconds">{(field) => <div className="field"><label htmlFor="apply-timeout">Apply agent timeout (seconds)</label><input id="apply-timeout" name="applyTimeoutSeconds" type="number" min={60} max={3600} step={1} readOnly={!timeout.editable} aria-describedby="apply-timeout-help" value={field.state.value} onChange={(event) => field.handleChange(Number(event.target.value))} /><small id="apply-timeout-help">Per application agent; separate from Temporal activity timeouts. {policyContext(timeout.source)}</small></div>}</form.Field>
        <div className="form-actions">
          <button className="tab on" type="submit" disabled={updateSettings.isPending || (!budget.editable && !timeout.editable)}>{updateSettings.isPending ? "saving" : "save Apply runtime"}</button>
        </div>
      </form>
    </section>
  );
}

function policyContext(source: "persisted" | "default"): string {
  return `${source === "persisted" ? "Saved in config.json" : "Using the default"}; applies to the next Apply job.`;
}
