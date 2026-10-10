import { describe, expect, it } from "vitest";
import { normalizeJobLocation } from "../src/location-normalization.js";

describe("source location display", () => {
  it("preserves the source without inferring places or work model", () => {
    expect(normalizeJobLocation("  Owned source location  ")).toBe("Owned source location");
    expect(normalizeJobLocation(null)).toBe("");
  });
});
