import { IconCheck, IconExternalLink } from "@tabler/icons-react";

import {
  useAcknowledgeDigestMutation,
  useDigestQuery,
  type DailyDigest,
} from "../../contexts/operations/index.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";

interface DigestRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly href: string;
  readonly tone?: "warn" | "ok" | undefined;
}

function formatMoney(value: number | null): string {
  if (value === null) {
    return "unlimited";
  }
  return value.toLocaleString(undefined, {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  });
}

function digestRows(digest: DailyDigest): readonly DigestRow[] {
  const blockedSourceNames = digest.blockedSources.sources
    .slice(0, 2)
    .map((source) => source.sourceId)
    .join(", ");
  const budgetDetail = digest.budget.unlimited
    ? `${formatMoney(digest.budget.estimatedUsd)} spent`
    : `${formatMoney(digest.budget.remainingUsd)} remaining of ${formatMoney(digest.budget.dailyBudgetUsd)}`;

  return [
    {
      key: "new-matches",
      label: "New matches",
      value: String(digest.newMatches.count),
      detail: `${digest.newMatches.highFitCount} high fit at ${digest.highFitThreshold}+`,
      href: digest.deepLinks.newMatches,
      tone: digest.newMatches.count > 0 ? "ok" : undefined,
    },
    {
      key: "blocked-sources",
      label: "Blocked sources",
      value: String(digest.blockedSources.count),
      detail: blockedSourceNames || "sources normal",
      href: digest.deepLinks.blockedSources,
      tone: digest.blockedSources.count > 0 ? "warn" : undefined,
    },
    {
      key: "review-needed-materials",
      label: "Materials review",
      value: String(digest.reviewNeededMaterials.count),
      detail: "resume or PDF attention",
      href: digest.deepLinks.reviewNeededMaterials,
      tone: digest.reviewNeededMaterials.count > 0 ? "warn" : undefined,
    },
    {
      key: "pending-approvals",
      label: "Pending approvals",
      value: String(digest.pendingApprovals.count),
      detail: "apply review queue",
      href: digest.deepLinks.pendingApprovals,
      tone: digest.pendingApprovals.count > 0 ? "warn" : undefined,
    },
    {
      key: "stale-scores",
      label: "Stale scores",
      value: String(digest.staleScores.count),
      detail: "needs rescore",
      href: digest.deepLinks.staleScores,
      tone: digest.staleScores.count > 0 ? "warn" : undefined,
    },
    {
      key: "follow-ups",
      label: "Follow-ups due",
      value: String(digest.followUpsDue.count),
      detail: `${digest.followUpsDue.thresholdDays}d, ${digest.followUpsDue.dayBoundary}`,
      href: digest.deepLinks.followUpsDue,
      tone: digest.followUpsDue.count > 0 ? "warn" : undefined,
    },
    {
      key: "budget",
      label: "Budget",
      value: digest.budget.status === "over_budget" ? "over" : "ok",
      detail: budgetDetail,
      href: digest.deepLinks.budget,
      tone: digest.budget.status === "over_budget" ? "warn" : "ok",
    },
  ];
}

function DigestRowLink({ row }: { readonly row: DigestRow }) {
  return (
    <a className={`digest-row${row.tone ? ` tone-${row.tone}` : ""}`} href={row.href}>
      <span className="digest-main">
        <span className="digest-label">{row.label}</span>
        <span className="digest-detail">{row.detail}</span>
      </span>
      <span className="digest-value">{row.value}</span>
      <IconExternalLink size={14} aria-hidden="true" />
    </a>
  );
}

export function DigestPanel() {
  const digest = useDigestQuery();
  const acknowledge = useAcknowledgeDigestMutation();
  const data = digest.data;
  const meta = digest.isFetching && !data ? "loading" : data?.since ? `since ${formatDateTime(data.since)}` : "first run";
  const acknowledgeError = acknowledge.error instanceof Error ? acknowledge.error.message : null;

  return (
    <section className="card digest-panel">
      <CardHeader title="Daily digest" meta={meta} />
      {digest.error instanceof Error ? <div className="banner inline">{digest.error.message}</div> : null}
      {acknowledgeError ? <div className="banner inline">{acknowledgeError}</div> : null}
      {data ? (
        <>
          <div className="digest-list">
            {digestRows(data).map((row) => (
              <DigestRowLink key={row.key} row={row} />
            ))}
          </div>
          <div className="digest-actions">
            <span className="meta">Generated {formatDateTime(data.generatedAt)}</span>
            <button
              className="tab on"
              type="button"
              disabled={acknowledge.isPending}
              onClick={() => acknowledge.mutate({ acknowledgedAt: data.generatedAt })}
            >
              <IconCheck size={14} aria-hidden="true" />
              <span>{acknowledge.isPending ? "marking" : "mark reviewed"}</span>
            </button>
          </div>
        </>
      ) : (
        <Empty title={digest.isLoading ? "Loading daily digest." : "No digest data."} />
      )}
    </section>
  );
}
