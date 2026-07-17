import { JobCtrlApiError } from "@jobctrl/api-client";
import type { JobAuditEntry, StageSummary } from "@jobctrl/contracts";
import { IconArrowLeft } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { ApplyHistory } from "../../contexts/apply/components/ApplyHistory.js";
import {
  InterviewReflectionPanel,
  JobOutcomePanel,
} from "../../contexts/apply/components/ApplicationOutcomes.js";
import { CompensationAuditSection } from "../../contexts/enrichment/components/CompensationEvidence.js";
import { JobContactsPanel } from "../../contexts/outreach/components/JobContactsPanel.js";
import { ArtifactStatusBadge } from "../../contexts/materials/components/ArtifactStatusBadge.js";
import {
  EmployerAnalysisPanel,
  type EmployerAnalysisEvidenceReference,
} from "../../contexts/materials/components/EmployerAnalysisPanel.js";
import { InterviewPrepPanel } from "../../contexts/materials/components/InterviewPrepPanel.js";
import { OpenArtifactButton } from "../../contexts/materials/components/OpenArtifactButton.js";
import { JobAuditHistory } from "../../contexts/operations/components/JobAuditHistory.js";
import { useDiscoverySettingsQuery } from "../../contexts/operations/hooks/useDiscoverySettingsQuery.js";
import { useEvidenceMapQuery } from "../../contexts/operations/hooks/useEvidenceMapQuery.js";
import { useJobDetailQuery } from "../../contexts/operations/hooks/useJobDetailQuery.js";
import type { EvidenceMapEntry } from "../../contexts/operations/types.js";
import { JobActions } from "../../contexts/pipeline/components/JobActions.js";
import { StageTimeline } from "../../contexts/pipeline/components/StageTimeline.js";
import { RescoreJobButton } from "../../contexts/scoring/components/RescoreCurrentPolicyButton.js";
import { Button, buttonVariants } from "../../shared/ui/button.js";
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

function evidenceReferenceExcerpt(entry: EvidenceMapEntry): string | null {
  const excerpt = entry.story?.outcome ?? entry.story?.action ?? entry.story?.scope ?? null;
  return excerpt && excerpt !== entry.title ? excerpt : null;
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
    <section
      className="section requirement-fit-missing"
      aria-label="Requirement fit not assessed"
    >
      <div>
        <h3>Requirement fit not assessed</h3>
        <p className="muted">
          This job has employer requirements, but the stored score predates
          requirement-level fit. Re-score it to produce candidate fit, score
          impact, and tailoring actions for each requirement.
        </p>
      </div>
      <RescoreJobButton
        className="tab on"
        jobId={jobId}
        label="re-score requirement fit"
      />
    </section>
  );
}

export function JobDetailDrawer({ jobId, onClose }: JobDetailDrawerProps) {
  const { data: detail, error: detailError } = useJobDetailQuery(jobId);
  const evidenceMap = useEvidenceMapQuery();
  const evidenceEntriesById = useMemo(() => {
    const entries = new Map<string, EvidenceMapEntry>();
    for (const entry of evidenceMap.data?.entries ?? []) {
      entries.set(entry.entryId, entry);
      if (entry.evidenceId) entries.set(entry.evidenceId, entry);
    }
    return entries;
  }, [evidenceMap.data?.entries]);
  const resolveEvidenceReference = useCallback(
    (evidenceId: string): EmployerAnalysisEvidenceReference | null | undefined => {
      if (evidenceMap.isPending) return undefined;
      const entry = evidenceEntriesById.get(evidenceId);
      if (!entry) return null;
      return {
        entryId: entry.entryId,
        title: entry.title,
        excerpt: evidenceReferenceExcerpt(entry),
      };
    },
    [evidenceEntriesById, evidenceMap.isPending],
  );
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
                <Link
                  aria-label={`Open Apply Review for ${detail.job.title}`}
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                  search={{ jobKey: detail.job.jobKey }}
                  to="/apply-review"
                >
                  Open Apply Review
                </Link>
                <Link
                  aria-label={`Open evidence map for ${detail.job.title}`}
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                  search={{ q: "", entry: "", job: detail.job.jobKey }}
                  to="/evidence-map"
                >
                  Evidence map
                </Link>
              </div>
            </div>
          }
          inspector={
            <div className="job-detail-workspace__inspector">
              <Section title="Preparation diagnostics">
                <StageTimeline
                  jobId={detail.job.jobKey}
                  postingUrl={detail.job.url}
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
                {...(detail.job.company
                  ? { employer: detail.job.company }
                  : {})}
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
            <section className="section job-detail-description">
              <div className="job-detail-section-heading">
                <h3>Description</h3>
                <span>Original posting text</span>
              </div>
              <JobDescription text={detail.job.descriptionPreview} />
            </section>
            {detail.employerAnalysis && !detail.requirementFitReport ? (
              <RequirementFitMissingCallout jobId={detail.job.jobKey} />
            ) : null}
            <EmployerAnalysisPanel
              analysis={detail.employerAnalysis}
              className="section job-detail-role-analysis"
              requirementFitReport={detail.requirementFitReport}
              resolveEvidenceReference={resolveEvidenceReference}
            />
            <InterviewPrepPanel
              jobId={detail.job.jobKey}
              prep={detail.interviewPrep}
              requirements={detail.employerAnalysis?.requirements ?? []}
              resolveEvidenceReference={resolveEvidenceReference}
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
