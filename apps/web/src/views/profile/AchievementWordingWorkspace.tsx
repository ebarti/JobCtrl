import { useRequirementLibrary } from "../../contexts/fit/index.js";
import { AchievementWordings, useWordingLibrary } from "../../contexts/profile/index.js";
import { Button } from "../../shared/ui/button.js";
import "../../styles/redesign-requirements.css";

/** Compose only saved assignment identities; coverage or approval never selects a wording. */
export function AchievementWordingWorkspace({ achievementId, onSelectRequirement }: {
  achievementId: string;
  roleId: string;
  onSelectRequirement: (requirementId: string) => void;
}) {
  const library = useRequirementLibrary();
  const wording = useWordingLibrary();
  const aligned = library.data?.profile_revision != null && library.data.profile_revision === wording.data?.profileVersion;
  const requirements = library.data?.requirements ?? [];
  const assignments = requirements.flatMap((requirement) => requirement.current_wordings
    .filter((assignment) => assignment.achievement_id === achievementId)
    .map((assignment) => ({ requirement, assignment })));
  const current = assignments.filter(({ assignment }) => assignment.current && aligned).map(({ assignment }) => ({
    variant_id: assignment.variant_id,
    variant_revision: assignment.variant_revision,
    requirement_id: assignment.requirement_id,
    requirement_revision: assignment.requirement_revision,
  }));
  const mismatch = !!library.data && !!wording.data && library.data.profile_revision !== wording.data.profileVersion;
  const stale = assignments.filter(({ assignment }) => !assignment.current || mismatch);
  const distinct = new Set(assignments.map(({ assignment }) => JSON.stringify([assignment.variant_id, assignment.variant_revision])));
  return <div className="achievement-wording-workspace">
    {library.isPending ? <p role="status">Loading requirement-specific wording…</p> : null}
    {library.error ? <p role="alert">Requirement-specific wording could not be refreshed.{library.data ? " Showing the last available mappings." : ""} <Button type="button" variant="outline" size="sm" onClick={() => void library.refetch()}>Retry</Button></p> : null}
    {distinct.size > 1 ? <p role="status">Several current wordings are recorded for this achievement. Review their linked requirements and selection history.</p> : null}
    {stale.length ? <div className="achievement-wording-workspace__notice" role="status"><strong>Current wording needs review</strong>
      <div className="achievement-requirements__tags">{stale.map(({ requirement }) => <button className="achievement-requirements__tag" type="button" key={requirement.requirement_id} onClick={() => onSelectRequirement(requirement.requirement_id)}>{requirement.definition}<small>Needs review</small></button>)}</div></div> : null}
    <AchievementWordings achievementId={achievementId} currentWordings={current} hasSavedAssignment={assignments.length > 0}
      assignmentsUnavailable={!library.data || (!!assignments.length && !wording.data)}
      wordingContext={(variantId, revision) => {
        const matches = requirements.flatMap((requirement) => {
          const assignment = requirement.current_wordings.find((item) => item.achievement_id === achievementId && item.variant_id === variantId && item.variant_revision === revision);
          const coverage = requirement.coverage.filter((item) => item.achievement_id === achievementId && item.variant_id === variantId && String(item.variant_revision) === String(revision));
          const associations = requirement.associations.filter((item) => item.state === "active" && item.achievement_id === achievementId && item.wording?.variant_id === variantId && item.wording.variant_revision === revision);
          if (!assignment && !coverage.length && !associations.length) return [];
          const status = assignment ? assignment.current && aligned ? "Current wording" : "Current wording · needs review" : coverage.some((item) => item.current) ? "Coverage recorded" : associations.some((item) => item.current) ? "Your link · unassessed" : "Earlier link · needs review";
          return [{ requirement, status }];
        });
        return matches.length ? <div className="achievement-requirements__tags" aria-label="Requirements for this wording">{matches.map(({ requirement, status }) => <button className="achievement-requirements__tag" type="button" key={requirement.requirement_id} onClick={() => onSelectRequirement(requirement.requirement_id)}><span>{requirement.definition}</span><small>{status}</small></button>)}</div> : null;
      }} />
  </div>;
}
