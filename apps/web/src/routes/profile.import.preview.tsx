import { createFileRoute, redirect } from "@tanstack/react-router";

import { ImportPreviewForm } from "../contexts/profile/forms/import-preview-form.js";
import {
  hasProfileImportUpload,
  useProfileImportStore,
} from "../contexts/profile/stores/profile-import-store.js";

export const Route = createFileRoute("/profile/import/preview")({
  beforeLoad: () => {
    if (!hasProfileImportUpload(useProfileImportStore.getState())) {
      throw redirect({ to: "/profile/import/upload", replace: true });
    }
  },
  component: ResumeImportPreviewStep,
});

function ResumeImportPreviewStep() {
  return <ImportPreviewForm />;
}
