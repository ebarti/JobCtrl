/**
 * Source preparation and safe acceptance over an already validated saved profile.
 *
 * These readonly structural inputs retain the saved-profile field names so
 * adapters can pass their snapshot directly, without copying unbounded rows.
 * Validation, version fencing and explicit acceptance belong to the adapters.
 * No provider, persistence or browser capabilities are used here.
 */
import type { EvidenceStrength } from "./profile.js";

export interface RequiredBulletCoachingEvidence {
  readonly id: string;
  readonly source_text: string;
  readonly metrics: readonly string[];
  readonly outcome: string;
  readonly evidence_strength: EvidenceStrength;
  readonly user_confirmed: boolean;
}

export interface RequiredBulletCoachingInput {
  readonly resume: {
    readonly experience_entries: readonly {
      readonly id: string;
      readonly title: string;
      readonly company: string;
      readonly bullets: readonly string[];
      readonly achievement_evidence: readonly RequiredBulletCoachingEvidence[];
    }[];
    readonly tailoring_rules?: {
      readonly required_bullets_by_experience_id?: Readonly<Record<string, readonly string[]>> | undefined;
    };
  };
}

// Result shapes are structurally assignable to the wire response. The domain
// owner has no upward dependency on contracts or their runtime validation.
export interface RequiredBulletCoachingSuggestion {
  id: string;
  kind: "grammar" | "relevance" | "achievement_framing" | "missing_evidence";
  originalText: string;
  proposedText: string | null;
  canApply: boolean;
  guidance: string;
  source: {
    sourceId: string;
    identityKind: "canonical_achievement" | "snapshot_bullet";
    excerpt: string;
    fieldPath: string;
    experienceId: string;
    experienceTitle: string;
    experienceCompany: string;
    bulletIndex: number;
    requiredBulletIndex: number;
  };
}

export interface RequiredBulletCoachingResponse {
  ok: true;
  profileVersion: number;
  suggestions: RequiredBulletCoachingSuggestion[];
  strategy: "model_v1";
  modelUsed: boolean;
  truncated: boolean;
}

const MAX_INSPECTED_REQUIRED_BULLETS = 512;
export const MAX_REQUIRED_COACHING_ENTRIES = 256;
export const MAX_REQUIRED_COACHING_SOURCE_ROWS = 4_096;

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function boundedExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

export interface RequiredBulletModelJudgment {
  reference: string;
  kind: RequiredBulletCoachingSuggestion["kind"];
  guidance: string;
  proposedText: string | null;
}

export interface RequiredBulletCoachingSource {
  reference: string;
  originalText: string;
  source: RequiredBulletCoachingSuggestion["source"];
  evidence: RequiredBulletCoachingEvidence[];
  cleanupText: string | null;
}

export interface RequiredBulletCoachingPreparation {
  profileVersion: number;
  sources: RequiredBulletCoachingSource[];
  truncated: boolean;
}

function truncatedPreparation(profileVersion: number): RequiredBulletCoachingPreparation {
  return { profileVersion, sources: [], truncated: true };
}

