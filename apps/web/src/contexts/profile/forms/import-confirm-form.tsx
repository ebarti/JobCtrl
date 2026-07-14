import { ProfileImportRequestSchema, type ProfileImportRequest } from "@jobctrl/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { IconFileTypePdf } from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { Button } from "../../../shared/ui/button.js";
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
      <div className="wizard-step resume-import-step grid gap-4">
        <Empty title="No upload found. Start at step 1." />
        <div className="form-actions resume-import-actions justify-end">
          <Button asChild variant="outline">
            <Link to="/profile/import/upload">Back to upload</Link>
          </Button>
        </div>
      </div>
    );
  }

  const errorMessage = importResume.error?.message ?? "";
  const summary =
    importProfile && importStyle
      ? "profile + style"
      : importProfile
        ? "profile only"
        : importStyle
          ? "style only"
          : "no fields";

  return (
    <form
      className="wizard-step resume-import-step resume-import-confirm grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {errorMessage ? <div className="banner inline" role="alert">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-line" role="status">{statusMessage}</div> : null}
      <section className="resume-import-confirmation" aria-label="Import summary">
        <IconFileTypePdf
          className="resume-import-confirmation__icon"
          aria-hidden="true"
          size={24}
          stroke={1.7}
        />
        <div className="resume-import-confirmation__file">
          <span>Source PDF</span>
          <strong className="break-all">{filename}</strong>
        </div>
        <dl className="resume-import-confirmation__ledger">
          <div>
            <dt>Import scope</dt>
            <dd>{summary}</dd>
          </div>
          <div>
            <dt>Current state</dt>
            <dd>Nothing has changed yet</dd>
          </div>
        </dl>
      </section>
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
          <div className="form-actions resume-import-actions">
            <Button asChild variant="outline">
              <Link to="/profile/import/preview">Back</Link>
            </Button>
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
