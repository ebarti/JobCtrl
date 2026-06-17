import {
  SettingsUpdateRequestSchema,
  type SettingsUpdateRequest,
} from "@jobhunter/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";

import type { DashboardSettings } from "../../operations/types.js";
import { useUpdateSettingsMutation } from "../hooks/useUpdateSettingsMutation.js";
import { AutosaveUndoController } from "./autosave-undo-controller.js";

export interface SettingsFormProps {
  initial: DashboardSettings;
}

type SettingsFormValues = Omit<SettingsUpdateRequest, "locationFilter">;

interface ScoringRubricOption {
  value: string;
  label: string;
  criteria: string;
  aliases: readonly string[];
}

interface ScoringRubricValues {
  company: string;
  exclusions: string[];
  priorities: string[];
  seniority: string;
  stretch: string;
}

const PRIORITY_OPTIONS: readonly ScoringRubricOption[] = [
  {
    value: "role_alignment",
    label: "Role alignment",
    criteria: "Prioritize close alignment with the target role scope and responsibilities.",
    aliases: ["role alignment", "target role", "role scope"],
  },
  {
    value: "technical_depth",
    label: "Technical depth",
    criteria: "Prioritize hands-on technical depth, architecture ownership, and implementation credibility.",
    aliases: ["technical depth", "architecture", "hands-on", "implementation"],
  },
  {
    value: "leadership_scope",
    label: "Leadership scope",
    criteria: "Prioritize engineering leadership scope, team ownership, hiring, mentoring, and cross-functional influence.",
    aliases: ["leadership", "team leadership", "manager", "mentoring", "cross-functional"],
  },
  {
    value: "platform_reliability",
    label: "Platform reliability",
    criteria: "Prioritize platform reliability, infrastructure scale, developer experience, and operational ownership.",
    aliases: ["platform", "reliability", "infrastructure", "developer experience", "operations"],
  },
  {
    value: "security_compliance",
    label: "Security and compliance",
    criteria: "Prioritize security, privacy, compliance, risk reduction, and governance responsibilities.",
    aliases: ["security", "privacy", "compliance", "governance", "risk"],
  },
  {
    value: "business_impact",
    label: "Business impact",
    criteria: "Prioritize measurable business impact, product outcomes, cost reduction, and execution ownership.",
    aliases: ["business impact", "product", "cost", "outcomes", "execution"],
  },
] as const;

const SENIORITY_OPTIONS: readonly ScoringRubricOption[] = [
  {
    value: "flexible",
    label: "Flexible",
    criteria: "Allow adjacent seniority when responsibilities and fit are otherwise strong.",
    aliases: ["flexible", "adjacent seniority"],
  },
  {
    value: "current_or_above",
    label: "Current level or above",
    criteria: "Penalize roles below the candidate's current scope; prefer equivalent or larger ownership.",
    aliases: ["current level", "above", "larger ownership", "senior"],
  },
  {
    value: "director_plus",
    label: "Director+",
    criteria: "Prioritize Director, Head of, VP, or equivalent strategic leadership roles.",
    aliases: ["director", "director-plus", "director+", "head of", "vp", "strategic leadership"],
  },
  {
    value: "executive",
    label: "Executive",
    criteria: "Prioritize executive or head-of-function roles with broad organizational accountability.",
    aliases: ["executive", "cto", "ciso", "head-of-function"],
  },
] as const;

const STRETCH_OPTIONS: readonly ScoringRubricOption[] = [
  {
    value: "conservative",
    label: "Conservative",
    criteria: "Favor direct matches and penalize missing must-have requirements.",
    aliases: ["conservative", "direct matches", "must-have"],
  },
  {
    value: "balanced",
    label: "Balanced",
    criteria: "Balance direct matches with selective stretch roles when transferable evidence is strong.",
    aliases: ["balanced", "selective stretch", "transferable"],
  },
  {
    value: "stretch",
    label: "Open to stretch",
    criteria: "Allow stretch roles when leadership, domain, or adjacent technical evidence is credible.",
    aliases: ["stretch", "adjacent", "credible"],
  },
] as const;

