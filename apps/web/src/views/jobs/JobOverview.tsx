import type { JobDetail } from "../../contexts/operations/types.js";
import { ScoreBadge } from "../../contexts/scoring/components/ScoreBadge.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";

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

function workflowTone(state: string): "ok" | "info" | "muted" | "warn" {
  if (state === "succeeded") return "ok";
  if (state === "queued" || state === "running") return "info";
  if (state === "failed" || state === "blocked" || state === "exhausted")
    return "warn";
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
        </span>
        <span data-typography="metric">
          <ScoreBadge score={job.fitScore} />
        </span>
      </div>
      <div className="job-overview-copy">
        <h1 data-typography="page-title">{job.title}</h1>
        <dl className="job-overview-facts" aria-label="Job metadata">
          {job.company ? (
            <MetadataField label="Company" value={job.company} />
          ) : null}
          {job.location.trim() ? (
            <MetadataField label="Location" value={job.location} />
          ) : null}
          {job.salary.trim() ? (
            <MetadataField label="Salary" value={job.salary} />
          ) : null}
          <div>
            <dt data-typography="label">Posting</dt>
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
              </a>
            </dd>
          </div>
          {job.discoverySource ? (
            <MetadataField label="Discovered via" value={job.discoverySource} />
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
            <span data-typography="label">Workflow</span>
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
              <span data-typography="label">Application</span>
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

function MetadataField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt data-typography="label">{label}</dt>
      <dd data-typography="metadata">{value}</dd>
    </div>
  );
}
