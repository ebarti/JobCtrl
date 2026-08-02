import { IconAlertTriangle } from "@tabler/icons-react";
import type { LearningRecommendationSummary } from "@jobctrl/contracts";
import { useState } from "react";

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
  const recommendations = useLearningRecommendationsQuery();
  const review = useReviewLearningRecommendationMutation();
  const readError = recommendations.error instanceof Error ? recommendations.error.message : null;
  const reviewError = review.error instanceof Error ? review.error.message : null;
  const pending = recommendations.data?.recommendations ?? [];

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
      {recommendations.data && pending.length === 0 ? (
        <Empty title="No learning recommendations to review." />
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
  const evidence = useLearningRecommendationEvidenceQuery(
    recommendation.recommendationId,
    { page: 1, pageSize: 100 },
    evidenceOpen,
  );
  const evidenceError = evidence.error instanceof Error ? evidence.error.message : null;
  const effect = `${recommendation.ruleKey} → ${recommendation.ruleValue}`;
  const titleId = `learning-recommendation-${recommendation.recommendationId}-title`;
  const reviewable = recommendation.active && recommendation.tombstoneCount === 0;

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
            </Alert>
          ) : null}
          {evidence.data?.evidence.length === 0 ? <Empty title="No evidence links available." /> : null}
          {evidence.data?.evidence.length ? (
            <ul aria-label={`Evidence for ${effect}`}>
              {evidence.data.evidence.map((link) => (
                <li key={`${link.signalId}:${link.sourceRevision}`}>
                  <StatusBadge tone={link.evidenceRole === "contradicting" ? "warn" : "info"}>
                    {link.evidenceRole}
                  </StatusBadge>
                  <span>{link.signalId}</span>
                  <span className="meta">
                    revision {link.sourceRevision} · job {link.jobId} · {formatDateTime(link.recordedAt)}
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
