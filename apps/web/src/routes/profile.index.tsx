import { createFileRoute } from "@tanstack/react-router";

import { ProfileEditor } from "../contexts/profile/components/ProfileEditor.js";
import { profileKeys } from "../contexts/profile/queryKeys.js";

export const Route = createFileRoute("/profile/")({
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
  component: ProfileEditor,
});
