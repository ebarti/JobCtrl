import { ProfileImportRequestSchema, type ProfileImportRequest } from "@jobhunter/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";

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
      <div className="wizard-step">
        <Empty title="No upload found. Start at step 1." />
        <div className="form-actions">
          <Link className="tab" to="/profile/import/upload">
            back to upload
          </Link>
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
      className="wizard-step"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      <p>
        Importing <b>{filename}</b> with {summary}.
      </p>
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
              {isSubmitting ? "importing..." : "confirm import"}
            </button>
            <Link className="tab" to="/profile/import/preview">
              back
            </Link>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
