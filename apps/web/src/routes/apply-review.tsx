import { prefetchApplicationQueue } from "../contexts/apply/index.js";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { ApplyReviewView } from "../views/apply-review/ApplyReviewView.js";
import {
  applyReviewSearchSchema,
  type ApplyReviewSearch,
} from "./-apply-review.search.js";

export const Route = createFileRoute("/apply-review")({
  validateSearch: (search) => applyReviewSearchSchema.parse(search),
  loader: ({ context }) => prefetchApplicationQueue(context),
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
