import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { AffectedMatchesPanel, PersonFitPanel } from "../contexts/fit/index.js";
import { useJobs } from "../contexts/jobs/index.js";
import { CareerLearningPanel } from "../contexts/learning/index.js";
import { ProfileEvidencePanel } from "../contexts/profile/index.js";
import { useMountedFeatures } from "../contexts/runtime/index.js";
import { Input } from "../shared/ui/input.js";
import { PageHead } from "../shared/ui/page-head.js";
import { EvidenceMapConnections } from "../views/evidence-map/EvidenceMapConnections.js";
import { evidenceMapSearchSchema } from "./-evidence-map.search.js";

export const Route = createFileRoute("/evidence-map")({
  validateSearch: (search) => evidenceMapSearchSchema.parse(search),
  component: EvidenceMapComposition,
});

function EvidenceMapComposition() {
  const routeSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const [jobSearch, setJobSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const jobs = useJobs(jobSearch, (page - 1) * pageSize, pageSize);
  const features = useMountedFeatures();
  const choices = {
    items: (jobs.data?.jobs ?? []).map((job) => ({
      jobId: job.job_id,
      title: job.title,
      company: job.company ?? null,
    })),
    total: jobs.data?.total ?? 0,
    page,
    pageSize,
    search: jobSearch,
    isPending: jobs.isPending,
    error: jobs.error,
    onSearchChange: (value: string) => { setJobSearch(value); setPage(1); },
    onPageChange: setPage,
  };
  return <div className="evidence-map-view">
    <PageHead eyebrow="Library" title="Career evidence map" subtitle="Review saved sources, learning and role-specific evidence." />
    <label>Filter sources
      <Input value={routeSearch.q} onChange={(event) => {
        void navigate({ search: (previous) => ({ ...previous, q: event.target.value, entry: "" }), replace: true });
      }} />
    </label>
    <ProfileEvidencePanel search={routeSearch.q} focusSourceId={routeSearch.entry} />
    {features.has("fit") ? <AffectedMatchesPanel /> : null}
    <EvidenceMapConnections search={routeSearch.q} focusSourceId={routeSearch.entry} jobId={routeSearch.job} />
    {features.has("learning") ? <CareerLearningPanel jobs={choices} /> : null}
    <section className="card" aria-labelledby="evidence-job-title">
      <h2 id="evidence-job-title">Role-specific evidence</h2>
      <p>Select a saved job to inspect person fit and approved wording coverage.</p>
      {jobs.error ? <p role="alert">Jobs could not be loaded: {jobs.error.message}</p> : null}
      {choices.items.length ? <ul>{choices.items.map((job) => <li key={job.jobId}>
        <Link to="/evidence-map" search={{ ...routeSearch, job: job.jobId }}>{job.title}{job.company ? ` · ${job.company}` : ""}</Link>
      </li>)}</ul> : <p>{jobs.isPending ? "Loading jobs…" : "No saved jobs on this page."}</p>}
      {routeSearch.job ? <PersonFitPanel jobId={routeSearch.job} /> : null}
    </section>
  </div>;
}
