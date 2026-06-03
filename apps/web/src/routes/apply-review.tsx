import { createFileRoute } from "@tanstack/react-router";

import { applyReviewKeys } from "../contexts/operations/applyReviewKeys.js";
import { ApplyReviewView } from "../views/apply-review/ApplyReviewView.js";

export const Route = createFileRoute("/apply-review")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData({
      queryKey: applyReviewKeys.queue(context.tenantId),
      queryFn: () => context.ports.api.applyReviewQueue(),
    });

  },
  component: ApplyReviewView,
});
