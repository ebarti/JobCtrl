import { SettingsUpdateRequestSchema } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

import { Button } from "../../../shared/ui/button.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Field,
  FieldDescription,
} from "../../../shared/ui/field.js";
import {
  SettingLabelWithHelp,
  type SettingHelpContent,
} from "../../../shared/ui/setting-help.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { useSettingsPolicyQuery } from "../../operations/hooks/useSettingsPolicyQueries.js";
import { useUpdateScoringGuidanceMutation } from "../hooks/useUpdateScoringGuidanceMutation.js";

const SCORING_GUIDE_URL = "https://jobctrl.dev/user/scoring-and-employer-analysis";
const SCORING_SETTING_HELP = {
  scoreCriteria: {
    title: "Scoring priorities",
    description:
      "Add guidance describing what strong-fit jobs should demonstrate. It affects newly started scoring work and does not become candidate evidence.",
    href: `${SCORING_GUIDE_URL}#runtime-setting-scoring-priorities`,
  },
  targetCriteria: {
    title: "Target role guidance",
    description:
      "Add role or company guidance for subsequent scoring runs. This supplements, but does not replace, Discovery target-search titles.",
    href: `${SCORING_GUIDE_URL}#runtime-setting-target-role-guidance`,
  },
} satisfies Record<string, SettingHelpContent>;

export function ScoringGuidancePanel() {
  const settingsQuery = useSettingsPolicyQuery();
  const updateSettings = useUpdateScoringGuidanceMutation();
  const [status, setStatus] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const response = settingsQuery.data;
  const form = useForm({
    defaultValues: {
      scoreCriteria: response?.settings.scoreCriteria ?? "",
      targetCriteria: response?.settings.targetCriteria ?? "",
    },
    validators: {
      onSubmit: ({ value }) =>
        SettingsUpdateRequestSchema.safeParse(value).success
          ? undefined
          : "Scoring guidance is too long",
    },
    onSubmit: async ({ value, formApi }) => {
      setStatus(null);
      try {
        const saved = await updateSettings.mutateAsync(value);
        formApi.reset({
          scoreCriteria: saved.settings.scoreCriteria,
          targetCriteria: saved.settings.targetCriteria,
        });
        setStatus({
          kind: "success",
          message: "Scoring guidance saved for newly started scoring work.",
        });
      } catch {
        setStatus({
          kind: "error",
          message:
            "Scoring guidance could not be saved. Review the fields and try again.",
        });
      }
    },
  });
  useEffect(() => {
    if (response && !form.state.isDirty)
      form.reset({
        scoreCriteria: response.settings.scoreCriteria,
        targetCriteria: response.settings.targetCriteria,
      });
  }, [form, response]);
  if (!response)
    return (
      <DisclosureSection
        className="scoring-guidance-settings"
        collapsedSummary="Fit and targeting guidance"
        defaultOpen={false}
        description="Instructions used by newly started scoring work"
        title="Scoring guidance"
      >
        <Empty title="Loading scoring guidance" />
      </DisclosureSection>
    );
  return (
    <DisclosureSection
      className="scoring-guidance-settings"
      collapsedSummary="Fit and targeting guidance"
      defaultOpen={false}
      description="Instructions used by newly started scoring work"
      title="Scoring guidance"
    >
      <form
        className="config-form"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        onReset={(event) => {
          event.preventDefault();
          form.reset({
            scoreCriteria: response.settings.scoreCriteria,
            targetCriteria: response.settings.targetCriteria,
          });
          setStatus(null);
        }}
      >
        {status ? (
          <div
            className="status-line"
            role={status.kind === "error" ? "alert" : "status"}
          >
            {status.message}
          </div>
        ) : null}
        <form.Field name="scoreCriteria">
          {(field) => (
            <Field className="field">
              <SettingLabelWithHelp
                help={SCORING_SETTING_HELP.scoreCriteria}
                htmlFor="score-guidance"
              >
                Scoring priorities
              </SettingLabelWithHelp>
              <Textarea
                id="score-guidance"
                name="scoreCriteria"
                maxLength={8000}
                aria-describedby="score-guidance-help"
                value={field.state.value}
                onChange={(event) => {
                  setStatus(null);
                  field.handleChange(event.target.value);
                }}
              />
              <FieldDescription id="score-guidance-help">
                What strong-fit jobs should demonstrate. Applies to new scoring
                work.
              </FieldDescription>
            </Field>
          )}
        </form.Field>
        <form.Field name="targetCriteria">
          {(field) => (
            <Field className="field">
              <SettingLabelWithHelp
                help={SCORING_SETTING_HELP.targetCriteria}
                htmlFor="target-guidance"
              >
                Target role guidance
              </SettingLabelWithHelp>
              <Textarea
                id="target-guidance"
                name="targetCriteria"
                maxLength={8000}
                aria-describedby="target-guidance-help"
                value={field.state.value}
                onChange={(event) => {
                  setStatus(null);
                  field.handleChange(event.target.value);
                }}
              />
              <FieldDescription id="target-guidance-help">
                Additional role and company targeting guidance.
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
                disabled={!canSubmit || !isDirty || isSubmitting}
              >
                {isSubmitting
                  ? "Saving scoring guidance"
                  : "Save scoring guidance"}
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
