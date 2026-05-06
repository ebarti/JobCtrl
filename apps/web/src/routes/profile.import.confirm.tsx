import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useImportResumeMutation } from "../contexts/profile/hooks/useImportResumeMutation.js";
import { useProfileImportStore } from "../contexts/profile/stores/profile-import-store.js";
import { Empty } from "../shared/ui/empty.js";

export const Route = createFileRoute("/profile/import/confirm")({
  component: ResumeImportConfirmStep,
});

function ResumeImportConfirmStep() {
  const navigate = useNavigate();
  const filename = useProfileImportStore((state) => state.filename);
  const pdfBase64 = useProfileImportStore((state) => state.pdfBase64);
  const importProfile = useProfileImportStore((state) => state.importProfile);
  const importStyle = useProfileImportStore((state) => state.importStyle);
  const reset = useProfileImportStore((state) => state.reset);

  const importResume = useImportResumeMutation();
  const [statusMessage, setStatusMessage] = useState("");
  const errorMessage = importResume.error?.message ?? "";

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

  const submit = () => {
    setStatusMessage("");
    importResume.mutate(
      { filename, pdfBase64, importProfile, importStyle },
      {
        onSuccess: (response) => {
          setStatusMessage(`import draft ${response.action?.status ?? "ready"}`);
          reset();
          void navigate({ to: "/profile" });
        },
      },
    );
  };

  return (
    <div className="wizard-step">
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-line">{statusMessage}</div> : null}
      <p>
        Importing <b>{filename}</b> with{" "}
        {importProfile && importStyle
          ? "profile + style"
          : importProfile
            ? "profile only"
            : importStyle
              ? "style only"
              : "no fields"}
        .
      </p>
      <div className="form-actions">
        <button
          className="tab on"
          type="button"
          disabled={importResume.isPending}
          onClick={submit}
        >
          {importResume.isPending ? "importing..." : "confirm import"}
        </button>
        <Link className="tab" to="/profile/import/preview">
          back
        </Link>
      </div>
    </div>
  );
}
