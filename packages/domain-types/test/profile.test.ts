/**
 * Tests for the Candidate Profile types (Phase 4 / S-13).
 *
 * The TS types are pure compile-time interfaces, so the runtime tests focus
 * on (a) the literal-tuple enums staying frozen and structurally compatible
 * with the wire schema, and (b) the snapshot interface accepting the data
 * we'd actually serialise from Python's ``ProfileSnapshot.from_profile``.
 */

import { describe, it, expect } from "vitest";
import { LOCAL_TENANT } from "../src/tenant.js";
import {
  TAILORING_MODES,
  CLAIM_MODES,
  AUTO_APPROVABLE_CLAIM_MODES,
  EVIDENCE_STRENGTHS,
  WRITING_TONES,
  BULLET_STYLES,
  VERBOSITY_LEVELS,
  KEYWORD_DENSITIES,
  DEFAULT_PROFILE_ID,
  type Profile,
  type ProfileSnapshot,
  type ExperienceEntry,
} from "../src/profile/index.js";

describe("Profile types", () => {
  it("exposes the canonical TailoringMode enum", () => {
    expect(TAILORING_MODES).toEqual(["strict", "balanced", "aggressive"]);
  });

  it("exposes claim mode and evidence-strength enums", () => {
    expect(CLAIM_MODES).toEqual([
      "verified_only",
      "evidence_reframing",
      "adjacent_translation",
      "draft_requires_confirmation",
    ]);
    expect(AUTO_APPROVABLE_CLAIM_MODES).toEqual(["verified_only", "evidence_reframing"]);
    expect(EVIDENCE_STRENGTHS).toEqual(["verified", "supported", "inferred", "draft"]);
  });

  it("exposes the canonical WritingTone enum", () => {
    expect(WRITING_TONES).toEqual(["direct", "executive", "technical", "confident", "warm"]);
  });

  it("exposes BulletStyle, Verbosity, KeywordDensity enums", () => {
    expect(BULLET_STYLES).toEqual(["balanced", "impact", "technical_depth", "leadership"]);
    expect(VERBOSITY_LEVELS).toEqual(["concise", "balanced", "detailed"]);
    expect(KEYWORD_DENSITIES).toEqual(["natural", "moderate", "high"]);
  });

  it("DEFAULT_PROFILE_ID matches Python", () => {
    expect(DEFAULT_PROFILE_ID).toBe("default");
  });

  it("a fully specified Profile is structurally constructable", () => {
    const experience: ExperienceEntry = {
      id: "role_1",
      title: "Software Engineer",
      company: "Acme",
      dateRange: "2022 -- Present",
      location: "Remote",
      bullets: ["Shipped APIs."],
      achievementEvidence: [
        {
          id: "ev_role_1_latency",
          sourceText: "Reduced API latency 35%.",
          scope: "owned service",
          action: "replaced synchronous calls",
          tools: ["Python"],
          metrics: ["35% latency reduction"],
          outcome: "faster API responses",
          senioritySignal: "technical ownership",
          evidenceStrength: "verified",
          claimConfidence: 0.95,
          userConfirmed: true,
          tags: ["latency"],
        },
      ],
    };

    const profile: Profile = {
      tenantId: LOCAL_TENANT,
      profileId: DEFAULT_PROFILE_ID,
      personal: {
        fullName: "Jordan",
        preferredName: "",
        email: "jordan@example.com",
        phone: "",
        address: "",
        city: "",
        provinceState: "",
        country: "",
        postalCode: "",
        linkedinUrl: "",
        githubUrl: "",
        portfolioUrl: "",
        websiteUrl: "",
        password: "",
      },
      workAuthorization: {
        legallyAuthorizedToWork: "Yes",
        requireSponsorship: "No",
        workPermitType: "",
      },
      compensation: {
        salaryExpectation: "100000",
        salaryCurrency: "USD",
        salaryRangeMin: "",
        salaryRangeMax: "",
        currencyConversionNote: "",
      },
      experienceMetadata: {
        yearsOfExperienceTotal: "5",
        educationLevel: "",
        currentJobTitle: "",
        currentCompany: "",
        targetRole: "",
        targetTrack: "",
        targetSeniorityFloor: "",
        targetFunctions: "",
        targetSpecializations: "",
      },
      applicationDefaults: {
        availability: {
          earliestStartDate: "Immediately",
          availableForFullTime: "",
          availableForContract: "",
        },
        eeoVoluntary: {
          gender: "Decline to self-identify",
          raceEthnicity: "Decline to self-identify",
          veteranStatus: "Decline to self-identify",
          disabilityStatus: "Decline to self-identify",
        },
      },
      resumeBaseline: { baselineText: "Engineer." },
      experienceEntries: [experience],
      educationEntries: [],
      skillCategories: [{ id: "lang", label: "Languages", items: ["Python"] }],
      tailoringRules: {
        requiredExperienceEntryIds: ["role_1"],
        requiredEducationEntryIds: [],
        requiredSkillCategoryIds: ["lang"],
        requiredBulletsByExperienceId: {},
        maxExperienceBullets: 4,
        customTailoringPrompt: "",
        tailoringPolicy: {
          mode: "balanced",
          allowTitleReframing: false,
          allowAchievementRewriting: true,
          allowSkillReordering: true,
          allowSummaryRewrite: true,
          allowMinorInference: false,
          claimMode: "evidence_reframing",
          autoApprovableClaimModes: ["verified_only", "evidence_reframing"],
          allowAdjacentAchievementDrafts: false,
        },
        writingStyle: {
          tone: "direct",
          bulletStyle: "balanced",
          verbosity: "balanced",
          keywordDensity: "natural",
          avoidFirstPerson: true,
        },
      },
      resumeConstraints: { realMetrics: ["99%"] },
    };

    expect(profile.experienceEntries[0]?.id).toBe("role_1");
    expect(profile.experienceEntries[0]?.achievementEvidence[0]?.id).toBe("ev_role_1_latency");
    expect(profile.tailoringRules.tailoringPolicy.mode).toBe("balanced");
  });

  it("a ProfileSnapshot mirrors Profile data plus version + legacy view", () => {
    const snapshot: ProfileSnapshot = {
      tenantId: LOCAL_TENANT,
      profileId: DEFAULT_PROFILE_ID,
      version: 1,
      personal: {
        fullName: "Jordan",
        preferredName: "",
        email: "",
        phone: "",
        address: "",
        city: "",
        provinceState: "",
        country: "",
        postalCode: "",
        linkedinUrl: "",
        githubUrl: "",
        portfolioUrl: "",
        websiteUrl: "",
        password: "",
      },
      workAuthorization: {
        legallyAuthorizedToWork: "",
        requireSponsorship: "",
        workPermitType: "",
      },
      compensation: {
        salaryExpectation: "",
        salaryCurrency: "USD",
        salaryRangeMin: "",
        salaryRangeMax: "",
        currencyConversionNote: "",
      },
      experienceMetadata: {
        yearsOfExperienceTotal: "",
        educationLevel: "",
        currentJobTitle: "",
        currentCompany: "",
        targetRole: "",
        targetTrack: "",
        targetSeniorityFloor: "",
        targetFunctions: "",
        targetSpecializations: "",
      },
      applicationDefaults: {
        availability: {
          earliestStartDate: "",
          availableForFullTime: "",
          availableForContract: "",
        },
        eeoVoluntary: {
          gender: "Decline to self-identify",
          raceEthnicity: "Decline to self-identify",
          veteranStatus: "Decline to self-identify",
          disabilityStatus: "Decline to self-identify",
        },
      },
      resumeBaseline: { baselineText: "" },
      experienceEntries: [],
      educationEntries: [],
      skillCategories: [{ id: "lang", label: "Languages", items: ["Python"] }],
      tailoringRules: {
        requiredExperienceEntryIds: [],
        requiredEducationEntryIds: [],
        requiredSkillCategoryIds: [],
        requiredBulletsByExperienceId: {},
        maxExperienceBullets: 4,
        customTailoringPrompt: "",
        tailoringPolicy: {
          mode: "balanced",
          allowTitleReframing: false,
          allowAchievementRewriting: true,
          allowSkillReordering: true,
          allowSummaryRewrite: true,
          allowMinorInference: false,
          claimMode: "evidence_reframing",
          autoApprovableClaimModes: ["verified_only", "evidence_reframing"],
          allowAdjacentAchievementDrafts: false,
        },
        writingStyle: {
          tone: "direct",
          bulletStyle: "balanced",
          verbosity: "balanced",
          keywordDensity: "natural",
          avoidFirstPerson: true,
        },
      },
      resumeConstraints: { realMetrics: [] },
      legacy: {
        skillsBoundary: { lang: ["Python"] },
        resumeFacts: {
          preservedCompanies: [],
          preservedProjects: [],
          preservedSchool: "",
          realMetrics: [],
        },
      },
    };

    expect(snapshot.version).toBe(1);
    expect(snapshot.legacy.skillsBoundary).toEqual({ lang: ["Python"] });
    expect(snapshot.tenantId).toBe("local");
  });
});
