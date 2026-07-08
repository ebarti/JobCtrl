import { createFileRoute } from "@tanstack/react-router";

import { ProfileEditor } from "../contexts/profile/components/ProfileEditor.js";
import { profileKeys } from "../contexts/profile/queryKeys.js";
import { PageHead } from "../shared/ui/page-head.js";

export const Route = createFileRoute("/preferences")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.prefetchQuery({
        queryKey: profileKeys.profile(context.tenantId),
        queryFn: () => context.ports.api.profile(),
      }),
      context.queryClient.prefetchQuery({
        queryKey: profileKeys.settings(context.tenantId),
        queryFn: () => context.ports.api.settings(),
      }),
    ]),
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
