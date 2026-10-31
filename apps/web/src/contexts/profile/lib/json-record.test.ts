import { describe, expect, it } from "vitest";

import { defaultRepeatItem } from "./json-record.js";

describe("profile repeat-item identity", () => {
  it.each([
    "resume.experience_entries",
    "resume.education_entries",
    "resume.skill_categories",
  ])("allocates nonempty distinct IDs without changing existing IDs for %s", (path) => {
    const occupied = new Set(["experience-1", "education-1", "skill-1", "imported-entry"]);
    const original = [...occupied];
    const first = defaultRepeatItem(path, occupied);
    const second = defaultRepeatItem(path, new Set([...occupied, String(first.id)]));
    expect(first.id).toEqual(expect.any(String));
    expect(first.id).not.toBe("");
    expect(second.id).not.toBe(first.id);
    expect(occupied.has(String(first.id))).toBe(false);
    expect(occupied.has(String(second.id))).toBe(false);
    expect([...occupied]).toEqual(original);
  });

  it("does not invent identity-bearing records for unknown paths", () => {
    expect(defaultRepeatItem("resume.other_entries", ["other-1"])).toEqual({});
  });
});
