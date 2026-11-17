import type { RequirementLibraryEntry } from "./requirement-library.js";

type Requirement = RequirementLibraryEntry;

/** Recorded identity joins only. Earlier links never acquire current authority. */
export function applicableAchievementIds(requirement: Requirement): string[] {
  return [...new Set([
    ...(requirement.assessment?.achievement_ids ?? []),
    ...(requirement.demand_assessments ?? []).flatMap((demand) => demand.assessment?.achievement_ids ?? []),
    ...requirement.coverage.map((item) => item.achievement_id),
    ...requirement.current_wordings.map((item) => item.achievement_id),
    ...requirement.associations.filter((item) => item.state === "active").map((item) => item.achievement_id),
  ])];
}

export function linkedAchievementIds(requirement: Requirement): string[] {
  return [...new Set([
    ...applicableAchievementIds(requirement),
    ...(requirement.historical_alias_records ?? []).flatMap((group) => [
      ...group.assessments.flatMap((item) => item.achievement_ids ?? []),
      ...group.coverage.map((item) => item.achievement_id),
      ...group.associations.filter((item) => item.state === "active").map((item) => item.achievement_id),
      ...group.wording_assignments.filter((item) => item.state === "active").map((item) => item.achievement_id),
    ]),
  ])];
}

export function earlierAchievementRecords(requirement: Requirement, achievementId: string) {
  return (requirement.historical_alias_records ?? []).map((group) => ({
    ...group,
    assessments: group.assessments.filter((item) => item.achievement_ids?.includes(achievementId)),
    coverage: group.coverage.filter((item) => item.achievement_id === achievementId),
    associations: group.associations.filter((item) => item.achievement_id === achievementId && item.state === "active"),
    wording_assignments: group.wording_assignments.filter((item) => item.achievement_id === achievementId && item.state === "active"),
  })).filter((group) => group.assessments.length || group.coverage.length || group.associations.length || group.wording_assignments.length);
}

export function earlierOnlyAchievementCount(requirement: Requirement): number {
  const applicable = new Set(applicableAchievementIds(requirement));
  return linkedAchievementIds(requirement).filter((id) => !applicable.has(id)).length;
}

/** Demand multiplicity is context, never a qualification outcome. */
export function requirementProfileMatch(requirement: Requirement): string {
  if (requirement.assessment_scope === "consolidation_required") return "Consolidation required";
  if (requirement.assessment_scope === "not_applicable") return "No current job demand";
  const demands = requirement.demand_assessments;
  const current = demands === undefined
    ? requirement.assessment?.current ? [requirement.assessment] : []
    : demands.flatMap((demand) => demand.current && demand.state === "current" && demand.assessment?.current ? [demand.assessment] : []);
  if (!current.length) {
    const earlier = requirement.assessment || demands?.some((demand) => demand.assessment)
      || requirement.historical_alias_records?.some((group) => group.assessments.length);
    return earlier ? "Needs update" : "Not assessed";
  }
  if (current.length < (demands?.length ?? 1)) return "Partially assessed";
  const outcomes = new Set(current.map((assessment) => assessment.kind));
  if (outcomes.size > 1) return "Varies by job";
  const outcome = current[0]!.kind.replaceAll("_", " ");
  return outcome[0]!.toLocaleUpperCase() + outcome.slice(1);
}
