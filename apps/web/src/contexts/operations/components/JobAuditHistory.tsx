import type { JobAuditEntry } from "@jobhunter/contracts";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Empty } from "../../../shared/ui/empty.js";

export interface JobAuditHistoryProps {
  readonly entries: readonly JobAuditEntry[];
}

const CATEGORY_LABELS: Record<JobAuditEntry["category"], string> = {
  discovery: "Discovery",
  enrichment: "Enrichment",
  scoring: "Scoring",
  materials: "Materials",
  apply: "Apply",
  outcome: "Outcome",
  pipeline: "Pipeline",
  job: "Job",
};

function categoryLabel(category: JobAuditEntry["category"]): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function JobAuditHistory({ entries }: JobAuditHistoryProps) {
  if (entries.length === 0) {
    return <Empty title="No audit history recorded for this job." />;
  }

  return (
    <ol className="job-audit-timeline" aria-label="Job audit history">
      {entries.map((entry) => (
        <li className={`job-audit-entry tone-${entry.tone}`} key={entry.id}>
          <span className="job-audit-marker" aria-hidden="true" />
          <span className="job-audit-body">
            <span className="job-audit-head">
              <span className="tag muted">{categoryLabel(entry.category)}</span>
              <strong>{entry.title}</strong>
              {entry.occurredAt ? (
                <time dateTime={entry.occurredAt}>{formatDateTime(entry.occurredAt)}</time>
              ) : null}
            </span>
            {entry.description ? (
              <span className="job-audit-description">{entry.description}</span>
            ) : null}
            {entry.actor ? <span className="job-audit-actor">Actor: {entry.actor}</span> : null}
            {entry.details.length ? (
              <dl className="job-audit-details">
                {entry.details.map((detail) => (
                  <div key={`${entry.id}-${detail.label}`}>
                    <dt>{detail.label}</dt>
                    <dd>{detail.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
