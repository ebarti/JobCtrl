import type { TailoringPolicyRevisionSummary } from "@jobctrl/contracts";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useState } from "react";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import { useTailoringPolicyRevisionsQuery } from "../../operations/index.js";
import { useRollbackTailoringPolicyMutation } from "../hooks/useRollbackTailoringPolicyMutation.js";

const HISTORY_PAGE_SIZE = 100;

export function TailoringPolicyHistoryPanel() {
  const [page, setPage] = useState(1);
  const history = useTailoringPolicyRevisionsQuery({
    page,
    pageSize: HISTORY_PAGE_SIZE,
  });
  const rollback = useRollbackTailoringPolicyMutation();
  const revisions = history.data?.revisions ?? [];
  const readError =
    history.error instanceof Error ? history.error.message : null;
  const rollbackError =
    rollback.error instanceof Error ? rollback.error.message : null;

  return (
    <section className="card col-span-full tailoring-policy-history-panel">
      <CardHeader
        title="Tailoring policy history"
        meta={
          history.data
            ? `${history.data.total} revision${history.data.total === 1 ? "" : "s"}`
            : "loading"
        }
      />
      {readError ? (
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>Tailoring policy history unavailable</AlertTitle>
          <AlertDescription>{readError}</AlertDescription>
        </Alert>
      ) : null}
      {rollbackError ? (
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>Policy restore failed</AlertTitle>
          <AlertDescription>{rollbackError}</AlertDescription>
        </Alert>
      ) : null}
      {history.isFetching && !history.data ? (
        <Empty title="Loading policy history." />
      ) : null}
      {history.data && revisions.length === 0 ? (
        <Empty title="No tailoring policy revisions recorded." />
      ) : null}
      {revisions.length > 0 ? (
        <div
          className="tailoring-policy-revisions"
          aria-label="Tailoring policy revisions"
        >
          {revisions.map((revision) => (
            <TailoringPolicyRevisionCard
              key={revision.version}
              revision={revision}
              restoring={rollback.isPending}
              onRestore={(targetVersion) => {
                rollback.reset();
                rollback.mutate(targetVersion);
              }}
            />
          ))}
        </div>
      ) : null}
      {history.data && history.data.totalPages > 1 ? (
        <nav
          className="row-actions tailoring-policy-pagination"
          aria-label="Tailoring policy history pages"
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={history.isFetching || history.data.page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous page
          </Button>
          <span className="meta" aria-live="polite">
            Page {history.data.page} of {history.data.totalPages}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              history.isFetching || history.data.page >= history.data.totalPages
            }
            onClick={() => setPage((current) => current + 1)}
          >
            Next page
          </Button>
        </nav>
      ) : null}
    </section>
  );
}

function TailoringPolicyRevisionCard({
  revision,
  restoring,
  onRestore,
}: {
  readonly revision: TailoringPolicyRevisionSummary;
  readonly restoring: boolean;
  readonly onRestore: (targetVersion: number) => void;
}) {
  const titleId = `tailoring-policy-version-${revision.version}`;
  const current = revision.status === "current";

  return (
    <article
      className="tailoring-policy-revision-card"
      aria-labelledby={titleId}
    >
      <header className="tailoring-policy-revision-head">
        <span>
          <b id={titleId}>Version {revision.version}</b>
          <span className="meta">
            Materials tailoring policy · {formatDateTime(revision.createdAt)}
          </span>
        </span>
        <StatusBadge tone={current ? "ok" : "muted"}>
          {current ? "Current" : "Superseded"}
        </StatusBadge>
      </header>

      <dl className="tailoring-policy-revision-facts">
        <div>
          <dt>Learned rules</dt>
          <dd>
            {revision.learnedRules.length > 0 ? (
              <ul>
                {revision.learnedRules.map((rule) => (
                  <li key={`${rule.ruleKey}:${rule.ruleValue}`}>
                    {rule.ruleKey} → {rule.ruleValue}
                  </li>
                ))}
              </ul>
            ) : (
              "Baseline policy; no accepted learned rules."
            )}
          </dd>
        </div>
        <div>
          <dt>Provenance</dt>
          <dd>{revisionProvenance(revision)}</dd>
        </div>
      </dl>

      {!current ? (
        <div className="row-actions">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={restoring}
            aria-label={`Restore tailoring policy version ${revision.version}`}
            onClick={() => onRestore(revision.version)}
          >
            {restoring ? "Restoring…" : `Restore version ${revision.version}`}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function revisionProvenance(revision: TailoringPolicyRevisionSummary) {
  if (revision.sourceReviewId && revision.sourceRecommendationId) {
    return (
      <span className="tailoring-policy-provenance">
        <span>Accepted recommendation {revision.sourceRecommendationId}</span>
        <span className="meta">Review {revision.sourceReviewId}</span>
      </span>
    );
  }
  if (revision.rollbackOfVersion && revision.rollbackReasonCode) {
    return (
      <span className="tailoring-policy-provenance">
        <span>Restored from version {revision.rollbackOfVersion}</span>
        <span className="meta">
          Reason: {rollbackReason(revision.rollbackReasonCode)}
        </span>
      </span>
    );
  }
  return "No recommendation or restore provenance recorded.";
}

function rollbackReason(
  reason: NonNullable<TailoringPolicyRevisionSummary["rollbackReasonCode"]>,
) {
  return reason === "user_requested"
    ? "user requested"
    : "historical or unspecified";
}
