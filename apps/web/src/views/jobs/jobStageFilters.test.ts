import { describe, expect, it } from "vitest";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import {
  bulkJobFilters,
  effectiveJobStates,
  jobsListInput,
} from "./jobStageFilters.js";

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

  it("passes URL job states to list and all-matching bulk filters", () => {
    const search = jobsSearchSchema.parse({
      deleted: "closed",
      jobStates: "active,hidden",
    });

    expect(jobsListInput(search)).toMatchObject({
      deleted: "closed",
      jobStates: ["active", "hidden"],
    });
    expect(bulkJobFilters(search)).toEqual([
      expect.objectContaining({
        deleted: "closed",
        jobStates: ["active", "hidden"],
      }),
    ]);
  });

  it("derives visible state from legacy URLs only when jobStates is absent", () => {
    expect(
      effectiveJobStates(jobsSearchSchema.parse({ deleted: "deleted" })),
    ).toEqual(["deleted"]);
    expect(
      effectiveJobStates(
        jobsSearchSchema.parse({
          deleted: "deleted",
          jobStates: ["active", "hidden"],
        }),
      ),
    ).toEqual(["active", "hidden"]);
    expect(
      effectiveJobStates(jobsSearchSchema.parse({ deleted: "closed" })),
    ).toEqual(["active"]);
  });
});
