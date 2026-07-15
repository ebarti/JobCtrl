import { JobCtrlApiError } from "@jobctrl/api-client";
import type { JobAuditEntry, StageSummary } from "@jobctrl/contracts";
import { IconX } from "@tabler/icons-react";
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
import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { DetailDrawerBackdrop } from "../../shared/ui/detail-drawer-backdrop.js";
import { Empty } from "../../shared/ui/empty.js";
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
  useEscapeKey(true, onClose);

  const { data: detail, error: detailError } = useJobDetailQuery(jobId);
  const discoverySettingsQuery = useDiscoverySettingsQuery();
  const applyApprovalRequired =
    discoverySettingsQuery.data?.settings.applyApprovalRequired ?? true;
  const errorMessage = detailErrorTitle(detailError);
  const currentSubstage = detail?.stages.find(
    (stage) => stage.stage === detail.job.currentSubstage,
  );

  return (
    <DetailDrawerBackdrop onDismiss={onClose}>
      <div className="drawer job-detail-drawer" role="dialog" aria-modal="true" aria-label="Job details">
        <button
          aria-label="Close job details"
          className="drawer-close"
          type="button"
          onClick={onClose}
        >
          <IconX aria-hidden="true" size={18} stroke={1.8} />
        </button>
        {errorMessage ? <Empty title={errorMessage} /> : null}
        {!detail && !errorMessage ? <Empty title="Loading job." /> : null}
        {detail ? (
          <>
            <JobOverview detail={detail} />
            <div className="job-detail-drawer-content">
              <div className="job-detail-top-actions">
                <JobActions
                  jobId={detail.job.jobKey}
                  currentStage={detail.job.currentSubstage}
                  canRetryStage={canRetryStage(currentSubstage)}
                  canRunCurrentStage={canRunCurrentStage(currentSubstage)}
                  canRetailor={detail.artifacts.length > 0}
                  applyApprovalRequired={applyApprovalRequired}
                />
                <Link
                  aria-label={`Open Apply Review for ${detail.job.title}`}
                  className="tab"
                  search={{ jobKey: detail.job.jobKey }}
                  to="/apply-review"
                >
                  Open Apply Review
                </Link>
                <Link
                  aria-label={`Open evidence map for ${detail.job.title}`}
                  className="tab"
                  search={{ q: "", entry: "", job: detail.job.jobKey }}
                  to="/evidence-map"
                >
                  Evidence map
                </Link>
              </div>
              <div className="job-detail-workspace job-detail-drawer-main">
                <main className="job-detail-primary">
                  <JobAuditTriage detail={detail} />
                  <section className="section job-detail-description">
                    <div className="job-detail-section-heading">
                      <h3>Description</h3>
                      <span>Original posting text</span>
                    </div>
                    <JobDescription text={detail.job.descriptionPreview} />
                  </section>
                  <CompensationAuditSection
                    jobId={detail.job.jobKey}
                    summary={detail.job.compensationSummary}
                    audit={detail.compensationAudit}
                    fallbackSalary={detail.job.salary}
                  />
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
                </main>
                <aside className="job-detail-sidebar" aria-label="Job preparation and audit">
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
                  <JobAuditHistorySection entries={detail.auditHistory} />
                </aside>
              </div>
              <div className="job-detail-follow-up">
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
              </div>
            </div>
          </>
        ) : null}
      </div>
    </DetailDrawerBackdrop>
  );
}
