import type { SavedTableViewGridFilters } from "@jobctrl/contracts";
import { SavedTableViewGridFiltersSchema } from "@jobctrl/contracts";
import { z } from "zod";

import { DISCOVERY_SOURCE_SORT_COLUMN_IDS } from "../shared/stores/saved-table-views.js";
import { jobsSearchSchema } from "./-jobs.search.js";

export const DEFAULT_DISCOVERY_SOURCE_FILTERS: SavedTableViewGridFilters = {
  state: {
    operator: "contains",
    text: "",
    selectedValues: ["active"],
  },
};

export const discoverySourceSortSchema = z.enum(
  DISCOVERY_SOURCE_SORT_COLUMN_IDS,
);

export const discoverySearchSchema = z.object({
  sourceFilters: SavedTableViewGridFiltersSchema.default(
    DEFAULT_DISCOVERY_SOURCE_FILTERS,
  ).catch(DEFAULT_DISCOVERY_SOURCE_FILTERS),
  sourceSort: discoverySourceSortSchema.default("displayName"),
  sourceDir: z.enum(["asc", "desc"]).default("asc"),
  returnTo: z.literal("jobs").optional().catch(undefined),
  jobsReturn: jobsSearchSchema.optional().catch(undefined),
});

export type DiscoverySearch = z.infer<typeof discoverySearchSchema>;
