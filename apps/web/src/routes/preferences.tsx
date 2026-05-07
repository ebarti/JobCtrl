import { createFileRoute } from "@tanstack/react-router";

import { ProfileEditor } from "../contexts/profile/components/ProfileEditor.js";
import { profileKeys } from "../contexts/profile/queryKeys.js";

export const Route = createFileRoute("/preferences")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData({
        queryKey: profileKeys.profile(context.tenantId),
        queryFn: () => context.ports.api.profile(),
      }),
      context.queryClient.ensureQueryData({
        queryKey: profileKeys.settings(context.tenantId),
        queryFn: () => context.ports.api.settings(),
      }),
    ]),
  component: PreferencesEditor,
});

function PreferencesEditor() {
  return <ProfileEditor section="preferences" />;
}
