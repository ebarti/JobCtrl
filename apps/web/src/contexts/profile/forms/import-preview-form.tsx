import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { IconFileTypePdf } from "@tabler/icons-react";
import { z } from "zod";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
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
import {
  hasCompletedImport,
  useProfileImportStore,
} from "../stores/profile-import-store.js";

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
  const { storage } = usePorts();
  const filename = useProfileImportStore((state) => state.filename);
  const pdfBase64 = useProfileImportStore((state) => state.pdfBase64);
  const importProfile = useProfileImportStore((state) => state.importProfile);
  const importStyle = useProfileImportStore((state) => state.importStyle);
  const setOptions = useProfileImportStore((state) => state.setOptions);
  const storageFailure = useProfileImportStore((state) => state.storageFailure);
  const completedImport = useProfileImportStore(hasCompletedImport);

  const form = useForm({
    defaultValues: { importProfile, importStyle } satisfies PreviewFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const result = PreviewValidator.safeParse(value);
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid options");
      },
    },
    listeners: {
      onChange: ({ formApi }) => {
        const value = formApi.state.values;
        void setOptions(value.importProfile, value.importStyle, storage);
      },
    },
    onSubmit: async ({ value }) => {
      if (!(await setOptions(value.importProfile, value.importStyle, storage)))
        return;
      await navigate({ to: "/profile/import/confirm" });
    },
  });

  if (!filename || !pdfBase64) {
    return (
      <div className="wizard-step resume-import-step resume-import-empty-step">
        <Empty title="Pick a PDF on the previous step before continuing." />
        <div className="form-actions resume-import-actions">
          <Link className={buttonVariants()} to="/profile/import/upload">
            Return to upload
          </Link>
        </div>
      </div>
    );
  }

  if (completedImport) {
    return (
      <div className="wizard-step resume-import-step resume-import-empty-step">
        <Alert role="status">
          <AlertDescription>
            The import request for this PDF already completed. Continue to
            remove the saved PDF without submitting the import again.
          </AlertDescription>
        </Alert>
        <div className="form-actions resume-import-actions">
          <Link className={buttonVariants()} to="/profile/import/confirm">
            Continue to cleanup
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
        <span className="resume-import-step__eyebrow" data-typography="label">
          Preview options
        </span>
        <h2 data-typography="section-title">
          Review the PDF and choose the import scope
        </h2>
        <p data-typography="body">
          The original document stays visible while you decide which sections to
          bring across.
        </p>
      </header>

      {storageFailure ? (
        <Alert className="resume-import-alert" variant="destructive">
          <AlertDescription>
            {storageFailure === "conflict"
              ? "Another tab changed the saved PDF. Return to upload and load the latest saved PDF."
              : storageFailure === "read"
                ? "The saved PDF could not be read from browser storage. Return to upload and retry browser storage before changing options."
                : "The import options could not be saved in browser storage. Check site data permissions or free space, then continue again to retry."}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="resume-import-selected-file">
        <IconFileTypePdf size={22} stroke={1.65} aria-hidden="true" />
        <span>
          <small data-typography="label">Selected PDF</small>
          <strong data-typography="strong-body">{filename}</strong>
        </span>
      </div>

      <FieldSet className="resume-import-option-set">
        <FieldLegend>What should be imported?</FieldLegend>
        <FieldDescription>
          Select at least one section. You can edit the resulting profile after
          import.
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
                  <FieldLabel htmlFor="resume-import-profile-data">
                    Profile data
                  </FieldLabel>
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
                  <FieldLabel htmlFor="resume-import-style-data">
                    Style data
                  </FieldLabel>
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
            .find(
              (entry): entry is string =>
                typeof entry === "string" && entry.length > 0,
            );
          return message ? (
            <Alert className="resume-import-alert" variant="destructive">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null;
        }}
      </form.Subscribe>

      <section
        className="resume-import-document-preview"
        aria-labelledby="resume-import-preview-title"
      >
        <header>
          <div>
            <h3
              id="resume-import-preview-title"
              data-typography="component-title"
            >
              Original PDF
            </h3>
            <p data-typography="body">Inspect every page before continuing.</p>
          </div>
          <span data-typography="metadata">{filename}</span>
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
        selector={(state) => ({
          canSubmit: state.canSubmit,
          isSubmitting: state.isSubmitting,
        })}
      >
        {({ canSubmit, isSubmitting }) => (
          <div className="form-actions resume-import-actions">
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              Continue to confirmation
            </Button>
            <Link
              className={buttonVariants({ variant: "outline" })}
              to="/profile/import/upload"
            >
              Back
            </Link>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
