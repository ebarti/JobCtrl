import { ProfileSchema, type ProfileConfigResponse } from "@jobctrl/contracts";
import { describe, expect, it } from "vitest";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import type { ProfileImportReviewDraft } from "../stores/profile-import-review-store.js";
import {
  buildImportAcceptance,
  importReviewSections,
  projectImportReview,
} from "./import-review.js";

function fixture(): ProfileImportReviewDraft & { base: ProfileConfigResponse } {
  const base = structuredClone(sampleProfileResponse);
  const profile = ProfileSchema.parse(ProfileSchema.parse(base.profile));
  profile.resume.experience_entries[0]!.achievement_evidence = [
    {
      id: "saved-evidence",
      source_text: "Synthetic accepted evidence",
      scope: "",
      action: "",
      tools: [],
      metrics: [],
      outcome: "",
      evidence_strength: "verified",
      claim_confidence: 1,
      user_confirmed: true,
      tags: [],
    },
  ];
  base.profile = profile;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    revision: 0,
    attempt: null,
    tenantId: "local",
    filename: "synthetic.pdf",
    importProfile: true,
    importStyle: true,
    base,
    result: {
      profile: {
        personal: { full_name: "Synthetic imported name" },
        resume: {
          executive_profile: { baseline_text: "Synthetic summary" },
          experience_entries: [
            {
              id: "import:experience:0",
              title: "Synthetic role",
              company: "Synthetic company",
              bullets: ["Synthetic bullet"],
              achievement_evidence: [{ user_confirmed: true }],
            },
          ],
          education_entries: [
            { degree: "Synthetic degree", institution: "Synthetic school" },
          ],
          skill_categories: [
            { label: "Synthetic skills", items: ["Synthetic skill"] },
          ],
        },
      },
      style: { font_family: "roman" },
      source: { attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), extractedPersonal: { full_name: "Synthetic imported name" },
        styleReceiptId: "00000000-0000-4000-8000-000000000001", inferredStyle: { font_family: "roman" } },
    },
  };
}

