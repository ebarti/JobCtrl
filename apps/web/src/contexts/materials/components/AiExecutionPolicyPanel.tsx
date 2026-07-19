import {
  SettingsUpdateRequestSchema,
  type ProviderId,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
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

interface SaveStatus {
  kind: "error" | "success";
  message: string;
}

export function AiExecutionPolicyPanel() {
  const settingsQuery = useSettingsPolicyQuery();
  const catalogQuery = useProviderModelCatalogQuery();
  const updateSettings = useUpdateAiExecutionPolicyMutation();
  const [status, setStatus] = useState<SaveStatus | null>(null);
  const response = settingsQuery.data;
  const models = useMemo(
    () =>
      (catalogQuery.data?.providers ?? []).flatMap((provider) =>
        provider.ready
          ? provider.models.map((model) => ({
              value: model.id.includes(":")
                ? model.id
                : `${provider.provider}:${model.id}`,
              label: `${providerLabel(provider.provider)} — ${model.displayName}`,
            }))
          : [],
      ),
    [catalogQuery.data],
  );
  const generators = response?.settings.tailoringGeneratorModels ?? [];
  const form = useForm({
    defaultValues: {
      analysisLegs:
        response?.settings.analysisLegs ??
        (["claude", "codex", "google"] as ProviderId[]),
      generatorPrimary: generators[0] ?? "",
      generatorFallback: generators[1] ?? "",
      tailoringJudgeModel: response?.settings.tailoringJudgeModel ?? "",
      tailoringJudgeMinScore: response?.settings.tailoringJudgeMinScore ?? 0.82,
    },
    onSubmit: async ({ value, formApi }) => {
      if (!response) return;
      setStatus(null);
      const generatorModels = [
        value.generatorPrimary,
        value.generatorFallback,
      ].filter((model, index, all) => model && all.indexOf(model) === index);
      const request = {
        ...(response.effectiveSettings.analysisLegs.editable
          ? { analysisLegs: value.analysisLegs }
          : {}),
        ...(response.effectiveSettings.tailoringGeneratorModels.editable
          ? {
              tailoringGeneratorModels: generatorModels.length
                ? generatorModels
                : null,
            }
          : {}),
        ...(response.effectiveSettings.tailoringJudgeModel.editable
          ? { tailoringJudgeModel: value.tailoringJudgeModel || null }
          : {}),
        ...(response.effectiveSettings.tailoringJudgeMinScore.editable
          ? { tailoringJudgeMinScore: value.tailoringJudgeMinScore }
          : {}),
      };
      const parsed = SettingsUpdateRequestSchema.safeParse(request);
      if (!parsed.success) {
        setStatus({
          kind: "error",
          message: "AI execution policy contains an invalid value.",
        });
        return;
      }
      try {
        const saved = await updateSettings.mutateAsync(parsed.data);
        const savedGenerators = saved.settings.tailoringGeneratorModels ?? [];
        formApi.reset({
          analysisLegs: saved.settings.analysisLegs,
          generatorPrimary: savedGenerators[0] ?? "",
          generatorFallback: savedGenerators[1] ?? "",
          tailoringJudgeModel: saved.settings.tailoringJudgeModel ?? "",
          tailoringJudgeMinScore: saved.settings.tailoringJudgeMinScore,
        });
        setStatus({
          kind: "success",
          message: "AI execution policy saved for newly started work.",
        });
      } catch {
        setStatus({
          kind: "error",
          message: "AI execution policy could not be saved. Try again.",
        });
      }
    },
  });

  useEffect(() => {
    if (!response || form.state.isDirty) return;
    const savedGenerators = response.settings.tailoringGeneratorModels ?? [];
    form.reset({
      analysisLegs: response.settings.analysisLegs,
      generatorPrimary: savedGenerators[0] ?? "",
      generatorFallback: savedGenerators[1] ?? "",
      tailoringJudgeModel: response.settings.tailoringJudgeModel ?? "",
      tailoringJudgeMinScore: response.settings.tailoringJudgeMinScore,
    });
  }, [form, response]);

  if (!response) {
    return (
      <DisclosureSection
        className="ai-execution-policy-settings"
        collapsedSummary="Analysis, generation, and judge policy"
        description="Provider roles used by newly started analysis and tailoring work"
        title="AI execution policy"
      >
        <Empty
          title={
            settingsQuery.error
              ? "AI execution policy is unavailable"
              : "Loading AI execution policy"
          }
        />
      </DisclosureSection>
    );
  }

  const effective = response.effectiveSettings;
  const initialValues = {
    analysisLegs: response.settings.analysisLegs,
    generatorPrimary: generators[0] ?? "",
    generatorFallback: generators[1] ?? "",
    tailoringJudgeModel: response.settings.tailoringJudgeModel ?? "",
    tailoringJudgeMinScore: response.settings.tailoringJudgeMinScore,
  };
  const allReadOnly =
    !effective.analysisLegs.editable &&
    !effective.tailoringGeneratorModels.editable &&
    !effective.tailoringJudgeModel.editable &&
    !effective.tailoringJudgeMinScore.editable;

  function clearSaveStatus() {
    setStatus(null);
  }

  return (
    <DisclosureSection
      className="ai-execution-policy-settings"
      collapsedSummary="Analysis, generation, and judge policy"
      description="Provider roles used by newly started analysis and tailoring work"
      title="AI execution policy"
    >
      <form
        className="config-form"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        onReset={(event) => {
          event.preventDefault();
          form.reset(initialValues);
          setStatus(null);
        }}
      >
        {catalogQuery.isPending ? (
          <p className="status-line" role="status">
            Checking available provider models…
          </p>
        ) : catalogQuery.error ? (
          <p className="status-line" role="alert">
            Live model choices are unavailable. Saved values remain visible.
          </p>
        ) : null}
        {status ? (
          <div
            className="status-line"
            role={status.kind === "error" ? "alert" : "status"}
          >
            {status.message}
          </div>
        ) : null}
        <form.Field name="analysisLegs">
          {(field) => (
            <FieldSet
              className="field wide checkbox-group-field"
              aria-describedby="analysis-legs-help"
            >
              <FieldLegend>Employer analysis perspectives</FieldLegend>
              <FieldGroup className="checkbox-options">
                {LEG_OPTIONS.map((option) => {
                  const id = `analysis-leg-${option.value}`;
                  return (
                    <Field
                      className="choice target-choice"
                      key={option.value}
                      orientation="horizontal"
                    >
                      <Checkbox
                        id={id}
                        name="analysisLegs"
                        disabled={!effective.analysisLegs.editable}
                        checked={field.state.value.includes(option.value)}
                        onCheckedChange={(checked) => {
                          const next = checked
                            ? [...field.state.value, option.value]
                            : field.state.value.filter(
                                (leg) => leg !== option.value,
                              );
                          if (next.length) {
                            clearSaveStatus();
                            field.handleChange(next);
                          }
                        }}
                      />
                      <FieldLabel htmlFor={id}>{option.label}</FieldLabel>
                    </Field>
                  );
                })}
              </FieldGroup>
              <FieldDescription id="analysis-legs-help">
                {context(effective.analysisLegs.source, "next analysis")}
              </FieldDescription>
            </FieldSet>
          )}
        </form.Field>
        <form.Field name="generatorPrimary">
          {(field) => (
            <ModelSelectControl
              name="generatorPrimary"
              label="Primary tailoring generator"
              models={models}
              value={field.state.value}
              readOnly={!effective.tailoringGeneratorModels.editable}
              help={context(
                effective.tailoringGeneratorModels.source,
                "next tailoring workflow",
              )}
              onChange={(value) => {
                clearSaveStatus();
                field.handleChange(value);
              }}
            />
          )}
        </form.Field>
        <form.Field name="generatorFallback">
          {(field) => (
            <ModelSelectControl
              name="generatorFallback"
              label="Fallback tailoring generator"
              models={models}
              value={field.state.value}
              readOnly={!effective.tailoringGeneratorModels.editable}
              help="Optional second choice; used after the primary."
              onChange={(value) => {
                clearSaveStatus();
                field.handleChange(value);
              }}
            />
          )}
        </form.Field>
        <form.Field name="tailoringJudgeModel">
          {(field) => (
            <ModelSelectControl
              name="tailoringJudgeModel"
              label="Tailoring judge"
              models={models}
              value={field.state.value}
              readOnly={!effective.tailoringJudgeModel.editable}
              help={context(
                effective.tailoringJudgeModel.source,
                "next tailoring workflow",
              )}
              onChange={(value) => {
                clearSaveStatus();
                field.handleChange(value);
              }}
            />
          )}
        </form.Field>
        <form.Field name="tailoringJudgeMinScore">
          {(field) => (
            <Field className="field">
              <FieldLabel htmlFor="tailoring-judge-score">
                Minimum judge score
              </FieldLabel>
              <Input
                id="tailoring-judge-score"
                name="tailoringJudgeMinScore"
                type="number"
                min={0}
                max={1}
                step={0.01}
                readOnly={!effective.tailoringJudgeMinScore.editable}
                aria-describedby="tailoring-judge-score-help"
                value={field.state.value}
                onChange={(event) => {
                  clearSaveStatus();
                  field.handleChange(Number(event.target.value));
                }}
              />
              <FieldDescription id="tailoring-judge-score-help">
                {context(
                  effective.tailoringJudgeMinScore.source,
                  "next tailoring workflow",
                )}
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
                disabled={!canSubmit || !isDirty || isSubmitting || allReadOnly}
              >
                {isSubmitting ? "Saving AI policy" : "Save AI policy"}
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

function ModelSelectControl({
  name,
  label,
  models,
  value,
  readOnly,
  help,
  onChange,
}: {
  name: "generatorPrimary" | "generatorFallback" | "tailoringJudgeModel";
  label: string;
  models: Array<{ value: string; label: string }>;
  value: string;
  readOnly: boolean;
  help: string;
  onChange: (value: string) => void;
}) {
  const options =
    value && !models.some((model) => model.value === value)
      ? [{ value, label: `${value} — saved` }, ...models]
      : models;
  const helpId = `ai-policy-${name}-help`;
  const defaultValue = `__${name}-default__`;
  const items = [
    { value: defaultValue, label: "Provider/default policy" },
    ...options,
  ];
  return (
    <Field className="field">
      <FieldLabel htmlFor={`ai-policy-${name}`}>{label}</FieldLabel>
      <Select
        name={name}
        disabled={readOnly}
        items={items}
        value={value || defaultValue}
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onChange(nextValue === defaultValue ? "" : nextValue);
          }
        }}
      >
        <SelectTrigger
          id={`ai-policy-${name}`}
          aria-label={label}
          aria-describedby={helpId}
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription id={helpId}>{help}</FieldDescription>
    </Field>
  );
}

function context(source: "persisted" | "default", activation: string): string {
  return `${source === "persisted" ? "Saved in config.json" : "Using provider/default policy"}; applies to the ${activation}.`;
}

function providerLabel(provider: ProviderId): string {
  if (provider === "google") return "Google";
  if (provider === "claude") return "Claude";
  return "Codex";
}
