import { describe, expect, it } from "vitest";

import { jobsSearchSchema } from "./-jobs.search.js";

describe("jobsSearchSchema", () => {
  it("preserves legacy closed lifecycle links without mapping them to hidden", () => {
    expect(jobsSearchSchema.parse({ deleted: "closed" }).deleted).toBe(
      "closed",
    );
  });

  it.each(["active", "closed", "deleted", "hidden"] as const)(
    "preserves the %s queue",
    (deleted) => {
      expect(jobsSearchSchema.parse({ deleted }).deleted).toBe(deleted);
    },
  );

  it("round-trips single and combined job-state filters", () => {
    expect(jobsSearchSchema.parse({ jobStates: "deleted" }).jobStates).toEqual([
      "deleted",
    ]);
    expect(
      jobsSearchSchema.parse({ jobStates: "active,hidden" }).jobStates,
    ).toEqual(["active", "hidden"]);
    expect(
      jobsSearchSchema.parse({ jobStates: ["deleted", "hidden"] }).jobStates,
    ).toEqual(["deleted", "hidden"]);
  });

  it("keeps legacy deleted URLs authoritative when jobStates is absent", () => {
    const parsed = jobsSearchSchema.parse({ deleted: "hidden" });
    expect(parsed.deleted).toBe("hidden");
    expect("jobStates" in parsed).toBe(false);
  });
});
