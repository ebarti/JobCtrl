import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { applyReviewKeys } from "../contexts/operations/applyReviewKeys.js";
import { ApplyReviewView } from "../views/apply-review/ApplyReviewView.js";
import { applyReviewSearchSchema, type ApplyReviewSearch } from "./-apply-review.search.js";

export const Route = createFileRoute("/apply-review")({
  validateSearch: (search) => applyReviewSearchSchema.parse(search),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData({
      queryKey: applyReviewKeys.queue(context.tenantId),
      queryFn: () => context.ports.api.applyReviewQueue(),
    });

  },
  component: ApplyReviewRoute,
});

function ApplyReviewRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/apply-review" });

  const setSelectedJobKey = (jobKey: string | null) => {
    void navigate({
      replace: true,
      search: (prev: ApplyReviewSearch) => ({
        ...prev,
        jobKey: jobKey ?? undefined,
      }),
    });
  };

  return (
    <ApplyReviewView
      targetJobKey={search.jobKey ?? null}
      onTargetJobKeyChange={setSelectedJobKey}
    />
  );
}
