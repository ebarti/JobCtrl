import { JobCtrlApiError } from "@jobctrl/api-client";
import type { JobAuditEntry, StageSummary } from "@jobctrl/contracts";
import { IconArrowLeft, IconChevronDown } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { ApplyHistory } from "../../contexts/apply/components/ApplyHistory.js";
import {
  InterviewReflectionPanel,
  JobOutcomePanel,
} from "../../contexts/apply/components/ApplicationOutcomes.js";
import { PostingAvailability } from "../../contexts/enrichment/index.js";
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
import type { ArtifactSummary, EvidenceMapEntry } from "../../contexts/operations/types.js";
import { JobActions } from "../../contexts/pipeline/components/JobActions.js";
import { RetryStageButton } from "../../contexts/pipeline/components/RetryStageButton.js";
import { StageTimeline } from "../../contexts/pipeline/components/StageTimeline.js";
import { RescoreJobButton } from "../../contexts/scoring/components/RescoreCurrentPolicyButton.js";
import { Button, buttonVariants } from "../../shared/ui/button.js";
import { ContextHelp } from "../../shared/ui/context-help.js";
import { DisclosureSection } from "../../shared/ui/disclosure-section.js";
import { Empty } from "../../shared/ui/empty.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/popover.js";
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

interface JobDetailSectionDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly content: ReactNode;
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

function isLinkedInPosting(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:"
      && (url.hostname === "linkedin.com" || url.hostname === "www.linkedin.com")
      && /^\/jobs\/view\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function evidenceReferenceExcerpt(entry: EvidenceMapEntry): string | null {
  const excerpt =
    entry.story?.outcome ?? entry.story?.action ?? entry.story?.scope ?? null;
  return excerpt && excerpt !== entry.title ? excerpt : null;
}

function groupJobArtifacts(artifacts: readonly ArtifactSummary[]) {
  const accepted: ArtifactSummary[] = [];
  const other: ArtifactSummary[] = [];
  const superseded: ArtifactSummary[] = [];
  for (const artifact of artifacts) {
    if (artifact.status === "active" || artifact.status === "approved") {
      accepted.push(artifact);
    } else if (artifact.status === "superseded") {
      superseded.push(artifact);
    } else {
      other.push(artifact);
    }
  }
  accepted.sort((left, right) => {
    const generationDifference = (right.generation ?? -1) - (left.generation ?? -1);
    if (generationDifference) return generationDifference;
    const leftTime = Date.parse(left.createdAt ?? "") || 0;
    const rightTime = Date.parse(right.createdAt ?? "") || 0;
    return rightTime - leftTime;
  });
  return { accepted, other, superseded };
}

function JobArtifactRow({ artifact }: { readonly artifact: ArtifactSummary }) {
  return (
    <div className="mini-row job-artifact-row">
      <ArtifactStatusBadge status={artifact.status} />
      <span>
        {artifact.type}
        {artifact.generation != null ? ` · Generation ${artifact.generation}` : null}
        <ContextHelp label={`${artifact.type} artifact`} description={`This saved material is ${artifact.status}${artifact.generation == null ? "" : ` in generation ${artifact.generation}`}. Its status comes from the artifact lifecycle record. ${artifact.status === "missing" ? "No file is available to open." : "Open it to inspect the material."} Superseded versions remain available in the history disclosure.`} />
      </span>
      <OpenArtifactButton
        artifactId={artifact.artifactId}
        className={buttonVariants({ size: "sm", variant: "outline" })}
        disabled={artifact.status === "missing"}
      />
      <details className="job-artifact-technical-details">
        <summary data-typography="control">Technical details</summary>
        <code data-typography="code">{artifact.localPath}</code>
      </details>
    </div>
  );
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
          <h3 aria-label="Audit history" data-typography="component-title">Audit history <ContextHelp label="Audit history" description="Recorded job events and technical changes. They show what happened in the local workflow; an event is not proof that an external application was submitted." /></h3>
          <JobAuditHistory entries={entries} />
        </div>
      </details>
    </section>
  );
}