export function prepareRequiredBulletCoaching(
  profile: RequiredBulletCoachingInput,
  profileVersion: number,
): RequiredBulletCoachingPreparation {
  const sources: RequiredBulletCoachingSource[] = [];
  const entries = profile.resume.experience_entries;
  const requiredByExperience = profile.resume.tailoring_rules?.required_bullets_by_experience_id ?? {};
  // The limit is checked before reading bullet or evidence contents. A profile
  // beyond this budget cannot prove identity uniqueness, so fail closed instead
  // of producing an apparently applicable suggestion from a partial scan.
  if (entries.length > MAX_REQUIRED_COACHING_ENTRIES) return truncatedPreparation(profileVersion);
  const entryIds = new Set(entries.map((entry) => entry.id));
  let sourceRows = 0;
  let orphanRequiredPins = false;
  for (const experienceId in requiredByExperience) {
    if (!Object.hasOwn(requiredByExperience, experienceId)) continue;
    const pins = requiredByExperience[experienceId]!;
    sourceRows += 1 + pins.length;
    if (sourceRows > MAX_REQUIRED_COACHING_SOURCE_ROWS) return truncatedPreparation(profileVersion);
    if (pins.length > 0 && !entryIds.has(experienceId)) orphanRequiredPins = true;
  }
  for (const entry of entries) {
    sourceRows += 1 + entry.bullets.length + entry.achievement_evidence.length;
    if (sourceRows > MAX_REQUIRED_COACHING_SOURCE_ROWS) return truncatedPreparation(profileVersion);
  }
  const entryIdCounts = new Map<string, number>();
  for (const entry of entries) entryIdCounts.set(entry.id, (entryIdCounts.get(entry.id) ?? 0) + 1);
  const achievementIdCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const evidence of entry.achievement_evidence) {
      if (evidence.id.trim()) {
        achievementIdCounts.set(evidence.id, (achievementIdCounts.get(evidence.id) ?? 0) + 1);
      }
    }
  }
  let inspectedBullets = 0;
  let scanTruncated = orphanRequiredPins;

  scan: for (const [experienceIndex, entry] of entries.entries()) {
    // A save addresses Required pins by experience ID. Duplicate IDs cannot be
    // resolved to one owning entry, even when a positional path is available.
    if (entryIdCounts.get(entry.id) !== 1) continue;
    const requiredBullets = Object.hasOwn(requiredByExperience, entry.id)
      ? requiredByExperience[entry.id] ?? [] : [];
    const bulletIndexesByText = new Map<string, number[]>();
    for (const [index, bullet] of entry.bullets.entries()) {
      const indexes = bulletIndexesByText.get(bullet) ?? [];
      indexes.push(index);
      bulletIndexesByText.set(bullet, indexes);
    }
    const requiredCounts = new Map<string, number>();
    for (const bullet of requiredBullets) {
      requiredCounts.set(bullet, (requiredCounts.get(bullet) ?? 0) + 1);
    }
    const achievementsBySource = new Map<string, RequiredBulletCoachingEvidence[]>();
    for (const evidence of entry.achievement_evidence) {
      const source = normalizedText(evidence.source_text);
      const matches = achievementsBySource.get(source) ?? [];
      matches.push(evidence);
      achievementsBySource.set(source, matches);
    }
    for (const [requiredBulletIndex, requiredText] of requiredBullets.entries()) {
        if (inspectedBullets >= MAX_INSPECTED_REQUIRED_BULLETS) {
        scanTruncated = true;
        break scan;
      }
      inspectedBullets += 1;
      if (
        requiredText.length > 2_000
        || entry.id.length > 160
        || !entry.id.trim()
        || entry.title.length > 160
        || !entry.title.trim()
        || entry.company.length > 160
        || !entry.company.trim()
      ) {
        scanTruncated = true;
        continue;
      }
      // Required pins store text, not an occurrence ID. An identical bullet or
      // pin has no provable one-to-one mapping, so never guess which to edit.
      if (
        bulletIndexesByText.get(requiredText)?.length !== 1
        || requiredCounts.get(requiredText) !== 1
      ) continue;
      const bulletIndex = bulletIndexesByText.get(requiredText)![0]!;
      const originalText = entry.bullets[bulletIndex]!;
      const normalizedOriginal = normalizedText(originalText);
      if (!normalizedOriginal) continue;
      const proposedTextCollides = normalizedOriginal !== originalText
        && (bulletIndexesByText.has(normalizedOriginal) || requiredCounts.has(normalizedOriginal));
      const matchingAchievements = achievementsBySource.get(normalizedOriginal) ?? [];
      // Duplicate bullets can have distinct durable evidence identities. Do not
      // guess which one owns an occurrence when the snapshot cannot prove it.
      // Invalid IDs still count as matching rows; they cannot make another row
      // unique by disappearing from the identity check.
      const onlyMatch = matchingAchievements.length === 1 ? matchingAchievements[0] : undefined;
      const uniqueMatch = onlyMatch?.id.trim() && onlyMatch.id.length <= 240 ? onlyMatch : undefined;
      const ambiguousAchievement = matchingAchievements.length > 1
        || (onlyMatch !== undefined && uniqueMatch === undefined)
        || (uniqueMatch !== undefined && achievementIdCounts.get(uniqueMatch.id) !== 1);
      const achievement = ambiguousAchievement ? undefined : uniqueMatch;
      const identityKind = achievement ? "canonical_achievement" as const : "snapshot_bullet" as const;
      const sourceId = achievement
        ? achievement.id
        : `profile:v${profileVersion}:experience[${experienceIndex}]:bullet[${bulletIndex}]`;
      const source = {
        sourceId,
        identityKind,
        excerpt: boundedExcerpt(originalText),
        fieldPath: `profile.resume.experience_entries[${experienceIndex}].bullets[${bulletIndex}]`,
        experienceId: entry.id,
        experienceTitle: entry.title,
        experienceCompany: entry.company,
        bulletIndex,
        requiredBulletIndex,
      };
      const idPrefix = `profile:v${profileVersion}:experience[${experienceIndex}]:bullet[${bulletIndex}]:required[${requiredBulletIndex}]`;

      // These are mechanical safeguards. They never decide whether a finding
      // exists; the model must return each finding explicitly.
      const cleanupText = normalizedOriginal !== originalText && !ambiguousAchievement
        && !proposedTextCollides && entry.id !== "__proto__" ? normalizedOriginal : null;
      const evidence = matchingAchievements.map((item) => ({ id: item.id, source_text: item.source_text, metrics: [...item.metrics], outcome: item.outcome, evidence_strength: item.evidence_strength, user_confirmed: item.user_confirmed }));
      const candidate = { reference: idPrefix, originalText, source, evidence, cleanupText };
      // Bound the complete provider payload, including evidence, before any call.
      if (JSON.stringify(candidate).length > 8_000) { scanTruncated = true; continue; }
      sources.push(candidate);
    }
  }
  let total = 0;
  const bounded = sources.filter((candidate) => {
    total += JSON.stringify(candidate).length;
    if (total > 24_000) { scanTruncated = true; return false; }
    return true;
  });
  return { profileVersion, sources: bounded, truncated: scanTruncated };
}

