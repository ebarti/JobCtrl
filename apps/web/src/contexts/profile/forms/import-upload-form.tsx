import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { IconFileTypePdf } from "@tabler/icons-react";
import { useState } from "react";
import { z } from "zod";

import { fileToBase64 } from "../../../shared/lib/file.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { useProfileImportStore } from "../stores/profile-import-store.js";

interface UploadFormValues {
  filename: string;
  pdfBase64: string;
}

const UploadValidator = z.object({
  filename: z.string().trim().min(1, "Choose a PDF before continuing.").max(260),
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
    defaultValues: { filename: initialFilename, pdfBase64: initialPdf } satisfies UploadFormValues,
    validators: {
      onSubmit: ({ value }) => {
        const result = UploadValidator.safeParse(value);
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid upload");
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
    setReading(true);
    try {
      const pdfBase64 = await fileToBase64(file);
      form.setFieldValue("filename", file.name);
      form.setFieldValue("pdfBase64", pdfBase64);
      setUpload(file.name, pdfBase64);
    } catch (requestError) {
      setReadError(requestError instanceof Error ? requestError.message : "Unable to read PDF.");
    } finally {
      setReading(false);
    }
  };

  return (
    <form
      className="wizard-step resume-import-step resume-import-upload grid gap-4"
      aria-busy={reading}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {readError ? <div className="banner inline" role="alert">{readError}</div> : null}
      <form.Field name="filename">
        {(field) => (
          <label className="import-target resume-import-upload__target">
            <span className="import-icon" aria-hidden="true">
              <IconFileTypePdf size={24} stroke={1.7} />
            </span>
            <span className="min-w-0">
              <b>Resume PDF</b>
              <small className="break-all">{field.state.value || "No file selected"}</small>
            </span>
            <Input
              className="resume-import-upload__input"
              aria-label="Resume PDF"
              name="resumePdf"
              type="file"
              accept="application/pdf"
              onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
            />
            <em>{reading ? "Reading…" : "Choose file"}</em>
          </label>
        )}
      </form.Field>
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
        selector={(state) => ({
          canSubmit: state.canSubmit,
          isSubmitting: state.isSubmitting,
        })}
      >
        {({ canSubmit, isSubmitting }) => (
          <div className="form-actions resume-import-actions justify-end">
            <Button asChild variant="outline">
              <Link to="/profile">Cancel</Link>
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || isSubmitting || reading}
            >
              Next
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
