import { createFileRoute } from "@tanstack/react-router";

import { ResumeImportWizard } from "../contexts/profile/components/ResumeImportWizard.js";
import { useProfileImportStore } from "../contexts/profile/stores/profile-import-store.js";

export const Route = createFileRoute("/profile/import")({
  beforeLoad: async ({ context }) => {
    await useProfileImportStore.getState().hydrate(context.ports.storage);
  },
  component: ResumeImportWizard,
});
