import { describe, expect, it } from "vitest";

import {
  DEFAULT_DISCOVERY_SOURCE_FILTERS,
  discoverySearchSchema,
} from "./-discovery.search.js";

describe("discoverySearchSchema", () => {
  it("defaults source review to active sources sorted by company", () => {
    expect(discoverySearchSchema.parse({})).toEqual({
      sourceFilters: DEFAULT_DISCOVERY_SOURCE_FILTERS,
      sourceSort: "displayName",
      sourceDir: "asc",
    });
  });

  it("preserves valid source filter and sort URL state", () => {
    const sourceFilters = {
      displayName: {
        operator: "does_not_contain" as const,
        text: "agency",
        selectedValues: [],
      },
      state: {
        operator: "contains" as const,
        text: "",
        selectedValues: ["disabled"],
      },
    };

    expect(
      discoverySearchSchema.parse({
        sourceFilters,
        sourceSort: "observedJobs",
        sourceDir: "desc",
      }),
    ).toEqual({
      sourceFilters,
      sourceSort: "observedJobs",
      sourceDir: "desc",
    });
  });
});
