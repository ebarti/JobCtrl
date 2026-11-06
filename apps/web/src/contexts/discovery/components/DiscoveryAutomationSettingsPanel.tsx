import {
  DiscoverySettingsUpdateRequestSchema,
  type DiscoverySettingsResponse,
  type DiscoverySettingsUpdateRequest,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";

import { AutosaveUndoController } from "../../../shared/ui/autosave-undo-controller.js";
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { useDiscoverySettingsQuery } from "../hooks/useDiscoverySettingsQuery.js";
import { useUpdateDiscoverySettingsMutation } from "../hooks/useUpdateDiscoverySettingsMutation.js";

type AutomationValues = Pick<
  DiscoverySettingsUpdateRequest,
  "autoApply" | "minFitScore"
>;

function toFormValues(response: DiscoverySettingsResponse): AutomationValues {
  return {
    autoApply: response.settings.autoApply,
    minFitScore: response.settings.minFitScore,
  };
}

export function DiscoveryAutomationSettingsPanel() {
  const settingsQuery = useDiscoverySettingsQuery();

  return (
    <DisclosureSection
      className="discovery-automation-settings"
      collapsedSummary="SQLite-backed scoring and apply controls"
      description="Scoring threshold and supervised apply policy"
      title="Automation settings"
    >
      {settingsQuery.error ? (
        <Alert className="inline" variant="destructive">
          <AlertDescription>{settingsQuery.error.message}</AlertDescription>
        </Alert>
      ) : null}
      {settingsQuery.data ? (
        <DiscoveryAutomationSettingsForm initial={settingsQuery.data} />
      ) : settingsQuery.isPending ? (
        <Empty title="Loading automation settings." />
      ) : null}
    </DisclosureSection>
  );
}

export function DiscoveryAutomationSettingsForm({
  initial,
}: {
  initial: DiscoverySettingsResponse;
}) {
  const updateSettings = useUpdateDiscoverySettingsMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const [resetToken, setResetToken] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const form = useForm({
    defaultValues: toFormValues(initial),
    validators: {
      onSubmit: ({ value }) => {
        const result = DiscoverySettingsUpdateRequestSchema.safeParse(value);
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid automation settings");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      setStatusMessage("");
      const submittedValues = JSON.stringify(value);
      const response = await updateSettings.mutateAsync(value);
      if (JSON.stringify(formApi.state.values) === submittedValues) {
        formApi.reset(toFormValues(response));
        setStatusMessage("Automation settings saved in SQLite");
      } else {
        setStatusMessage("Saved; newer changes pending");
      }
    },
  });

  useEffect(() => {
    if (form.state.isDirty || form.state.isSubmitting) return;
    form.reset(toFormValues(initial));
    setResetToken((token) => token + 1);
  }, [form, initial]);

  return (
    <form
      className="config-form discovery-automation-settings-form"
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
      {statusMessage ? (
        <div className="status-line" data-typography="metadata" role="status">
          {statusMessage}
        </div>
      ) : null}
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
          <Field className="field">
            <FieldLabel htmlFor="discovery-minimum-fit-score">
              Minimum fit score
            </FieldLabel>
            <Input
              id="discovery-minimum-fit-score"
              type="number"
              min={1}
              max={10}
              step={1}
              value={field.state.value ?? 1}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(Number(event.target.value))}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="autoApply">
        {(field) => (
          <Field className="field check" orientation="horizontal">
            <Checkbox
              aria-describedby="discovery-auto-apply-help"
              checked={field.state.value ?? false}
              id="discovery-auto-apply"
              onCheckedChange={(checked) => field.handleChange(checked)}
            />
            <FieldContent>
              <FieldLabel htmlFor="discovery-auto-apply">Auto apply</FieldLabel>
              <FieldDescription id="discovery-auto-apply-help">
                Keep one standing apply loop running for eligible prepared jobs.
              </FieldDescription>
            </FieldContent>
          </Field>
        )}
      </form.Field>
      <p>Live submissions require approval for the exact application payload. This approval cannot be disabled.</p>
      <form.Subscribe
        selector={(state) => ({
          autoApply: state.values.autoApply,
        })}
      >
        {({ autoApply }) => {
          const summary = applyAutomationSummary(Boolean(autoApply));
          if (summary.warning) {
            return (
              <Alert variant="warning">
                <AlertDescription>{summary.text}</AlertDescription>
              </Alert>
            );
          }
          return (
            <div
              className="status-line info"
              data-typography="body"
              role="status"
              aria-label="Automation policy summary"
            >
              {summary.text}
            </div>
          );
        }}
      </form.Subscribe>
      <form.Subscribe
        selector={(state) => ({
          canSubmit: state.canSubmit,
          isSubmitting: state.isSubmitting,
          isDirty: state.isDirty,
        })}
      >
        {({ canSubmit, isSubmitting, isDirty }) =>
          isDirty || isSubmitting ? (
            <div className="form-actions" data-state="dirty">
              <span data-typography="metadata" role="status">
                {isSubmitting ? "Saving changes" : "Unsaved changes"}
              </span>
              <Button type="submit" disabled={!canSubmit || isSubmitting}>
                {isSubmitting ? "Saving changes" : "Save changes"}
              </Button>
              <Button type="reset" variant="secondary" disabled={isSubmitting}>
                Discard changes
              </Button>
            </div>
          ) : null
        }
      </form.Subscribe>
      {updateSettings.error ? (
        <Alert className="inline" variant="destructive">
          <AlertDescription>{updateSettings.error.message}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}

function applyAutomationSummary(autoApply: boolean): { text: string; warning: boolean } {
  if (autoApply) {
    return {
      text: "Auto apply is supervised: the standing loop polls eligible jobs, browser forms stop for manual completion, and exact-approved email applications may use the owned sender.",
      warning: false,
    };
  }
  return {
    text: "Default supervised mode: no standing apply loop runs, live claims require Apply Review approval, and browser final submit stays manual.",
    warning: false,
  };
}
