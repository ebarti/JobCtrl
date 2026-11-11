import { useState } from "react";

import { RequirementAssociationPicker, achievementChoices, useRequirementLibrary } from "../../contexts/fit/index.js";
import { useProfileQuery, useWordingLibrary } from "../../contexts/profile/index.js";
import { Button } from "../../shared/ui/button.js";

/** Requirement identities come from saved assessments, exact coverage or user links. */
export function AchievementRequirementTags({ achievementId, roleId, onSelectRequirement }: {
  achievementId: string;
  roleId: string;
  onSelectRequirement: (requirementId: string) => void;
}) {
  const library = useRequirementLibrary();
  const profile = useProfileQuery();
  const wording = useWordingLibrary();
  const choices = achievementChoices(profile.data?.profile, wording.data);
  const [linking, setLinking] = useState(false);
  const requirements = (library.data?.requirements ?? []).flatMap((requirement) => {
    const assessment = requirement.assessment?.achievement_ids.includes(achievementId) ? requirement.assessment : null;
    const coverage = requirement.coverage.filter((item) => item.achievement_id === achievementId);
    const assignments = requirement.current_wordings.filter((item) => item.achievement_id === achievementId);
    const links = requirement.associations.filter((item) => item.achievement_id === achievementId && item.role_id === roleId && item.state === "active");
    if (!assessment && !coverage.length && !links.length && !assignments.length) return [];
    const current = !!assessment?.current || coverage.some((item) => item.current) || assignments.some((item) => item.current) || links.some((item) => item.current);
    const needsReview = assignments.some((item) => !item.current) || links.some((item) => !item.current) || !!(assessment && !assessment.current);
    const status = !current || needsReview ? "Needs review" : assessment?.current ? "Assessment recorded" : assignments.some((item) => item.current) ? "Current wording" : coverage.some((item) => item.current) ? "Wording coverage recorded" : "Your link · unassessed";
    return [{ requirement, status }];
  });
  return <section className="achievement-requirements" aria-label="Requirements for this achievement">
    <div className="achievement-requirements__heading"><strong>Requirements</strong>
      {library.data?.readiness === "ready" && !library.error ? <Button type="button" variant="ghost" size="sm" onClick={() => setLinking(true)}>Link requirement</Button> : null}
    </div>
    {library.isPending ? <p className="muted">Loading requirements…</p> : null}
    {library.error ? <p className="requirement-error" role="status">Requirements could not be refreshed.{library.data ? " Showing the last available links." : ""} <Button type="button" variant="outline" size="sm" onClick={() => void library.refetch()}>Retry</Button></p> : null}
    {requirements.length ? <div className="achievement-requirements__tags">{requirements.map(({ requirement, status }) => <button
      className="achievement-requirements__tag" type="button" key={requirement.requirement_id}
      onClick={() => onSelectRequirement(requirement.requirement_id)}>
      <span>{requirement.definition}</span><small>{status}</small>
    </button>)}</div> : library.data && !library.error && !library.isPending ? <p className="muted">No requirements linked yet.</p> : null}
    {linking && library.data ? <RequirementAssociationPicker library={library.data} choices={choices} profileVersion={profile.data?.profileVersion} wordingProfileVersion={wording.data?.profileVersion} sourceLoading={profile.isPending || wording.isPending} sourceError={profile.error?.message ?? wording.error?.message} achievementId={achievementId} onClose={() => setLinking(false)} /> : null}
  </section>;
}
