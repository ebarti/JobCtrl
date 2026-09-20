import {
  BulkJobMutationFilterSchema,
  JobListQuerySchema,
  SavedTableViewUrlFiltersSchema,
} from "@jobctrl/contracts";
import { describe, expect, it } from "vitest";

describe("job state filter contracts", () => {
  it("parses comma and router JSON query serialization", () => {
    expect(
      JobListQuerySchema.parse({ jobStates: "active,hidden" }).jobStates,
    ).toEqual(["active", "hidden"]);
    expect(
      JobListQuerySchema.parse({
        jobStates: '["deleted","hidden"]',
      }).jobStates,
    ).toEqual(["deleted", "hidden"]);
  });

  it("accepts the same enum array in bulk and saved-view filters", () => {
    expect(
      BulkJobMutationFilterSchema.parse({
        deleted: "active",
        jobStates: ["deleted", "hidden"],
      }).jobStates,
    ).toEqual(["deleted", "hidden"]);
    expect(
      SavedTableViewUrlFiltersSchema.parse({
        deleted: "closed",
        jobStates: ["active", "deleted"],
      }),
    ).toMatchObject({
      deleted: "closed",
      jobStates: ["active", "deleted"],
    });
  });

  it("keeps legacy deleted values unchanged when jobStates is absent", () => {
    const parsed = JobListQuerySchema.parse({ deleted: "closed" });
    expect(parsed.deleted).toBe("closed");
    expect("jobStates" in parsed).toBe(false);
  });
});
