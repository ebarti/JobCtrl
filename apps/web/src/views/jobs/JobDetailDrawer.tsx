import type { ReactNode } from "react";

import { PersonFitPanel } from "../../contexts/fit/index.js";
import { PostingAvailabilityPanel, RoleAnalysisPanel, useJob, useJobActions } from "../../contexts/jobs/index.js";
import { useProfileQuery, useProfileSources, useWordingLibrary } from "../../contexts/profile/index.js";
import { RequirementsPanel } from "../../contexts/requirements/index.js";
import { ResumePanel } from "../../contexts/resumes/index.js";
import { useApplicationSettings } from "../../contexts/settings/index.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { getApiCapabilityAvailability } from "../../shared/lib/apiCapabilityAvailability.js";
import { Button } from "../../shared/ui/button.js";
import { JobDescription } from "./JobDescription.js";

export interface JobDetailOptionalSection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly content: ReactNode;
}
export interface JobDetailDrawerProps {
  readonly jobId: string;
  readonly onClose: () => void;
  readonly optionalSections?: readonly JobDetailOptionalSection[];
  readonly optionalHeaderActions?: ReactNode;
}

export function JobDetailDrawer({ jobId, onClose, optionalSections = [], optionalHeaderActions }: JobDetailDrawerProps) {
  const { featureFlags } = usePorts();
  const postingRefresh = getApiCapabilityAvailability(featureFlags, "importJobUrl");
  const job = useJob(jobId);
  const profile = useProfileQuery();
  const sources = useProfileSources();
  const wording = useWordingLibrary();
  const settings = useApplicationSettings();
  const { refresh } = useJobActions(jobId);
  const posting = job.data;
  return <main className="route-page route-page--job-detail" aria-label="Job details">
    <Button type="button" variant="ghost" onClick={onClose}>Back to jobs</Button>
    {job.isPending ? <p>Loading job…</p> : null}
    {job.error ? <p role="alert">{job.error.message} {posting ? "The last saved posting remains below." : ""}</p> : null}
    {posting ? <>
      <header className="card"><h1>{posting.title}</h1><p>{[posting.company, posting.location].filter(Boolean).join(" · ")}</p>
        <p>Posting revision {posting.revision} · source {posting.source_id}, revision {posting.source_revision}</p>
        <a href={posting.url} target="_blank" rel="noreferrer">Open original posting</a>
        {optionalHeaderActions}
        <div><Button type="button" variant="outline" disabled={!postingRefresh.available || refresh.isPending} onClick={() => refresh.mutate(posting.revision)}>Refresh posting</Button></div>
        {!postingRefresh.available ? <p>{postingRefresh.reason}</p> : null}
        {refresh.error ? <p role="alert">{refresh.error.message} The saved posting remains available.</p> : null}
      </header>
      <section className="section" aria-labelledby="job-description-title"><h2 id="job-description-title">Description</h2><JobDescription text={posting.description} /></section>
      <PostingAvailabilityPanel posting={posting} />
      <RoleAnalysisPanel jobId={jobId} postingRevision={posting.revision} />
      <RequirementsPanel jobId={jobId} postingRevision={posting.revision} />
      <PersonFitPanel jobId={jobId} sources={sources.data?.sources ?? []} achievements={wording.data?.roles.flatMap((role) => role.achievements) ?? []} defaultMode={settings.data?.resumeMode ?? null} />
      {profile.error ? <p role="alert">Profile unavailable: {profile.error.message}</p> : null}
      <ResumePanel jobId={jobId} profileVersion={profile.data?.profileVersion ?? null} defaultMode={settings.data?.resumeMode ?? null} onProfileChanged={() => { void profile.refetch(); void wording.refetch(); }} />
      {settings.error ? <p role="alert">Saved resume mode unavailable: {settings.error.message}. Choose an explicit resume mode or reload settings.</p> : null}
      {optionalSections.map((section) => <section className="section" key={section.id} aria-label={section.title}><h2>{section.title}</h2><p>{section.description}</p>{section.content}</section>)}
    </> : null}
  </main>;
}
