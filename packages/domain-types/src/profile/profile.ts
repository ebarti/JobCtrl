/**
 * Candidate Profile aggregate — TypeScript mirror.
 *
 * See docs/architecture/domain-model/tactical.md §4.3. Every type in this file is an immutable, readonly
 * structure intended for transport between the API and consumers. The
 * Python ``Profile`` aggregate (``workers/automation/src/jobctl/domain/
 * profile/aggregate.py``) is the source of truth; both languages must stay
 * structurally compatible.
 */

import type { TenantId } from "../tenant.js";

// ---------------------------------------------------------------------------
// Enum-style discriminated unions
// ---------------------------------------------------------------------------

export const TAILORING_MODES = ["strict", "balanced", "aggressive"] as const;
export type TailoringMode = (typeof TAILORING_MODES)[number];

export const CLAIM_MODES = ["verified_only", "evidence_reframing", "adjacent_translation", "draft_requires_confirmation"] as const;
export type ClaimMode = (typeof CLAIM_MODES)[number];

export const AUTO_APPROVABLE_CLAIM_MODES = ["verified_only", "evidence_reframing", "adjacent_translation"] as const;
export type AutoApprovableClaimMode = (typeof AUTO_APPROVABLE_CLAIM_MODES)[number];

export const EVIDENCE_STRENGTHS = ["verified", "supported", "inferred", "draft"] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export const WRITING_TONES = ["direct", "executive", "technical", "confident", "warm"] as const;
export type WritingTone = (typeof WRITING_TONES)[number];

export const BULLET_STYLES = ["balanced", "impact", "technical_depth", "leadership"] as const;
export type BulletStyle = (typeof BULLET_STYLES)[number];

export const VERBOSITY_LEVELS = ["concise", "balanced", "detailed"] as const;
export type Verbosity = (typeof VERBOSITY_LEVELS)[number];

export const KEYWORD_DENSITIES = ["natural", "moderate", "high"] as const;
export type KeywordDensity = (typeof KEYWORD_DENSITIES)[number];

// ---------------------------------------------------------------------------
// Personal / Authorization / Compensation / Application defaults
// ---------------------------------------------------------------------------

export interface PersonalInfo {
  readonly fullName: string;
  readonly preferredName: string;
  readonly email: string;
  readonly phone: string;
  readonly address: string;
  readonly city: string;
  readonly provinceState: string;
  readonly country: string;
  readonly postalCode: string;
  readonly linkedinUrl: string;
  readonly githubUrl: string;
  readonly portfolioUrl: string;
  readonly websiteUrl: string;
  readonly password: string;
}

export interface WorkAuthorization {
  readonly legallyAuthorizedToWork: string;
  readonly requireSponsorship: string;
  readonly workPermitType: string;
}

export interface Compensation {
  readonly salaryExpectation: string;
  readonly salaryCurrency: string;
  readonly salaryRangeMin: string;
  readonly salaryRangeMax: string;
  readonly currencyConversionNote: string;
}

export interface Availability {
  readonly earliestStartDate: string;
  readonly availableForFullTime: string;
  readonly availableForContract: string;
}

export interface ExperienceMetadata {
  readonly yearsOfExperienceTotal: string;
  readonly educationLevel: string;
  readonly currentJobTitle: string;
  readonly currentCompany: string;
  readonly targetRole: string;
  readonly targetTrack: string;
  readonly targetSeniorityFloor: string;
  readonly targetFunctions: string;
  readonly targetSpecializations: string;
}

export interface EeoVoluntary {
  readonly gender: string;
  readonly raceEthnicity: string;
  readonly veteranStatus: string;
  readonly disabilityStatus: string;
}

export interface ApplicationDefaults {
  readonly availability: Availability;
  readonly eeoVoluntary: EeoVoluntary;
}

