import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { PersonFitPanel, useJobFit } from "../../contexts/fit/index.js";
import { PostingAvailabilityPanel, RoleAnalysisPanel, useJob, useJobActions } from "../../contexts/jobs/index.js";
import { useProfileQuery, useProfileSources, useWordingLibrary } from "../../contexts/profile/index.js";
import { RequirementsPanel } from "../../contexts/requirements/index.js";
import { ResumePanel, useResumeDraftStatus, useResumes } from "../../contexts/resumes/index.js";
import { useApplicationSettings } from "../../contexts/settings/index.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { getApiCapabilityAvailability } from "../../shared/lib/apiCapabilityAvailability.js";
import { Button } from "../../shared/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../shared/ui/tabs.js";
import { JobDescription } from "./JobDescription.js";

export type JobWorkspaceTab = "fit" | "resume" | "application" | "people" | "offer";

export interface JobDetailOptionalSection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly content: ReactNode;
}
export interface JobDetailDrawerProps {
  readonly jobId: string;
  readonly onClose: () => void;
  readonly returnLabel?: string;
  readonly optionalSections?: readonly JobDetailOptionalSection[];
  readonly optionalHeaderActions?: ReactNode;
  readonly affectedMatches?: ReactNode;
  readonly activeTab?: JobWorkspaceTab;
  readonly onTabChange?: (tab: JobWorkspaceTab) => void;
  readonly preparationControls?: (input: { defaultMode: "baseline" | "tailored" | null; profileVersion: number | null; blockedByDraft: boolean; onReviewReady: (resumeId?: string, runId?: string) => void }) => ReactNode;
}

