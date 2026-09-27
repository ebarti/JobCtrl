import { ProfileSchema, RequiredBulletSuggestionResponseSchema } from "@jobctrl/contracts";
import { describe, expect, it } from "vitest";

import { generateRequiredBulletSuggestions } from "../src/required-bullet-suggestions.js";

function profile() {
  return ProfileSchema.parse({
    resume: {
      experience_entries: [
        {
          id: "exp-1",
          title: "Platform Engineer",
          company: "Synthetic Co",
          bullets: ["  Worked   on platform reliability  ", "Reduced latency using verified traces."],
          achievement_evidence: [
            {
              id: "achievement-2",
              source_text: "Reduced latency using verified traces.",
              action: "Reduced latency",
              outcome: "Improved reliability",
              user_confirmed: true,
            },
          ],
        },
        {
          id: "exp-2",
          title: "Earlier Engineer",
          company: "Example Co",
          bullets: ["Unrequired bullet with   whitespace."],
        },
      ],
      tailoring_rules: {
        required_bullets_by_experience_id: {
          "exp-1": ["  Worked   on platform reliability  ", "Reduced latency using verified traces."],
        },
      },
    },
  });
}

describe("generateRequiredBulletSuggestions", () => {
  it("withholds an applicable cleanup when its saved result duplicates another bullet or Required pin", () => {
    const candidate = profile();
    candidate.resume.experience_entries[0]!.bullets[1] = "Worked on platform reliability";
    const result = generateRequiredBulletSuggestions(candidate, 7, 24);
    const grammar = result.suggestions.find((item) => item.kind === "grammar");
    expect(grammar).toMatchObject({
      originalText: "  Worked   on platform reliability  ",
      proposedText: null,
      canApply: false,
      source: { experienceId: "exp-1", bulletIndex: 0, requiredBulletIndex: 0 },
    });
    expect(grammar?.guidance).toMatch(/duplicate another saved bullet or Required pin/);

    candidate.resume.experience_entries[0]!.bullets[1] = "Reduced latency using verified traces.";
    candidate.resume.tailoring_rules.required_bullets_by_experience_id!["exp-1"]!.push(
      "Worked on platform reliability",
    );
    const orphanPin = generateRequiredBulletSuggestions(candidate, 7, 24).suggestions.find(
      (item) => item.kind === "grammar",
    );
    expect(orphanPin).toMatchObject({ canApply: false, proposedText: null });
  });

  it("reads required bullets only and preserves their facts in conservative replacements", () => {
    const result = generateRequiredBulletSuggestions(profile(), 7, 24);

    expect(result).toMatchObject({
      profileVersion: 7,
      strategy: "deterministic_rules_v1",
      modelUsed: false,
      truncated: false,
    });
    expect(result.suggestions.filter((item) => item.canApply)).toEqual([
      expect.objectContaining({
        kind: "grammar",
        originalText: "  Worked   on platform reliability  ",
        proposedText: "Worked on platform reliability",
        source: expect.objectContaining({
          identityKind: "snapshot_bullet",
          experienceId: "exp-1",
          bulletIndex: 0,
          requiredBulletIndex: 0,
        }),
      }),
    ]);
    expect(result.suggestions.some((item) => item.originalText.includes("Unrequired"))).toBe(false);
    expect(result.suggestions.some((item) => /\d/.test(item.proposedText ?? ""))).toBe(false);
  });

  it("resolves actual canonical achievement identity and keeps evidence-complete bullets quiet", () => {
    const result = generateRequiredBulletSuggestions(profile(), 11, 24);
    const secondBulletSuggestions = result.suggestions.filter(
      (item) => item.source.bulletIndex === 1,
    );

    expect(secondBulletSuggestions).toEqual([]);
    const missingEvidence = result.suggestions.find((item) => item.kind === "missing_evidence");
    expect(missingEvidence?.source.sourceId).toBe("profile:v11:experience[0]:bullet[0]");
    expect(missingEvidence?.source.identityKind).toBe("snapshot_bullet");
  });

  it("does not mistake a materialized legacy identity for substantive evidence", () => {
    const candidate = profile();
    candidate.resume.experience_entries[0]!.achievement_evidence.unshift({
      id: "exp-1_bullet_1",
      source_text: "Worked on platform reliability",
      scope: "Platform Engineer Synthetic Co",
      action: "Worked on platform reliability",
      tools: [],
      metrics: [],
      outcome: "Worked on platform reliability",
      seniority_signal: "",
      evidence_strength: "supported",
      claim_confidence: 0.8,
      user_confirmed: true,
      tags: [],
    });

    const result = generateRequiredBulletSuggestions(candidate, 7, 24);
    const missing = result.suggestions.find((item) => item.kind === "missing_evidence");
    expect(missing?.source).toMatchObject({
      sourceId: "exp-1_bullet_1",
      identityKind: "canonical_achievement",
    });
  });

  it("asks for evidence and outcome when a saved action count is only restated with punctuation", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.bullets = ["Managed 10 projects,"];
    entry.achievement_evidence = [{
      ...entry.achievement_evidence[0]!,
      id: "action-count",
      source_text: "Managed 10 projects,",
      action: "Managed 10 projects",
      metrics: ["10 projects"],
      outcome: "Managed 10 projects.",
      evidence_strength: "supported",
      user_confirmed: true,
    }];
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": ["Managed 10 projects,"],
    };

    const result = generateRequiredBulletSuggestions(candidate, 7, 24);
    expect(result.suggestions.map((item) => item.kind)).toEqual([
      "achievement_framing", "missing_evidence",
    ]);
    expect(result.suggestions.every((item) => item.source.sourceId === "action-count"
      && item.proposedText === null && !item.canApply)).toBe(true);

    entry.achievement_evidence[0]!.outcome = "Oversaw 10 projects across teams.";
    expect(generateRequiredBulletSuggestions(candidate, 7, 24).suggestions.map((item) => item.kind))
      .toEqual(["achievement_framing", "missing_evidence"]);
  });

  it("uses a snapshot identity when duplicate bullet evidence is ambiguous", () => {
    const candidate = profile();
    candidate.resume.experience_entries[0]!.achievement_evidence = [
      { ...candidate.resume.experience_entries[0]!.achievement_evidence[0]!, id: "achievement-a", source_text: "  Worked on platform reliability" },
      { ...candidate.resume.experience_entries[0]!.achievement_evidence[0]!, id: "achievement-b", source_text: "Worked   on platform reliability" },
    ];

    const result = generateRequiredBulletSuggestions(candidate, 7, 24);
    expect(result.suggestions[0]?.source).toMatchObject({
      identityKind: "snapshot_bullet",
      sourceId: "profile:v7:experience[0]:bullet[0]",
    });
    expect(result.suggestions[0]).toMatchObject({
      kind: "grammar",
      canApply: false,
      proposedText: null,
    });
  });

  it("counts matching evidence with unusable IDs and bounds every emitted source ID", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    const requiredText = entry.bullets[0]!;
    const evidence = entry.achievement_evidence[0]!;
    entry.achievement_evidence = [
      { ...evidence, id: "stable-id", source_text: requiredText },
      { ...evidence, id: "", source_text: requiredText },
    ];

    const ambiguous = generateRequiredBulletSuggestions(candidate, 7, 24);
    expect(ambiguous.suggestions.find((item) => item.kind === "grammar")).toMatchObject({
      canApply: false,
      proposedText: null,
      source: { identityKind: "snapshot_bullet", sourceId: "profile:v7:experience[0]:bullet[0]" },
    });
    expect(RequiredBulletSuggestionResponseSchema.safeParse(ambiguous).success).toBe(true);

    entry.achievement_evidence = [{ ...evidence, id: `x${" ".repeat(240)}`, source_text: requiredText }];
    const overlong = generateRequiredBulletSuggestions(candidate, 7, 24);
    expect(overlong.suggestions.find((item) => item.kind === "grammar")).toMatchObject({
      canApply: false,
      proposedText: null,
      source: { identityKind: "snapshot_bullet" },
    });
    expect(RequiredBulletSuggestionResponseSchema.safeParse(overlong).success).toBe(true);
  });

  it("does not choose one of identical saved bullet or Required-pin occurrences", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.bullets = ["  Repeated   claim  ", "  Repeated   claim  "];
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": ["  Repeated   claim  "],
    };

    expect(generateRequiredBulletSuggestions(candidate, 7, 24).suggestions).toEqual([]);
    entry.bullets = ["  Repeated   claim  "];
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": ["  Repeated   claim  ", "  Repeated   claim  "],
    };
    expect(generateRequiredBulletSuggestions(candidate, 7, 24).suggestions).toEqual([]);
  });

  it("asks for source confirmation when saved evidence is draft without treating a metric as missing", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.achievement_evidence[0] = {
      ...entry.achievement_evidence[0]!,
      metrics: ["40%"],
      evidence_strength: "draft",
      user_confirmed: false,
    };
    const result = generateRequiredBulletSuggestions(candidate, 7, 24);
    const metricSuggestions = result.suggestions.filter((item) => item.source.bulletIndex === 1);

    expect(metricSuggestions).toEqual([
      expect.objectContaining({
        kind: "missing_evidence",
        canApply: false,
        proposedText: null,
        guidance: expect.stringMatching(/draft, inferred, or unconfirmed/),
      }),
    ]);
  });

  it("gives unique suggestion IDs when separate experiences reuse an achievement ID", () => {
    const candidate = profile();
    const first = candidate.resume.experience_entries[0]!;
    const second = candidate.resume.experience_entries[1]!;
    first.achievement_evidence = [{
      ...first.achievement_evidence[0]!,
      id: "reused-id",
      source_text: first.bullets[0]!,
    }];
    second.bullets = ["  Other   claim  "];
    second.achievement_evidence = [{
      ...first.achievement_evidence[0]!,
      id: "reused-id",
      source_text: second.bullets[0]!,
    }];
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      ...(candidate.resume.tailoring_rules.required_bullets_by_experience_id ?? {}),
      "exp-2": [second.bullets[0]!],
    };
    const result = generateRequiredBulletSuggestions(candidate, 7, 24);
    expect(new Set(result.suggestions.map((item) => item.id)).size).toBe(result.suggestions.length);
    expect(result.suggestions.filter((item) => item.kind === "grammar")).toEqual([
      expect.objectContaining({ canApply: false, proposedText: null, source: expect.objectContaining({ identityKind: "snapshot_bullet" }) }),
      expect.objectContaining({ canApply: false, proposedText: null, source: expect.objectContaining({ identityKind: "snapshot_bullet" }) }),
    ]);
  });

  it("does not treat a tag or tool copied onto a restated bullet as independent evidence", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.achievement_evidence = [{
      ...entry.achievement_evidence[0]!,
      id: "restated-with-tags",
      source_text: entry.bullets[0]!,
      action: "Worked on platform reliability",
      outcome: "Worked on platform reliability",
      tools: ["Synthetic tool"],
      tags: ["platform"],
    }];

    const result = generateRequiredBulletSuggestions(candidate, 7, 24);
    expect(result.suggestions).toContainEqual(expect.objectContaining({
      kind: "missing_evidence",
      source: expect.objectContaining({ sourceId: "restated-with-tags" }),
    }));
  });

  it("bounds output and reports truncation", () => {
    const result = generateRequiredBulletSuggestions(profile(), 7, 2);
    expect(result.suggestions).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("bounds the scan even when every earlier Required bullet has complete evidence", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.bullets = Array.from({ length: 513 }, (_, index) => `Delivered synthetic system ${index}.`);
    entry.achievement_evidence = entry.bullets.map((bullet, index) => ({
      id: `synthetic-${index}`,
      source_text: bullet,
      scope: "Synthetic fixture",
      action: "Delivered a synthetic system",
      tools: [],
      metrics: [String(index)],
      outcome: `Improved reliability for synthetic system ${index}.`,
      seniority_signal: "",
      evidence_strength: "verified" as const,
      claim_confidence: 1,
      user_confirmed: true,
      tags: [],
    }));
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": [...entry.bullets],
    };

    const result = generateRequiredBulletSuggestions(candidate, 7, 24);
    expect(result.suggestions).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("stops before reading a large optional-bullet and evidence collection", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.bullets = [entry.bullets[0]!, ...Array.from({ length: 4_100 }, (_, index) => `Optional ${index}`)];
    entry.achievement_evidence = Array.from({ length: 4_100 }, (_, index) => ({
      ...entry.achievement_evidence[0]!,
      id: `optional-${index}`,
      source_text: `Optional ${index}`,
    }));
    Object.defineProperty(entry.bullets, 1, { get: () => { throw new Error("optional bullet was scanned"); } });
    Object.defineProperty(entry.achievement_evidence, 0, { get: () => { throw new Error("optional evidence was scanned"); } });

    expect(generateRequiredBulletSuggestions(candidate, 7, 1)).toMatchObject({
      suggestions: [],
      truncated: true,
      profileVersion: 7,
    });
  });

  it("indexes each evidence source once when many Required bullets share an entry", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.bullets = Array.from({ length: 100 }, (_, index) => `Required action ${index}.`);
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": [...entry.bullets],
    };
    let sourceReads = 0;
    const optionalEvidence = { ...entry.achievement_evidence[0]!, source_text: "An unrelated optional claim." };
    Object.defineProperty(optionalEvidence, "source_text", {
      get: () => { sourceReads += 1; return "An unrelated optional claim."; },
    });
    entry.achievement_evidence = [
      ...entry.bullets.map((bullet, index) => ({
        ...entry.achievement_evidence[0]!,
        id: `verified-${index}`,
        source_text: bullet,
        outcome: "Improved synthetic reliability.",
        evidence_strength: "verified" as const,
        user_confirmed: true,
      })),
      optionalEvidence,
    ];

    generateRequiredBulletSuggestions(candidate, 7, 1);
    expect(sourceReads).toBe(1);
  });
});
