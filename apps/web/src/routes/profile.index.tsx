import { prefetchProfileEditor } from "../contexts/profile/readQueries.js";
import { createFileRoute } from "@tanstack/react-router";

import { ProfileEditor } from "../contexts/profile/components/ProfileEditor.js";
import { PageHead } from "../shared/ui/page-head.js";

export const Route = createFileRoute("/profile/")({
  loader: ({ context }) => prefetchProfileEditor(context),
  component: ProfilePage,
});

function ProfilePage() {
  return (
    <>
      <PageHead
        eyebrow="Setup"
        title="Profile"
        subtitle="Baseline resume, evidence, and personal details"
      />
      <ProfileEditor />
    </>
  );
}
