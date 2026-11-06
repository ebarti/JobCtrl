import {
  createFileRoute,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback } from "react";

import { JobDetailComposition } from "../views/jobs/JobDetailComposition.js";

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
    void navigate({ to: "/jobs", search });
  }, [navigate, search]);

  if (showingRunDetail) {
    return <Outlet />;
  }

  return <JobDetailComposition key={jobId} jobId={jobId} onClose={close} />;
}
