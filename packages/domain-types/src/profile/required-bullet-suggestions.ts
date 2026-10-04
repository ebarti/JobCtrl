/**
 * Deterministic coaching over an already validated saved profile.
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
  strategy: "deterministic_rules_v1";
  modelUsed: false;
  truncated: boolean;
}

const MAX_INSPECTED_REQUIRED_BULLETS = 512;
export const MAX_REQUIRED_COACHING_ENTRIES = 256;
export const MAX_REQUIRED_COACHING_SOURCE_ROWS = 4_096;

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

// Describe the claim rather than penalizing an opening phrase. Function words
// and unspecified objects cannot supply context; domain nouns are unrestricted.
const CONTEXTLESS_WORDS = new Set([
  "a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "the", "to", "with",
  "i", "we", "it", "this", "that", "these", "those", "some", "various", "multiple",
  "things", "stuff", "tasks", "duties", "work", "initiatives", "responsibilities",
]);

function claimContext(text: string): string[] {
  // The first word is normally the resume action, not its object. Relevance
  // here means inspectable responsibility/result context, never job-fit scoring.
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(1)
    .filter((word) => !CONTEXTLESS_WORDS.has(word) && !/^\d+$/.test(word));
}

function statedResult(text: string): string | null {
  // Assess each clause separately so a goal, negation or activity count does
  // not become an achieved result merely because it contains a result verb.
  const clauses = text.split(/[,;]|\.(?:\s|$)/);
  for (const raw of clauses) {
    const clause = raw.trim();
    // Comparative structure works for any domain: "p99 latency 40%", "from
    // three days to one", "10x", or an explicit consequence of an action.
    const change = /\b(?:reduc(?:ed|ing|tion)|decreas(?:ed|ing|e)|lower(?:ed|ing)|cut(?:ting)?|improv(?:ed|ing|ement)|increas(?:ed|ing|e)|rais(?:ed|ing)|boost(?:ed|ing)|grew|grow(?:ing|th)|accelerat(?:ed|ing)|shorten(?:ed|ing)|eliminat(?:ed|ing)|prevent(?:ed|ing)|sav(?:ed|ing|ings)|scal(?:ed|ing)|doubl(?:ed|ing)|tripl(?:ed|ing))\b/i.exec(clause);
    const comparison = /\bfrom\s+\S+(?:\s+\S+){0,5}\s+to\s+\S+|\b\d+(?:[.,]\d+)?\s*(?:%|percent\b|x\b)|\b(?:faster|fewer|less|more)\b/i.test(clause);
    const consequence = /\b(?:enabl(?:ed|ing)|result(?:ed|ing) in|so that)\s+(.+)/i.exec(clause);
    const predicate = change ?? consequence;
    if (!predicate) continue;
    const prefix = clause.slice(0, predicate.index).replace(/\bnot only\b/gi, "");
    if (/\b(?:not|never|without|aimed|aiming|hoped|hoping|planned|planning|targeted|targeting|would|could|failed|tried)\b|n['’]t\b/i.test(prefix)
      || /\bto\s*(?:have\s+)?$/i.test(prefix)) continue;
    if (consequence && !/^no\b/i.test(consequence[1]!)
      && claimContext(`Result ${consequence[1]}`).length > 0) return clause;
    if (!change || claimContext(clause).length === 0) continue;
    // "Improved 10 dashboards" states inventory, not what changed about it.
    const object = clause.slice(change.index + change[0].length).trim();
    if (/^\d+(?:[.,]\d+)?\s+\p{L}/u.test(object) && !comparison) continue;
    if (object && !/^no\b/i.test(object) && (comparison || !/^\d/u.test(object))) return clause;
    // Passive result wording and metric labels: "35% latency reduction".
    if (comparison && claimContext(`Result ${clause}`).length > 1) return clause;
  }
  return null;
}

function boundedExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

function isSubstantiveEvidence(
  evidence: RequiredBulletCoachingEvidence,
): boolean {
  // Saved wording is not independent proof, however novel it sounds. The
  // canonical evidence-strength field is the available verification signal;
  // user confirmation is checked separately before suppressing the question.
  return evidence.evidence_strength === "verified";
}

function truncatedResponse(
  profileVersion: number,
): RequiredBulletCoachingResponse {
  return {
    ok: true,
    profileVersion,
    suggestions: [],
    strategy: "deterministic_rules_v1",
    modelUsed: false,
    truncated: true,
  };
}

export function generateRequiredBulletSuggestions(
  profile: RequiredBulletCoachingInput,
  profileVersion: number,
  maximumSuggestions: number,
): RequiredBulletCoachingResponse {
  const suggestions: RequiredBulletCoachingSuggestion[] = [];
  const entries = profile.resume.experience_entries;
  const requiredByExperience = profile.resume.tailoring_rules?.required_bullets_by_experience_id ?? {};
  // The limit is checked before reading bullet or evidence contents. A profile
  // beyond this budget cannot prove identity uniqueness, so fail closed instead
  // of producing an apparently applicable suggestion from a partial scan.
  if (entries.length > MAX_REQUIRED_COACHING_ENTRIES) return truncatedResponse(profileVersion);
  const entryIds = new Set(entries.map((entry) => entry.id));
  let sourceRows = 0;
  let orphanRequiredPins = false;
  for (const experienceId in requiredByExperience) {
    if (!Object.hasOwn(requiredByExperience, experienceId)) continue;
    const pins = requiredByExperience[experienceId]!;
    sourceRows += 1 + pins.length;
    if (sourceRows > MAX_REQUIRED_COACHING_SOURCE_ROWS) return truncatedResponse(profileVersion);
    if (pins.length > 0 && !entryIds.has(experienceId)) orphanRequiredPins = true;
  }
  for (const entry of entries) {
    sourceRows += 1 + entry.bullets.length + entry.achievement_evidence.length;
    if (sourceRows > MAX_REQUIRED_COACHING_SOURCE_ROWS) return truncatedResponse(profileVersion);
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
    if (suggestions.length > maximumSuggestions) break;
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
      if (suggestions.length > maximumSuggestions) break;
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
      const hasSubstantiveEvidence = achievement ? isSubstantiveEvidence(achievement) : false;
      // A stated outcome and independent verification are separate facts.
      // Read the bullet first, even without any canonical achievement. A saved
      // outcome or contextualized metric can supply framing, never proof.
      const bulletResult = statedResult(normalizedOriginal);
      const savedResult = achievement
        ? statedResult(achievement.outcome)
          ?? achievement.metrics.map(statedResult).find((result) => result !== null)
        : null;
      const hasOutcome = bulletResult !== null || Boolean(savedResult);
      const needsEvidence = !hasSubstantiveEvidence || achievement?.user_confirmed === false;
      const lacksContext = claimContext(normalizedOriginal).length === 0 && !hasOutcome;
      const claim = boundedExcerpt(normalizedOriginal).slice(0, 180);
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

      if (normalizedOriginal !== originalText) {
        const blockedProfileInputKey = entry.id === "__proto__";
        const canApply = !ambiguousAchievement && !proposedTextCollides && !blockedProfileInputKey;
        suggestions.push({
          id: `${idPrefix}:grammar`,
          kind: "grammar",
          originalText,
          proposedText: canApply ? normalizedOriginal : null,
          canApply,
          guidance: blockedProfileInputKey
            ? "This saved experience ID prevents a safe profile save. Correct the experience identity before editing this Required bullet."
            : proposedTextCollides
            ? "Whitespace cleanup would duplicate another saved bullet or Required pin. Resolve the duplicate identity before editing this text."
            : ambiguousAchievement
              ? "The saved achievement identity is ambiguous. Resolve it and edit whitespace manually; this suggestion cannot choose one record."
            : "Trim leading or trailing space and collapse repeated whitespace without changing the words or facts.",
          source,
        });
      }
      if (lacksContext) {
        suggestions.push({
          id: `${idPrefix}:relevance`,
          kind: "relevance",
          originalText,
          proposedText: null,
          canApply: false,
          guidance: `“${claim}” does not identify a specific responsibility or result in your ${entry.title} role. Which system, audience or deliverable did you work on? Add only details you can verify.`,
          source,
        });
      }
      if (!hasOutcome) {
        suggestions.push({
          id: `${idPrefix}:achievement-framing`,
          kind: "achievement_framing",
          originalText,
          proposedText: null,
          canApply: false,
          guidance: `“${claim}” describes an activity${/\d/.test(normalizedOriginal) ? " or its scale" : ""}, but does not state what changed because of it. What supported result followed? Leave it unchanged if none is available.`,
          source,
        });
      }
      if (needsEvidence) {
        suggestions.push({
          id: `${idPrefix}:missing-evidence`,
          kind: "missing_evidence",
          originalText,
          proposedText: null,
          canApply: false,
          guidance: `${hasOutcome ? `The stated result “${boundedExcerpt(bulletResult ?? savedResult ?? "").slice(0, 160)}” still needs independent support. ` : `The claim “${claim}” needs independent support. `}${!achievement
            ? "No unambiguous canonical achievement record matches this bullet. Which saved source supports its claim? Add only evidence you can verify in the normal editor."
            : achievement.evidence_strength === "draft"
              || achievement.evidence_strength === "inferred"
              || !achievement.user_confirmed
              ? "This achievement is marked draft, inferred, or unconfirmed. Which source verifies its claim? Review and confirm it in the normal editor before strengthening the wording."
              : "The matching achievement is not marked verified. Which independent source confirms the claim or metric? Add only verified details in the normal editor."}`,
          source,
        });
      }
    }
  }

  return {
    ok: true,
    profileVersion,
    suggestions: suggestions.slice(0, maximumSuggestions),
    strategy: "deterministic_rules_v1",
    modelUsed: false,
    truncated: scanTruncated || suggestions.length > maximumSuggestions,
  };
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
  return generateRequiredBulletSuggestions(profile, profileVersion, MAX_INSPECTED_REQUIRED_BULLETS * 4)
    .suggestions.some((candidate) => candidate.kind === "grammar" && candidate.canApply
      && candidate.originalText === suggestion.originalText
      && candidate.proposedText === suggestion.proposedText
      && (Object.keys(candidate.source) as (keyof typeof candidate.source)[])
        .every((key) => candidate.source[key] === suggestion.source[key]));
}