const COMPANY_OPTIONS: readonly ScoringRubricOption[] = [
  {
    value: "any",
    label: "No company preference",
    criteria: "Do not apply an extra company-stage preference.",
    aliases: ["no company preference", "any company"],
  },
  {
    value: "startup_scaleup",
    label: "Startup / scale-up",
    criteria: "Favor startup or scale-up environments with broad ownership and fast execution.",
    aliases: ["startup", "scale-up", "scaleup", "fast execution"],
  },
  {
    value: "enterprise",
    label: "Enterprise scale",
    criteria: "Favor mature organizations with large-scale systems and cross-team coordination.",
    aliases: ["enterprise", "large-scale", "cross-team"],
  },
  {
    value: "regulated",
    label: "Regulated / high-security",
    criteria: "Favor regulated, high-security, privacy-sensitive, or compliance-heavy environments.",
    aliases: ["regulated", "high-security", "privacy-sensitive", "compliance-heavy"],
  },
  {
    value: "product_platform",
    label: "Product / platform company",
    criteria: "Favor product-led technology or platform organizations over generic services work.",
    aliases: ["product-led", "platform organization", "technology company"],
  },
] as const;

const EXCLUSION_OPTIONS: readonly ScoringRubricOption[] = [
  {
    value: "junior_roles",
    label: "Exclude junior roles",
    criteria: "Exclude junior, entry-level, internship, or trainee roles.",
    aliases: ["junior", "entry-level", "internship", "trainee"],
  },
  {
    value: "onsite_only",
    label: "Exclude onsite-only",
    criteria: "Exclude onsite-only roles when the target work model is remote or hybrid.",
    aliases: ["onsite-only", "on-site only", "office-only"],
  },
  {
    value: "sales_quota",
    label: "Exclude sales quota roles",
    criteria: "Exclude quota-carrying sales, pure business development, or recruiter roles.",
    aliases: ["quota", "sales", "business development", "recruiter"],
  },
  {
    value: "short_contract",
    label: "Exclude short contracts",
    criteria: "Exclude short-term contract-only roles unless the rest of the match is exceptional.",
    aliases: ["short-term", "contract-only", "short contract"],
  },
] as const;

const DEFAULT_RUBRIC: ScoringRubricValues = {
  company: "any",
  exclusions: [],
  priorities: [],
  seniority: "flexible",
  stretch: "balanced",
};

function toFormValues(values: DashboardSettings): SettingsFormValues {
  const scoringRubric = parseScoringRubric(values.scoreCriteria, values.targetCriteria);
  return {
    minFitScore: values.minFitScore,
    autoApply: values.autoApply,
    applyConcurrency: values.applyConcurrency,
    targetRole: values.targetRole,
    scoreCriteria: buildScoreCriteriaText(scoringRubric),
    targetCriteria: buildTargetCriteriaText(scoringRubric),
  };
}

function serializeSettingsValues(values: SettingsFormValues): string {
  return JSON.stringify(values);
}

