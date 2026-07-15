import { ProfileImportRequestSchema, type ProfileImportRequest } from "@jobctrl/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { IconCheck, IconFileTypePdf, IconMinus } from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { Button, buttonVariants } from "../../../shared/ui/button.js";
import { Empty } from "../../../shared/ui/empty.js";
import { useImportResumeMutation } from "../hooks/useImportResumeMutation.js";
import { useProfileImportStore } from "../stores/profile-import-store.js";

export function ImportConfirmForm() {
  const navigate = useNavigate();
  const filename = useProfileImportStore((state) => state.filename);
  const pdfBase64 = useProfileImportStore((state) => state.pdfBase64);
  const importProfile = useProfileImportStore((state) => state.importProfile);
  const importStyle = useProfileImportStore((state) => state.importStyle);
  const reset = useProfileImportStore((state) => state.reset);

  const importResume = useImportResumeMutation();
  const [statusMessage, setStatusMessage] = useState("");

  const form = useForm({
    defaultValues: {
      filename,
      pdfBase64,
      importProfile,
      importStyle,
    } satisfies ProfileImportRequest,
    validators: {
      onSubmit: ({ value }) => {
        const result = ProfileImportRequestSchema.safeParse(value);
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid import");
      },
    },
    onSubmit: async ({ value }) => {
      setStatusMessage("");
      const response = await importResume.mutateAsync(value);
      setStatusMessage(`import draft ${response.action?.status ?? "ready"}`);
      reset();
      await navigate({ to: "/profile" });
    },
  });

  useEffect(() => {
    form.reset({ filename, pdfBase64, importProfile, importStyle });
  }, [form, filename, pdfBase64, importProfile, importStyle]);

  if (!filename || !pdfBase64) {
    return (
      <div className="wizard-step resume-import-step resume-import-empty-step">
        <Empty title="No upload found. Start at step 1." />
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

  const errorMessage = importResume.error?.message ?? "";
  const summary =
    importProfile && importStyle
      ? "Profile and style"
      : importProfile
        ? "Profile only"
        : importStyle
          ? "Style only"
          : "No sections selected";

  return (
    <form
      className="wizard-step resume-import-step resume-import-step--confirm"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <header className="resume-import-step__header">
        <span className="resume-import-step__eyebrow">Confirm import</span>
        <h2>Review the final import</h2>
        <p>Check the source and selected scope once more before applying the import.</p>
      </header>

      {errorMessage ? (
        <div className="banner inline resume-import-alert" role="alert">
          {errorMessage}
        </div>
      ) : null}
      {statusMessage ? (
        <div className="status-line resume-import-status" role="status">
          {statusMessage}
        </div>
      ) : null}

      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors
            .flat()
            .find((entry): entry is string => typeof entry === "string" && entry.length > 0);
          return message ? (
            <div className="banner inline resume-import-alert" role="alert">
              {message}
            </div>
          ) : null;
        }}
      </form.Subscribe>

      <dl className="resume-import-confirmation-summary">
        <div>
          <dt>Source PDF</dt>
          <dd>
            <IconFileTypePdf size={20} stroke={1.65} aria-hidden="true" />
            <span>{filename}</span>
          </dd>
        </div>
        <div>
          <dt>Import scope</dt>
          <dd>{summary}</dd>
        </div>
      </dl>

      <div
        className="resume-import-scope-review"
        role="group"
        aria-label="Selected import sections"
      >
        <div data-selected={importProfile || undefined}>
          {importProfile ? (
            <IconCheck size={18} stroke={2} aria-hidden="true" />
          ) : (
            <IconMinus size={18} stroke={2} aria-hidden="true" />
          )}
          <span>
            <strong>Profile data</strong>
            <small>{importProfile ? "Included in this import" : "Not selected"}</small>
          </span>
        </div>
        <div data-selected={importStyle || undefined}>
          {importStyle ? (
            <IconCheck size={18} stroke={2} aria-hidden="true" />
          ) : (
            <IconMinus size={18} stroke={2} aria-hidden="true" />
          )}
          <span>
            <strong>Style data</strong>
            <small>{importStyle ? "Included in this import" : "Not selected"}</small>
          </span>
        </div>
      </div>

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <div className="form-actions resume-import-actions">
            <Link
              className={buttonVariants({ variant: "outline" })}
              to="/profile/import/preview"
            >
              Back
            </Link>
            <Button
              type="submit"
              disabled={!canSubmit || isSubmitting}
            >
              {isSubmitting ? "Importing…" : "Confirm import"}
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
