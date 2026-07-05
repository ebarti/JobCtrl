import { describe, expect, it } from "vitest";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { jobsListInput } from "./jobStageFilters.js";

describe("jobsListInput", () => {
  it("preserves digest timestamp filters from URL search state", () => {
    const search = jobsSearchSchema.parse({
      discoveredSince: "2026-07-01T00:00:00.000Z",
      scoredSince: "2026-07-01T00:00:00.000Z",
    });

    expect(jobsListInput(search)).toMatchObject({
      discoveredSince: "2026-07-01T00:00:00.000Z",
      scoredSince: "2026-07-01T00:00:00.000Z",
      sort: "discovered_at",
      dir: "desc",
    });
  });
});
