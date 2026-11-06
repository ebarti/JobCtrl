import { Link } from "@tanstack/react-router";

import type {
  ResumeArtifact,
  ResumeArtifactStatus,
} from "../../contexts/resumes/index.js";
import type { DataGridColumn } from "../../shared/ui/filterable-data-grid.js";
import { RelativeTime } from "../../shared/ui/relative-time.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";
import { ArtifactFileActions } from "./ArtifactFileActions.js";

export const artifactStatusLabels: Record<ResumeArtifactStatus, string> = {
  accepted: "Accepted",
  accepted_history: "Previously accepted",
  candidate: "Candidate",
  history: "Render history",
  accepted_translation: "Accepted translation",
};
export function ArtifactState({ row }: { row: ResumeArtifact }) {
  return (
    <StatusBadge
      tone={
        row.status === "accepted" || row.status === "accepted_translation"
          ? "ok"
          : "muted"
      }
    >
      {artifactStatusLabels[row.status]}
    </StatusBadge>
  );
}
export function artifactBytes(size: number) {
  return `${(size / 1024).toFixed(1)} KB`;
}
export function ArtifactMobileRow({ row }: { row: ResumeArtifact }) {
  return (
    <article className="grid gap-2">
      <Link
        className="title-link"
        to="/artifacts/$artifactId"
        params={{ artifactId: row.artifactId }}
      >
        {row.title}
      </Link>
      <p>
        {row.company ?? "Employer label unavailable"} · revision{" "}
        {row.revision.number}
        {row.locale ? ` · ${row.locale.target_locale}` : ""}
      </p>
      <ArtifactState row={row} />
      <p>
        {artifactBytes(row.render.size_bytes)} · {row.render.page_count} pages
      </p>
      <ArtifactFileActions artifact={row} compact />
    </article>
  );
}
export const artifactColumns: Array<DataGridColumn<ResumeArtifact>> = [
  {
    id: "title",
    label: "Source",
    sortable: true,
    rowHeader: true,
    render: (row) => (
      <Link
        className="title-link"
        to="/artifacts/$artifactId"
        params={{ artifactId: row.artifactId }}
      >
        {row.title}
        <span className="block text-sm">
          Revision {row.revision.number} ·{" "}
          {row.locale
            ? `Translation ${row.locale.target_locale}`
            : row.revision.mode === "baseline_copy"
              ? "Baseline copy"
              : "Tailored resume"}
        </span>
      </Link>
    ),
  },
  {
    id: "company",
    label: "Company",
    sortable: true,
    render: (row) => row.company ?? "Not recorded",
  },
  {
    id: "type",
    label: "Type",
    sortable: true,
    render: (row) => (row.locale ? "Translation PDF" : "Resume PDF"),
  },
  {
    id: "status",
    label: "Recorded state",
    sortable: true,
    render: (row) => <ArtifactState row={row} />,
  },
  {
    id: "created_at",
    label: "Rendered",
    sortable: true,
    render: (row) =>
      row.renderedAt ? (
        <RelativeTime value={row.renderedAt} />
      ) : row.acceptedAt ? (
        <>
          Accepted <RelativeTime value={row.acceptedAt} />
        </>
      ) : (
        "Time not recorded"
      ),
  },
  {
    id: "size_bytes",
    label: "Size",
    sortable: true,
    render: (row) => artifactBytes(row.render.size_bytes),
  },
  {
    id: "actions",
    label: "File",
    render: (row) => <ArtifactFileActions artifact={row} compact />,
  },
];
