import { useForm } from "@tanstack/react-form";
import { useId, useState } from "react";
import { z } from "zod";

import { Button } from "../../../shared/ui/button.js";
import { DisclosureSection } from "../../../shared/ui/disclosure-section.js";
import { Input } from "../../../shared/ui/input.js";
import {
  useApplicationSettings,
  useUpdateApplicationSettings,
  type ApplicationSettings,
} from "../../settings/index.js";

const schema = z.object({
  applyMaxBudgetUsd: z.number().min(0).max(10000),
  applyTimeoutSeconds: z.number().int().min(30).max(7200),
});

export function ApplyRuntimeSettingsPanel() {
  const query = useApplicationSettings();
  return (
    <DisclosureSection
      title="Application runtime"
      collapsedSummary="Budget and timeout policy"
      description="Budget and timeout for newly started applications"
    >
      {query.isPending ? (
        <p role="status">Loading application runtime settings…</p>
      ) : null}
      {query.error ? (
        <p role="alert">
          Application runtime settings are unavailable. Saved values remain
          unchanged.
        </p>
      ) : null}
      {query.data ? <RuntimeSettingsForm saved={query.data} /> : null}
    </DisclosureSection>
  );
}

function RuntimeSettingsForm({ saved }: { saved: ApplicationSettings }) {
  const id = useId();
  const update = useUpdateApplicationSettings();
  const [baseline, setBaseline] = useState(saved);
  const [status, setStatus] = useState("");
  const form = useForm({
    defaultValues: {
      applyMaxBudgetUsd: baseline.applyMaxBudgetUsd,
      applyTimeoutSeconds: baseline.applyTimeoutSeconds,
    },
    validators: {
      onSubmit: ({ value }) =>
        schema.safeParse(value).success
          ? undefined
          : "Enter a valid nonnegative budget and a timeout from 30 to 7200 seconds.",
    },
    onSubmit: async ({ value }) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return;
      try {
        const result = await update.mutateAsync({
          expectedRevision: baseline.revision,
          patch: parsed.data,
        });
        setBaseline(result);
        const current = form.state.values;
        const values = {
          applyMaxBudgetUsd: result.applyMaxBudgetUsd,
          applyTimeoutSeconds: result.applyTimeoutSeconds,
        };
        form.reset(values);
        if (current.applyMaxBudgetUsd !== value.applyMaxBudgetUsd)
          form.setFieldValue("applyMaxBudgetUsd", current.applyMaxBudgetUsd);
        if (current.applyTimeoutSeconds !== value.applyTimeoutSeconds)
          form.setFieldValue(
            "applyTimeoutSeconds",
            current.applyTimeoutSeconds,
          );
        setStatus("Application runtime saved for newly started applications.");
      } catch {
        setStatus(
          "Application runtime could not be saved. Your edits remain available. Reload the saved settings before resolving a competing revision.",
        );
      }
    },
  });
  return (
    <form
      className="config-form"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      {saved.revision !== baseline.revision ? (
        <div role="alert">
          <p>
            Saved settings changed while this form was open. Your edits remain
            available.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setBaseline(saved);
              setStatus(
                "Rebased the pending edits onto the current saved settings. Review before saving.",
              );
            }}
          >
            Use current saved revision with pending edits
          </Button>
        </div>
      ) : null}
      <form.Field name="applyMaxBudgetUsd">
        {(field) => (
          <label htmlFor={`${id}-budget`}>
            Maximum AI budget per application (USD)
            <Input
              id={`${id}-budget`}
              type="number"
              min={0}
              max={10000}
              step={0.01}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) =>
                field.handleChange(Number(event.target.value))
              }
            />
            <span>
              Zero is a zero-dollar cap. Changes apply to newly started
              applications.
            </span>
          </label>
        )}
      </form.Field>
      <form.Field name="applyTimeoutSeconds">
        {(field) => (
          <label htmlFor={`${id}-timeout`}>
            Application timeout (seconds)
            <Input
              id={`${id}-timeout`}
              type="number"
              min={30}
              max={7200}
              step={1}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) =>
                field.handleChange(Number(event.target.value))
              }
            />
          </label>
        )}
      </form.Field>
      <form.Subscribe
        selector={(state) => ({ dirty: state.isDirty, errors: state.errors })}
      >
        {({ dirty, errors }) => (
          <>
            {errors.length ? (
              <p role="alert">Enter valid application runtime values.</p>
            ) : null}
            <Button
              type="submit"
              disabled={
                !dirty ||
                update.isPending ||
                saved.revision !== baseline.revision
              }
            >
              {update.isPending
                ? "Saving application runtime…"
                : "Save application runtime"}
            </Button>
          </>
        )}
      </form.Subscribe>
      {status ? <p role={update.error ? "alert" : "status"}>{status}</p> : null}
    </form>
  );
}
