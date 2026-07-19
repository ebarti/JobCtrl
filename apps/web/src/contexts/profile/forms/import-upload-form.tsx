import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { IconFileTypePdf } from "@tabler/icons-react";
import { useState } from "react";
import { z } from "zod";

import { fileToBase64 } from "../../../shared/lib/file.js";
import { Alert, AlertDescription } from "../../../shared/ui/alert.js";
import { Button, buttonVariants } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import {
  hasProfileImportUpload,
  useProfileImportStore,
} from "../stores/profile-import-store.js";

interface UploadFormValues {
  filename: string;
  pdfBase64: string;
}

const UploadValidator = z.object({
  filename: z
    .string()
    .trim()
    .min(1, "Choose a PDF before continuing.")
    .max(260),
  pdfBase64: z.string().min(1, "Choose a PDF before continuing."),
});

export function ImportUploadForm() {
  const navigate = useNavigate();
  const initialFilename = useProfileImportStore((state) => state.filename);
  const initialPdf = useProfileImportStore((state) => state.pdfBase64);
  const setUpload = useProfileImportStore((state) => state.setUpload);
  const reset = useProfileImportStore((state) => state.reset);

  const [readError, setReadError] = useState("");
  const [reading, setReading] = useState(false);

  const form = useForm({
    defaultValues: {
      filename: initialFilename,
      pdfBase64: initialPdf,
    } satisfies UploadFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const result = UploadValidator.safeParse(value);
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid upload");
      },
    },
    onSubmit: async ({ value }) => {
      setUpload(value.filename, value.pdfBase64);
      await navigate({ to: "/profile/import/preview" });
    },
  });

  const handleFile = async (file: File | null) => {
    setReadError("");
    if (!file) {
      reset();
      form.setFieldValue("filename", "");
      form.setFieldValue("pdfBase64", "");
      return;
    }
    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      reset();
      form.setFieldValue("filename", "");
      form.setFieldValue("pdfBase64", "");
      setReadError("Choose a PDF file.");
      return;
    }
    setReading(true);
    try {
      const pdfBase64 = await fileToBase64(file);
      form.setFieldValue("filename", file.name);
      form.setFieldValue("pdfBase64", pdfBase64);
      setUpload(file.name, pdfBase64);
    } catch (requestError) {
      setReadError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to read PDF.",
      );
    } finally {
      setReading(false);
    }
  };

  return (
    <form
      className="wizard-step resume-import-step resume-import-step--upload"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <header className="resume-import-step__header">
        <span className="resume-import-step__eyebrow" data-typography="label">
          Upload PDF
        </span>
        <h2 data-typography="section-title">Choose your source resume</h2>
        <p data-typography="body">
          Select the PDF you want to inspect before deciding which information
          to import.
        </p>
      </header>

      {readError ? (
        <Alert className="resume-import-alert" variant="destructive">
          <AlertDescription>{readError}</AlertDescription>
        </Alert>
      ) : null}

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

      <form.Field name="filename">
        {(field) => (
          <label
            className="import-target resume-import-target"
            data-ready={Boolean(field.state.value) || undefined}
            aria-busy={reading}
          >
            <span className="resume-import-target__icon" aria-hidden="true">
              <IconFileTypePdf size={30} stroke={1.65} />
            </span>
            <span className="resume-import-target__copy">
              <b data-typography="strong-body">
                {field.state.value ? "PDF selected" : "Choose a resume PDF"}
              </b>
              <small data-typography="metadata" aria-live="polite">
                {reading
                  ? "Reading the selected file…"
                  : field.state.value || "PDF files only"}
              </small>
            </span>
            <Input
              aria-label="Resume PDF"
              type="file"
              accept="application/pdf"
              onChange={(event) =>
                void handleFile(event.target.files?.[0] ?? null)
              }
            />
            <span
              className="resume-import-target__action"
              data-typography="control"
              aria-hidden="true"
            >
              {reading
                ? "Reading…"
                : field.state.value
                  ? "Choose another"
                  : "Choose PDF"}
            </span>
          </label>
        )}
      </form.Field>

      <p className="resume-import-step__hint" data-typography="body">
        The selected file is not imported until you review the options and
        confirm the final step.
      </p>

      <form.Subscribe
        selector={(state) => ({
          hasUpload: hasProfileImportUpload(state.values),
          isSubmitting: state.isSubmitting,
        })}
      >
        {({ hasUpload, isSubmitting }) => (
          <div className="form-actions resume-import-actions">
            <Button
              type="submit"
              disabled={!hasUpload || isSubmitting || reading}
            >
              Continue to options
            </Button>
            <Link
              className={buttonVariants({ variant: "outline" })}
              to="/profile"
            >
              Cancel
            </Link>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
