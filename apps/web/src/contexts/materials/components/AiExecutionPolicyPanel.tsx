import {
  SettingsUpdateRequestSchema,
  type ProviderId,
  type SettingsResponse,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useMemo, useState } from "react";

import { AdaptiveFieldGrid } from "../../../shared/ui/adaptive-field-grid.js";
import { Button } from "../../../shared/ui/button.js";
import { ChoiceControl } from "../../../shared/ui/choice-control.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { SelectField } from "../../../shared/ui/select-field.js";
import {
  useProviderModelCatalogQuery,
  useSettingsPolicyQuery,
} from "../../operations/hooks/useSettingsPolicyQueries.js";
import { useUpdateAiExecutionPolicyMutation } from "../hooks/useUpdateAiExecutionPolicyMutation.js";

const DEFAULT_POLICY_OPTION = "__jobctrl_provider_default_policy__";

const LEG_OPTIONS: Array<{ value: ProviderId; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "google", label: "Google" },
];

interface AiPolicyFormValues {
  analysisLegs: ProviderId[];
  generatorPrimary: string;
  generatorFallback: string;
  tailoringJudgeModel: string;
  tailoringJudgeMinScore: number;
}

export function AiExecutionPolicyPanel() {
  const settingsQuery = useSettingsPolicyQuery();
  const catalogQuery = useProviderModelCatalogQuery();
  const updateSettings = useUpdateAiExecutionPolicyMutation();
  const [status, setStatus] = useState("");
  const response = settingsQuery.data;
  const models = useMemo(
    () =>
      (catalogQuery.data?.providers ?? []).flatMap((provider) =>
        provider.ready
          ? provider.models.map((model) => ({
              value: model.id.includes(":")
                ? model.id
                : `${provider.provider}:${model.id}`,
              label: `${providerName(provider.provider)} — ${model.displayName}`,
            }))
          : [],
      ),
    [catalogQuery.data],
  );
  const generators = response?.settings.tailoringGeneratorModels ?? [];
  const form = useForm({
    defaultValues: {
      analysisLegs: response?.settings.analysisLegs ?? ["claude", "codex", "google"] as ProviderId[],
      generatorPrimary: generators[0] ?? "",
      generatorFallback: generators[1] ?? "",
      tailoringJudgeModel: response?.settings.tailoringJudgeModel ?? "",
      tailoringJudgeMinScore: response?.settings.tailoringJudgeMinScore ?? 0.82,
    },
    validators: {
      onSubmit: ({ value }) => {
        if (!response) return "AI execution policy is unavailable.";
        const parsed = SettingsUpdateRequestSchema.safeParse(toSettingsRequest(response, value));
        return parsed.success
          ? undefined
          : (parsed.error.issues[0]?.message ?? "Invalid AI execution policy.");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      if (!response) return;
      const parsed = SettingsUpdateRequestSchema.safeParse(toSettingsRequest(response, value));
      if (!parsed.success) return;
      setStatus("");
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
    form.reset({
      analysisLegs: response.settings.analysisLegs,
      generatorPrimary: savedGenerators[0] ?? "",
      generatorFallback: savedGenerators[1] ?? "",
      tailoringJudgeModel: response.settings.tailoringJudgeModel ?? "",
      tailoringJudgeMinScore: response.settings.tailoringJudgeMinScore,
    });
  }, [form, response]);

  const effective = response?.effectiveSettings;
  const editableFieldCount = effective
    ? [
        effective.analysisLegs,
        effective.tailoringGeneratorModels,
        effective.tailoringJudgeModel,
        effective.tailoringJudgeMinScore,
      ].filter((field) => field.editable).length
    : 0;
  const editStatus =
    editableFieldCount === 4
      ? "Editable"
      : editableFieldCount === 0
        ? "Read only"
        : "Partially editable";
  const collapsedSummary = settingsQuery.error
    ? "Policy unavailable"
    : response
      ? `${editStatus} · Primary generator: ${generators[0] ?? "Provider/default policy"}`
      : "Loading policy and saved choices";

  return (
    <DisclosureSection
      className="ai-execution-policy-settings"
      title="AI execution policy"
      description="Analysis perspectives, tailoring generators, and judge policy"
      collapsedSummary={collapsedSummary}
    >
      <div className="ai-execution-policy-settings__content grid gap-4">
        {settingsQuery.error ? (
          <p className="m-0 text-[12px] leading-5 text-destructive" role="alert">
            {settingsQuery.error.message}
          </p>
        ) : null}
        {!response || !effective ? (
          <Empty
            title={
              settingsQuery.error
                ? "AI execution policy is unavailable."
                : "Loading AI execution policy."
            }
          />
        ) : (
          <form
            className="ai-execution-policy-form grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <div className="ai-execution-policy-status grid gap-2">
              <p className="m-0 text-[12px] leading-5 text-muted-foreground">
                Configuration status: {editStatus}.
              </p>
              {status ? (
                <p className="m-0 text-[12px] leading-5 text-muted-foreground" role="status">
                  {status}
                </p>
              ) : null}
              {catalogQuery.error ? (
                <div className="ai-policy-catalog-error flex flex-wrap items-center justify-between gap-3">
                  <p className="m-0 text-[12px] leading-5 text-destructive" role="alert">
                    Available model choices could not be loaded. Saved choices remain visible.
                  </p>
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() => void catalogQuery.refetch()}
                  >
                    Retry catalog
                  </Button>
                </div>
              ) : null}
            </div>

            <form.Field name="analysisLegs">
              {(field) => (
                <FieldSet
                  className="ai-execution-policy-analysis gap-2"
                  aria-describedby="analysis-legs-help"
                >
                  <FieldLegend>Employer analysis perspectives</FieldLegend>
                  <div className="ai-execution-policy-analysis__choices">
                    {LEG_OPTIONS.map((option) => (
                      <ChoiceControl
                        key={option.value}
                        id={`analysis-leg-${option.value}`}
                        name="analysisLegs"
                        label={option.label}
                        disabled={!effective.analysisLegs.editable}
                        checked={field.state.value.includes(option.value)}
                        onCheckedChange={(checked) => {
                          const next = checked === true
                            ? [...field.state.value, option.value]
                            : field.state.value.filter((leg) => leg !== option.value);
                          if (next.length) field.handleChange(next);
                        }}
                      />
                    ))}
                  </div>
                  <FieldDescription id="analysis-legs-help">
                    {context(effective.analysisLegs.source, "next analysis")}
                  </FieldDescription>
                </FieldSet>
              )}
            </form.Field>

            <AdaptiveFieldGrid columns={2} minColumnWidth={300} density="compact">
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
                    onChange={field.handleChange}
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
                    help={`Optional second choice; used after the primary. ${context(
                      effective.tailoringGeneratorModels.source,
                      "next tailoring workflow",
                    )}`}
                    onChange={field.handleChange}
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
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
              <form.Field name="tailoringJudgeMinScore">
                {(field) => (
                  <Field data-disabled={!effective.tailoringJudgeMinScore.editable || undefined}>
                    <FieldLabel htmlFor="tailoring-judge-score">Minimum judge score</FieldLabel>
                    <Input
                      id="tailoring-judge-score"
                      name="tailoringJudgeMinScore"
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      readOnly={!effective.tailoringJudgeMinScore.editable}
                      aria-readonly={!effective.tailoringJudgeMinScore.editable || undefined}
                      aria-describedby="tailoring-judge-score-help"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(Number(event.target.value))}
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
            </AdaptiveFieldGrid>

            <form.Subscribe selector={(state) => state.errors}>
              {(errors) => {
                const message = errors
                  .flat()
                  .filter((entry): entry is string => typeof entry === "string")
                  .at(0);
                return message ? (
                  <p className="m-0 text-[12px] leading-5 text-destructive" role="alert">
                    {message}
                  </p>
                ) : null;
              }}
            </form.Subscribe>
            {updateSettings.error ? (
              <p className="m-0 text-[12px] leading-5 text-destructive" role="alert">
                {updateSettings.error.message}
              </p>
            ) : null}

            <div className="form-actions ai-execution-policy-form__actions">
              <Button
                type="submit"
                disabled={updateSettings.isPending || editableFieldCount === 0}
              >
                {updateSettings.isPending ? "Saving…" : "Save AI policy"}
              </Button>
            </div>
          </form>
        )}
      </div>
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
  const options = [
    { value: DEFAULT_POLICY_OPTION, label: "Provider/default policy" },
    ...(value && !models.some((model) => model.value === value)
      ? [{ value, label: `${value} — saved` }]
      : []),
    ...models,
  ];

  return (
    <SelectField
      id={`ai-policy-${name}`}
      name={name}
      className="ai-execution-policy-model-field"
      label={label}
      description={help}
      disabled={readOnly}
      options={options}
      value={value || DEFAULT_POLICY_OPTION}
      onValueChange={(nextValue) =>
        onChange(nextValue === DEFAULT_POLICY_OPTION ? "" : nextValue)
      }
    />
  );
}

function toSettingsRequest(
  response: SettingsResponse,
  value: AiPolicyFormValues,
): unknown {
  const generatorModels = [value.generatorPrimary, value.generatorFallback].filter(
    (model, index, all) => model && all.indexOf(model) === index,
  );
  return {
    ...(response.effectiveSettings.analysisLegs.editable
      ? { analysisLegs: value.analysisLegs }
      : {}),
    ...(response.effectiveSettings.tailoringGeneratorModels.editable
      ? { tailoringGeneratorModels: generatorModels.length ? generatorModels : null }
      : {}),
    ...(response.effectiveSettings.tailoringJudgeModel.editable
      ? { tailoringJudgeModel: value.tailoringJudgeModel || null }
      : {}),
    ...(response.effectiveSettings.tailoringJudgeMinScore.editable
      ? { tailoringJudgeMinScore: value.tailoringJudgeMinScore }
      : {}),
  };
}

function providerName(provider: ProviderId): string {
  return provider === "google" ? "Google" : provider === "claude" ? "Claude" : "Codex";
}

function context(source: "persisted" | "default", activation: string): string {
  return `${source === "persisted" ? "Saved in config.json" : "Using provider/default policy"}; applies to the ${activation}.`;
}
