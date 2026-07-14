import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { IconFileTypePdf } from "@tabler/icons-react";
import { z } from "zod";

import { Button } from "../../../shared/ui/button.js";
import { ChoiceControl } from "../../../shared/ui/choice-control.js";
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
      <div className="wizard-step resume-import-step grid gap-4">
        <Empty title="Pick a PDF on the previous step before continuing." />
        <div className="form-actions resume-import-actions justify-end">
          <Button asChild variant="outline">
            <Link to="/profile/import/upload">Back to upload</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="wizard-step resume-import-step resume-import-preview grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <div
        className="resume-import-file-summary flex items-center gap-3 border-y border-border py-3"
      >
        <IconFileTypePdf
          className="shrink-0 text-muted-foreground"
          aria-hidden="true"
          size={24}
          stroke={1.7}
        />
        <div className="resume-import-file-summary__copy grid min-w-0 gap-0.5">
          <span className="text-[11px] font-medium text-muted-foreground">Selected PDF</span>
          <strong className="break-all text-[12px]">{filename}</strong>
        </div>
      </div>
      <fieldset className="import-options resume-import-options m-0 min-w-0">
        <legend className="px-1 text-[11px] font-bold text-muted-foreground">
          Sections to import
        </legend>
        <form.Field name="importProfile">
          {(field) => (
            <ChoiceControl
              name="importProfile"
              label="Profile data"
              checked={field.state.value}
              onBlur={field.handleBlur}
              onCheckedChange={(checked) => field.handleChange(checked === true)}
            />
          )}
        </form.Field>
        <form.Field name="importStyle">
          {(field) => (
            <ChoiceControl
              name="importStyle"
              label="Style data"
              checked={field.state.value}
              onBlur={field.handleBlur}
              onCheckedChange={(checked) => field.handleChange(checked === true)}
            />
          )}
        </form.Field>
      </fieldset>
      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors
            .flat()
            .filter((entry): entry is string => typeof entry === "string")
            .at(0);
          return message ? <div className="banner inline" role="alert">{message}</div> : null;
        }}
      </form.Subscribe>
      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <div className="form-actions resume-import-actions justify-end">
            <Button asChild variant="outline">
              <Link to="/profile/import/upload">Back</Link>
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || isSubmitting}
            >
              Next
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
