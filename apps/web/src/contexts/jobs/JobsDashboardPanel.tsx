import { Link } from "@tanstack/react-router";

import { useJobs } from "./client.js";

export function JobsDashboardPanel() {
  const jobs = useJobs("", 0, 5);
  return <section className="card jobs-dashboard-panel" aria-labelledby="dashboard-jobs-title">
    <h2 id="dashboard-jobs-title">Captured jobs</h2>
    {jobs.isPending ? <p>Loading jobs…</p> : null}
    {jobs.error ? <p role="alert">{jobs.error.message}</p> : null}
    {jobs.data ? <><p>{jobs.data.total} saved postings</p>
      {jobs.data.jobs.length ? <ul>{jobs.data.jobs.map((job) => <li key={job.job_id}><Link to="/jobs/$jobId" params={{ jobId: job.job_id }}>{job.title}</Link>{job.company ? ` · ${job.company}` : ""}</li>)}</ul> : <p>No jobs captured yet.</p>}
    </> : null}
    <Link to="/jobs">Open jobs</Link>
  </section>;
}
