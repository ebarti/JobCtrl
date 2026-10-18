import { prefetchEvidenceMap } from "../contexts/operations/readQueries.js";
import { createFileRoute } from "@tanstack/react-router";

import { EvidenceMapView } from "../views/evidence-map/EvidenceMapView.js";
import { evidenceMapSearchSchema } from "./-evidence-map.search.js";

export const Route = createFileRoute("/evidence-map")({
  validateSearch: (search) => evidenceMapSearchSchema.parse(search),
  loader: ({ context }) => prefetchEvidenceMap(context),
  component: EvidenceMapView,
});
