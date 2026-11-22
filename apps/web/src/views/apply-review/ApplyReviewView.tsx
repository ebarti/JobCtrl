import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  ApplicationPanel,
  ScreeningAnswerLibrary,
  useApplicationQueueQuery,
} from "../../contexts/apply/index.js";
import { useJobsReturnSearch } from "../../contexts/jobs/index.js";
import {
  JobActions,
  type PreparationResumeMode,
} from "../../contexts/pipeline/index.js";
import {
  ResumePanel,
  useResumeDraftStatus,
} from "../../contexts/resumes/index.js";
import { useProfileQuery } from "../../contexts/profile/index.js";
import { useMountedFeatures } from "../../contexts/runtime/index.js";
import { useApplicationSettings } from "../../contexts/settings/index.js";
import { Badge } from "../../shared/ui/badge.js";
import { Button } from "../../shared/ui/button.js";
import { Input } from "../../shared/ui/input.js";
import { PageHead } from "../../shared/ui/page-head.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../shared/ui/tabs.js";
import "../../styles/applications-workspace.css";

export type ApplicationReviewTab = "resume" | "screening" | "application";

function applicationStatusLabel(status: string, stopped: boolean) {
  const words = status.replaceAll("_", " ");
  return `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}${stopped ? " · Stopped" : ""}`;
}

export interface ApplyReviewViewProps {
  readonly targetJobKey?: string | null;
  readonly onTargetJobKeyChange?: (jobKey: string | null) => void;
  readonly targetTab?: ApplicationReviewTab;
  readonly onTargetTabChange?: (tab: ApplicationReviewTab) => void;
}

