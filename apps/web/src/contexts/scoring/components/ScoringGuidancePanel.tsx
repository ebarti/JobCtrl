import { SettingsUpdateRequestSchema } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { useSettingsPolicyQuery } from "../../operations/hooks/useSettingsPolicyQueries.js";
import { useUpdateScoringGuidanceMutation } from "../hooks/useUpdateScoringGuidanceMutation.js";

export function ScoringGuidancePanel() {
  const settingsQuery = useSettingsPolicyQuery();
  const updateSettings = useUpdateScoringGuidanceMutation();
  const [status, setStatus] = useState("");
  const response = settingsQuery.data;
  const form = useForm({
    defaultValues: { scoreCriteria: response?.settings.scoreCriteria ?? "", targetCriteria: response?.settings.targetCriteria ?? "" },
    validators: { onSubmit: ({ value }) => SettingsUpdateRequestSchema.safeParse(value).success ? undefined : "Scoring guidance is too long" },
    onSubmit: async ({ value, formApi }) => {
      const saved = await updateSettings.mutateAsync(value);
      formApi.reset({ scoreCriteria: saved.settings.scoreCriteria, targetCriteria: saved.settings.targetCriteria });
      setStatus("Scoring guidance saved for newly started scoring work.");
    },
  });
  useEffect(() => {
    if (response && !form.state.isDirty) form.reset({ scoreCriteria: response.settings.scoreCriteria, targetCriteria: response.settings.targetCriteria });
  }, [form, response]);
  if (!response) return <section className="card full"><CardHeader title="Scoring guidance" meta="scoring" /><Empty title="Loading scoring guidance." /></section>;
  return (
    <section className="card full">
      <CardHeader title="Scoring guidance" meta="scoring" />
      <form className="config-form" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
        {status ? <div className="status-line" role="status">{status}</div> : null}
        <form.Field name="scoreCriteria">{(field) => <label className="field" htmlFor="score-guidance"><span>Scoring priorities</span><textarea id="score-guidance" name="scoreCriteria" maxLength={8000} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} /><small>What strong-fit jobs should demonstrate. Applies to new scoring work.</small></label>}</form.Field>
        <form.Field name="targetCriteria">{(field) => <label className="field" htmlFor="target-guidance"><span>Target role guidance</span><textarea id="target-guidance" name="targetCriteria" maxLength={8000} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} /><small>Additional role and company targeting guidance.</small></label>}</form.Field>
        <button className="tab on" type="submit" disabled={updateSettings.isPending}>{updateSettings.isPending ? "saving" : "save scoring guidance"}</button>
      </form>
    </section>
  );
}
