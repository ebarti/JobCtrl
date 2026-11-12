import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback } from "react";

import { JobDetailComposition } from "../views/jobs/JobDetailComposition.js";
import type { JobWorkspaceTab } from "../views/jobs/JobDetailDrawer.js";
import type { PreparationResumeMode } from "../contexts/pipeline/index.js";

export const Route = createFileRoute("/jobs/$jobId")({
  component: JobDrawerRoute,
});

function JobDrawerRoute() {
  const { jobId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const showingRunDetail = useRouterState({
    select: (state) =>
      state.matches.some(
        (match) => match.routeId === "/jobs/$jobId/run/$runId",
      ),
  });
  const close = useCallback(() => {
    if (search.returnRequirement) {
      void navigate({ to: "/requirements", search: { requirement: search.returnRequirement, q: search.returnRequirementsFilter ?? "" } });
      return;
    }
    void navigate({ to: "/jobs", search: { ...search, jobTab: undefined } });
  }, [navigate, search]);
  const changeTab = useCallback((jobTab: JobWorkspaceTab) => {
    void navigate({ to: "/jobs/$jobId", params: { jobId }, search: { ...search, jobTab }, replace: true });
  }, [navigate, jobId, search]);
  const renderProfileSetup = useCallback((mode: PreparationResumeMode | null) => <Link to="/profile" search={{
    section: "experience",
    returnJobId: jobId,
    returnJobs: { ...search, ...(mode ? { resumeMode: mode } : {}) },
    ...(mode ? { returnResumeMode: mode } : {}),
  }}>Open My profile</Link>, [jobId, search]);
  const changeResumeMode = useCallback((resumeMode: PreparationResumeMode) => {
    void navigate({ to: "/jobs/$jobId", params: { jobId }, search: { ...search, resumeMode }, replace: true });
  }, [navigate, jobId, search]);

  if (showingRunDetail) {
    return <Outlet />;
  }

  return <JobDetailComposition key={jobId} jobId={jobId} onClose={close} returnLabel={search.returnRequirement ? "Back to requirements" : "Back to jobs"} activeTab={search.jobTab ?? "fit"} onTabChange={changeTab} initialResumeMode={search.resumeMode ?? null} onResumeModeChange={changeResumeMode} renderProfileSetup={renderProfileSetup} />;
}
