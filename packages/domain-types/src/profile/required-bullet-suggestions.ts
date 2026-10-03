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

const VAGUE_RELEVANCE = /\b(responsible for|worked on|helped(?: with)?|participated in|various|multiple tasks|duties included)\b/i;
const MAX_INSPECTED_REQUIRED_BULLETS = 512;
export const MAX_REQUIRED_COACHING_ENTRIES = 256;
export const MAX_REQUIRED_COACHING_SOURCE_ROWS = 4_096;
const RESULT_LANGUAGE = /\b(reduced|decreased|lowered|cut|improved|increased|raised|boosted|grew|accelerated|shortened|eliminated|prevented|faster|slower|fewer)\b/i;
const RESULT_TARGET = /\b(latency|response time|load time|deployment time|uptime|downtime|error rate|errors?|defects?|incidents?|costs?|expenses?|spend|revenue|conversion|retention|throughput|processing time|cycle time|reliability|performance)\b/i;
const RESULT_DIRECTION = /\b(reduced|reduction|decreased|decrease|lowered|cut|improved|improvement|increased|increase|raised|boosted|grew|growth|accelerated|shortened|eliminated|prevented|faster|slower|fewer|saved|savings)\b/i;
const RESULT_QUANTITY = /(?:\b\d+(?:[.,]\d+)?\s*(?:%|percent\b|ms\b|milliseconds?\b|seconds?\b|minutes?\b|hours?\b|days?\b)|[$£€]\s*\d+(?:[.,]\d+)?)/i;
const BARE_RESULT_QUANTITY = /^(?:\d+(?:[.,]\d+)?\s*(?:%|percent|ms|milliseconds?|seconds?|minutes?|hours?|days?)|[$£€]\s*\d+(?:[.,]\d+)?)$/i;

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function claimSignature(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const CLAIM_CONNECTORS = new Set([
  "a", "an", "and", "at", "be", "been", "by", "for", "from", "in", "is", "of", "on", "role", "s", "the", "this", "to", "was", "were", "with",
]);

function claimFacts(value: string): string[] {
  return claimSignature(value.normalize("NFKC")
    .replace(/([\p{L}\p{N}])['’]s\b/gu, "$1")
    .replace(/%/g, " percent "))
    .split(" ")
    .filter((token) => (token.length > 1 || /^\d$/.test(token))
      && !CLAIM_CONNECTORS.has(token)
      && !RESULT_LANGUAGE.test(token))
    .map((token) => token.length > 5 && token.endsWith("sses")
      ? token.slice(0, -2)
      : token.length > 4 && token.endsWith("ies")
      ? `${token.slice(0, -3)}y`
      : token.length > 4 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("is")
        ? token.slice(0, -1)
        : token);
}

function addsOutcomeDetail(sourceText: string, outcome: string): boolean {
  if (!RESULT_LANGUAGE.test(outcome) || !RESULT_TARGET.test(outcome)) return false;
  // Context such as "during planning" or "across teams" does not add a
  // result. Compare only result targets and result measures, never arbitrary
  // lexical novelty in a restated outcome.
  const resultTargets = (value: string) => Array.from(
    value.matchAll(new RegExp(RESULT_TARGET.source, "gi")),
    ([target]) => claimFacts(target).join(" "),
  );
  const resultMeasures = (value: string) => Array.from(
    value.matchAll(new RegExp(RESULT_QUANTITY.source, "gi")),
    ([measure]) => measure.toLowerCase().replace(/\s+/g, "")
      .replace(/percent\b/g, "%")
      .replace(/milliseconds?\b/g, "ms"),
  );
  const sourceTargets = new Set(resultTargets(sourceText));
  const sourceMeasures = new Set(resultMeasures(sourceText));
  return resultTargets(outcome).some((target) => !sourceTargets.has(target))
    || resultMeasures(outcome).some((measure) => !sourceMeasures.has(measure));
}

function hasVerifiedResultMeasure(
  evidence: RequiredBulletCoachingEvidence,
): boolean {
  if (evidence.evidence_strength !== "verified" || !evidence.user_confirmed) return false;
  const sourceDescribesResult = RESULT_LANGUAGE.test(evidence.source_text)
    && RESULT_TARGET.test(evidence.source_text);
  return evidence.metrics.some((metric) => RESULT_QUANTITY.test(metric)
    && ((BARE_RESULT_QUANTITY.test(metric.trim()) && sourceDescribesResult)
      || (RESULT_DIRECTION.test(metric) && RESULT_TARGET.test(metric))));
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
      // An extracted number such as "10 projects" measures action scale, not
      // necessarily a result. Restated actions also need a result, not a new
      // punctuation mark or a different verb for the same activity.
      const hasOutcome = Boolean(achievement && (
        addsOutcomeDetail(achievement.source_text, achievement.outcome)
        || hasVerifiedResultMeasure(achievement)
      ));
      const needsEvidence = !hasSubstantiveEvidence
        || achievement?.evidence_strength === "inferred"
        || achievement?.evidence_strength === "draft"
        || achievement?.user_confirmed === false;
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
      if (VAGUE_RELEVANCE.test(normalizedOriginal)) {
        suggestions.push({
          id: `${idPrefix}:relevance`,
          kind: "relevance",
          originalText,
          proposedText: null,
          canApply: false,
          guidance: "Which specific responsibility or result makes this required bullet relevant? Add only details you can verify in the normal editor.",
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
          guidance: "What truthful outcome, scale, frequency, or comparison followed from this action? Leave it unchanged if no supported result is available.",
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
          guidance: !achievement
            ? "No unambiguous canonical achievement record matches this bullet. Which saved source supports its claim? Add only evidence you can verify in the normal editor."
            : achievement.evidence_strength === "draft"
              || achievement.evidence_strength === "inferred"
              || !achievement.user_confirmed
              ? "This achievement is marked draft, inferred, or unconfirmed. Which source verifies its claim? Review and confirm it in the normal editor before strengthening the wording."
              : "The matching achievement is not marked verified. Which independent source confirms the claim or metric? Add only verified details in the normal editor.",
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
