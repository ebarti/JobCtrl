/**
 * ProfileSnapshot — published language for the Candidate Profile context.
 *
 * Mirrors ``workers/automation/src/jobctl/domain/profile/snapshot.py``.
 * Carries a ``version`` so consumers can detect stale snapshots and refuse
 * to mix data from two generations of the profile.
 *
 * Consumer contexts (Scoring, Materials, Apply) depend ONLY on this type —
 * never on the underlying ``Profile`` aggregate.
 */

import type { TenantId } from "../tenant.js";
import type {
  ApplicationDefaults,
  ApplicationAttestations,
  ApplicationPreferences,
  Compensation,
  EducationEntry,
  ExperienceEntry,
  ExperienceMetadata,
  PersonalInfo,
  ResumeBaseline,
  ResumeConstraints,
  SkillCategory,
  TailoringRules,
  WorkAuthorization,
} from "./profile.js";

/** Augmented (legacy) compatibility view — derived from the canonical schema
 * at snapshot construction time. Lets cover-letter / judge prompts keep
 * reading flat ``skills_boundary`` / ``resume_facts`` without the API having
 * to persist those fields separately. */
export interface ProfileSnapshotLegacyExtras {
  readonly skillsBoundary: Readonly<Record<string, readonly string[]>>;
  readonly resumeFacts: {
    readonly preservedCompanies: readonly string[];
    readonly preservedProjects: readonly string[];
    readonly preservedSchool: string;
    readonly realMetrics: readonly string[];
  };
}

export interface ProfileSnapshot {
  readonly tenantId: TenantId;
  readonly profileId: string;
  readonly version: number;

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

  readonly legacy: ProfileSnapshotLegacyExtras;
}
