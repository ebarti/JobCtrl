import type { ApplyReviewQueueItem } from "@jobhunter/contracts";

import { ApplyReviewDecisionControls } from "../../contexts/apply/components/ApplyReviewDecisionControls.js";
import { OutcomeSuggestionsPanel } from "../../contexts/apply/components/ApplicationOutcomes.js";
import { useApplicationOutcomesQuery } from "../../contexts/operations/hooks/useApplicationOutcomesQuery.js";
import { useApplyReviewQueueQuery } from "../../contexts/operations/hooks/useApplyReviewQueueQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";

function readinessTone(item: ApplyReviewQueueItem): "ok" | "warn" {
  return item.materials.ready && item.blockers.length === 0 ? "ok" : "warn";
}

function readinessLabel(item: ApplyReviewQueueItem): string {
  if (item.materials.ready && item.blockers.length === 0) {
    return "ready";
  }
  return item.blockers.length ? "blocked" : "materials incomplete";
}

function latestApplyContext(item: ApplyReviewQueueItem): string {
  const run = item.latestApplyRun;
  if (!run) {
    return "no apply run";
  }
  const mode = run.dryRun ? "dry run" : "submit";
  const result = run.result ? ` · ${run.result}` : "";
  return `${mode} · ${run.status}${result}`;
}

function reviewLabel(item: ApplyReviewQueueItem): string {
  if (item.review.decision && item.review.decidedAt) {
    return `${item.review.state} · ${formatDateTime(item.review.decidedAt)}`;
  }
  return item.review.state;
}

function materialsLabel(item: ApplyReviewQueueItem): string {
  const parts = [
    item.materials.hasResume ? "resume" : "no resume",
    item.materials.hasCoverLetter ? "cover" : "no cover",
    item.materials.hasPdf ? "pdf" : "no pdf",
  ];
  return parts.join(" · ");
}

function ApplyReviewTable({ items }: { readonly items: readonly ApplyReviewQueueItem[] }) {
  if (!items.length) {
    return <Empty title="No application review items." />;
  }
  return (
    <div className="apply-review-table-wrap">
      <table className="apply-review-table">
        <caption>{items.length} application review item{items.length === 1 ? "" : "s"}</caption>
        <thead>
          <tr>
            <th scope="col">Job</th>
            <th scope="col">Readiness</th>
            <th scope="col">Latest apply context</th>
            <th scope="col">Review</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.jobKey}>
              <th scope="row">
                <span className="title-stack">
                  <b>{item.title}</b>
                  <span>
                    {item.company} · {item.source} · score {item.fitScore ?? "-"}
                  </span>
                  {item.applicationUrl ? <span>{item.applicationUrl}</span> : null}
                </span>
              </th>
              <td>
                <span className={`tag ${readinessTone(item)}`}>{readinessLabel(item)}</span>
                <span className="muted-cell">{materialsLabel(item)}</span>
                {item.blockers.length ? (
                  <ul className="apply-review-blockers">
                    {item.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                ) : null}
              </td>
              <td>
                <span>{latestApplyContext(item)}</span>
                {item.latestApplyRun?.startedAt ? (
                  <span className="muted-cell">{formatDateTime(item.latestApplyRun.startedAt)}</span>
                ) : null}
              </td>
              <td>
                <span>{reviewLabel(item)}</span>
              </td>
              <td>
                <ApplyReviewDecisionControls item={item} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ApplyReviewView() {
  const queue = useApplyReviewQueueQuery();
  const outcomes = useApplicationOutcomesQuery();
  const queueError = queue.error instanceof Error ? queue.error.message : null;
  const outcomesError = outcomes.error instanceof Error ? outcomes.error.message : null;
  const items = queue.data?.items ?? [];
  const pendingSuggestions = (outcomes.data?.suggestions ?? []).filter(
    (suggestion) => suggestion.status === "pending",
  );
  const readyCount = items.filter((item) => readinessTone(item) === "ok").length;
  const blockedCount = items.length - readyCount;

  return (
    <div className="apply-review-layout">
      <section className="card full">
        <CardHeader
          title="Application review"
          meta={`${readyCount} ready · ${blockedCount} blocked · ${pendingSuggestions.length} suggestions`}
        />
        {queueError ? <div className="banner inline">{queueError}</div> : null}
        {queue.isFetching && !queue.data ? <Empty title="Loading review queue." /> : null}
        {queue.data ? <ApplyReviewTable items={items} /> : null}
      </section>
      <section className="card full">
        <CardHeader
          title="Outcome suggestions"
          meta={outcomes.data ? `${pendingSuggestions.length} pending` : "loading"}
        />
        {outcomesError ? <div className="banner inline">{outcomesError}</div> : null}
        {outcomes.isFetching && !outcomes.data ? <Empty title="Loading outcome suggestions." /> : null}
        {outcomes.data ? <OutcomeSuggestionsPanel suggestions={pendingSuggestions} /> : null}
      </section>
    </div>
  );
}