describe("resume import review", () => {
  it.each([1, 2])("accepts a valid projected v%s style directly", (version) => {
    const canonical = fixture().base;
    const input = { tenantId: "local", filename: "synthetic.pdf", importProfile: false, importStyle: true,
      base: canonical, result: { style: { font_family: "roman" }, source: {
        attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), styleReceiptId: "00000000-0000-4000-8000-000000000001", inferredStyle: { font_family: "roman" },
      } } };
    const reviewed = { ...projectImportReview(input), id: "00000000-0000-4000-8000-000000000001", revision: 0, projectionVersion: version, attempt: null };
    expect(buildImportAcceptance(reviewed, new Set(["style"]), canonical)).toMatchObject({
      expectedProfileVersion: canonical.profileVersion, style: { font_family: "roman" },
    });
  });

  it("accepts supported style fields from an older unprojected draft", () => {
    const reviewed = fixture();
    expect(buildImportAcceptance(reviewed, new Set(["style"]), reviewed.base)).toMatchObject({ style: { font_family: "roman" } });
  });

  it.each(["unsupported", "v1 extra style", "v2 extra style", "legacy extra style"])("refuses %s at the acceptance builder without mutating the draft", (kind) => {
    const canonical = fixture().base;
    const input = { tenantId: "local", filename: "synthetic.pdf", importProfile: false, importStyle: true,
      base: canonical, result: { style: { font_family: "roman" }, source: {
        attemptId: "00000000-0000-4000-8000-000000000001", determinationId: "a".repeat(64), styleReceiptId: "00000000-0000-4000-8000-000000000001", inferredStyle: { font_family: "roman" },
      } } };
    const reviewed: ProfileImportReviewDraft = { ...projectImportReview(input), id: "00000000-0000-4000-8000-000000000001", revision: 0,
      projectionVersion: kind === "unsupported" ? 3 : kind === "v1 extra style" ? 1 : kind === "v2 extra style" ? 2 : undefined,
      attempt: null };
    if (kind !== "unsupported") reviewed.result.style = { font_family: "roman", synthetic_unexpected: "synthetic-private-style" };
    const original = structuredClone(reviewed);
    expect(() => buildImportAcceptance(reviewed, new Set(["style"]), canonical)).toThrow(/review data could not be verified/i);
    expect(reviewed).toEqual(original);
  });

  it("saves only selected sections and preserves accepted evidence", () => {
    const draft = fixture();
    const before = structuredClone(draft.base.profile);
    expect(importReviewSections(draft).map((section) => section.id)).toEqual([
      "personal",
      "summary",
      "experience",
      "education",
      "skills",
      "style",
    ]);
    const request = buildImportAcceptance(draft, new Set(["experience"]), draft.base);
    expect(request.expectedProfileVersion).toBe(draft.base.profileVersion);
    expect(request.style).toBeUndefined();
    const saved = ProfileSchema.parse(request.profile);
    const original = ProfileSchema.parse(before);
    expect(saved.personal).toEqual(original.personal);
    expect(saved.resume.experience_entries[0]!.achievement_evidence).toEqual(
      original.resume.experience_entries[0]!.achievement_evidence,
    );
    expect(saved.resume.experience_entries.at(-1)).toMatchObject({
      title: "Synthetic role",
      bullets: ["Synthetic bullet"],
      achievement_evidence: [],
    });
    expect(saved.resume.education_entries).toEqual(
      original.resume.education_entries,
    );
    expect(saved.resume.skill_categories).toEqual(
      original.resume.skill_categories,
    );
    expect(draft.base.profile).toEqual(before);
  });

  it("uses distinct new IDs and fences first profile creation with null", () => {
    const draft = fixture();
    draft.base.profileVersion = null;
    draft.base.profile = {};
    const request = buildImportAcceptance(
      draft,
      new Set(["personal", "experience"]),
      draft.base,
    );
    expect(request.expectedProfileVersion).toBeNull();
    expect(
      ProfileSchema.parse(request.profile).resume.experience_entries[0]?.id,
    ).toBe("import:experience:00000000-0000-4000-8000-000000000001:0");
    expect(request.style).toBeUndefined();
  });

  it("never overwrites or duplicates an existing entry with this draft's identity", () => {
    const draft = fixture();
    const profile = ProfileSchema.parse(draft.base.profile);
    profile.resume.experience_entries.push({
      id: "import:experience:00000000-0000-4000-8000-000000000001:0", title: "Synthetic newer edit", company: "Synthetic company",
      date_range: "", location: "", summary: "", bullets: [], achievement_evidence: [],
    });
    draft.base.profile = profile;
    expect(() => buildImportAcceptance(draft, new Set(["experience"]), draft.base)).toThrow(/already exists/i);
    expect(profile.resume.experience_entries.at(-1)?.title).toBe("Synthetic newer edit");
  });

  it("refuses a selected section when a damaged base hides a field from review", () => {
    const draft = fixture();
    const canonical = structuredClone(draft.base);
    (draft.result.profile as { personal: { email: string } }).personal.email = "imported@example.invalid";
    (draft.result.source as { extractedPersonal: Record<string, string> }).extractedPersonal.email = "imported@example.invalid";
    (draft.base.profile as { personal: { email: string } }).personal.email = "imported@example.invalid";
    expect(importReviewSections(draft).find((section) => section.id === "personal")?.lines)
      .toEqual(["Full name: Synthetic imported name"]);
    expect(() => buildImportAcceptance(draft, new Set(["personal"]), canonical))
      .toThrow(/review fields changed/i);
    const experienceOnly = buildImportAcceptance(draft, new Set(["experience"]), canonical);
    expect(ProfileSchema.parse(experienceOnly.profile).personal.email)
      .toBe((canonical.profile as { personal: { email: string } }).personal.email);
  });

  it("does not accept unselected, unrequested, or unavailable sections", () => {
    const draft = fixture();
    draft.importStyle = false;
    expect(
      importReviewSections(draft).map((section) => section.id),
    ).not.toContain("style");
    expect(() => buildImportAcceptance(draft, new Set(), draft.base)).toThrow(
      /choose at least one/i,
    );
    expect(() => buildImportAcceptance(draft, new Set(["style"]), draft.base)).toThrow(
      /choose at least one/i,
    );
    const styleOnly = fixture();
    styleOnly.base.profileVersion = null;
    styleOnly.base.profile = {};
    expect(() => buildImportAcceptance(styleOnly, new Set(["style"]), styleOnly.base)).toThrow(
      /create a profile/i,
    );
    const emptyStyle = fixture();
    emptyStyle.result.style = {};
    expect(importReviewSections(emptyStyle).map((section) => section.id)).not.toContain("style");
  });
});
