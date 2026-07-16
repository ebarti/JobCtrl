import { SettingsUpdateRequestSchema, type ProviderId } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useMemo, useState } from "react";

import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../../shared/ui/select.js";
import {
  useProviderModelCatalogQuery,
  useSettingsPolicyQuery,
} from "../../operations/hooks/useSettingsPolicyQueries.js";
import { useUpdateAiExecutionPolicyMutation } from "../hooks/useUpdateAiExecutionPolicyMutation.js";

const LEG_OPTIONS: Array<{ value: ProviderId; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "google", label: "Google" },
];

export function AiExecutionPolicyPanel() {
  const settingsQuery = useSettingsPolicyQuery();
  const catalogQuery = useProviderModelCatalogQuery();
  const updateSettings = useUpdateAiExecutionPolicyMutation();
  const [status, setStatus] = useState("");
  const response = settingsQuery.data;
  const models = useMemo(() => (catalogQuery.data?.providers ?? []).flatMap((provider) =>
    provider.ready ? provider.models.map((model) => ({ value: model.id.includes(":") ? model.id : `${provider.provider}:${model.id}`, label: `${provider.provider === "google" ? "Google" : provider.provider === "claude" ? "Claude" : "Codex"} — ${model.displayName}` })) : []
  ), [catalogQuery.data]);
  const generators = response?.settings.tailoringGeneratorModels ?? [];
  const form = useForm({
    defaultValues: {
      analysisLegs: response?.settings.analysisLegs ?? ["claude", "codex", "google"] as ProviderId[],
      generatorPrimary: generators[0] ?? "",
      generatorFallback: generators[1] ?? "",
      tailoringJudgeModel: response?.settings.tailoringJudgeModel ?? "",
      tailoringJudgeMinScore: response?.settings.tailoringJudgeMinScore ?? 0.82,
    },
    onSubmit: async ({ value, formApi }) => {
      if (!response) return;
      const generatorModels = [value.generatorPrimary, value.generatorFallback].filter((model, index, all) => model && all.indexOf(model) === index);
      const request = {
        ...(response.effectiveSettings.analysisLegs.editable ? { analysisLegs: value.analysisLegs } : {}),
        ...(response.effectiveSettings.tailoringGeneratorModels.editable ? { tailoringGeneratorModels: generatorModels.length ? generatorModels : null } : {}),
        ...(response.effectiveSettings.tailoringJudgeModel.editable ? { tailoringJudgeModel: value.tailoringJudgeModel || null } : {}),
        ...(response.effectiveSettings.tailoringJudgeMinScore.editable ? { tailoringJudgeMinScore: value.tailoringJudgeMinScore } : {}),
      };
      const parsed = SettingsUpdateRequestSchema.safeParse(request);
      if (!parsed.success) return;
      const saved = await updateSettings.mutateAsync(parsed.data);
      const savedGenerators = saved.settings.tailoringGeneratorModels ?? [];
      formApi.reset({
        analysisLegs: saved.settings.analysisLegs,
        generatorPrimary: savedGenerators[0] ?? "",
        generatorFallback: savedGenerators[1] ?? "",
        tailoringJudgeModel: saved.settings.tailoringJudgeModel ?? "",
        tailoringJudgeMinScore: saved.settings.tailoringJudgeMinScore,
      });
      setStatus("AI execution policy saved for newly started work.");
    },
  });
  useEffect(() => {
    if (!response || form.state.isDirty) return;
    const savedGenerators = response.settings.tailoringGeneratorModels ?? [];
    form.reset({ analysisLegs: response.settings.analysisLegs, generatorPrimary: savedGenerators[0] ?? "", generatorFallback: savedGenerators[1] ?? "", tailoringJudgeModel: response.settings.tailoringJudgeModel ?? "", tailoringJudgeMinScore: response.settings.tailoringJudgeMinScore });
  }, [form, response]);
  if (!response) return <section className="card full"><CardHeader title="AI execution policy" /><Empty title="Loading AI execution policy." /></section>;
  const effective = response.effectiveSettings;
  return (
    <section className="card full">
      <CardHeader title="AI execution policy" />
      <form className="config-form" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
        {status ? <div className="status-line" role="status">{status}</div> : null}
        <form.Field name="analysisLegs">{(field) => <fieldset className="field wide checkbox-group-field" aria-describedby="analysis-legs-help"><legend>Employer analysis perspectives</legend><div className="checkbox-options">{LEG_OPTIONS.map((option) => <label className="choice target-choice" key={option.value}><input name="analysisLegs" type="checkbox" disabled={!effective.analysisLegs.editable} checked={field.state.value.includes(option.value)} onChange={(event) => { const next = event.target.checked ? [...field.state.value, option.value] : field.state.value.filter((leg) => leg !== option.value); if (next.length) field.handleChange(next); }} /><span>{option.label}</span></label>)}</div><small id="analysis-legs-help">{context(effective.analysisLegs.source, "next analysis")}</small></fieldset>}</form.Field>
        <form.Field name="generatorPrimary">{(field) => <ModelSelectControl name="generatorPrimary" label="Primary tailoring generator" models={models} value={field.state.value} readOnly={!effective.tailoringGeneratorModels.editable} help={context(effective.tailoringGeneratorModels.source, "next tailoring workflow")} onChange={field.handleChange} />}</form.Field>
        <form.Field name="generatorFallback">{(field) => <ModelSelectControl name="generatorFallback" label="Fallback tailoring generator" models={models} value={field.state.value} readOnly={!effective.tailoringGeneratorModels.editable} help="Optional second choice; used after the primary." onChange={field.handleChange} />}</form.Field>
        <form.Field name="tailoringJudgeModel">{(field) => <ModelSelectControl name="tailoringJudgeModel" label="Tailoring judge" models={models} value={field.state.value} readOnly={!effective.tailoringJudgeModel.editable} help={context(effective.tailoringJudgeModel.source, "next tailoring workflow")} onChange={field.handleChange} />}</form.Field>
        <form.Field name="tailoringJudgeMinScore">{(field) => <div className="field"><label htmlFor="tailoring-judge-score">Minimum judge score</label><input id="tailoring-judge-score" name="tailoringJudgeMinScore" type="number" min={0} max={1} step={0.01} readOnly={!effective.tailoringJudgeMinScore.editable} aria-describedby="tailoring-judge-score-help" value={field.state.value} onChange={(event) => field.handleChange(Number(event.target.value))} /><small id="tailoring-judge-score-help">{context(effective.tailoringJudgeMinScore.source, "next tailoring workflow")}</small></div>}</form.Field>
        <button className="tab on" type="submit" disabled={updateSettings.isPending || (!effective.analysisLegs.editable && !effective.tailoringGeneratorModels.editable && !effective.tailoringJudgeModel.editable && !effective.tailoringJudgeMinScore.editable)}>{updateSettings.isPending ? "saving" : "save AI policy"}</button>
      </form>
    </section>
  );
}

