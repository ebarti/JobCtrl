import { createFileRoute, Link } from "@tanstack/react-router";

import { useJobs } from "../contexts/jobs/index.js";
import { CareerLearningPanel, useLearningJobListDraft } from "../contexts/learning/index.js";
import { useRuntimeHealth } from "../contexts/runtime/index.js";
import { Button } from "../shared/ui/button.js";
import { Empty } from "../shared/ui/empty.js";
import { PageHead } from "../shared/ui/page-head.js";

export const Route = createFileRoute("/learning")({ component: LearningPage });

function LearningPage() {
  const health = useRuntimeHealth();
  if (!health.data) return <Empty title={health.error ? "Learning unavailable" : "Loading learning"}
    description={health.error ? "The application status could not be checked." : "Checking the available workspace."}
    {...(health.error ? { action: <Button type="button" onClick={() => void health.refetch()}>Retry</Button> } : {})} />;
  if (!health.data.features.includes("learning")) return <Empty title="Learning unavailable"
    description="The learning workspace is not enabled in this application." action={<Link to="/profile">Back to profile</Link>} />;
  return <LearningWorkspace />;
}

function LearningWorkspace() {
  const { search: jobSearch, page, setSearch, setPage } = useLearningJobListDraft();
  const pageSize = 20;
  const jobs = useJobs(jobSearch, (page - 1) * pageSize, pageSize);
  return <>
    <PageHead eyebrow="My profile" title="Learning" subtitle="Compare selected jobs with your experience and choose your own next steps." />
    <CareerLearningPanel variant="workspace" jobs={{
      items: (jobs.data?.jobs ?? []).map((job) => ({ jobId: job.job_id, title: job.title, company: job.company ?? null })),
      total: jobs.data?.total ?? 0,
      page,
      pageSize,
      search: jobSearch,
      isPending: jobs.isPending,
      error: jobs.error,
      onSearchChange: setSearch,
      onPageChange: setPage,
    }} />
  </>;
}
