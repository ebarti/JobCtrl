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
import { Textarea } from "../../../shared/ui/textarea.js";
import { useSettingsPolicyQuery } from "../../operations/hooks/useSettingsPolicyQueries.js";
import { useUpdateScoringGuidanceMutation } from "../hooks/useUpdateScoringGuidanceMutation.js";

export function ScoringGuidancePanel() {
  const settingsQuery = useSettingsPolicyQuery();
  const updateSettings = useUpdateScoringGuidanceMutation();
  const [status, setStatus] = useState("");
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
      const saved = await updateSettings.mutateAsync(value);
      formApi.reset({
        scoreCriteria: saved.settings.scoreCriteria,
        targetCriteria: saved.settings.targetCriteria,
      });
      setStatus("Scoring guidance saved for newly started scoring work.");
    },
  });

  useEffect(() => {
    if (response && !form.state.isDirty) {
      form.reset({
        scoreCriteria: response.settings.scoreCriteria,
        targetCriteria: response.settings.targetCriteria,
      });
    }
  }, [form, response]);

  return (
    <DisclosureSection
      className="scoring-guidance-settings"
      title="Scoring guidance"
      description="Priorities and targeting context for newly started scoring work"
      collapsedSummary="Scoring priorities and target role guidance"
    >
      {!response ? (
        <Empty title="Loading scoring guidance." />
      ) : (
        <form
          className="scoring-guidance-form grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          {status ? <div className="status-line" role="status">{status}</div> : null}
          <AdaptiveFieldGrid columns={2} minColumnWidth={320} density="compact">
            <form.Field name="scoreCriteria">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="score-guidance">Scoring priorities</FieldLabel>
                  <Textarea
                    id="score-guidance"
                    name="scoreCriteria"
                    maxLength={8000}
                    aria-describedby="score-guidance-help"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldDescription id="score-guidance-help">
                    What strong-fit jobs should demonstrate. Applies to new scoring work.
                  </FieldDescription>
                </Field>
              )}
            </form.Field>
            <form.Field name="targetCriteria">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="target-guidance">Target role guidance</FieldLabel>
                  <Textarea
                    id="target-guidance"
                    name="targetCriteria"
                    maxLength={8000}
                    aria-describedby="target-guidance-help"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldDescription id="target-guidance-help">
                    Additional role and company targeting guidance.
                  </FieldDescription>
                </Field>
              )}
            </form.Field>
          </AdaptiveFieldGrid>
          <div className="form-actions scoring-guidance-form__actions">
            <Button type="submit" disabled={updateSettings.isPending}>
              {updateSettings.isPending ? "Saving…" : "Save scoring guidance"}
            </Button>
          </div>
        </form>
      )}
    </DisclosureSection>
  );
}