function ModelSelectControl({ name, label, models, value, readOnly, help, onChange }: { name: "generatorPrimary" | "generatorFallback" | "tailoringJudgeModel"; label: string; models: Array<{ value: string; label: string }>; value: string; readOnly: boolean; help: string; onChange: (value: string) => void }) {
  const options = value && !models.some((model) => model.value === value) ? [{ value, label: `${value} — saved` }, ...models] : models;
  const helpId = `ai-policy-${name}-help`;
  const defaultValue = `__${name}-default__`;
  const items = [{ value: defaultValue, label: "Provider/default policy" }, ...options];
  return <div className="field"><label htmlFor={`ai-policy-${name}`}>{label}</label><Select name={name} disabled={readOnly} items={items} value={value || defaultValue} onValueChange={(nextValue) => { if (nextValue !== null) onChange(nextValue === defaultValue ? "" : nextValue); }}><SelectTrigger id={`ai-policy-${name}`} aria-label={label} aria-describedby={helpId} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{items.map((model) => <SelectItem key={model.value} value={model.value}>{model.label}</SelectItem>)}</SelectGroup></SelectContent></Select><small id={helpId}>{help}</small></div>;
}

function context(source: "persisted" | "default", activation: string): string {
  return `${source === "persisted" ? "Saved in config.json" : "Using provider/default policy"}; applies to the ${activation}.`;
}
