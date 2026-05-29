import { createFileRoute } from "@tanstack/react-router";

import { profileKeys } from "../contexts/profile/queryKeys.js";
import { DiscoveryView } from "../views/discovery/DiscoveryView.js";

export const Route = createFileRoute("/discovery")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({
      queryKey: profileKeys.profile(context.tenantId),
      queryFn: () => context.ports.api.profile(),
    }),
  component: DiscoveryView,
});
