import { describe, expect, it } from "vitest";

import {
  generateRequiredBulletSuggestions,
  MAX_REQUIRED_COACHING_ENTRIES,
  MAX_REQUIRED_COACHING_SOURCE_ROWS,
  type RequiredBulletCoachingEvidence,
  type RequiredBulletCoachingInput,
  type RequiredBulletCoachingResponse,
} from "../src/profile/index.js";
import fixtureData from "./fixtures/required-bullet-suggestions.json" with { type: "json" };

interface Fixture {
  name: string;
  profile: RequiredBulletCoachingInput;
  profileVersion: number;
  maximumSuggestions: number;
  expected: RequiredBulletCoachingResponse;
}

const fixtures = fixtureData as readonly Fixture[];
const REQUIRED_TEXT = "  Worked   on synthetic queues  ";

function candidate() {
  return {
    resume: {
      experience_entries: [{
        id: "exp-1",
        title: "Synthetic Engineer",
        company: "Synthetic Co",
        bullets: [REQUIRED_TEXT],
        achievement_evidence: [] as RequiredBulletCoachingEvidence[],
      }],
      tailoring_rules: {
        required_bullets_by_experience_id: { "exp-1": [REQUIRED_TEXT] } as Record<string, string[]>,
      },
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function completeEvidence(id: string, text: string): RequiredBulletCoachingEvidence {
  return {
    id,
    source_text: text,
    metrics: [],
    outcome: "Improved synthetic reliability.",
    evidence_strength: "verified",
    user_confirmed: true,
  };
}

describe("shared Required-bullet coaching policy", () => {
  it.each(fixtures)("$name", (fixture: Fixture) => {
    const profile = deepFreeze(structuredClone(fixture.profile));
    const before = JSON.stringify(profile);
    const first = generateRequiredBulletSuggestions(profile, fixture.profileVersion, fixture.maximumSuggestions);
    const second = generateRequiredBulletSuggestions(profile, fixture.profileVersion, fixture.maximumSuggestions);

    expect(first).toEqual(fixture.expected);
    expect(second).toEqual(fixture.expected);
    expect(second).not.toBe(first);
    expect(JSON.stringify(profile)).toBe(before);
  });

  it.each([255, 256, 257])("checks the raw entry budget at %i entries", (count: number) => {
    const profile = candidate();
    profile.resume.experience_entries.push(...Array.from({ length: count - 1 }, (_, index) => ({
      id: `optional-${index}`, title: "Synthetic Engineer", company: "Synthetic Co",
      bullets: [], achievement_evidence: [],
    })));
    const result = generateRequiredBulletSuggestions(profile, 7, 24);
    expect(result.truncated).toBe(count > MAX_REQUIRED_COACHING_ENTRIES);
    expect(result.suggestions).toHaveLength(count > MAX_REQUIRED_COACHING_ENTRIES ? 0 : 4);
  });

  it("rejects excess entries before reading their identities or row contents", () => {
    const profile = candidate();
    const guarded = profile.resume.experience_entries[0]!;
    for (const key of ["id", "bullets", "achievement_evidence"]) {
      Object.defineProperty(guarded, key, { get: () => { throw new Error(`read ${key}`); } });
    }
    profile.resume.experience_entries = Array.from({ length: 257 }, () => guarded);
    expect(generateRequiredBulletSuggestions(profile, 7, 1)).toMatchObject({
      suggestions: [], truncated: true, profileVersion: 7,
    });
  });

  it.each([4_095, 4_096, 4_097])("checks raw optional source rows at %i total rows", (rows: number) => {
    const profile = candidate();
    // Two pin rows (key + occurrence) and one entry row, before bullets.
    profile.resume.experience_entries[0]!.bullets.push(
      ...Array.from({ length: rows - 4 }, (_, index) => `Optional fact ${index}.`),
    );
    const result = generateRequiredBulletSuggestions(profile, 7, 24);
    expect(result.truncated).toBe(rows > MAX_REQUIRED_COACHING_SOURCE_ROWS);
    expect(result.suggestions).toHaveLength(rows > MAX_REQUIRED_COACHING_SOURCE_ROWS ? 0 : 4);
  });

  it.each(["bullets", "achievement_evidence"] as const)(
    "rejects over-budget %s before materializing rows",
    (collection: "bullets" | "achievement_evidence") => {
      const profile = candidate();
      const entry = profile.resume.experience_entries[0]!;
      const rows = Array.from({ length: 4_097 }, () => collection === "bullets"
        ? "Optional fact." : completeEvidence("optional-evidence", "Optional fact."));
      Object.defineProperty(rows, 0, { get: () => { throw new Error("row content read"); } });
      Object.defineProperty(entry, collection, { value: rows });
      expect(generateRequiredBulletSuggestions(profile, 7, 1)).toMatchObject({
        suggestions: [], truncated: true,
      });
    },
  );

  it("counts Required pin lengths before reading their contents or entry rows", () => {
    const profile = candidate();
    const pins = Array.from({ length: 4_097 }, () => REQUIRED_TEXT);
    Object.defineProperty(pins, 0, { get: () => { throw new Error("pin content read"); } });
    profile.resume.tailoring_rules.required_bullets_by_experience_id["exp-1"] = pins;
    Object.defineProperty(profile.resume.experience_entries[0]!, "bullets", {
      get: () => { throw new Error("entry rows read"); },
    });
    expect(generateRequiredBulletSuggestions(profile, 7, 1)).toMatchObject({
      suggestions: [], truncated: true,
    });
  });

  it("counts empty own pin-map keys toward the source budget", () => {
    const profile = candidate();
    profile.resume.tailoring_rules.required_bullets_by_experience_id = Object.fromEntries(
      Array.from({ length: 4_097 }, (_, index) => [`deleted-${index}`, []]),
    );
    Object.defineProperty(profile.resume.experience_entries[0]!, "bullets", {
      get: () => { throw new Error("entry rows read"); },
    });
    expect(generateRequiredBulletSuggestions(profile, 7, 1)).toMatchObject({
      suggestions: [], truncated: true,
    });
  });

  it.each([511, 512, 513])("limits Required inspection at %i occurrences even when evidence is complete", (count: number) => {
    const profile = candidate();
    const entry = profile.resume.experience_entries[0]!;
    entry.bullets = Array.from({ length: count }, (_, index) => `Delivered synthetic service ${index}.`);
    entry.achievement_evidence = entry.bullets.map((text, index) => completeEvidence(`achievement-${index}`, text));
    profile.resume.tailoring_rules.required_bullets_by_experience_id["exp-1"] = [...entry.bullets];
    expect(generateRequiredBulletSuggestions(profile, 7, 24)).toMatchObject({
      suggestions: [], truncated: count > 512,
    });
  });

  it("retains partial results when the Required occurrence limit ends the inspection", () => {
    const profile = candidate();
    const entry = profile.resume.experience_entries[0]!;
    const completed = Array.from({ length: 512 }, (_, index) => `Delivered synthetic service ${index}.`);
    entry.bullets = [REQUIRED_TEXT, ...completed];
    entry.achievement_evidence = completed.map((text, index) => completeEvidence(`achievement-${index}`, text));
    profile.resume.tailoring_rules.required_bullets_by_experience_id["exp-1"] = [...entry.bullets];
    const result = generateRequiredBulletSuggestions(profile, 7, 24);
    expect(result.truncated).toBe(true);
    expect(result.suggestions).toEqual(fixtures[0]!.expected.suggestions);
  });

  it.each([2_000, 2_001])("checks raw Required text length at %i characters", (length: number) => {
    const profile = candidate();
    const text = "x".repeat(length);
    profile.resume.experience_entries[0]!.bullets = [text];
    profile.resume.tailoring_rules.required_bullets_by_experience_id["exp-1"] = [text];
    const result = generateRequiredBulletSuggestions(profile, 7, 24);
    expect(result.truncated).toBe(length > 2_000);
    expect(result.suggestions).toHaveLength(length > 2_000 ? 0 : 2);
    expect(result.suggestions.every((item) => item.source.excerpt.length <= 500)).toBe(true);
  });

  it.each(["id", "title", "company"] as const)("bounds raw entry %s and rejects blank identity fields", (field: "id" | "title" | "company") => {
    for (const text of ["x".repeat(160), "x".repeat(161), " "]) {
      const profile = candidate();
      const entry = profile.resume.experience_entries[0]!;
      entry[field] = text;
      profile.resume.tailoring_rules.required_bullets_by_experience_id = { [entry.id]: [REQUIRED_TEXT] };
      const result = generateRequiredBulletSuggestions(profile, 7, 24);
      expect(result.truncated).toBe(text.length > 160 || !text.trim());
      expect(result.suggestions).toHaveLength(text.length > 160 || !text.trim() ? 0 : 4);
    }
  });

  it("indexes optional evidence sources once and stops outcome reads after enough suggestions", () => {
    const profile = candidate();
    const entry = profile.resume.experience_entries[0]!;
    entry.bullets = Array.from({ length: 100 }, (_, index) => `Required synthetic action ${index}.`);
    profile.resume.tailoring_rules.required_bullets_by_experience_id["exp-1"] = [...entry.bullets];
    let sourceReads = 0;
    const optional = completeEvidence("optional", "Optional fact.");
    Object.defineProperty(optional, "source_text", { get: () => { sourceReads += 1; return "Optional fact."; } });
    entry.achievement_evidence = [optional];
    const later = completeEvidence("later", "Later fact.");
    Object.defineProperty(later, "source_text", { get: () => { throw new Error("later source read"); } });
    profile.resume.experience_entries.push({
      id: "later", title: "Synthetic Engineer", company: "Synthetic Co",
      bullets: ["Later fact."], achievement_evidence: [later],
    });
    const result = generateRequiredBulletSuggestions(profile, 7, 1);
    expect(result.suggestions).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(sourceReads).toBe(1);
  });

  it("accepts an explicitly undefined Required pin map from a validated saved profile", () => {
    const input: RequiredBulletCoachingInput = {
      resume: {
        experience_entries: candidate().resume.experience_entries,
        tailoring_rules: { required_bullets_by_experience_id: undefined },
      },
    };
    expect(generateRequiredBulletSuggestions(deepFreeze(input), 7, 24)).toEqual({
      ok: true,
      profileVersion: 7,
      suggestions: [],
      strategy: "deterministic_rules_v1",
      modelUsed: false,
      truncated: false,
    });
  });

  it("ignores inherited pins and accepts absent tailoring rules without mutation", () => {
    const profile = candidate();
    profile.resume.tailoring_rules.required_bullets_by_experience_id = Object.create({
      "exp-1": [REQUIRED_TEXT],
    }) as Record<string, string[]>;
    expect(generateRequiredBulletSuggestions(profile, 7, 24)).toMatchObject({
      suggestions: [], truncated: false,
    });
    expect(generateRequiredBulletSuggestions({ resume: {
      experience_entries: profile.resume.experience_entries,
    } }, 7, 24)).toMatchObject({ suggestions: [], truncated: false });
  });
});
