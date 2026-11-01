import { IconAlertTriangle } from "@tabler/icons-react";
import type { LearningRecommendationSummary } from "@jobctrl/contracts";
import { useEffect, useState } from "react";

import {
  useLearningRecommendationEvidenceQuery,
  useLearningRecommendationsQuery,
} from "../../operations/index.js";
import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Alert, AlertDescription, AlertTitle } from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import { useReviewLearningRecommendationMutation } from "../hooks/useReviewLearningRecommendationMutation.js";

export function LearningRecommendationReviewPanel() {
  const [page, setPage] = useState(1);
  const [requestedPage, setRequestedPage] = useState(1);
  const recommendations = useLearningRecommendationsQuery({ page, pageSize: 50 });
  const requested = useLearningRecommendationsQuery(
    { page: requestedPage, pageSize: 50 },
    requestedPage !== page,
  );
  const review = useReviewLearningRecommendationMutation();
  const readError = recommendations.error instanceof Error ? recommendations.error.message : null;
  const reviewError = review.error instanceof Error ? review.error.message : null;
  const pending = recommendations.data?.recommendations ?? [];

  useEffect(() => {
    if (
      requestedPage !== page &&
      requested.isSuccess &&
      !requested.isFetching &&
      requested.data.page === requestedPage
    ) {
      setPage(requestedPage);
    }
  }, [page, requestedPage, requested.data, requested.isFetching, requested.isSuccess]);

  return (
    <section className="card col-span-full learning-review-panel">
      <CardHeader
        title="Learning recommendations"
        meta={
          recommendations.data
            ? `${recommendations.data.total} review item${recommendations.data.total === 1 ? "" : "s"}`
            : "loading"
        }
      />
      {readError ? (
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>Learning recommendations unavailable</AlertTitle>
          <AlertDescription>{readError}</AlertDescription>
          <Button type="button" size="sm" variant="outline" onClick={() => void recommendations.refetch()}>
            Retry recommendations
          </Button>
        </Alert>
      ) : null}
      {reviewError ? (
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>Recommendation review failed</AlertTitle>
          <AlertDescription>{reviewError}</AlertDescription>
        </Alert>
      ) : null}
      {recommendations.isFetching && !recommendations.data ? (
        <Empty title="Loading learning recommendations." />
      ) : null}
      {recommendations.data && pending.length === 0 && recommendations.data.total === 0 ? (
        <Empty title="No learning recommendations to review." />
      ) : null}
      {recommendations.data && pending.length === 0 && recommendations.data.total > 0 ? (
        <Empty title="No recommendations on this page. Use the previous page to see remaining reviews." />
      ) : null}
      {recommendations.data ? (
        <div className="px-4 pt-3">
          <PageNavigation
            label="Learning recommendations"
            page={recommendations.data.page}
            totalPages={recommendations.data.totalPages}
            total={recommendations.data.total}
            shown={pending.length}
            itemLabel="review items"
            requestedPage={requestedPage}
            loading={requestedPage !== page && requested.isFetching}
            error={requestedPage !== page ? requested.error : null}
            onPage={setRequestedPage}
            onRetry={() => void requested.refetch()}
          />
        </div>
      ) : null}
      {pending.length ? (
        <div className="learning-recommendations" aria-label="Learning recommendations">
          {pending.map((recommendation) => (
            <LearningRecommendationCard
              key={recommendation.recommendationId}
              recommendation={recommendation}
              disabled={review.isPending}
              onReview={(decision) => {
                review.reset();
                review.mutate({ recommendationId: recommendation.recommendationId, decision });
              }}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function LearningRecommendationCard({
  recommendation,
  disabled,
  onReview,
}: {
  readonly recommendation: LearningRecommendationSummary;
  readonly disabled: boolean;
  readonly onReview: (decision: "accepted" | "rejected") => void;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [requestedPage, setRequestedPage] = useState(1);
  const evidence = useLearningRecommendationEvidenceQuery(
    recommendation.recommendationId,
    { page, pageSize: 100 },
    evidenceOpen,
  );
  const requested = useLearningRecommendationEvidenceQuery(
    recommendation.recommendationId,
    { page: requestedPage, pageSize: 100 },
    evidenceOpen && requestedPage !== page,
  );
  const evidenceError = evidence.error instanceof Error ? evidence.error.message : null;
  const effect = `${recommendation.ruleKey} → ${recommendation.ruleValue}`;
  const titleId = `learning-recommendation-${recommendation.recommendationId}-title`;
  const reviewable = recommendation.active && recommendation.tombstoneCount === 0;

  useEffect(() => {
    if (
      evidenceOpen &&
      requestedPage !== page &&
      requested.isSuccess &&
      !requested.isFetching &&
      requested.data.page === requestedPage
    ) {
      setPage(requestedPage);
    }
  }, [evidenceOpen, page, requestedPage, requested.data, requested.isFetching, requested.isSuccess]);

  return (
    <article className="learning-recommendation-card" aria-labelledby={titleId}>
      <header className="learning-recommendation-head">
        <span>
          <b id={titleId}>{effect}</b>
          <span className="meta">
            {recommendation.signalKind.replaceAll("_", " ")} · derived {formatDateTime(recommendation.derivedAt)}
          </span>
        </span>
        <StatusBadge tone={reviewable ? "info" : "warn"}>
          {reviewable ? "Pending" : "Inactive"}
        </StatusBadge>
      </header>

      <dl className="learning-recommendation-facts">
        <div>
          <dt>Sample</dt>
          <dd>
            {recommendation.observedSignalCount} of {recommendation.minimumSignalCount} required
            accepted signals across {recommendation.observedJobCount} of{" "}
            {recommendation.minimumJobCount} required jobs
          </dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>
            {recommendation.supportingEvidenceCount} supporting ·{" "}
            {recommendation.contradictingEvidenceCount} contradicting ·{" "}
            {recommendation.tombstoneCount} tombstones
          </dd>
        </div>
        <div>
          <dt>Versions</dt>
          <dd>
            derivation {recommendation.derivationVersion} · fixture{" "}
            {recommendation.evaluationFixtureVersion} · allowlist{" "}
            {recommendation.allowlistVersion}
          </dd>
        </div>
      </dl>
      <p className="meta">
        Sample-gated recommendation only; it does not claim a population-wide improvement.
      </p>
      {!reviewable ? (
        <p className="meta" role="status">
          {recommendation.tombstoneCount > 0
            ? "Review unavailable: source evidence was tombstoned, so this recommendation must be re-derived."
            : "Review unavailable: this recommendation is no longer active."}
        </p>
      ) : null}

      <div className="row-actions">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={evidenceOpen}
          aria-label={`${evidenceOpen ? "Hide" : "Inspect"} evidence for ${effect}`}
          onClick={() => setEvidenceOpen((open) => !open)}
        >
          {evidenceOpen ? "Hide evidence" : "Inspect evidence"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={disabled || !reviewable}
          aria-label={`Accept learning recommendation ${effect}`}
          onClick={() => onReview("accepted")}
        >
          Accept
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !reviewable}
          aria-label={`Reject learning recommendation ${effect}`}
          onClick={() => onReview("rejected")}
        >
          Reject
        </Button>
      </div>

      {evidenceOpen ? (
        <div className="learning-recommendation-evidence">
          {evidence.isFetching && !evidence.data ? <Empty title="Loading evidence." /> : null}
          {evidenceError ? (
            <Alert variant="destructive">
              <IconAlertTriangle aria-hidden="true" />
              <AlertTitle>Recommendation evidence unavailable</AlertTitle>
              <AlertDescription>{evidenceError}</AlertDescription>
              <Button type="button" size="sm" variant="outline" onClick={() => void evidence.refetch()}>
                Retry evidence
              </Button>
            </Alert>
          ) : null}
          {evidence.data ? (
            <PageNavigation
              label={`Evidence for ${effect}`}
              page={evidence.data.page}
              totalPages={evidence.data.totalPages}
              total={evidence.data.total}
              shown={evidence.data.evidence.length}
              itemLabel="evidence links"
              requestedPage={requestedPage}
              loading={requestedPage !== page && requested.isFetching}
              error={requestedPage !== page ? requested.error : null}
              onPage={setRequestedPage}
              onRetry={() => void requested.refetch()}
            />
          ) : null}
          {evidence.data?.evidence.length === 0 ? <Empty title="No evidence links available." /> : null}
          {evidence.data?.evidence.length ? (
            <ul aria-label={`Evidence for ${effect}`}>
              {evidence.data.evidence.map((link) => (
                <li key={`${link.signalId}:${link.sourceRevision}:${link.jobId}`}>
                  <StatusBadge tone={link.evidenceRole === "contradicting" ? "warn" : "info"}>
                    {link.evidenceRole}
                  </StatusBadge>
                  <span>{link.signalId}</span>
                  <span className="meta">
                    {link.sourceKind} · revision {link.sourceRevision} · job {link.jobId} · {formatDateTime(link.recordedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function PageNavigation({
  label,
  page,
  totalPages,
  total,
  shown,
  itemLabel,
  requestedPage,
  loading,
  error,
  onPage,
  onRetry,
}: {
  readonly label: string;
  readonly page: number;
  readonly totalPages: number;
  readonly total: number;
  readonly shown: number;
  readonly itemLabel: string;
  readonly requestedPage: number;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly onPage: (page: number) => void;
  readonly onRetry: () => void;
}) {
  return (
    <nav aria-label={`${label} pages`} className="grid gap-2 pb-2">
      <p className="meta" role="status">
        {page <= Math.max(totalPages, 1)
          ? `Page ${page} of ${Math.max(totalPages, 1)}`
          : `Page ${page} · ${totalPages} ${totalPages === 1 ? "page" : "pages"} currently available`}
        {` · Showing ${shown} of ${total} ${itemLabel}`}
      </p>
      {loading ? <p className="meta" role="status">Loading page {requestedPage}.</p> : null}
      {error ? (
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>Could not load page {requestedPage}</AlertTitle>
          <AlertDescription>{error.message} The displayed page is unchanged.</AlertDescription>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Retry page {requestedPage}
          </Button>
        </Alert>
      ) : null}
      <div className="row-actions justify-self-start">
        <Button type="button" size="sm" variant="outline" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>
          Previous page
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={loading || page >= totalPages} onClick={() => onPage(page + 1)}>
          Next page
        </Button>
      </div>
    </nav>
  );
}
