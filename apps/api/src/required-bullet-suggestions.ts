import type {
  ProfileShape,
  RequiredBulletSuggestion,
  RequiredBulletSuggestionResponse,
} from "./contracts.js";

const VAGUE_RELEVANCE = /\b(responsible for|worked on|helped(?: with)?|participated in|various|multiple tasks|duties included)\b/i;
const MAX_INSPECTED_REQUIRED_BULLETS = 512;

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function boundedExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

function isSubstantiveEvidence(
  evidence: ProfileShape["resume"]["experience_entries"][number]["achievement_evidence"][number],
): boolean {
  const source = normalizedText(evidence.source_text);
  // Normalized storage materializes every legacy bullet as an achievement row,
  // copying the bullet into action, outcome, and extracted metrics. That row
  // preserves identity but does not add an independent source for the claim.
  return Boolean(normalizedText(evidence.outcome) && normalizedText(evidence.outcome) !== source)
    || evidence.evidence_strength === "verified";
}

export function generateRequiredBulletSuggestions(
  profile: ProfileShape,
  profileVersion: number,
  maximumSuggestions: number,
): RequiredBulletSuggestionResponse {
  const suggestions: RequiredBulletSuggestion[] = [];
  const entries = profile.resume.experience_entries;
  const requiredByExperience = profile.resume.tailoring_rules?.required_bullets_by_experience_id ?? {};
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
    for (const [requiredBulletIndex, requiredText] of requiredBullets.entries()) {
      if (suggestions.length > maximumSuggestions) break;
      if (inspectedBullets >= MAX_INSPECTED_REQUIRED_BULLETS) {
        scanTruncated = true;
        break scan;
      }
      inspectedBullets += 1;
      // Required pins store text, not an occurrence ID. An identical bullet or
      // pin has no provable one-to-one mapping, so never guess which to edit.
      if (
        bulletIndexesByText.get(requiredText)?.length !== 1
        || requiredCounts.get(requiredText) !== 1
      ) continue;
      const bulletIndex = bulletIndexesByText.get(requiredText)![0]!;
      const originalText = entry.bullets[bulletIndex]!;
      if (
        originalText.length > 2_000
        || entry.id.length > 160
        || !entry.id.trim()
        || entry.title.length > 160
        || !entry.title.trim()
        || entry.company.length > 160
        || !entry.company.trim()
      ) continue;
      const normalizedOriginal = normalizedText(originalText);
      if (!normalizedOriginal) continue;
      const matchingAchievements = entry.achievement_evidence.filter(
        (candidate) => candidate.id.trim().length > 0
          && candidate.id.trim().length <= 240
          && normalizedText(candidate.source_text) === normalizedOriginal,
      );
      // Duplicate bullets can have distinct durable evidence identities. Do not
      // guess which one owns an occurrence when the snapshot cannot prove it.
      const uniqueMatch = matchingAchievements.length === 1 ? matchingAchievements[0] : undefined;
      const ambiguousAchievement = matchingAchievements.length > 1
        || (uniqueMatch !== undefined && achievementIdCounts.get(uniqueMatch.id) !== 1);
      const achievement = ambiguousAchievement ? undefined : uniqueMatch;
      const hasSubstantiveEvidence = achievement ? isSubstantiveEvidence(achievement) : false;
      const hasOutcome = Boolean(
        achievement && (
          achievement.metrics.length > 0
          || (achievement.outcome.trim() && normalizedText(achievement.outcome) !== normalizedOriginal)
        ),
      );
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
        suggestions.push({
          id: `${idPrefix}:grammar`,
          kind: "grammar",
          originalText,
          proposedText: ambiguousAchievement ? null : normalizedOriginal,
          canApply: !ambiguousAchievement,
          guidance: ambiguousAchievement
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
            : !hasSubstantiveEvidence
              ? "The matching achievement record adds no independent detail beyond this bullet. Which source confirms the claim or metric? Add only verified details in the normal editor."
              : "This achievement is marked draft, inferred, or unconfirmed. Which source verifies its claim? Review and confirm it in the normal editor before strengthening the wording.",
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
