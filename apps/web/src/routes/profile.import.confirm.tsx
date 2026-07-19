import { createFileRoute, redirect } from "@tanstack/react-router";

import { ImportConfirmForm } from "../contexts/profile/forms/import-confirm-form.js";
import {
  hasProfileImportUpload,
  useProfileImportStore,
} from "../contexts/profile/stores/profile-import-store.js";

export const Route = createFileRoute("/profile/import/confirm")({
  beforeLoad: () => {
    if (!hasProfileImportUpload(useProfileImportStore.getState())) {
      throw redirect({ to: "/profile/import/upload", replace: true });
    }
  },
  component: ResumeImportConfirmStep,
});

function ResumeImportConfirmStep() {
  return <ImportConfirmForm />;
}
