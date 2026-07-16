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
});
