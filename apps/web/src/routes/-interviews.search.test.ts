import { describe, expect, it } from "vitest";

import { interviewsSearchSchema } from "./-interviews.search.js";

describe("interview URL state", () => {
  it("preserves catalog filters, selected question, display mode and canonical job", () => {
    const input = { q: "tradeoffs", topic: "leadership", role: "manager", source: "source-1", format: "principle", mode: "graph", card: "B11", job: "job-1" };
    expect(interviewsSearchSchema.parse(input)).toEqual(input);
  });

  it("bounds hostile values and keeps offline browsing free of an implicit job", () => {
    expect(interviewsSearchSchema.parse({ q: "a".repeat(201), mode: "invalid" })).toEqual({
      q: "", topic: "", role: "", source: "", format: "", mode: "list", card: "", job: "",
    });
  });
});
