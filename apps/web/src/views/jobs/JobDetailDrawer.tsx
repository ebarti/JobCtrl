import { JobCtrlApiError } from "@jobctrl/api-client";
import type { JobAuditEntry, StageSummary } from "@jobctrl/contracts";
import { IconArrowLeft } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { ApplyHistory } from "../../contexts/apply/components/ApplyHistory.js";
import {
  InterviewReflectionPanel,
  JobOutcomePanel,
} from "../../contexts/apply/components/ApplicationOutcomes.js";
import { CompensationAuditSection } from "../../contexts/enrichment/components/CompensationEvidence.js";
import { JobContactsPanel } from "../../contexts/outreach/components/JobContactsPanel.js";
import { ArtifactStatusBadge } from "../../contexts/materials/components/ArtifactStatusBadge.js";
import { EmployerAnalysisPanel } from "../../contexts/materials/components/EmployerAnalysisPanel.js";
import { InterviewPrepPanel } from "../../contexts/materials/components/InterviewPrepPanel.js";
import { OpenArtifactButton } from "../../contexts/materials/components/OpenArtifactButton.js";
import { JobAuditHistory } from "../../contexts/operations/components/JobAuditHistory.js";
import { useDiscoverySettingsQuery } from "../../contexts/operations/hooks/useDiscoverySettingsQuery.js";
import { useJobDetailQuery } from "../../contexts/operations/hooks/useJobDetailQuery.js";
import { JobActions } from "../../contexts/pipeline/components/JobActions.js";
import { StageTimeline } from "../../contexts/pipeline/components/StageTimeline.js";
import { RescoreJobButton } from "../../contexts/scoring/components/RescoreCurrentPolicyButton.js";
import { Button } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
import { Section } from "../../shared/ui/section.js";
import { JobAuditTriage } from "./JobAuditTriage.js";
import { JobDescription } from "./JobDescription.js";
import { JobOverview } from "./JobOverview.js";

export interface JobDetailDrawerProps {
  jobId: string;
  onClose: () => void;
}

function detailErrorTitle(error: unknown): string {
  if (error instanceof JobCtrlApiError && error.status === 404) {
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

function canRunCurrentStage(stage: StageSummary | undefined): boolean {
  return Boolean(stage && !["queued", "running"].includes(stage.state));
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

function RequirementFitMissingCallout({ jobId }: { readonly jobId: string }) {
  return (
    <section className="section requirement-fit-missing" aria-label="Requirement fit not assessed">
      <div>
        <h3>Requirement fit not assessed</h3>
        <p className="muted">
          This job has employer requirements, but the stored score predates requirement-level fit.
          Re-score it to produce candidate fit, score impact, and tailoring actions for each
          requirement.
        </p>
      </div>
      <RescoreJobButton className="tab on" jobId={jobId} label="re-score requirement fit" />
    </section>
  );
}

export function JobDetailDrawer({ jobId, onClose }: JobDetailDrawerProps) {
  const { data: detail, error: detailError } = useJobDetailQuery(jobId);
  const discoverySettingsQuery = useDiscoverySettingsQuery();
  const applyApprovalRequired =
    discoverySettingsQuery.data?.settings.applyApprovalRequired ?? true;
  const errorMessage = detailErrorTitle(detailError);
  const currentSubstage = detail?.stages.find(
    (stage) => stage.stage === detail.job.currentSubstage,
  );

  return (
    <div className="route-page route-page--job-detail" aria-label="Job details">
      {errorMessage ? <Empty title={errorMessage} /> : null}
      {!detail && !errorMessage ? <Empty title="Loading job." /> : null}
      {detail ? (
        <RouteWorkspace
          aria-label="Job details"
          className="job-detail-workspace"
          contentLabel="Job evidence and analysis"
          inspectorLabel="Job progress, materials, and history"
          header={
            <div className="job-detail-workspace__header">
              <Button
                aria-label="Back to jobs"
                className="workspace-back"
                size="sm"
                type="button"
                variant="ghost"
                onClick={onClose}
              >
                <IconArrowLeft aria-hidden="true" size={16} stroke={1.9} />
                Jobs
              </Button>
              <JobOverview detail={detail} />
              <div className="job-detail-top-actions">
                <JobActions
                  jobId={detail.job.jobKey}
                  currentStage={detail.job.currentSubstage}
                  canRetryStage={canRetryStage(currentSubstage)}
                  canRunCurrentStage={canRunCurrentStage(currentSubstage)}
                  canRetailor={detail.artifacts.length > 0}
                  applyApprovalRequired={applyApprovalRequired}
                />
                <Button asChild size="sm" variant="outline">
                  <Link
                    aria-label={`Open Apply Review for ${detail.job.title}`}
                    search={{ jobKey: detail.job.jobKey }}
                    to="/apply-review"
                  >
                    Open Apply Review
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link
                    aria-label={`Open evidence map for ${detail.job.title}`}
                    search={{ q: "", entry: "", job: detail.job.jobKey }}
                    to="/evidence-map"
                  >
                    Evidence map
                  </Link>
                </Button>
              </div>
            </div>
          }
          inspector={
            <div className="job-detail-workspace__inspector">
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
              <Section title="Apply history">
                <ApplyHistory jobId={detail.job.jobKey} />
              </Section>
              <Section title="Application outcomes">
                <JobOutcomePanel jobId={detail.job.jobKey} />
              </Section>
              <JobContactsPanel
                jobId={detail.job.jobKey}
                {...(detail.job.company ? { employer: detail.job.company } : {})}
              />
              <JobAuditHistorySection entries={detail.auditHistory} />
            </div>
          }
        >
          <div className="job-detail-workspace__content">
            <JobAuditTriage detail={detail} />
            <CompensationAuditSection
              jobId={detail.job.jobKey}
              summary={detail.job.compensationSummary}
              audit={detail.compensationAudit}
              fallbackSalary={detail.job.salary}
            />
            <Section title="Description" className="job-detail-description">
              <JobDescription text={detail.job.descriptionPreview} />
            </Section>
            {detail.employerAnalysis && !detail.requirementFitReport ? (
              <RequirementFitMissingCallout jobId={detail.job.jobKey} />
            ) : null}
            <EmployerAnalysisPanel
              analysis={detail.employerAnalysis}
              className="section job-detail-role-analysis"
              requirementFitReport={detail.requirementFitReport}
            />
            <InterviewPrepPanel
              jobId={detail.job.jobKey}
              prep={detail.interviewPrep}
              reflectionContent={
                detail.interviewPrep ? (
                  <InterviewReflectionPanel
                    jobId={detail.job.jobKey}
                    prepGeneration={detail.interviewPrep.generation}
                  />
                ) : null
              }
            />
          </div>
        </RouteWorkspace>
      ) : null}
    </div>
  );
}
