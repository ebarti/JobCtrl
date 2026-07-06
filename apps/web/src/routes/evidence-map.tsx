import { createFileRoute } from "@tanstack/react-router";

import { evidenceMapKeys } from "../contexts/operations/evidenceMapKeys.js";
import { EvidenceMapView } from "../views/evidence-map/EvidenceMapView.js";
import { evidenceMapSearchSchema } from "./-evidence-map.search.js";

export const Route = createFileRoute("/evidence-map")({
  validateSearch: (search) => evidenceMapSearchSchema.parse(search),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({
      queryKey: evidenceMapKeys.list(context.tenantId),
      queryFn: () => context.ports.api.evidenceMap(),
    }),
  component: EvidenceMapView,
});
