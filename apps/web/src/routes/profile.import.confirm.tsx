import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useProfileImportStore } from "../contexts/profile/stores/profile-import-store.js";
import { usePorts } from "../shared/providers/PortsProvider.js";
import { Empty } from "../shared/ui/empty.js";

export const Route = createFileRoute("/profile/import/confirm")({
  component: ResumeImportConfirmStep,
});

function ResumeImportConfirmStep() {
  const ports = usePorts();
  const navigate = useNavigate();
  const filename = useProfileImportStore((state) => state.filename);
  const pdfBase64 = useProfileImportStore((state) => state.pdfBase64);
  const importProfile = useProfileImportStore((state) => state.importProfile);
  const importStyle = useProfileImportStore((state) => state.importStyle);
  const reset = useProfileImportStore((state) => state.reset);

  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

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

  const submit = async () => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await ports.api.importResume({
        filename,
        pdfBase64,
        importProfile,
        importStyle,
      });
      setStatus(`import draft ${response.action?.status ?? "ready"}`);
      reset();
      void navigate({ to: "/profile" });
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Unable to import resume.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard-step">
      {error ? <div className="banner inline">{error}</div> : null}
      {status ? <div className="status-line">{status}</div> : null}
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
        <button className="tab on" type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? "importing..." : "confirm import"}
        </button>
        <Link className="tab" to="/profile/import/preview">
          back
        </Link>
      </div>
    </div>
  );
}
