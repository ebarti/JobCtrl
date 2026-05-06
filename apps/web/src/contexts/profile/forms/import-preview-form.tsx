import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { z } from "zod";

import { Empty } from "../../../shared/ui/empty.js";
import { useProfileImportStore } from "../stores/profile-import-store.js";

interface PreviewFormValues {
  importProfile: boolean;
  importStyle: boolean;
}

const PreviewValidator = z
  .object({
    importProfile: z.boolean(),
    importStyle: z.boolean(),
  })
  .refine((value) => value.importProfile || value.importStyle, {
    message: "Choose at least one section to import.",
  });

export function ImportPreviewForm() {
  const navigate = useNavigate();
  const filename = useProfileImportStore((state) => state.filename);
  const importProfile = useProfileImportStore((state) => state.importProfile);
  const importStyle = useProfileImportStore((state) => state.importStyle);
  const setOptions = useProfileImportStore((state) => state.setOptions);

  const form = useForm({
    defaultValues: { importProfile, importStyle } satisfies PreviewFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const result = PreviewValidator.safeParse(value);
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid options");
      },
    },
    listeners: {
      onChange: ({ formApi }) => {
        const value = formApi.state.values;
        setOptions(value.importProfile, value.importStyle);
      },
    },
    onSubmit: async ({ value }) => {
      setOptions(value.importProfile, value.importStyle);
      await navigate({ to: "/profile/import/confirm" });
    },
  });

  if (!filename) {
    return (
      <div className="wizard-step">
        <Empty title="Pick a PDF on the previous step before continuing." />
        <div className="form-actions">
          <Link className="tab" to="/profile/import/upload">
            back to upload
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form
      className="wizard-step"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <p className="status-line">
        Selected: <b>{filename}</b>
      </p>
      <div className="import-options">
        <form.Field name="importProfile">
          {(field) => (
            <label>
              <input
                type="checkbox"
                checked={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.checked)}
              />
              profile data
            </label>
          )}
        </form.Field>
        <form.Field name="importStyle">
          {(field) => (
            <label>
              <input
                type="checkbox"
                checked={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.checked)}
              />
              style data
            </label>
          )}
        </form.Field>
      </div>
      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <div className="form-actions">
            <button
              type="submit"
              className="tab on"
              disabled={!canSubmit || isSubmitting}
            >
              next
            </button>
            <Link className="tab" to="/profile/import/upload">
              back
            </Link>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
