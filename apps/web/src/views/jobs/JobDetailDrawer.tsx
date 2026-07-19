import { JobCtrlApiError } from "@jobctrl/api-client";
import type { JobAuditEntry, StageSummary } from "@jobctrl/contracts";
import { IconArrowLeft, IconChevronDown } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

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
import { StatusBadge } from "../../shared/ui/status-badge.js";
import { JobAuditTriage } from "./JobAuditTriage.js";
import { JobDescription } from "./JobDescription.js";
import { JobOverview } from "./JobOverview.js";

export interface JobDetailDrawerProps {
  jobId: string;
  onClose: () => void;
}

type JobDetailMobileSection = "overview" | "diagnostics";

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
  const excerpt =
    entry.story?.outcome ?? entry.story?.action ?? entry.story?.scope ?? null;
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
          <span className="job-audit-summary-title" data-typography="control">
            Technical details
          </span>
          <StatusBadge icon={false} tone="muted">
            {entries.length} audit event{entries.length === 1 ? "" : "s"}
          </StatusBadge>
        </summary>
        <div className="job-audit-history-detail">
          <h3 data-typography="component-title">Audit history</h3>
          <JobAuditHistory entries={entries} />
        </div>
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
        className={buttonVariants({ size: "sm", variant: "default" })}
        jobId={jobId}
        label="re-score requirement fit"
      />
    </section>
  );
}

export function JobDetailDrawer({ jobId, onClose }: JobDetailDrawerProps) {
  const [mobileSection, setMobileSection] =
    useState<JobDetailMobileSection>("overview");
  const [commandsOpen, setCommandsOpen] = useState(false);
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
    (
      evidenceId: string,
    ): EmployerAnalysisEvidenceReference | null | undefined => {
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
              <div
                className="job-detail-mobile-sections"
                aria-label="Job detail section"
                role="group"
              >
                <Button
                  aria-controls="job-detail-overview-panel"
                  aria-pressed={mobileSection === "overview"}
                  data-selected={
                    mobileSection === "overview" ? "true" : "false"
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setMobileSection("overview")}
                >
                  Summary and evidence
                </Button>
                <Button
                  aria-controls="job-detail-diagnostics-panel"
                  aria-pressed={mobileSection === "diagnostics"}
                  data-selected={
                    mobileSection === "diagnostics" ? "true" : "false"
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setMobileSection("diagnostics")}
                >
                  Progress and history
                </Button>
              </div>
              <div className="job-detail-top-actions">
                <nav
                  className="job-detail-handoff-actions"
                  aria-label="Related job workspaces"
                >
                  <Link
                    aria-label={`Open Apply Review for ${detail.job.title}`}
                    className={buttonVariants({
                      size: "sm",
                      variant: "default",
                    })}
                    search={{ jobKey: detail.job.jobKey }}
                    to="/apply-review"
                  >
                    Open Apply Review
                  </Link>
                  <Link
                    aria-label={`Open evidence map for ${detail.job.title}`}
                    className={buttonVariants({
                      size: "sm",
                      variant: "outline",
                    })}
                    search={{ q: "", entry: "", job: detail.job.jobKey }}
                    to="/evidence-map"
                  >
                    Evidence map
                  </Link>
                </nav>
                <div className="job-detail-command-disclosure">
                  <Button
                    aria-controls="job-detail-workflow-commands"
                    aria-expanded={commandsOpen}
                    className="job-detail-command-trigger"
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() => setCommandsOpen((open) => !open)}
                  >
                    More job actions
                    <IconChevronDown
                      aria-hidden="true"
                      data-icon="inline-end"
                    />
                  </Button>
                  <section
                    className="job-detail-workflow-actions"
                    aria-label="Job workflow actions"
                    data-mobile-open={commandsOpen ? "true" : "false"}
                    id="job-detail-workflow-commands"
                  >
                    <JobActions
                      jobId={detail.job.jobKey}
                      currentStage={detail.job.currentSubstage}
                      canRetryStage={canRetryStage(currentSubstage)}
                      canRunCurrentStage={canRunCurrentStage(currentSubstage)}
                      canRetailor={detail.artifacts.length > 0}
                      applyApprovalRequired={applyApprovalRequired}
                      activeApplyRunId={detail.activeApplyRun?.runId ?? null}
                      isApplied={
                        detail.job.applyStatus?.toLowerCase() === "applied"
                      }
                    />
                  </section>
                </div>
              </div>
            </div>
          }
          inspector={
            <div
              className="job-detail-workspace__inspector"
              data-mobile-active={
                mobileSection === "diagnostics" ? "true" : "false"
              }
              id="job-detail-diagnostics-panel"
            >
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
                      <OpenArtifactButton
                        artifactId={artifact.artifactId}
                        disabled={artifact.status === "missing"}
                      />
                      <details className="job-artifact-technical-details">
                        <summary data-typography="control">
                          Technical details
                        </summary>
                        <code data-typography="code">{artifact.localPath}</code>
                      </details>
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
          <div
            className="job-detail-workspace__content"
            data-mobile-active={mobileSection === "overview" ? "true" : "false"}
            id="job-detail-overview-panel"
          >
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
                <span data-typography="label">Original posting text</span>
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
