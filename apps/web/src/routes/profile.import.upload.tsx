import { createFileRoute } from "@tanstack/react-router";

import { ImportUploadForm } from "../contexts/profile/forms/import-upload-form.js";

export const Route = createFileRoute("/profile/import/upload")({
  component: ResumeImportUploadStep,
});

function ResumeImportUploadStep() {
  return <ImportUploadForm />;
}
