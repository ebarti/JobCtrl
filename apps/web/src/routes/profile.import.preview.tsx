import { createFileRoute } from "@tanstack/react-router";

import { ImportPreviewForm } from "../contexts/profile/forms/import-preview-form.js";

export const Route = createFileRoute("/profile/import/preview")({
  component: ResumeImportPreviewStep,
});

function ResumeImportPreviewStep() {
  return <ImportPreviewForm />;
}
