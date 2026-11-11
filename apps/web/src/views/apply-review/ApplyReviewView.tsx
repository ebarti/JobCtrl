import {
  ApplicationPanel,
  ScreeningAnswerLibrary,
  useApplicationQueueQuery,
} from "../../contexts/apply/index.js";
import { ResumePanel } from "../../contexts/resumes/index.js";
import { useProfileQuery } from "../../contexts/profile/index.js";
import { useApplicationSettings } from "../../contexts/settings/index.js";
import { Button } from "../../shared/ui/button.js";
import { PageHead } from "../../shared/ui/page-head.js";

export interface ApplyReviewViewProps {
  readonly targetJobKey?: string | null;
  readonly onTargetJobKeyChange?: (jobKey: string | null) => void;
}

export function ApplyReviewView({
  targetJobKey = null,
  onTargetJobKeyChange,
}: ApplyReviewViewProps) {
  const queue = useApplicationQueueQuery();
  const profile = useProfileQuery();
  const settings = useApplicationSettings();
  const selected = targetJobKey ?? queue.data?.[0]?.jobId ?? null;
  const selectedJob = queue.data?.find((item) => item.jobId === selected)?.job;
  return (
    <main className="page apply-review-page grid gap-6">
      <PageHead eyebrow="Jobs" title="Applications" subtitle="Review your resume, screening answers and the exact application before approving it." />
      <section
        className="section grid gap-3"
        aria-label="Application review queue"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2>Review queue</h2>
          <Button
            variant="outline"
            onClick={() => {
              void queue.refetch();
            }}
          >
            Reload review queue
          </Button>
        </div>
        {queue.isPending ? (
          <p role="status">Loading application review queue…</p>
        ) : null}
        {queue.error ? (
          <p role="alert">
            The review queue could not be refreshed. Previously loaded entries
            remain visible.
          </p>
        ) : null}
        {!queue.isPending && !queue.data?.length ? (
          <p>
            No prepared applications yet. Open a job to accept a resume, capture
            screening questions and prepare its application.
          </p>
        ) : null}
        <ul className="grid gap-2">
          {queue.data?.map((item) => (
            <li key={item.jobId}>
              <Button
                variant={selected === item.jobId ? "default" : "outline"}
                aria-pressed={selected === item.jobId}
                onClick={() => onTargetJobKeyChange?.(item.jobId)}
              >
                {item.job.title ?? item.jobId}
                {item.job.employer ? ` · ${item.job.employer}` : ""} ·{" "}
                {item.status}
                {item.stopped ? " · stopped" : ""}
              </Button>
            </li>
          ))}
        </ul>
      </section>
      {selected ? (
        <div key={selected} className="grid gap-6">
          <div className="grid gap-1">
            <h2>{selectedJob?.title ? `Application for ${selectedJob.title}` : "Selected application"}</h2>
            {selectedJob?.employer ? <p className="text-muted-foreground">{selectedJob.employer}</p> : null}
            <details className="text-sm text-muted-foreground">
              <summary>Record details</summary>
              <p className="break-all">Job ID: {selected}</p>
            </details>
          </div>
          {profile.error ? (
            <p role="alert">
              Profile unavailable. Resume composition requires the current saved
              profile revision.
            </p>
          ) : null}
          {settings.error ? (
            <p role="alert">
              Saved resume mode unavailable. Reload settings or choose an
              explicit composition mode in Resumes.
            </p>
          ) : null}
          <ResumePanel
            jobId={selected}
            profileVersion={profile.data?.profileVersion ?? null}
            defaultMode={settings.data?.resumeMode ?? null}
            onProfileChanged={() => { void profile.refetch(); }}
          />
          <ScreeningAnswerLibrary jobId={selected} initialOpen />
          <ApplicationPanel jobId={selected} />
        </div>
      ) : null}
    </main>
  );
}
