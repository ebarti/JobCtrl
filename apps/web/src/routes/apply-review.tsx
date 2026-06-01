import { createFileRoute } from "@tanstack/react-router";

import { applyReviewKeys } from "../contexts/operations/applyReviewKeys.js";
import { outcomesKeys } from "../contexts/operations/outcomesKeys.js";
import { ApplyReviewView } from "../views/apply-review/ApplyReviewView.js";

export const Route = createFileRoute("/apply-review")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData({
        queryKey: applyReviewKeys.queue(context.tenantId),
        queryFn: () => context.ports.api.applyReviewQueue(),
      }),
      context.queryClient.ensureQueryData({
        queryKey: outcomesKeys.list(context.tenantId),
        queryFn: () => context.ports.api.applicationOutcomes(),
      }),
    ]),
  component: ApplyReviewView,
});
