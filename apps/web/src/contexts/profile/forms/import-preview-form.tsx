import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { IconFileTypePdf } from "@tabler/icons-react";
import { z } from "zod";

import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { Button, buttonVariants } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../shared/ui/field.js";
import { PdfPreviewViewer } from "../../../shared/ui/PdfPreviewViewer.js";
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
  const pdfBase64 = useProfileImportStore((state) => state.pdfBase64);
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

  if (!filename || !pdfBase64) {
    return (
      <div className="wizard-step resume-import-step resume-import-empty-step">
        <Empty title="Pick a PDF on the previous step before continuing." />
        <div className="form-actions resume-import-actions">
          <Link
            className={buttonVariants({ variant: "outline" })}
            to="/profile/import/upload"
          >
            Back to upload
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form
      className="wizard-step resume-import-step resume-import-step--preview"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <header className="resume-import-step__header">
        <span className="resume-import-step__eyebrow">Preview options</span>
        <h2>Review the PDF and choose the import scope</h2>
        <p>The original document stays visible while you decide which sections to bring across.</p>
      </header>

      <div className="resume-import-selected-file">
        <IconFileTypePdf size={22} stroke={1.65} aria-hidden="true" />
        <span>
          <small>Selected PDF</small>
          <strong>{filename}</strong>
        </span>
      </div>

      <FieldSet className="resume-import-option-set">
        <FieldLegend>What should be imported?</FieldLegend>
        <FieldDescription>
          Select at least one section. You can edit the resulting profile after import.
        </FieldDescription>
        <FieldGroup className="import-options resume-import-options">
          <form.Field name="importProfile">
            {(field) => (
              <Field orientation="horizontal" className="resume-import-option">
                <Checkbox
                  id="resume-import-profile-data"
                  checked={field.state.value}
                  onBlur={field.handleBlur}
                  onCheckedChange={(checked) => field.handleChange(checked)}
                />
                <FieldContent>
                  <FieldLabel htmlFor="resume-import-profile-data">Profile data</FieldLabel>
                  <FieldDescription>
                    Canonical profile fields parsed from the source resume.
                  </FieldDescription>
                </FieldContent>
              </Field>
            )}
          </form.Field>
          <form.Field name="importStyle">
            {(field) => (
              <Field orientation="horizontal" className="resume-import-option">
                <Checkbox
                  id="resume-import-style-data"
                  checked={field.state.value}
                  onBlur={field.handleBlur}
                  onCheckedChange={(checked) => field.handleChange(checked)}
                />
                <FieldContent>
                  <FieldLabel htmlFor="resume-import-style-data">Style data</FieldLabel>
                  <FieldDescription>
                    Resume rendering style parsed from the source document.
                  </FieldDescription>
                </FieldContent>
              </Field>
            )}
          </form.Field>
        </FieldGroup>
      </FieldSet>

      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors
            .flat()
            .find((entry): entry is string => typeof entry === "string" && entry.length > 0);
          return message ? (
            <Alert className="resume-import-alert" variant="destructive">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null;
        }}
      </form.Subscribe>

      <section className="resume-import-document-preview" aria-labelledby="resume-import-preview-title">
        <header>
          <div>
            <h3 id="resume-import-preview-title">Original PDF</h3>
            <p>Inspect every page before continuing.</p>
          </div>
          <span>{filename}</span>
        </header>
        <div className="resume-import-document-preview__viewer">
          <PdfPreviewViewer
            url={`data:application/pdf;base64,${pdfBase64}`}
            cacheKey={filename}
            title="Uploaded resume"
            loadingTitle="Preparing resume preview"
            loadingMessage="Rendering the selected PDF."
            pageAltPrefix="Uploaded resume"
            openLabel="Open original PDF"
          />
        </div>
      </section>

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <div className="form-actions resume-import-actions">
            <Link
              className={buttonVariants({ variant: "outline" })}
              to="/profile/import/upload"
            >
              Back
            </Link>
            <Button
              type="submit"
              disabled={!canSubmit || isSubmitting}
            >
              Continue to confirmation
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
