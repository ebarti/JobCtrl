import { createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { AffectedMatchesPanel } from "../contexts/fit/index.js";
import { ProfileEditor } from "../contexts/profile/index.js";
import { prefetchProfileEditor } from "../contexts/profile/readQueries.js";
import { useMountedFeatures } from "../contexts/runtime/index.js";
import { PageHead } from "../shared/ui/page-head.js";
import { profileSectionForLocation } from "../shared/layout/workspace-location.js";
import { AchievementRequirementTags } from "../views/profile/AchievementRequirementTags.js";
import { AchievementWordingWorkspace } from "../views/profile/AchievementWordingWorkspace.js";
import { jobsSearchSchema } from "./-jobs.search.js";

const labels = {
  experience: "Experience",
  skills: "Skills",
  education: "Education",
  personal: "Personal details",
  resume: "Resume",
} as const;

export const Route = createFileRoute("/profile/")({
  loader: ({ context }) => prefetchProfileEditor(context),
  component: ProfilePage,
});

function ProfilePage() {
  const features = useMountedFeatures();
  const search = Route.useSearch();
  const location = useRouterState({ select: (state) => state.location });
  const section = profileSectionForLocation(location.search, location.hash);
  useEffect(() => {
    if (!location.hash.startsWith("profile-")) return;
    const frame = requestAnimationFrame(() => document.getElementById(location.hash)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [location.hash, section]);
  const navigate = useNavigate();
  const openRequirement = useCallback((requirement: string) => {
    void navigate({ to: "/requirements", search: { requirement, q: search.returnRequirementsFilter ?? "" } });
  }, [navigate, search.returnRequirementsFilter]);
  const achievementContent = useCallback((achievementId: string, roleId: string) =>
    <AchievementRequirementTags achievementId={achievementId} roleId={roleId} onSelectRequirement={openRequirement} />,
  [openRequirement]);
  const achievementWordings = useCallback((achievementId: string, roleId: string) =>
    <AchievementWordingWorkspace achievementId={achievementId} roleId={roleId} onSelectRequirement={openRequirement} />, [openRequirement]);

  return <>
    <PageHead eyebrow="My profile" title={labels[section]}
      subtitle={section === "resume" ? "Edit your baseline resume." : "Keep your experience and evidence up to date."}
      actions={<>
        {search.returnJobId ? <Link className="tab" to="/jobs/$jobId" params={{ jobId: search.returnJobId }}
          search={{ ...(search.returnJobs ?? jobsSearchSchema.parse({})), resumeMode: search.returnResumeMode ?? search.returnJobs?.resumeMode }}>← Return to job</Link> : null}
        {search.returnRequirement ? <Link className="tab" to="/requirements"
          search={{ requirement: search.returnRequirement, q: search.returnRequirementsFilter ?? "" }}>← Back to requirements</Link> : null}
        {section === "resume" && features.has("resumes") ? <Link className="tab" to="/artifacts">Accepted materials</Link> : null}
      </>} />
    <ProfileEditor activeSection={section}
      {...(search.roleId ? { roleId: search.roleId } : {})}
      {...(search.achievementId ? { achievementId: search.achievementId } : {})}
      {...(features.has("fit") && features.has("requirements") ? { achievementContent, achievementWordings } : {})}
      affectedMatches={features.has("fit") ? <AffectedMatchesPanel /> : null} />
  </>;
}