/** Bind model decisions to canonical saved sources; never infer findings. */
export function bindRequiredBulletSuggestions(
  profile: RequiredBulletCoachingInput,
  profileVersion: number,
  maximumSuggestions: number,
  judgments: readonly RequiredBulletModelJudgment[],
  modelUsed: boolean,
): RequiredBulletCoachingResponse {
  return bindRequiredBulletJudgments(prepareRequiredBulletCoaching(profile, profileVersion), judgments, maximumSuggestions, modelUsed);
}

export function bindRequiredBulletJudgments(
  preparation: RequiredBulletCoachingPreparation,
  judgments: readonly RequiredBulletModelJudgment[],
  maximumSuggestions: number,
  modelUsed: boolean,
): RequiredBulletCoachingResponse {
  if (!modelUsed && judgments.length > 0) throw new Error("Findings require a completed model call");
  const seen = new Set<string>();
  const suggestions = judgments.map((judgment): RequiredBulletCoachingSuggestion => {
    const candidate = preparation.sources.find((item) => item.reference === judgment.reference);
    const id = `${judgment.reference}:${judgment.kind}`;
    if (!candidate || seen.has(id)) throw new Error("Invalid model source reference or duplicate finding");
    seen.add(id);
    const proposedText = judgment.kind === "grammar" && judgment.proposedText === candidate.cleanupText
      ? candidate.cleanupText : null;
    return { id, kind: judgment.kind, guidance: judgment.guidance, originalText: candidate.originalText,
      source: candidate.source, proposedText, canApply: proposedText !== null };
  });
  return { ok: true, profileVersion: preparation.profileVersion,
    suggestions: suggestions.slice(0, maximumSuggestions), strategy: "model_v1", modelUsed,
    truncated: preparation.truncated || suggestions.length > maximumSuggestions };
}

/** Recheck applicability against the saved snapshot using the policy's identity
 * and collision rules. Adapters still own validation, version/write fencing.
 * Guidance and presentation IDs do not authorize a write. */
export function isApplicableRequiredBulletCleanup(
  profile: RequiredBulletCoachingInput,
  profileVersion: number,
  suggestion: RequiredBulletCoachingSuggestion,
): boolean {
  if (suggestion.kind !== "grammar" || !suggestion.canApply || suggestion.proposedText === null) return false;
  return prepareRequiredBulletCoaching(profile, profileVersion).sources.some((candidate) =>
    candidate.cleanupText !== null && candidate.originalText === suggestion.originalText
    && candidate.cleanupText === suggestion.proposedText
    && (Object.keys(candidate.source) as (keyof typeof candidate.source)[])
      .every((key) => candidate.source[key] === suggestion.source[key]));
}
