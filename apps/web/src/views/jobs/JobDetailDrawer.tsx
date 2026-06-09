import { JobHunterApiError } from "@jobhunter/api-client";
import type { ArtifactSummary, JobAuditEntry, StageSummary } from "@jobhunter/contracts";

import { ApplyHistory } from "../../contexts/apply/components/ApplyHistory.js";
import { JobOutcomePanel } from "../../contexts/apply/components/ApplicationOutcomes.js";
import { ArtifactStatusBadge } from "../../contexts/materials/components/ArtifactStatusBadge.js";
import { ArtifactTailoringInspector } from "../../contexts/materials/components/ArtifactTailoringInspector.js";
import { EmployerAnalysisPanel } from "../../contexts/materials/components/EmployerAnalysisPanel.js";
import { OpenArtifactButton } from "../../contexts/materials/components/OpenArtifactButton.js";
import { JobAuditHistory } from "../../contexts/operations/components/JobAuditHistory.js";
import { useJobDetailQuery } from "../../contexts/operations/hooks/useJobDetailQuery.js";
import { JobActions } from "../../contexts/pipeline/components/JobActions.js";
import { StageTimeline } from "../../contexts/pipeline/components/StageTimeline.js";
import { ResetStaleScoresButton } from "../../contexts/scoring/components/ResetStaleScoresButton.js";
import { ScoreBreakdown } from "../../contexts/scoring/components/ScoreBreakdown.js";
import { ScoreCorrectionControl } from "../../contexts/scoring/components/ScoreCorrectionControl.js";
import { ScoreStalenessBadge } from "../../contexts/scoring/components/ScoreStalenessBadge.js";
import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { DetailDrawerBackdrop } from "../../shared/ui/detail-drawer-backdrop.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";
import { JobDescription } from "./JobDescription.js";
import { JobOverview } from "./JobOverview.js";

export interface JobDetailDrawerProps {
  jobId: string;
  onClose: () => void;
}

function detailErrorTitle(error: unknown): string {
  if (error instanceof JobHunterApiError && error.status === 404) {
    return "Job not found.";
  }
  return error instanceof Error ? error.message : "";
}

function preparationStages(stages: readonly StageSummary[]): StageSummary[] {
  return stages.filter((stage) => stage.stage !== "apply");
}

function canRetryStage(stage: StageSummary | undefined): boolean {
  return Boolean(stage && ["failed", "exhausted"].includes(stage.state));
}

// Prefer the rendered PDF (provenance/coverage hang off it), else the text resume.
const TAILORED_RESUME_TYPES = ["tailored_resume_pdf", "resume_pdf", "tailored_resume", "tailored_resume_txt"];

function tailoredResumeArtifact(artifacts: readonly ArtifactSummary[]): ArtifactSummary | undefined {
  for (const type of TAILORED_RESUME_TYPES) {
    const match = artifacts.find((artifact) => artifact.type === type);
    if (match) return match;
  }
  return undefined;
}

function JobAuditHistorySection({
  entries,
}: {
  readonly entries: readonly JobAuditEntry[];
}) {
  return (
    <section className="section job-audit-section">
      <details className="job-audit-disclosure">
        <summary>
          <span className="job-audit-summary-title">Audit history</span>
          <span className="tag muted">{entries.length} events</span>
        </summary>
        <JobAuditHistory entries={entries} />
      </details>
    </section>
  );
}

export function JobDetailDrawer({ jobId, onClose }: JobDetailDrawerProps) {
  useEscapeKey(true, onClose);

  const { data: detail, error: detailError } = useJobDetailQuery(jobId);
  const errorMessage = detailErrorTitle(detailError);
  const currentSubstage = detail?.stages.find(
    (stage) => stage.stage === detail.job.currentSubstage,
  );
  const resumeArtifact = detail ? tailoredResumeArtifact(detail.artifacts) : undefined;

  return (
    <DetailDrawerBackdrop onDismiss={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Job details">
        <button
          aria-label="Close job details"
          className="drawer-close"
          type="button"
          onClick={onClose}
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
              currentStage={detail.job.currentSubstage}
              canRetryStage={canRetryStage(currentSubstage)}
              canRetailor={detail.artifacts.length > 0}
            />
            <Section title="Preparation diagnostics">
              <StageTimeline
                jobId={detail.job.jobKey}
                stages={preparationStages(detail.stages)}
              />
            </Section>
            <Section title="Active artifacts">
              {detail.artifacts.length ? (
                detail.artifacts.map((artifact) => (
                  <div className="mini-row" key={artifact.artifactId}>
                    <ArtifactStatusBadge status={artifact.status} />
                    <span>{artifact.type}</span>
                    <code>{artifact.localPath}</code>
                    <OpenArtifactButton
                      artifactId={artifact.artifactId}
                      disabled={artifact.status === "missing"}
                    />
                  </div>
                ))
              ) : (
                <Empty title="No active apply-ready artifacts." />
              )}
            </Section>
            <EmployerAnalysisPanel analysis={detail.employerAnalysis} className="section" />
            {resumeArtifact ? (
              <ArtifactTailoringInspector
                artifactId={resumeArtifact.artifactId}
                className="section"
              />
            ) : null}
            <Section title="Apply history">
              <ApplyHistory jobId={detail.job.jobKey} />
            </Section>
            <Section title="Application outcomes">
              <JobOutcomePanel jobId={detail.job.jobKey} />
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
            <JobAuditHistorySection entries={detail.auditHistory} />
          </>
        ) : null}
      </div>
    </DetailDrawerBackdrop>
  );
}
