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
  if (!response) return <section className="card full"><CardHeader title="Scoring guidance" /><Empty title="Loading scoring guidance." /></section>;
  return (
    <section className="card full">
      <CardHeader title="Scoring guidance" />
      <form className="config-form" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
        {status ? <div className="status-line" role="status">{status}</div> : null}
        <form.Field name="scoreCriteria">{(field) => <div className="field"><label htmlFor="score-guidance">Scoring priorities</label><textarea id="score-guidance" name="scoreCriteria" maxLength={8000} aria-describedby="score-guidance-help" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} /><small id="score-guidance-help">What strong-fit jobs should demonstrate. Applies to new scoring work.</small></div>}</form.Field>
        <form.Field name="targetCriteria">{(field) => <div className="field"><label htmlFor="target-guidance">Target role guidance</label><textarea id="target-guidance" name="targetCriteria" maxLength={8000} aria-describedby="target-guidance-help" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} /><small id="target-guidance-help">Additional role and company targeting guidance.</small></div>}</form.Field>
        <button className="tab on" type="submit" disabled={updateSettings.isPending}>{updateSettings.isPending ? "saving" : "save scoring guidance"}</button>
      </form>
    </section>
  );
}