function RequirementFitMissingCallout({
  jobId,
  outdated,
}: { readonly jobId: string; readonly outdated: boolean }) {
  const title = outdated ? "Requirement fit is outdated" : "Requirement fit not assessed";
  return (
    <section
      className="section requirement-fit-missing"
      aria-label={title}
    >
      <div>
        <h3 aria-label={title}>{title} <ContextHelp label="Requirement fit status" description="The stored requirement-level score is absent or belongs to an earlier analysis or score version. Re-score to assess current requirements; prior score and materials remain available for review." /></h3>
        <p className="muted">
          {outdated
            ? "The saved requirement fit belongs to a different employer-analysis generation or score version. Re-score this job to assess the current requirements; the previous score and materials remain available for review."
            : "This job has employer requirements, but the stored score predates requirement-level fit. Re-score it to produce candidate fit, score impact, and tailoring actions for each requirement."}
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
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const jumpTarget = useRef<string | null>(null);
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
  const artifactGroups = groupJobArtifacts(detail?.artifacts ?? []);
  const sections: JobDetailSectionDefinition[] = detail ? [
    {
      id: "fit-evidence",
      title: "Fit & evidence",
      description: "Assessment, requirement fit, and apply concerns",
      content: <>
        <JobAuditTriage detail={detail} />
        {detail.employerAnalysis && !detail.requirementFitReport ? (
          <RequirementFitMissingCallout
            jobId={detail.job.jobKey}
            outdated={detail.job.scoreAnalysisFreshness?.status === "outdated"}
          />
        ) : null}
      </>,
    },
    {
      id: "preparation",
      title: "Preparation diagnostics",
      description: "Saved workflow stages and application target",
      content: <>
        <PostingAvailability jobId={detail.job.jobKey} postingUrl={detail.job.url} availability={detail.job.availability} />
        <Section title="Preparation diagnostics" help="Saved preparation stage states and diagnostic messages. A failed, blocked, or exhausted stage calls for review; these stages do not by themselves submit an application.">
          <StageTimeline jobId={detail.job.jobKey} postingUrl={detail.job.url} stages={preparationStages(detail.stages)} />
        </Section>
        {!detail.job.applicationUrl && isLinkedInPosting(detail.job.url)
          && detail.stages.some((stage) => stage.stage === "enrich" && stage.state === "succeeded") ? (
          <section className="section requirement-fit-missing" aria-label="Application target refresh">
            <div>
              <h3 aria-label="Application target unavailable">Application target unavailable <ContextHelp label="Application target" description="A verified destination link was not saved for this posting. Refresh attempts to locate a target; the saved description, score, and materials remain available even if none is found." /></h3>
              <p className="muted">Check the current posting for an application link. The saved description, score, and materials stay available if the check finds no verified target.</p>
              {detail.stages.find((stage) => stage.stage === "enrich")?.applyUrlOutcome?.message ? (
                <p className="muted">{detail.stages.find((stage) => stage.stage === "enrich")?.applyUrlOutcome?.message}</p>
              ) : null}
            </div>
            <RetryStageButton jobId={detail.job.jobKey} stage="enrich" runAfter refreshApplyUrl label="Refresh application target" />
          </section>
        ) : null}
      </>,
    },
    {
      id: "artifacts",
      title: "Artifacts",
      description: "Accepted materials and lifecycle history",
      content: <Section title="Artifacts" help="Generated job materials and their canonical lifecycle statuses. Accepted versions appear first, newest generation first; only records marked superseded are in the disclosure. Failed or draft refreshes never erase an accepted material.">
        {detail.artifacts.length ? <>
          {[...artifactGroups.accepted, ...artifactGroups.other].map((artifact) => <JobArtifactRow artifact={artifact} key={artifact.artifactId} />)}
          {artifactGroups.superseded.length ? (
            <details className="job-artifact-history">
              <summary data-typography="control">Superseded artifacts ({artifactGroups.superseded.length})</summary>
              {artifactGroups.superseded.map((artifact) => <JobArtifactRow artifact={artifact} key={artifact.artifactId} />)}
            </details>
          ) : null}
        </> : <Empty title="No artifacts recorded." />}
      </Section>,
    },
    {
      id: "compensation",
      title: "Compensation",
      description: "Posted pay and market evidence",
      content: <CompensationAuditSection jobId={detail.job.jobKey} summary={detail.job.compensationSummary} audit={detail.compensationAudit} fallbackSalary={detail.job.salary} />,
    },
    {
      id: "description",
      title: "Description",
      description: "Captured posting text",
      content: <section className="section job-detail-description">
        <div className="job-detail-section-heading">
          <h3 aria-label="Description">Description <ContextHelp label="Description" description="Saved text captured from the original job posting. It may differ from the live posting after capture; use the original posting link to verify current wording." /></h3>
          <span data-typography="label">Original posting text</span>
        </div>
        <JobDescription text={detail.job.descriptionPreview} />
      </section>,
    },
    {
      id: "role-analysis",
      title: "Role Analysis",
      description: "Employer interpretation and requirement evidence",
      content: <EmployerAnalysisPanel analysis={detail.employerAnalysis} className="section job-detail-role-analysis" requirementFitReport={detail.requirementFitReport} resolveEvidenceReference={resolveEvidenceReference} />,
    },
    {
      id: "interview",
      title: "Interview prep",
      description: "Practice material and reflections",
      content: <InterviewPrepPanel jobId={detail.job.jobKey} prep={detail.interviewPrep} requirements={detail.employerAnalysis?.requirements ?? []} resolveEvidenceReference={resolveEvidenceReference} reflectionContent={detail.interviewPrep ? <InterviewReflectionPanel jobId={detail.job.jobKey} prepGeneration={detail.interviewPrep.generation} /> : null} />,
    },
    {
      id: "apply-history",
      title: "Apply history",
      description: "Recorded attempts and dry runs",
      content: <Section title="Apply history" help="Recorded apply runs for this job, including dry runs and their status. Open a run to inspect its details; a dry run is not a submission."><ApplyHistory jobId={detail.job.jobKey} /></Section>,
    },
    {
      id: "outcomes",
      title: "Application outcomes",
      description: "Recorded follow-up outcomes",
      content: <Section title="Application outcomes" help="Manually recorded or suggested follow-up outcomes for this job. Suggested outcomes need review before acceptance, and an empty timeline means none are recorded here."><JobOutcomePanel jobId={detail.job.jobKey} /></Section>,
    },
    {
      id: "contacts",
      title: "Contacts",
      description: "People and outreach research linked to this job",
      content: <JobContactsPanel jobId={detail.job.jobKey} {...(detail.job.company ? { employer: detail.job.company } : {})} />,
    },
    {
      id: "audit",
      title: "Audit history",
      description: "Recorded job events and technical changes",
      content: <JobAuditHistorySection entries={detail.auditHistory} />,
    },
  ] : [];

  function jumpToSection(id: string) {
    jumpTarget.current = id;
    setExpandedSections((current) => ({ ...current, [id]: true }));
    setSectionsOpen(false);
  }

  function focusJumpTarget() {
    const id = jumpTarget.current;
    if (!id) return;
    jumpTarget.current = null;
    const section = document.getElementById(`job-detail-${id}`);
    const trigger = section?.querySelector<HTMLButtonElement>("[data-slot='collapsible-trigger']");
    if (!section || !trigger) return;
    const topbarBottom = document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect().bottom ?? 0;
    section.style.setProperty("--job-detail-topbar-bottom", `${Math.max(0, topbarBottom)}px`);
    section.scrollIntoView?.({ block: "start" });
    trigger.focus({ preventScroll: true });
  }

  return (
    <div className="route-page route-page--job-detail" aria-label="Job details">
      {errorMessage ? <Empty title={errorMessage} /> : null}
      {!detail && !errorMessage ? <Empty title="Loading job." /> : null}
      {detail ? (
        <RouteWorkspace
          aria-label="Job details"
          className="job-detail-workspace"
          contentLabel="Job evidence and analysis"
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
                <Popover open={commandsOpen} onOpenChange={setCommandsOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      className="job-detail-command-trigger"
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      More job actions
                      <IconChevronDown
                        aria-hidden="true"
                        data-icon="inline-end"
                      />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    aria-label="Job workflow actions"
                    className="job-detail-workflow-actions"
                    id="job-detail-workflow-commands"
                    sideOffset={8}
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
                  </PopoverContent>
                </Popover>
              </div>
              <JobOverview detail={detail} />
              <Popover open={sectionsOpen} onOpenChange={setSectionsOpen}>
                <PopoverTrigger asChild>
                  <Button className="job-detail-sections-trigger" size="sm" type="button" variant="outline">
                    Sections
                    <IconChevronDown aria-hidden="true" data-icon="inline-end" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  aria-label="Job detail sections"
                  className="job-detail-sections-menu"
                  onCloseAutoFocus={(event) => {
                    if (jumpTarget.current) {
                      event.preventDefault();
                      focusJumpTarget();
                    }
                  }}
                  side="top"
                  sideOffset={8}
                >
                  <nav aria-label="Job detail sections">
                    {sections.map((section) => (
                      <Button
                        aria-controls={`job-detail-${section.id}`}
                        aria-expanded={expandedSections[section.id] ?? true}
                        key={section.id}
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() => jumpToSection(section.id)}
                      >
                        {section.title}
                      </Button>
                    ))}
                  </nav>
                  <div className="job-detail-sections-menu__bulk">
                    <Button size="sm" type="button" variant="outline" onClick={() => {
                      setExpandedSections(Object.fromEntries(sections.map((section) => [section.id, true])));
                      setSectionsOpen(false);
                    }}>Expand all</Button>
                    <Button size="sm" type="button" variant="outline" onClick={() => {
                      setExpandedSections(Object.fromEntries(sections.map((section) => [section.id, false])));
                      setSectionsOpen(false);
                    }}>Collapse all</Button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          }
        >
          <div className="job-detail-workspace__content">
            {sections.map((section, index) => (
              <DisclosureSection
                className="job-detail-major-section"
                description={section.description}
                headingLevel={2}
                id={`job-detail-${section.id}`}
                key={section.id}
                onOpenChange={(open) => setExpandedSections((current) => ({ ...current, [section.id]: open }))}
                open={expandedSections[section.id] ?? true}
                title={`${String(index + 1).padStart(2, "0")} · ${section.title}`}
              >
                {section.content}
              </DisclosureSection>
            ))}
          </div>
        </RouteWorkspace>
      ) : null}
    </div>
  );
}
