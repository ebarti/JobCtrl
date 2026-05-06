import { createFileRoute } from "@tanstack/react-router";

import { ResumeImportWizard } from "../contexts/profile/components/ResumeImportWizard.js";

export const Route = createFileRoute("/profile/import")({
  component: ResumeImportWizard,
});