export function JobDetailDrawer({ jobId, onClose, returnLabel = "Back to jobs", optionalSections = [], optionalHeaderActions, affectedMatches, activeTab, onTabChange, preparationControls }: JobDetailDrawerProps) {
  const [localTab, setLocalTab] = useState<JobWorkspaceTab>("fit");
  const [reviewSelection, setReviewSelection] = useState<{ resumeId: string; requestId: string } | null>(null);
  const selectTab = useCallback((tab: JobWorkspaceTab) => { setLocalTab(tab); onTabChange?.(tab); }, [onTabChange]);
  const openResume = useCallback((resumeId?: string, runId?: string) => {
    if (resumeId && runId) setReviewSelection({ resumeId, requestId: runId });
    selectTab("resume");
  }, [selectTab]);
  const { featureFlags } = usePorts();
  const postingRefresh = getApiCapabilityAvailability(featureFlags, "importJobUrl");
  const job = useJob(jobId);
  const profile = useProfileQuery();
  const sources = useProfileSources();
  const wording = useWordingLibrary();
  const settings = useApplicationSettings();
  const fit = useJobFit(jobId);
  const resumes = useResumes(jobId);
  const resumeDirty = useResumeDraftStatus(jobId);
  const { refresh } = useJobActions(jobId);
  const posting = job.data;
  const latestResume = resumes.data?.at(-1);
  const acceptedResumeAvailable = resumes.data?.some((resume) => resume.accepted_revision_id);
  const resumeState = latestResume
    ? `${latestResume.accepted_revision_id === latestResume.current_revision ? "Accepted copy available" : acceptedResumeAvailable ? "Draft available · accepted copy retained" : "Draft available"}${latestResume.composition_freshness?.current === false ? " · update needed" : ""}`
    : resumes.error ? "State unavailable" : resumes.isPending ? "Loading…" : "Not prepared";
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (posting) headingRef.current?.focus(); }, [posting?.job_id]);
  const sections = (ids: readonly string[]) => optionalSections.filter((section) => ids.includes(section.id));
  const application = sections(["application", "screening", "outcomes"]);
  const people = sections(["contacts", "interviews"]);
  const offer = sections(["offers"]);
  const overview = optionalSections.filter((section) => !["application", "screening", "outcomes", "contacts", "interviews", "offers"].includes(section.id));
  const visibleTabs: Array<{ id: JobWorkspaceTab; label: string }> = [{ id: "fit", label: "Fit & overview" }, { id: "resume", label: "Resume" },
    ...(application.length ? [{ id: "application" as const, label: "Application" }] : []),
    ...(people.length ? [{ id: "people" as const, label: "People & interviews" }] : []),
    ...(offer.length ? [{ id: "offer" as const, label: "Offer" }] : [])];
  const requestedTab = activeTab ?? localTab;
  const tab = visibleTabs.some((item) => item.id === requestedTab) ? requestedTab : "fit";
  const renderSection = (section: JobDetailOptionalSection) => <section className="job-workspace-section" key={section.id} aria-label={section.title}><h2>{section.title}</h2>{section.content}</section>;
  return <main className="route-page route-page--job-detail" aria-label="Job details">
    {job.isPending ? <p>Loading job…</p> : null}
    {job.error ? <p role="alert">{job.error.message} {posting ? "The last saved posting remains below." : ""}</p> : null}
    {!posting ? <Button type="button" variant="ghost" onClick={onClose}>{returnLabel}</Button> : null}
    {posting ? <>
      <header className="job-workspace-header">
        <div className="job-workspace-header__return"><Button type="button" variant="ghost" onClick={onClose}>{returnLabel}</Button><a href={posting.url} target="_blank" rel="noreferrer">Original posting ↗</a></div>
        <h1 data-typography="page-title" tabIndex={-1} ref={headingRef}>{posting.title}</h1><p data-typography="body" className="job-workspace-header__company">{[posting.company, posting.location].filter(Boolean).join(" · ") || "Employer and location not recorded"}</p>
        <dl className="job-workspace-state">
          <div><dt data-typography="metadata">Availability</dt><dd data-typography="strong-body">{posting.active_state && posting.active_state !== "unknown" ? posting.active_state : "Unverified"}</dd></div>
          <div><dt data-typography="metadata">Person fit</dt><dd data-typography="strong-body">{fit.data?.score ? `${fit.data.score.score}/10${fit.data.current ? "" : " · stale"}${fit.error ? " · last saved" : ""}` : fit.error ? "Unavailable" : fit.isPending ? "Loading…" : "Not assessed"}</dd></div>
          <div><dt data-typography="metadata">Latest resume</dt><dd data-typography="strong-body">{resumeState}</dd></div>
        </dl>
        {preparationControls?.({ defaultMode: settings.data?.resumeMode ?? null, profileVersion: profile.error ? null : profile.data?.profileVersion ?? null, blockedByDraft: resumeDirty, onReviewReady: openResume })}
        {optionalHeaderActions}
        {refresh.error ? <p role="alert">{refresh.error.message} The saved posting remains available.</p> : null}
        {profile.error ? <p role="alert">Profile unavailable: {profile.error.message}</p> : null}
        {settings.error ? <p role="alert">Saved resume preference unavailable. Choose a resume type explicitly above.</p> : null}
      </header>
      <Tabs value={tab} onValueChange={(value) => { const next = visibleTabs.find((item) => item.id === value); if (next) selectTab(next.id); }} className="job-workspace-tabs">
        <TabsList aria-label="Job workspace" className="job-workspace-tabs__list">{visibleTabs.map((item) => <TabsTrigger key={item.id} value={item.id}>{item.label}</TabsTrigger>)}</TabsList>
        <TabsContent value="fit" forceMount>
          <PersonFitPanel jobId={jobId} sources={sources.data?.sources ?? []} achievements={wording.data?.roles.flatMap((role) => role.achievements) ?? []} defaultMode={settings.data?.resumeMode ?? null} managedPreparation={Boolean(preparationControls)} />
          {overview.map(renderSection)}
          <details className="job-workspace-inspection"><summary>Posting, availability and requirement details</summary>
            <JobDescription text={posting.description} />
            <PostingAvailabilityPanel posting={posting} />
            <RoleAnalysisPanel jobId={jobId} postingRevision={posting.revision} />
            <RequirementsPanel jobId={jobId} postingRevision={posting.revision} />
            <p>Posting revision {posting.revision} · source {posting.source_id}, revision {posting.source_revision}</p>
            <Button type="button" variant="outline" disabled={!postingRefresh.available || refresh.isPending} onClick={() => refresh.mutate(posting.revision)}>Refresh posting</Button>
            {!postingRefresh.available ? <p>{postingRefresh.reason}</p> : null}
          </details>
          {affectedMatches ? <details className="job-workspace-inspection"><summary>Update affected matches</summary>{affectedMatches}</details> : null}
        </TabsContent>
        <TabsContent value="resume" forceMount>
          <ResumePanel jobId={jobId} profileVersion={profile.data?.profileVersion ?? null} defaultMode={settings.data?.resumeMode ?? null} managedPreparation={Boolean(preparationControls)} reviewSelection={reviewSelection} onProfileChanged={() => { void profile.refetch(); void wording.refetch(); }} />
        </TabsContent>
        {application.length ? <TabsContent value="application" forceMount>{application.map(renderSection)}</TabsContent> : null}
        {people.length ? <TabsContent value="people" forceMount>{people.map(renderSection)}</TabsContent> : null}
        {offer.length ? <TabsContent value="offer" forceMount>{offer.map(renderSection)}</TabsContent> : null}
      </Tabs>
    </> : null}
  </main>;
}
