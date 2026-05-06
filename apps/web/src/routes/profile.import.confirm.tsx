import { createFileRoute } from "@tanstack/react-router";

import { ImportConfirmForm } from "../contexts/profile/forms/import-confirm-form.js";

export const Route = createFileRoute("/profile/import/confirm")({
  component: ResumeImportConfirmStep,
});

function ResumeImportConfirmStep() {
  return <ImportConfirmForm />;
}
