import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { useProfileImportStore } from "../contexts/profile/stores/profile-import-store.js";
import { fileToBase64 } from "../shared/lib/file.js";

export const Route = createFileRoute("/profile/import/upload")({
  component: ResumeImportUploadStep,
});

function ResumeImportUploadStep() {
  const filename = useProfileImportStore((state) => state.filename);
  const setUpload = useProfileImportStore((state) => state.setUpload);
  const reset = useProfileImportStore((state) => state.reset);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File | null) => {
    setError("");
    if (!file) {
      reset();
      return;
    }
    setBusy(true);
    try {
      const pdfBase64 = await fileToBase64(file);
      setUpload(file.name, pdfBase64);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to read PDF.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard-step">
      {error ? <div className="banner inline">{error}</div> : null}
      <label className="import-target">
        <span className="import-icon">PDF</span>
        <span>
          <b>Resume PDF</b>
          <small>{filename || "No file selected"}</small>
        </span>
        <input
          aria-label="Resume PDF"
          type="file"
          accept="application/pdf"
          onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
        />
        <em>{busy ? "reading..." : "choose file"}</em>
      </label>
      <div className="form-actions">
        {filename ? (
          <Link className="tab on" to="/profile/import/preview">
            next
          </Link>
        ) : (
          <span className="tab on is-disabled" aria-disabled="true">
            next
          </span>
        )}
        <Link className="tab" to="/profile">
          cancel
        </Link>
      </div>
    </div>
  );
}