export function SettingsForm({ initial }: SettingsFormProps) {
  const updateSettings = useUpdateSettingsMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const [resetToken, setResetToken] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  const form = useForm({
    defaultValues: toFormValues(initial),
    validators: {
      onSubmit: ({ value }) => {
        const result = SettingsUpdateRequestSchema.safeParse(value);
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid settings");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const submittedValues = serializeSettingsValues(value);
      const response = await updateSettings.mutateAsync(value);
      if (serializeSettingsValues(formApi.state.values) === submittedValues) {
        formApi.reset(toFormValues(response.settings));
        setStatusMessage("settings saved");
      } else {
        setStatusMessage("saved; newer changes pending");
      }
    },
  });

  useEffect(() => {
    if (form.state.isDirty || form.state.isSubmitting) {
      return;
    }
    form.reset(toFormValues(initial));
    setResetToken((token) => token + 1);
  }, [form, initial]);

  return (
    <form
      className="config-form"
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
      onReset={(event) => {
        event.preventDefault();
        form.reset(toFormValues(initial));
        setResetToken((token) => token + 1);
        setStatusMessage("");
      }}
    >
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      <form.Subscribe
        selector={(state) => ({
          isDirty: state.isDirty,
          isSubmitting: state.isSubmitting,
          values: state.values,
        })}
      >
        {({ isDirty, isSubmitting, values }) => (
          <AutosaveUndoController
            formRef={formRef}
            isDirty={isDirty}
            isSubmitting={isSubmitting}
            resetToken={resetToken}
            restoreValues={(nextValues) => form.reset(nextValues, { keepDefaultValues: true })}
            setStatusMessage={setStatusMessage}
            submit={() => form.handleSubmit()}
            values={values}
          />
        )}
      </form.Subscribe>
      <form.Field name="minFitScore">
        {(field) => (
          <label className="field">
            <span>Minimum fit score</span>
            <input
              type="number"
              min={0}
              max={10}
              step={1}
              value={field.state.value ?? 0}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(Number(event.target.value))}
            />
          </label>
        )}
      </form.Field>
      <form.Field name="applyConcurrency">
        {(field) => (
          <label className="field">
            <span>Apply concurrency</span>
            <input
              type="number"
              min={1}
              max={16}
              step={1}
              value={field.state.value ?? 1}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(Number(event.target.value))}
            />
          </label>
        )}
      </form.Field>
      <form.Field name="targetRole">
        {(field) => (
          <label className="field">
            <span>Target role</span>
            <input
              value={field.state.value ?? ""}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      <form.Field name="scoreCriteria">
        {(scoreCriteriaField) => (
          <form.Field name="targetCriteria">
            {(targetCriteriaField) => (
              <ScoringCriteriaControls
                scoreCriteria={scoreCriteriaField.state.value ?? ""}
                targetCriteria={targetCriteriaField.state.value ?? ""}
                onChange={(nextRubric) => {
                  scoreCriteriaField.handleChange(buildScoreCriteriaText(nextRubric));
                  targetCriteriaField.handleChange(buildTargetCriteriaText(nextRubric));
                }}
              />
            )}
          </form.Field>
        )}
      </form.Field>
      <form.Field name="autoApply">
        {(field) => (
          <label className="field check">
            <input
              type="checkbox"
              checked={field.state.value ?? false}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.checked)}
            />
            <span>Auto apply</span>
          </label>
        )}
      </form.Field>
      <form.Subscribe
        selector={(state) => ({
          canSubmit: state.canSubmit,
          isSubmitting: state.isSubmitting,
          isDirty: state.isDirty,
        })}
      >
        {({ canSubmit, isSubmitting, isDirty }) => (
          <div className="form-actions">
            <button
              className="tab on"
              type="submit"
              disabled={!canSubmit || !isDirty || isSubmitting}
            >
              {isSubmitting ? "saving" : "save"}
            </button>
            <button
              className="tab"
              type="reset"
              disabled={!isDirty || isSubmitting}
            >
              reset
            </button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

function ScoringCriteriaControls({
  scoreCriteria,
  targetCriteria,
  onChange,
}: {
  scoreCriteria: string;
  targetCriteria: string;
  onChange: (nextRubric: ScoringRubricValues) => void;
}) {
  const rubric = parseScoringRubric(scoreCriteria, targetCriteria);
  const setRubric = (patch: Partial<ScoringRubricValues>) => onChange({ ...rubric, ...patch });
  const toggleArrayValue = (values: string[], optionValue: string, checked: boolean) =>
    checked ? [...values, optionValue] : values.filter((value) => value !== optionValue);

  return (
    <fieldset className="field wide scoring-rubric-field">
      <legend>Scoring rubric</legend>
      <div className="scoring-rubric-grid">
        <fieldset className="checkbox-group-field scoring-rubric-priorities">
          <legend>Ranking priorities</legend>
          <div className="checkbox-options">
            {PRIORITY_OPTIONS.map((option) => (
              <label className="choice target-choice" key={option.value}>
                <input
                  type="checkbox"
                  checked={rubric.priorities.includes(option.value)}
                  onChange={(event) =>
                    setRubric({
                      priorities: toggleArrayValue(rubric.priorities, option.value, event.target.checked),
                    })
                  }
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span>Seniority bar</span>
          <select
            value={rubric.seniority}
            onChange={(event) => setRubric({ seniority: event.target.value })}
          >
            {SENIORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Stretch tolerance</span>
          <select
            value={rubric.stretch}
            onChange={(event) => setRubric({ stretch: event.target.value })}
          >
            {STRETCH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Company context</span>
          <select
            value={rubric.company}
            onChange={(event) => setRubric({ company: event.target.value })}
          >
            {COMPANY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="checkbox-group-field scoring-rubric-exclusions">
          <legend>Exclusions</legend>
          <div className="checkbox-options">
            {EXCLUSION_OPTIONS.map((option) => (
              <label className="choice target-choice" key={option.value}>
                <input
                  type="checkbox"
                  checked={rubric.exclusions.includes(option.value)}
                  onChange={(event) =>
                    setRubric({
                      exclusions: toggleArrayValue(rubric.exclusions, option.value, event.target.checked),
                    })
                  }
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </fieldset>
  );
}

export function parseScoringRubric(scoreCriteria: string, targetCriteria = ""): ScoringRubricValues {
  const combinedText = `${scoreCriteria}\n${targetCriteria}`.toLowerCase();
  const priorities = PRIORITY_OPTIONS.filter((option) => textMatchesOption(combinedText, option)).map(
    (option) => option.value,
  );
  const exclusions = EXCLUSION_OPTIONS.filter((option) => textMatchesOption(combinedText, option)).map(
    (option) => option.value,
  );
  return {
    company: firstMatchingValue(combinedText, COMPANY_OPTIONS, DEFAULT_RUBRIC.company),
    exclusions,
    priorities,
    seniority: firstMatchingValue(combinedText, SENIORITY_OPTIONS, DEFAULT_RUBRIC.seniority),
    stretch: firstMatchingValue(combinedText, STRETCH_OPTIONS, DEFAULT_RUBRIC.stretch),
  };
}

export function buildScoreCriteriaText(rubric: ScoringRubricValues): string {
  const priorities = optionCriteria(PRIORITY_OPTIONS, rubric.priorities);
  const seniority = optionCriteria(SENIORITY_OPTIONS, [rubric.seniority]);
  const stretch = optionCriteria(STRETCH_OPTIONS, [rubric.stretch]);
  const company = optionCriteria(COMPANY_OPTIONS, [rubric.company]);
  return [
    priorities.length
      ? `Ranking priorities: ${priorities.join(" ")}`
      : "Ranking priorities: Use the default score dimensions without extra emphasis.",
    `Seniority bar: ${seniority.join(" ")}`,
    `Stretch tolerance: ${stretch.join(" ")}`,
    `Company context: ${company.join(" ")}`,
  ].join("\n");
}

export function buildTargetCriteriaText(rubric: ScoringRubricValues): string {
  const exclusions = optionCriteria(EXCLUSION_OPTIONS, rubric.exclusions);
  return exclusions.length
    ? `Scoring exclusions: ${exclusions.join(" ")}`
    : "Scoring exclusions: No additional rubric exclusions selected.";
}

function firstMatchingValue(
  text: string,
  options: readonly ScoringRubricOption[],
  fallback: string,
): string {
  return (
    options.find((option) => matchesNeedle(text, option.criteria))?.value ??
    options.find((option) => textMatchesOption(text, option))?.value ??
    fallback
  );
}

function optionCriteria(options: readonly ScoringRubricOption[], values: string[]): string[] {
  const selected = new Set(values);
  return options.filter((option) => selected.has(option.value)).map((option) => option.criteria);
}

function textMatchesOption(text: string, option: ScoringRubricOption): boolean {
  return (
    matchesNeedle(text, option.criteria) ||
    [option.label, ...option.aliases].some((needle) => matchesNeedle(text, needle))
  );
}

function matchesNeedle(text: string, needle: string): boolean {
  const normalizedNeedle = needle.trim().toLowerCase();
  if (!normalizedNeedle) {
    return false;
  }
  const escapedNeedle = normalizedNeedle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = /^[a-z0-9]/.test(normalizedNeedle) ? "\\b" : "";
  const suffix = /[a-z0-9]$/.test(normalizedNeedle) ? "\\b" : "";
  return new RegExp(`${prefix}${escapedNeedle}${suffix}`).test(text);
}