export interface ApplicationAttestations {
  readonly age18Plus: boolean | null;
  readonly backgroundCheckConsent: boolean | null;
  readonly felonyConviction: boolean | null;
  readonly previouslyWorkedAtEmployer: boolean | null;
  readonly additional: Readonly<Record<string, boolean | string | null>>;
}

export interface ApplicationPreferences {
  readonly howHeard: string;
}

// ---------------------------------------------------------------------------
// Resume baseline + structured entries
// ---------------------------------------------------------------------------

export interface ResumeBaseline {
  readonly baselineText: string;
}

export interface AchievementEvidence {
  readonly id: string;
  readonly sourceText: string;
  readonly scope: string;
  readonly action: string;
  readonly tools: readonly string[];
  readonly metrics: readonly string[];
  readonly outcome: string;
  readonly senioritySignal: string;
  readonly evidenceStrength: EvidenceStrength;
  readonly claimConfidence: number;
  readonly userConfirmed: boolean;
  readonly tags: readonly string[];
}

export interface ExperienceEntry {
  readonly id: string;
  readonly title: string;
  readonly company: string;
  readonly dateRange: string;
  readonly location: string;
  readonly bullets: readonly string[];
  readonly achievementEvidence: readonly AchievementEvidence[];
}

export interface EducationEntry {
  readonly id: string;
  readonly degree: string;
  readonly institution: string;
  readonly location: string;
  readonly date: string;
}

export interface SkillCategory {
  readonly id: string;
  readonly label: string;
  readonly items: readonly string[];
}

// ---------------------------------------------------------------------------
// Tailoring policy / writing style / constraints
// ---------------------------------------------------------------------------

export interface TailoringPolicy {
  readonly mode: TailoringMode;
  readonly allowTitleReframing: boolean;
  readonly allowAchievementRewriting: boolean;
  readonly allowSkillReordering: boolean;
  readonly allowSummaryRewrite: boolean;
  readonly allowMinorInference: boolean;
  readonly claimMode: ClaimMode;
  readonly autoApprovableClaimModes: readonly AutoApprovableClaimMode[];
  readonly allowAdjacentAchievementDrafts: boolean;
}

export interface WritingStyle {
  readonly tone: WritingTone;
  readonly bulletStyle: BulletStyle;
  readonly verbosity: Verbosity;
  readonly keywordDensity: KeywordDensity;
  readonly avoidFirstPerson: boolean;
}

export interface ResumeConstraints {
  readonly realMetrics: readonly string[];
}

export interface TailoringRules {
  readonly requiredExperienceEntryIds: readonly string[];
  readonly requiredEducationEntryIds: readonly string[];
  readonly requiredSkillCategoryIds: readonly string[];
  readonly requiredBulletsByExperienceId: Readonly<Record<string, readonly string[]>>;
  readonly maxExperienceBullets: number;
  readonly customTailoringPrompt: string;
  readonly tailoringPolicy: TailoringPolicy;
  readonly writingStyle: WritingStyle;
}

// ---------------------------------------------------------------------------
// Profile aggregate root
// ---------------------------------------------------------------------------

export const DEFAULT_PROFILE_ID = "default";

export interface ProfileId {
  readonly value: string;
}

export interface Profile {
  readonly tenantId: TenantId;
  readonly profileId: string;
  readonly personal: PersonalInfo;
  readonly workAuthorization: WorkAuthorization;
  readonly compensation: Compensation;
  readonly experienceMetadata: ExperienceMetadata;
  readonly applicationDefaults: ApplicationDefaults;
  readonly applicationAttestations: ApplicationAttestations;
  readonly applicationPreferences: ApplicationPreferences;
  readonly resumeBaseline: ResumeBaseline;
  readonly experienceEntries: readonly ExperienceEntry[];
  readonly educationEntries: readonly EducationEntry[];
  readonly skillCategories: readonly SkillCategory[];
  readonly tailoringRules: TailoringRules;
  readonly resumeConstraints: ResumeConstraints;
}
