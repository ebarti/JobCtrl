import { Link, useRouterState } from "@tanstack/react-router";

import { useJobsReturnSearch } from "../../contexts/jobs/index.js";
import { useMountedFeatures } from "../../contexts/runtime/index.js";
import { profileSectionForLocation, workspaceLocation } from "./workspace-location.js";

const profileTabs = [
  ["experience", "Experience"],
  ["skills", "Skills"],
  ["education", "Education"],
  ["personal", "Personal details"],
  ["resume", "Resume"],
] as const;

export function WorkspaceNav() {
  const location = useRouterState({ select: (state) => state.location });
  const { workspace } = workspaceLocation(location.pathname, location.search, location.hash);
  const features = useMountedFeatures();
  const jobsSearch = useJobsReturnSearch();
  const pathname = location.pathname;

  if (workspace === "profile") {
    const currentSection = pathname === "/profile" || pathname === "/profile/"
      ? profileSectionForLocation(location.search, location.hash)
      : null;
    return <nav className="workspace-tabs" aria-label="My profile sections">
      {profileTabs.map(([section, label]) => <Link key={section} to="/profile" search={{ section,
        ...(typeof location.search.returnRequirement === "string" ? { returnRequirement: location.search.returnRequirement } : {}),
        ...(typeof location.search.returnRequirementsFilter === "string" ? { returnRequirementsFilter: location.search.returnRequirementsFilter } : {}),
        ...(typeof location.search.returnJobId === "string" ? { returnJobId: location.search.returnJobId } : {}),
        ...(location.search.returnJobs && typeof location.search.returnJobs === "object" ? { returnJobs: location.search.returnJobs } : {}),
        ...(location.search.returnResumeMode === "baseline" || location.search.returnResumeMode === "tailored" ? { returnResumeMode: location.search.returnResumeMode } : {}),
      }}
        aria-current={currentSection === section ? "page" : undefined}>{label}</Link>)}
      {features.has("learning") ? <Link to="/learning" aria-current={pathname === "/learning" ? "page" : undefined}>Learning</Link> : null}
      <Link to="/preferences" aria-current={pathname === "/preferences" ? "page" : undefined}>Search preferences</Link>
    </nav>;
  }

  if (workspace === "jobs") {
    return <nav className="workspace-tabs" aria-label="Jobs sections">
      <Link to="/jobs" search={jobsSearch} aria-current={pathname.startsWith("/jobs") ? "page" : undefined}>All jobs</Link>
      {features.has("requirements") && features.has("fit") ? <Link to="/requirements" aria-current={pathname === "/requirements" ? "page" : undefined}>Requirements</Link> : null}
      {features.has("applications") ? <Link to="/apply-review" aria-current={pathname === "/apply-review" ? "page" : undefined}>Applications</Link> : null}
      {features.has("applications") ? <Link to="/analytics" aria-current={pathname === "/analytics" ? "page" : undefined}>Outcomes</Link> : null}
      {features.has("interviews") ? <Link to="/interviews" aria-current={pathname === "/interviews" ? "page" : undefined}>Interview library</Link> : null}
      {features.has("contacts") && features.has("outreach") ? <Link to="/outreach" aria-current={pathname.startsWith("/outreach") ? "page" : undefined}>Contacts</Link> : null}
      {features.has("resumes") ? <Link to="/artifacts" aria-current={pathname.startsWith("/artifacts") ? "page" : undefined}>Materials</Link> : null}
    </nav>;
  }

  if (["/runs", "/debug", "/activity"].some((prefix) => pathname.startsWith(prefix))) {
    return <nav className="workspace-tabs" aria-label="Settings navigation">
      <Link to="/settings/data">← Data &amp; diagnostics</Link>
    </nav>;
  }
  return null;
}
