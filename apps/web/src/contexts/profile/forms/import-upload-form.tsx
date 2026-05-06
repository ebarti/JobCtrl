import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { z } from "zod";

import { fileToBase64 } from "../../../shared/lib/file.js";
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
      className="wizard-step"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {readError ? <div className="banner inline">{readError}</div> : null}
      <form.Field name="filename">
        {(field) => (
          <label className="import-target">
            <span className="import-icon">PDF</span>
            <span>
              <b>Resume PDF</b>
              <small>{field.state.value || "No file selected"}</small>
            </span>
            <input
              aria-label="Resume PDF"
              type="file"
              accept="application/pdf"
              onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
            />
            <em>{reading ? "reading..." : "choose file"}</em>
          </label>
        )}
      </form.Field>
      <form.Subscribe
        selector={(state) => ({
          canSubmit: state.canSubmit,
          isSubmitting: state.isSubmitting,
        })}
      >
        {({ canSubmit, isSubmitting }) => (
          <div className="form-actions">
            <button
              type="submit"
              className="tab on"
              disabled={!canSubmit || isSubmitting || reading}
            >
              next
            </button>
            <Link className="tab" to="/profile">
              cancel
            </Link>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
