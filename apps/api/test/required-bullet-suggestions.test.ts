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
              evidence_strength: "verified",
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

  it("marks pins for deleted experience identities as uninspected", () => {
    const candidate = profile();
    candidate.resume.tailoring_rules.required_bullets_by_experience_id!["deleted-exp"] = [
      `Orphan Required claim ${"x".repeat(2_000)}`,
    ];
    const result = generateRequiredBulletSuggestions(candidate, 7, 24);
    expect(result.truncated).toBe(true);
    expect(result.suggestions.some((item) => item.source.experienceId === "exp-1")).toBe(true);
    expect(result.suggestions.some((item) => item.source.experienceId === "deleted-exp")).toBe(false);
    expect(RequiredBulletSuggestionResponseSchema.safeParse(result).success).toBe(true);
  });

  it("bounds inspection of empty orphan pin lists before traversing an unbounded map", () => {
    const candidate = profile();
    const pins = candidate.resume.tailoring_rules.required_bullets_by_experience_id!;
    for (let index = 0; index < 4_100; index += 1) pins[`deleted-${index}`] = [];
    expect(generateRequiredBulletSuggestions(candidate, 7, 1)).toMatchObject({
      suggestions: [], truncated: true,
    });
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

  it("keeps framing advice for a verified action count despite an outcome-sounding verb", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.bullets = ["Improved 10 dashboards."];
    entry.achievement_evidence = [{
      ...entry.achievement_evidence[0]!,
      id: "verified-action-count",
      source_text: entry.bullets[0]!,
      action: "Improved dashboards",
      metrics: ["10 dashboards"],
      outcome: "",
      evidence_strength: "verified",
      user_confirmed: true,
    }];
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": [entry.bullets[0]!],
    };
    expect(generateRequiredBulletSuggestions(candidate, 7, 24).suggestions.map((item) => item.kind))
      .toEqual(["achievement_framing"]);

    entry.achievement_evidence[0]!.outcome = "Improved 10 dashboards for teams.";
    expect(generateRequiredBulletSuggestions(candidate, 7, 24).suggestions.map((item) => item.kind))
      .toEqual(["achievement_framing"]);
    entry.achievement_evidence[0]!.outcome = "";

    entry.achievement_evidence[0]!.metrics = ["35% latency reduction"];
    expect(generateRequiredBulletSuggestions(candidate, 7, 24).suggestions).toEqual([]);

    entry.bullets = ["Reduced latency by 10%."];
    entry.achievement_evidence[0]!.source_text = entry.bullets[0]!;
    entry.achievement_evidence[0]!.metrics = ["10%"];
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": [entry.bullets[0]!],
    };
    expect(generateRequiredBulletSuggestions(candidate, 7, 24).suggestions).toEqual([]);
  });

  it.each(["constructor", "toString", "__proto__"])(
    "reads %s as an own experience ID and never an inherited pin",
    (experienceId) => {
      const candidate = profile();
      const entry = candidate.resume.experience_entries[1]!;
      entry.id = experienceId;
      entry.bullets = ["  Special   Required claim  "];
      const pins = candidate.resume.tailoring_rules.required_bullets_by_experience_id!;
      const originalPrototype = Object.getPrototypeOf(pins);
      const withoutPin = generateRequiredBulletSuggestions(candidate, 7, 24);
      expect(withoutPin.suggestions.some((item) => item.source.experienceId === experienceId)).toBe(false);
      expect(withoutPin.suggestions.some((item) => item.source.experienceId === "exp-1")).toBe(true);

      Object.defineProperty(pins, experienceId, {
        value: [entry.bullets[0]!], enumerable: true, writable: true, configurable: true,
      });
      const withPin = generateRequiredBulletSuggestions(candidate, 7, 24);
      expect(withPin.suggestions).toContainEqual(expect.objectContaining({
        kind: "grammar",
        canApply: experienceId !== "__proto__",
        source: expect.objectContaining({ experienceId, bulletIndex: 0 }),
      }));
      expect(Object.getPrototypeOf(pins)).toBe(originalPrototype);
      expect(Object.hasOwn(pins, experienceId)).toBe(true);
      expect(RequiredBulletSuggestionResponseSchema.safeParse(withPin).success).toBe(true);
    },
  );

  it("does not treat a reordered or grammatical restatement as independent evidence", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.bullets = ["Reduced latency by 10%."];
    entry.achievement_evidence = [{
      ...entry.achievement_evidence[0]!,
      id: "reordered-outcome",
      source_text: entry.bullets[0]!,
      metrics: ["10%"],
      outcome: "Latency reduced by 10%.",
      evidence_strength: "supported",
      user_confirmed: true,
    }];
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": [entry.bullets[0]!],
    };

    for (const outcome of ["Latency reduced by 10%.", "Latency was reduced by 10 percent."]) {
      entry.achievement_evidence[0]!.outcome = outcome;
      const result = generateRequiredBulletSuggestions(candidate, 7, 24);
      expect(result.suggestions).toContainEqual(expect.objectContaining({
        kind: "missing_evidence",
        proposedText: null,
        canApply: false,
        source: expect.objectContaining({ sourceId: "reordered-outcome" }),
      }));
    }
  });

  it("requires verification even when a supported outcome adds different words", () => {
    const candidate = profile();
    const evidence = candidate.resume.experience_entries[0]!.achievement_evidence[0]!;
    evidence.evidence_strength = "supported";
    evidence.outcome = "Improved reliability across the platform.";
    const result = generateRequiredBulletSuggestions(candidate, 7, 24);
    const secondBullet = result.suggestions.filter((item) => item.source.bulletIndex === 1);
    expect(secondBullet.map((item) => item.kind)).toEqual(["missing_evidence"]);
    expect(secondBullet[0]?.guidance).toMatch(/not marked verified/);
  });

  it("keeps framing and evidence questions for plural possessives and contextual filler", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.bullets = ["Reduced process latency."];
    entry.achievement_evidence = [{
      ...entry.achievement_evidence[0]!,
      id: "contextual-restatement",
      source_text: entry.bullets[0]!,
      outcome: "Reduced processes' latency in this role.",
      evidence_strength: "supported",
      user_confirmed: true,
    }];
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": [entry.bullets[0]!],
    };
    expect(generateRequiredBulletSuggestions(candidate, 7, 24).suggestions.map((item) => item.kind))
      .toEqual(["achievement_framing", "missing_evidence"]);
  });

  it("does not count contextual wording as a new result in verified saved evidence", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.bullets = ["Reduced API latency."];
    entry.achievement_evidence = [{
      ...entry.achievement_evidence[0]!,
      id: "context-only-outcome",
      source_text: entry.bullets[0]!,
      metrics: [],
      outcome: "Reduced API latency during planning.",
      evidence_strength: "verified",
      user_confirmed: true,
    }];
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": [entry.bullets[0]!],
    };

    expect(generateRequiredBulletSuggestions(candidate, 7, 24).suggestions.map((item) => item.kind))
      .toEqual(["achievement_framing"]);
    entry.achievement_evidence[0]!.outcome = "Reduced API latency by 35%.";
    expect(generateRequiredBulletSuggestions(candidate, 7, 24).suggestions).toEqual([]);
  });

  it("asks both questions when a possessive is the only new outcome token", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    entry.bullets = ["Reduced team latency."];
    entry.achievement_evidence = [{
      ...entry.achievement_evidence[0]!,
      id: "possessive-restatement",
      source_text: entry.bullets[0]!,
      metrics: [],
      outcome: "Reduced team's latency.",
      evidence_strength: "supported",
      user_confirmed: true,
    }];
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": [entry.bullets[0]!],
    };

    for (const outcome of [
      "Reduced team's latency.",
      "Reduced team’s latency.",
      "Decreased teams' latency.",
    ]) {
      entry.achievement_evidence[0]!.outcome = outcome;
      expect(generateRequiredBulletSuggestions(candidate, 7, 24).suggestions.map((item) => item.kind))
        .toEqual(["achievement_framing", "missing_evidence"]);
    }
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
      evidence_strength: "supported",
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

  it("reports incomplete inspection when a saved Required source cannot fit the response contract", () => {
    const candidate = profile();
    const entry = candidate.resume.experience_entries[0]!;
    const longBullet = `Saved claim ${"x".repeat(2_000)}`;
    entry.bullets[0] = longBullet;
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": [longBullet],
    };
    expect(generateRequiredBulletSuggestions(candidate, 7, 24)).toMatchObject({
      suggestions: [], truncated: true,
    });

    entry.bullets[0] = "Unrelated short bullet.";
    expect(generateRequiredBulletSuggestions(candidate, 7, 24)).toMatchObject({
      suggestions: [], truncated: true,
    });

    entry.bullets[0] = "  Worked   on platform reliability  ";
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": [entry.bullets[0], longBullet],
    };
    const partial = generateRequiredBulletSuggestions(candidate, 7, 24);
    expect(partial.truncated).toBe(true);
    expect(partial.suggestions).toContainEqual(expect.objectContaining({ kind: "grammar" }));

    entry.bullets[0] = "Required claim.";
    candidate.resume.tailoring_rules.required_bullets_by_experience_id = {
      "exp-1": ["Required claim."],
    };
    entry.title = "T".repeat(161);
    expect(generateRequiredBulletSuggestions(candidate, 7, 24)).toMatchObject({
      suggestions: [], truncated: true,
    });

    entry.title = "Engineer";
    entry.company = "C".repeat(161);
    expect(generateRequiredBulletSuggestions(candidate, 7, 24)).toMatchObject({
      suggestions: [], truncated: true,
    });
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