/** Resume preparation stays independent of approving or executing an application. */
function ApplicationResumeWorkspace({
  jobId,
  profileVersion,
  defaultMode,
  onProfileChanged,
}: {
  readonly jobId: string;
  readonly profileVersion: number | null;
  readonly defaultMode: PreparationResumeMode | null;
  readonly onProfileChanged: () => void;
}) {
  const features = useMountedFeatures();
  const preparationMounted = features.has("preparation");
  const dirty = useResumeDraftStatus(jobId);
  const jobsReturn = useJobsReturnSearch();
  const [reviewSelection, setReviewSelection] = useState<{
    resumeId: string;
    requestId: string;
  } | null>(null);
  const resumeRef = useRef<HTMLElement>(null);
  const reviewReady = useCallback((resumeId?: string, requestId?: string) => {
    if (resumeId && requestId) {
      // Completion selects the prepared result without interrupting an active
      // editor. Explicit Review navigation below still moves focus deliberately.
      setReviewSelection({ resumeId, requestId });
      return;
    }
    resumeRef.current?.scrollIntoView({ block: "start" });
    resumeRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="application-resume-workspace grid gap-4">
      {preparationMounted ? (
        <JobActions
          jobId={jobId}
          profileVersion={profileVersion}
          defaultMode={defaultMode}
          blockedByDraft={dirty}
          onReviewReady={reviewReady}
          renderProfileSetup={(mode) => (
            <Link
              className="underline"
              to="/profile"
              search={{
                section: "experience",
                returnJobId: jobId,
                returnJobs: {
                  ...jobsReturn,
                  jobTab: "application",
                  ...(mode ? { resumeMode: mode } : {}),
                },
                ...(mode ? { returnResumeMode: mode } : {}),
              }}
            >
              Open My profile
            </Link>
          )}
        />
      ) : null}
      <section
        ref={resumeRef}
        tabIndex={-1}
        aria-label="Application resume workspace"
      >
        <ResumePanel
          jobId={jobId}
          profileVersion={profileVersion}
          defaultMode={defaultMode}
          managedPreparation={preparationMounted}
          reviewSelection={reviewSelection}
          onProfileChanged={onProfileChanged}
        />
      </section>
    </div>
  );
}

export function ApplyReviewView({
  targetJobKey = null,
  onTargetJobKeyChange,
  targetTab = "resume",
  onTargetTabChange,
}: ApplyReviewViewProps) {
  const queue = useApplicationQueueQuery();
  const profile = useProfileQuery();
  const settings = useApplicationSettings();
  const [filter, setFilter] = useState("");
  const [mobileQueueOpen, setMobileQueueOpen] = useState(false);
  const queueToggleRef = useRef<HTMLButtonElement>(null);
  const queueId = useId();
  const selected = targetJobKey ?? queue.data?.[0]?.jobId ?? null;
  const selectedItem = queue.data?.find((item) => item.jobId === selected);
  const needle = filter.trim().toLocaleLowerCase();
  const visibleItems =
    queue.data?.filter((item) =>
      [item.job.title, item.job.employer, item.status].some((value) =>
        value?.toLocaleLowerCase().includes(needle),
      ),
    ) ?? [];

  // Make the initially selected queue entry as shareable as an explicit selection.
  useEffect(() => {
    if (!targetJobKey && queue.data?.[0]) {
      onTargetJobKeyChange?.(queue.data[0].jobId);
    }
  }, [onTargetJobKeyChange, queue.data, targetJobKey]);

  return (
    <div className="page apply-review-page grid gap-6">
      <PageHead
        eyebrow="Jobs"
        title="Applications"
        subtitle="Review your resume, screening answers and the exact application before approving it."
      />
      <div className="application-workspace">
        <Button
          ref={queueToggleRef}
          variant="outline"
          className="application-queue-toggle"
          aria-controls={queueId}
          aria-expanded={mobileQueueOpen}
          onClick={() => setMobileQueueOpen((open) => !open)}
        >
          {mobileQueueOpen ? "Close review queue" : "Choose an application"}
          {queue.data ? (
            <span aria-hidden="true"> · {queue.data.length}</span>
          ) : null}
        </Button>
        <aside
          id={queueId}
          className="application-queue"
          data-mobile-open={mobileQueueOpen}
          aria-label="Application review queue"
        >
          <div className="application-queue-header">
            <div>
              <h2>Review queue</h2>
              <p>
                {queue.data
                  ? `${queue.data.length} ${queue.data.length === 1 ? "application" : "applications"}`
                  : queue.isPending
                    ? "Loading…"
                    : "Unavailable"}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void queue.refetch();
              }}
            >
              Refresh
            </Button>
          </div>
          <label className="application-queue-filter">
            <span>Filter applications</span>
            <Input
              type="search"
              name="filter-applications"
              placeholder="Role, company or status"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          {queue.isPending ? (
            <p role="status">Loading application review queue…</p>
          ) : null}
          {queue.error ? (
            <p role="alert">
              The review queue could not be refreshed.{" "}
              {queue.data
                ? "Previously loaded entries remain visible."
                : "Try refreshing the queue."}
            </p>
          ) : null}
          {queue.data && !queue.data.length ? (
            <p>
              No applications in the review queue yet. Open a job to accept a
              resume, capture screening questions and prepare its application.
            </p>
          ) : null}
          {queue.data?.length && !visibleItems.length ? (
            <p>No applications match this filter.</p>
          ) : null}
          <ul className="application-queue-list">
            {visibleItems.map((item) => (
              <li key={item.jobId}>
                <button
                  type="button"
                  className="application-queue-item"
                  aria-pressed={selected === item.jobId}
                  onClick={() => {
                    onTargetJobKeyChange?.(item.jobId);
                    if (mobileQueueOpen) queueToggleRef.current?.focus();
                    setMobileQueueOpen(false);
                  }}
                >
                  <strong>{item.job.title ?? "Untitled role"}</strong>
                  <span>{item.job.employer ?? "Employer not specified"}</span>
                  <span className="application-queue-status">
                    {applicationStatusLabel(item.status, item.stopped)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        {selected ? (
          <section
            key={selected}
            className="application-review-workspace"
            aria-label="Selected application workspace"
          >
            <header className="application-selected-header">
              <div>
                <h2>{selectedItem?.job.title ?? "Selected application"}</h2>
                {selectedItem?.job.employer ? (
                  <p>{selectedItem.job.employer}</p>
                ) : null}
                <details>
                  <summary>Record details</summary>
                  <p className="break-all">Job ID: {selected}</p>
                </details>
              </div>
              {selectedItem ? (
                <Badge variant="secondary">
                  {applicationStatusLabel(
                    selectedItem.status,
                    selectedItem.stopped,
                  )}
                </Badge>
              ) : null}
            </header>
            <Tabs
              value={targetTab}
              onValueChange={(value) => {
                if (
                  value === "resume" ||
                  value === "screening" ||
                  value === "application"
                )
                  onTargetTabChange?.(value);
              }}
            >
              <TabsList
                aria-label="Application review tasks"
                className="application-task-tabs"
              >
                <TabsTrigger value="resume">Resume</TabsTrigger>
                <TabsTrigger value="screening">Screening answers</TabsTrigger>
                <TabsTrigger value="application">
                  Application review
                </TabsTrigger>
              </TabsList>
              <TabsContent value="resume" forceMount>
                {profile.error ? (
                  <p role="alert">
                    Profile unavailable. Resume composition requires the current
                    saved profile revision.
                  </p>
                ) : null}
                {settings.error ? (
                  <p role="alert">
                    Saved resume preference unavailable. Choose a resume type
                    explicitly.
                  </p>
                ) : null}
                <ApplicationResumeWorkspace
                  jobId={selected}
                  profileVersion={
                    profile.error
                      ? null
                      : (profile.data?.profileVersion ?? null)
                  }
                  defaultMode={settings.data?.resumeMode ?? null}
                  onProfileChanged={() => {
                    void profile.refetch();
                  }}
                />
              </TabsContent>
              <TabsContent value="screening" forceMount>
                <ScreeningAnswerLibrary jobId={selected} embedded />
              </TabsContent>
              <TabsContent value="application" forceMount>
                <ApplicationPanel jobId={selected} />
              </TabsContent>
            </Tabs>
          </section>
        ) : (
          <div className="application-workspace-empty">
            Select an application to begin review.
          </div>
        )}
      </div>
    </div>
  );
}
