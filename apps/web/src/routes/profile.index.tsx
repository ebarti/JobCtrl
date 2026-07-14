import { createFileRoute, Link } from "@tanstack/react-router";

import { ProfileEditor } from "../contexts/profile/components/ProfileEditor.js";
import { profileKeys } from "../contexts/profile/queryKeys.js";
import { Button } from "../shared/ui/button.js";
import { PageHead } from "../shared/ui/page-head.js";

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
  component: ProfilePage,
});

function ProfilePage() {
  return (
    <div className="route-page route-page--profile">
      <PageHead
        eyebrow="Setup"
        title="Profile"
        subtitle="Canonical candidate evidence and the baseline resume that every generated artifact starts from."
        actions={
          <>
            <Button asChild size="sm" variant="outline">
              <Link to="/evidence-map">Open evidence map</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/profile/import/upload">Import resume</Link>
            </Button>
          </>
        }
      />
      <ProfileEditor />
    </div>
  );
}
