import type { EnrichmentFailed, JobEnriched } from "@jobhunter/domain-types";

import type { InvalidationItem } from "../operations/invalidation-router.js";

export const jobEnrichedHandler = (_event: JobEnriched): readonly InvalidationItem[] => [];
export const enrichmentFailedHandler = (
  _event: EnrichmentFailed,
): readonly InvalidationItem[] => [];
