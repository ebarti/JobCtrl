import type {
  JobDeleted,
  JobDiscovered,
  JobRestored,
  JobUpdated,
} from "@jobhunter/domain-types";

import type { InvalidationItem } from "../operations/invalidation-router.js";

export const jobDiscoveredHandler = (_event: JobDiscovered): readonly InvalidationItem[] => [];
export const jobUpdatedHandler = (_event: JobUpdated): readonly InvalidationItem[] => [];
export const jobDeletedHandler = (_event: JobDeleted): readonly InvalidationItem[] => [];
export const jobRestoredHandler = (_event: JobRestored): readonly InvalidationItem[] => [];
