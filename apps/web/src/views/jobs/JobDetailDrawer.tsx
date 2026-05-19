import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import { ApplyHistory } from "../../contexts/apply/components/ApplyHistory.js";
import { ArtifactStatusBadge } from "../../contexts/materials/components/ArtifactStatusBadge.js";
import { OpenArtifactButton } from "../../contexts/materials/components/OpenArtifactButton.js";
import { useJobDetailQuery } from "../../contexts/operations/hooks/useJobDetailQuery.js";
import { JobActions } from "../../contexts/pipeline/components/JobActions.js";
import { StageTimeline } from "../../contexts/pipeline/components/StageTimeline.js";
import { ResetStaleScoresButton } from "../../contexts/scoring/components/ResetStaleScoresButton.js";
import { ScoreBreakdown } from "../../contexts/scoring/components/ScoreBreakdown.js";
import { ScoreCorrectionControl } from "../../contexts/scoring/components/ScoreCorrectionControl.js";
import { ScoreStalenessBadge } from "../../contexts/scoring/components/ScoreStalenessBadge.js";
import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";
import { JobDescription } from "./JobDescription.js";
import { JobOverview } from "./JobOverview.js";

export interface JobDetailDrawerProps {
  jobId: string;
}

export function JobDetailDrawer({ jobId }: JobDetailDrawerProps) {
  const navigate = useNavigate();
  const search = useSearch({ from: "/jobs" });
  const close = useCallback(() => {
    void navigate({ to: "/jobs", search });
  }, [navigate, search]);
  useEscapeKey(true, close);

  const { data: detail, error: detailError } = useJobDetailQuery(jobId);
  const errorMessage = detailError instanceof Error ? detailError.message : "";

  return (
    <div className="drawer-backdrop">
      <aside className="drawer">
        <button
          aria-label="Close job details"
          className="drawer-close"
          type="button"
          onClick={close}
        >
          x
        </button>
        {errorMessage ? <Empty title={errorMessage} /> : null}
        {!detail && !errorMessage ? <Empty title="Loading job." /> : null}
        {detail ? (
          <>
            <JobOverview detail={detail} />
            <JobActions
              jobId={detail.job.jobKey}
              currentStage={detail.job.currentStage}
              nextAction={detail.job.nextAction}
            />
            <Section title="Stage timeline">
              <StageTimeline stages={detail.stages} />
            </Section>
            <Section title="Artifacts">
              {detail.artifacts.map((artifact) => (
                <div className="mini-row" key={artifact.artifactId}>
                  <ArtifactStatusBadge status={artifact.status} />
                  <span>{artifact.type}</span>
                  <code>{artifact.localPath}</code>
                  <OpenArtifactButton
                    artifactId={artifact.artifactId}
                    disabled={artifact.status === "missing"}
                  />
                </div>
              ))}
            </Section>
            <Section title="Apply history">
              <ApplyHistory jobId={detail.job.jobKey} />
            </Section>
            <Section title="Score breakdown">
              {detail.job.scoreStaleness.isStale ? (
                <div className="score-policy-row">
                  <ScoreStalenessBadge staleness={detail.job.scoreStaleness} />
                  <span className="muted">
                    scoring policy updated; reset this score before rescoring
                  </span>
                  <ResetStaleScoresButton
                    className="tab on"
                    jobKeys={[detail.job.jobKey]}
                    label="reset for rescore"
                    staleCount={1}
                  />
                </div>
              ) : null}
              <ScoreBreakdown
                fitScore={detail.job.fitScore}
                scoreBreakdown={detail.job.scoreBreakdown}
                scoreKeywords={detail.job.scoreKeywords}
                scoreReasoning={detail.job.scoreReasoning}
                scoreVersion={detail.job.scoreVersion}
                scoredAt={detail.job.scoredAt}
                scoreCriteria={detail.job.scoreCriteria}
                scoreTrace={detail.job.scoreTrace}
                scoreCorrection={detail.job.scoreCorrection}
              />
              <ScoreCorrectionControl
                jobId={detail.job.jobKey}
                currentScore={detail.job.fitScore}
              />
            </Section>
            <Section title="Description">
              <JobDescription text={detail.job.descriptionPreview} />
            </Section>
          </>
        ) : null}
      </aside>
    </div>
  );
}
