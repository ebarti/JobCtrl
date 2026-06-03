import { describe, expect, it } from "vitest";

import { normalizeJobLocation } from "../src/location-normalization.js";

describe("normalizeJobLocation", () => {
  it.each([
    ["ES (Remote)", "Spain (Remote)"],
    ["En remoto, ES (Remote)", "Spain (Remote)"],
    ["Barcelona, CT, ES (Remote)", "Barcelona, Catalonia, Spain (Remote)"],
    ["Madrid, MD, ES", "Madrid, Community of Madrid, Spain"],
    ["Work from Home - Poland", "Poland (Remote)"],
    ["Work From Home - US", "US (Remote)"],
    ["UK - Remote", "UK (Remote)"],
  ])("normalizes source location %s", (input, expected) => {
    expect(normalizeJobLocation(input)).toBe(expected);
  });
});
