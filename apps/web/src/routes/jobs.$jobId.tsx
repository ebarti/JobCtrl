import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { JobDetailDrawer } from "../views/jobs/JobDetailDrawer.js";

export const Route = createFileRoute("/jobs/$jobId")({
  component: JobDrawerRoute,
});

function JobDrawerRoute() {
  const { jobId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const close = useCallback(() => {
    void navigate({ to: "/jobs", search });
  }, [navigate, search]);

  return <JobDetailDrawer jobId={jobId} onClose={close} />;
}
