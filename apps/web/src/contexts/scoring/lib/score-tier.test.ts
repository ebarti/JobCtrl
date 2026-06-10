import { describe, expect, it } from "vitest";

import { scoreTier } from "./score-tier.js";

describe("scoreTier", () => {
  it("keeps score tiers in the explicit fit vocabulary", () => {
    expect(scoreTier(10)).toBe("good");
    expect(scoreTier(8)).toBe("good");
    expect(scoreTier(7)).toBe("mid");
    expect(scoreTier(6)).toBe("mid");
    expect(scoreTier(5)).toBe("none");
    expect(scoreTier(null)).toBe("none");
  });
});

