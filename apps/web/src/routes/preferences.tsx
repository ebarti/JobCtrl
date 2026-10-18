import { prefetchProfileEditor } from "../contexts/profile/readQueries.js";
import { createFileRoute } from "@tanstack/react-router";

import { ProfileEditor } from "../contexts/profile/components/ProfileEditor.js";
import { PageHead } from "../shared/ui/page-head.js";

export const Route = createFileRoute("/preferences")({
  loader: ({ context }) => prefetchProfileEditor(context),
  component: PreferencesEditor,
});

function PreferencesEditor() {
  return (
    <>
      <PageHead
        eyebrow="Setup"
        title="Preferences"
        subtitle="Search targets, tailoring, and apply configuration"
      />
      <ProfileEditor section="preferences" />
    </>
  );
}
