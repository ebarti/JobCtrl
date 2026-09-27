import type {
  ProfileShape,
  RequiredBulletSuggestion,
  RequiredBulletSuggestionResponse,
} from "./contracts.js";

const VAGUE_RELEVANCE = /\b(responsible for|worked on|helped(?: with)?|participated in|various|multiple tasks|duties included)\b/i;
const MAX_INSPECTED_REQUIRED_BULLETS = 512;
export const MAX_REQUIRED_COACHING_ENTRIES = 256;
export const MAX_REQUIRED_COACHING_SOURCE_ROWS = 4_096;
const RESULT_LANGUAGE = /\b(reduced|decreased|lowered|cut|improved|increased|raised|boosted|grew|accelerated|shortened|eliminated|prevented|faster|slower|fewer)\b/i;

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
  if (!RESULT_LANGUAGE.test(outcome)) return false;
  const sourceFacts = new Set(claimFacts(sourceText));
  // A reordered claim, changed result verb, plural, or possessive does not
  // supply another fact. Require a saved content token absent from the source;
  // grammar fragments cannot establish support.
  return claimFacts(outcome).some((token) => !sourceFacts.has(token));
}

function boundedExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

function isSubstantiveEvidence(
  evidence: ProfileShape["resume"]["experience_entries"][number]["achievement_evidence"][number],
): boolean {
  // Saved wording is not independent proof, however novel it sounds. The
  // canonical evidence-strength field is the available verification signal;
  // user confirmation is checked separately before suppressing the question.
  return evidence.evidence_strength === "verified";
}

function truncatedResponse(
  profileVersion: number,
): RequiredBulletSuggestionResponse {
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
  profile: ProfileShape,
  profileVersion: number,
  maximumSuggestions: number,
): RequiredBulletSuggestionResponse {
  const suggestions: RequiredBulletSuggestion[] = [];
  const entries = profile.resume.experience_entries;
  const requiredByExperience = profile.resume.tailoring_rules?.required_bullets_by_experience_id ?? {};
  // The limit is checked before reading bullet or evidence contents. A profile
  // beyond this budget cannot prove identity uniqueness, so fail closed instead
  // of producing an apparently applicable suggestion from a partial scan.
  if (entries.length > MAX_REQUIRED_COACHING_ENTRIES) return truncatedResponse(profileVersion);
  let sourceRows = 0;
  for (const entry of entries) {
    sourceRows += 1 + entry.bullets.length + entry.achievement_evidence.length
      + (requiredByExperience[entry.id]?.length ?? 0);
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
  let scanTruncated = false;

  scan: for (const [experienceIndex, entry] of entries.entries()) {
    if (suggestions.length > maximumSuggestions) break;
    // A save addresses Required pins by experience ID. Duplicate IDs cannot be
    // resolved to one owning entry, even when a positional path is available.
    if (entryIdCounts.get(entry.id) !== 1) continue;
    const requiredBullets = requiredByExperience[entry.id] ?? [];
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
    const achievementsBySource = new Map<string, typeof entry.achievement_evidence>();
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
        || (achievement.metrics.length > 0 && RESULT_LANGUAGE.test(normalizedOriginal))
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
        const canApply = !ambiguousAchievement && !proposedTextCollides;
        suggestions.push({
          id: `${idPrefix}:grammar`,
          kind: "grammar",
          originalText,
          proposedText: canApply ? normalizedOriginal : null,
          canApply,
          guidance: proposedTextCollides
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
