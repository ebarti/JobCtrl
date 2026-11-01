import type { ProviderModel } from "@jobctrl/contracts";

import { Field, FieldDescription, FieldLabel } from "../../../shared/ui/field.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../../shared/ui/select.js";

export function CodexReasoningEffortFields({ models, modelSpecs, analysisModel, includeDefaultAnalysisModel, value, readOnly, onChange }: {
  models: ProviderModel[];
  modelSpecs: string[];
  analysisModel: string | null;
  includeDefaultAnalysisModel: boolean;
  value: Record<string, string>;
  readOnly: boolean;
  onChange: (value: Record<string, string>) => void;
}) {
  const ids = new Set(modelSpecs.filter((spec) => spec.startsWith("codex:")).map((spec) => spec.slice("codex:".length)));
  if (includeDefaultAnalysisModel) {
    const model = analysisModel ?? models.find((model) => model.isDefault)?.id;
    if (model) ids.add(model);
  }
  const selected = models.filter((model) => ids.has(model.id));
  if (selected.length === 0) return null;
  return selected.map((model) => {
    const options = model.supportedReasoningEfforts ?? [];
    const selectedEffort = value[model.id] ?? "";
    const option = options.find((option) => option.reasoningEffort === selectedEffort);
    const id = `codex-effort-${model.id}`;
    const items = [{ value: "__per-call__", label: "Existing call settings" }, ...options.map((option) => ({ value: option.reasoningEffort, label: effortLabel(option.reasoningEffort) }))];
    return (
      <Field key={model.id} className="field">
        <FieldLabel htmlFor={id}>Reasoning effort · {model.displayName}</FieldLabel>
        <Select
          name={id}
          items={items}
          value={selectedEffort && !option ? null : selectedEffort || "__per-call__"}
          disabled={readOnly || options.length === 0}
          onValueChange={(effort) => {
            if (effort === null) return;
            const next = { ...value };
            if (effort === "__per-call__") delete next[model.id];
            else next[model.id] = effort;
            onChange(next);
          }}
        >
          <SelectTrigger id={id} aria-label={`Reasoning effort · ${model.displayName}`} aria-describedby={`${id}-help`} className="w-full">
            <SelectValue placeholder="Select a currently supported effort" />
          </SelectTrigger>
          <SelectContent><SelectGroup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
        <FieldDescription id={`${id}-help`}>
          {options.length === 0
            ? "The provider did not report effort controls for this model."
            : selectedEffort
              ? option
                ? `${option.description ?? effortLabel(selectedEffort)}. Applies to every new call using this Codex model, including analysis, generation and review.`
                : `Saved effort ${selectedEffort} is not in the current provider catalog. Choose a supported effort.`
              : "Current policy: High for analysis and review; Low for tailoring drafts. An explicit effort applies to every new call using this Codex model."}
        </FieldDescription>
      </Field>
    );
  });
}

function effortLabel(effort: string): string {
  return ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" } as Record<string, string>)[effort] ?? effort;
}
