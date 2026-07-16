import {
  createFileRoute,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback } from "react";

import { JobDetailDrawer } from "../views/jobs/JobDetailDrawer.js";

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

  return <JobDetailDrawer jobId={jobId} onClose={close} />;
}
