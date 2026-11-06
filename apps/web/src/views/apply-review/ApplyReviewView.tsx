import {
  ApplicationPanel,
  ScreeningAnswerLibrary,
  useApplicationQueueQuery,
} from "../../contexts/apply/index.js";
import { ResumePanel } from "../../contexts/resumes/index.js";
import { useProfileQuery } from "../../contexts/profile/index.js";
import { useApplicationSettings } from "../../contexts/settings/index.js";
import { Button } from "../../shared/ui/button.js";

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
  return (
    <main className="page apply-review-page grid gap-6">
      <header className="page-header">
        <h1>Application review</h1>
        <p>
          Review the accepted resume, screening answers and exact outgoing
          application before approving a bound payload.
        </p>
      </header>
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
          <h2>Application for {selected}</h2>
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
