import { IconExternalLink } from "@tabler/icons-react";

import type { JobDetail } from "../../contexts/operations/types.js";
import { ScoreBadge } from "../../contexts/scoring/components/ScoreBadge.js";
import { ContextHelp } from "../../shared/ui/context-help.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";
import { fitScoreHelp } from "./fit-score-help.js";

export interface JobOverviewProps {
  detail: JobDetail;
}

function auditTone(
  state: JobDetail["applyAudit"]["state"],
): "ok" | "info" | "warn" {
  if (state === "ready") return "ok";
  if (state === "preparing") return "info";
  return "warn";
}

function applicationTone(status: string | null): "ok" | "info" | "muted" {
  if (status?.toLowerCase() === "applied") return "ok";
  if (status?.toLowerCase() === "in_progress") return "info";
  return "muted";
}

function workflowTone(state: string): "ok" | "info" | "muted" | "warn" | "danger" {
  if (state === "succeeded") return "ok";
  if (state === "queued" || state === "running") return "info";
  if (state === "failed" || state === "exhausted") return "danger";
  if (state === "blocked" || state === "needs_verification") return "warn";
  return "muted";
}

function sentenceCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

export function JobOverview({ detail }: JobOverviewProps) {
  const { applyAudit, job } = detail;
  return (
    <header className="drawer-head job-overview">
      <div
        className="job-overview-score"
        aria-label={`Fit score ${job.fitScore ?? "not scored"}`}
      >
        <span className="job-overview-score-label" data-typography="label">
          Fit
          <ContextHelp label="Fit score" description={fitScoreHelp(job)} />
        </span>
        <span data-typography="metric">
          <ScoreBadge score={job.fitScore} />
        </span>
      </div>
      <div className="job-overview-copy">
        <h1 data-typography="page-title">{job.title}</h1>
        <dl className="job-overview-facts" aria-label="Job metadata">
          {job.company ? (
            <MetadataField label="Company" value={job.company} help="Employer name saved with the job posting. Verify it against the original posting before using it in application materials." />
          ) : null}
          {job.location.trim() ? (
            <MetadataField label="Location" value={job.location} help="Location text saved from the posting; it is not a verified work-arrangement or relocation guarantee." />
          ) : null}
          {job.salary.trim() ? (
            <MetadataField label="Salary" value={job.salary} help="Raw salary text captured with the posting. The Compensation section separates employer-posted facts from market estimates and their evidence." />
          ) : null}
          <div>
            <dt data-typography="label">Posting <ContextHelp label="Posting" description="The recorded source and original posting URL. Opening it starts a new tab; the current posting may have changed since capture." /></dt>
            <dd data-typography="metadata">
              <span>{job.postingSource || "not recorded"}</span>
              <a
                className="external-link"
                data-typography="control"
                href={job.url}
                rel="noreferrer"
                target="_blank"
              >
                Open original posting
                <IconExternalLink aria-hidden="true" size={14} stroke={1.9} />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </dd>
          </div>
          {job.discoverySource ? (
            <MetadataField label="Discovered via" value={job.discoverySource} help="Discovery source recorded when this job entered the local pipeline; it does not establish that the current posting is still open." />
          ) : null}
        </dl>
        <div className="job-overview-meta-row">
          <div
            className="job-overview-readiness"
            aria-label="Apply readiness"
            role="group"
          >
            <span
              className="job-overview-readiness-label"
              data-typography="label"
            >
              Apply readiness
              <ContextHelp label="Apply readiness" description="A current preflight summary of prerequisites, eligibility concerns, hard blockers, and required sources. Ready means these checks passed; it is not approval to submit an application." />
            </span>
            <StatusBadge
              tone={auditTone(applyAudit.state)}
              title={applyAudit.summary}
            >
              {applyAudit.label}
            </StatusBadge>
          </div>
          <div
            className="job-overview-workflow-state"
            aria-label="Workflow state"
            role="group"
          >
            <span data-typography="label">Workflow <ContextHelp label="Workflow" description="The saved preparation substage and its current state. Failed or exhausted stages need attention; a succeeded stage records completed preparation, not application submission." /></span>
            <StatusBadge tone={workflowTone(job.currentState)}>
              {sentenceCase(job.currentSubstage)} ·{" "}
              {sentenceCase(job.currentState)}
            </StatusBadge>
          </div>
          {job.applyStatus ? (
            <div
              className="job-overview-application-state"
              aria-label="Application state"
              role="group"
            >
              <span data-typography="label">Application <ContextHelp label="Application state" description="The recorded application lifecycle status. It appears only when an application status has been saved; inspect Apply history and outcomes for events and follow-up." /></span>
              <StatusBadge tone={applicationTone(job.applyStatus)}>
                {sentenceCase(job.applyStatus)}
              </StatusBadge>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function MetadataField({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <div>
      <dt data-typography="label">{label} <ContextHelp label={label} description={help} /></dt>
      <dd data-typography="metadata">{value}</dd>
    </div>
  );
}
