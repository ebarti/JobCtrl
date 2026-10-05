import { ProfileSchema, RequiredBulletSuggestionResponseSchema, RequiredBulletModelResultSchema } from "@jobctrl/contracts";
import { bindRequiredBulletSuggestions } from "@jobctrl/domain-types";
import { describe, expect, it } from "vitest";
import fixtures from "../../../packages/domain-types/test/fixtures/required-bullet-suggestions.json" with { type: "json" };

describe("model findings bound to saved sources", () => {
  it.each(fixtures)("$name", (fixture) => {
    const profile = ProfileSchema.parse(fixture.profile);
    const result = RequiredBulletModelResultSchema.parse({ profileVersion: fixture.profileVersion, suggestions: fixture.judgments });
    if (!("suggestions" in result)) throw new Error("Expected model findings fixture");
    const judgments = result.suggestions;
    const response = bindRequiredBulletSuggestions(profile, fixture.profileVersion, fixture.maximumSuggestions, judgments, true);
    expect(RequiredBulletSuggestionResponseSchema.parse(response)).toEqual(response);
    expect(response.suggestions).toMatchObject(fixture.expected.suggestions);
    expect(response.suggestions).toHaveLength(fixture.expected.suggestions.length);
  });
  it("rejects model replacement wording rather than accepting unsupported facts", () => {
    expect(RequiredBulletModelResultSchema.safeParse({ profileVersion: 7,
      suggestions: [{ reference: "source", kind: "grammar", guidance: "Rewrite.", sourceId: "Invented source" }] }).success).toBe(false);
  });
});
