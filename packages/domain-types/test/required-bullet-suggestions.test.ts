import { describe, expect, it } from "vitest";
import { prepareRequiredBulletCoaching, bindRequiredBulletSuggestions, bindRequiredBulletJudgments,
  isApplicableRequiredBulletCleanup, type RequiredBulletCoachingInput, type RequiredBulletModelJudgment } from "../src/profile/index.js";
import fixtures from "./fixtures/required-bullet-suggestions.json" with { type: "json" };

function candidate(text = "  Worked   on synthetic queues  ") {
  return { resume: { experience_entries: [{ id: "exp-1", title: "Synthetic Engineer", company: "Synthetic Co",
    bullets: [text], achievement_evidence: [] }], tailoring_rules: { required_bullets_by_experience_id: { "exp-1": [text] } } } };
}

describe("Required source binding and acceptance", () => {
  it.each(fixtures)("$name", (fixture) => {
    const profile = structuredClone(fixture.profile);
    const before = JSON.stringify(profile);
    const result = bindRequiredBulletSuggestions(profile as RequiredBulletCoachingInput, fixture.profileVersion, fixture.maximumSuggestions,
      fixture.judgments as RequiredBulletModelJudgment[], true);
    expect(result.suggestions).toMatchObject(fixture.expected.suggestions);
    expect(result.suggestions).toHaveLength(fixture.expected.suggestions.length);
    for (const suggestion of result.suggestions) {
      expect(isApplicableRequiredBulletCleanup(profile as RequiredBulletCoachingInput, fixture.profileVersion, suggestion)).toBe(suggestion.canApply);
      if (suggestion.source.identityKind === "snapshot_bullet") {
        expect(isApplicableRequiredBulletCleanup(profile as RequiredBulletCoachingInput, fixture.profileVersion + 1, suggestion)).toBe(false);
      }
    }
    expect(JSON.stringify(profile)).toBe(before);
  });
  it.each(["Worked on the payments API, cutting p99 latency 40%", "Florbulated the synthetic shibboleth", "Didn’t reduce synthetic latency"])(
    "adds no findings from words in %s", (text) => {
      const profile = candidate(text);
      const preparation = prepareRequiredBulletCoaching(profile, 7);
      expect(preparation.sources[0]!.originalText).toBe(text);
      expect(bindRequiredBulletJudgments(preparation, [], 24, true).suggestions).toEqual([]);
      const finding = { reference: preparation.sources[0]!.reference, kind: "achievement_framing" as const,
        guidance: "The model’s specific finding.", proposedText: null };
      expect(bindRequiredBulletJudgments(preparation, [finding], 24, true).suggestions[0]!.guidance).toBe(finding.guidance);
    });
  it("rejects unknown references and repeated model findings", () => {
    const preparation = prepareRequiredBulletCoaching(candidate(), 7);
    const finding = { reference: preparation.sources[0]!.reference, kind: "grammar" as const, guidance: "Spacing.", proposedText: "Worked on synthetic queues" };
    expect(() => bindRequiredBulletJudgments(preparation, [finding, finding], 24, true)).toThrow();
    expect(() => bindRequiredBulletJudgments(preparation, [{ ...finding, reference: "invented" }], 24, true)).toThrow();
  });
  it.each([255, 256, 257])("bounds raw entries before inspecting contents: %i", (count) => {
    const profile = candidate();
    profile.resume.experience_entries.push(...Array.from({ length: count - 1 }, (_, i) => ({
      id: `optional-${i}`, title: "Synthetic Engineer", company: "Synthetic Co", bullets: [], achievement_evidence: [],
    })));
    expect(prepareRequiredBulletCoaching(profile, 7).sources).toHaveLength(count > 256 ? 0 : 1);
  });
  it("rejects excess entries before reading identities", () => {
    const profile = candidate();
    Object.defineProperty(profile.resume.experience_entries[0], "id", { get: () => { throw new Error("Identity read"); } });
    profile.resume.experience_entries = Array.from({ length: 257 }, () => profile.resume.experience_entries[0]!);
    expect(prepareRequiredBulletCoaching(profile, 7)).toMatchObject({ sources: [], truncated: true });
  });
  it.each([4095, 4096, 4097])("bounds optional source rows: %i", (count) => {
    const profile = candidate();
    profile.resume.experience_entries[0]!.bullets.push(...Array.from({ length: count - 4 }, (_, i) => `Optional ${i}`));
    expect(prepareRequiredBulletCoaching(profile, 7).sources).toHaveLength(count > 4096 ? 0 : 1);
  });
  it("bounds the complete evidence payload without deriving findings", () => {
    const profile = fixtures.find((fixture) => fixture.profile.resume.experience_entries.some((entry) => entry.achievement_evidence.length))!;
    const copy = structuredClone(profile.profile);
    copy.resume.experience_entries[0]!.achievement_evidence[0]!.outcome = "x".repeat(32001);
    expect(prepareRequiredBulletCoaching(copy as RequiredBulletCoachingInput, 7).truncated).toBe(true);
  });
  it("refuses a cleanup with forged source position or changed words", () => {
    const profile = candidate();
    const preparation = prepareRequiredBulletCoaching(profile, 7);
    const result = bindRequiredBulletJudgments(preparation, [{ reference: preparation.sources[0]!.reference,
      kind: "grammar", guidance: "Spacing.", proposedText: "Worked on synthetic queues" }], 24, true);
    const suggestion = result.suggestions[0]!;
    expect(isApplicableRequiredBulletCleanup(profile, 7, suggestion)).toBe(true);
    expect(bindRequiredBulletJudgments(preparation, [{ reference: preparation.sources[0]!.reference,
      kind: "grammar", guidance: "Fix substantive grammar manually.", proposedText: "Changed words" }], 24, true)
      .suggestions[0]!.canApply).toBe(false);
    expect(isApplicableRequiredBulletCleanup(profile, 7, { ...suggestion, proposedText: "Invented result" })).toBe(false);
    expect(isApplicableRequiredBulletCleanup(profile, 7, { ...suggestion, source: { ...suggestion.source, bulletIndex: 1 } })).toBe(false);
  });
});
