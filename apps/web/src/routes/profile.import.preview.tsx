import { Link, createFileRoute } from "@tanstack/react-router";

import { useProfileImportStore } from "../contexts/profile/stores/profile-import-store.js";
import { Empty } from "../shared/ui/empty.js";

export const Route = createFileRoute("/profile/import/preview")({
  component: ResumeImportPreviewStep,
});

function ResumeImportPreviewStep() {
  const filename = useProfileImportStore((state) => state.filename);
  const importProfile = useProfileImportStore((state) => state.importProfile);
  const importStyle = useProfileImportStore((state) => state.importStyle);
  const setOptions = useProfileImportStore((state) => state.setOptions);

  if (!filename) {
    return (
      <div className="wizard-step">
        <Empty title="Pick a PDF on the previous step before continuing." />
        <div className="form-actions">
          <Link className="tab" to="/profile/import/upload">
            back to upload
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard-step">
      <p className="status-line">
        Selected: <b>{filename}</b>
      </p>
      <div className="import-options">
        <label>
          <input
            type="checkbox"
            checked={importProfile}
            onChange={(event) => setOptions(event.target.checked, importStyle)}
          />
          profile data
        </label>
        <label>
          <input
            type="checkbox"
            checked={importStyle}
            onChange={(event) => setOptions(importProfile, event.target.checked)}
          />
          style data
        </label>
      </div>
      <div className="form-actions">
        <Link className="tab on" to="/profile/import/confirm">
          next
        </Link>
        <Link className="tab" to="/profile/import/upload">
          back
        </Link>
      </div>
    </div>
  );
}
