import { IconArrowRight, IconAlertTriangle } from "@tabler/icons-react";

import { Button } from "../../../shared/ui/button.js";
import { useDigestQuery } from "../hooks/useDigestQuery.js";
import type { Digest } from "../contracts.js";

interface AttentionItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
}

function attentionItems(digest: Digest): readonly AttentionItem[] {
  const items: AttentionItem[] = [];
  const addCount = (key: keyof Digest["deepLinks"], count: number | null, singular: string, plural: string) => {
    if (count !== null && count > 0) {
      items.push({ key, label: `${count} ${count === 1 ? singular : plural}`, href: digest.deepLinks[key] });
    }
  };
  addCount("reviewNeededMaterials", digest.reviewNeededMaterials.count, "resume to review", "resumes to review");
  addCount("pendingApprovals", digest.pendingApprovals.count, "application to review", "applications to review");
  addCount("followUpsDue", digest.followUpsDue.count, "follow-up due", "follow-ups due");
  addCount("staleScores", digest.staleScores.count, "fit assessment to update", "fit assessments to update");
  addCount("blockedSources", digest.blockedSources.count, "search source needs attention", "search sources need attention");
  // In-flight work is progress, not an instruction to reconcile a lost call.
  if (digest.budget.status !== "ok" && digest.budget.costStatus !== "pending") {
    items.push({
      key: "budget",
      label: digest.budget.status === "over_budget" ? "Daily budget reached"
        : digest.budget.costStatus === "unavailable" ? "Daily limit needs cost tracking"
          : "Model call needs reconciliation",
      href: digest.deepLinks.budget,
    });
  }
  return items;
}

/** A passive, compact task summary; zero or absent optional sections make no health claim. */
export function DigestAttentionPanel() {
  const digest = useDigestQuery();
  const items = digest.data ? attentionItems(digest.data) : [];
  if (!items.length && !digest.isError) return null;

  return (
    <section aria-labelledby="jobs-attention-title" className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <h2 id="jobs-attention-title" className="flex items-center gap-2 text-sm font-semibold">
          <IconAlertTriangle aria-hidden="true" size={16} className="text-warning-text" />
          Needs attention
        </h2>
        {items.length ? (
          <ul className="m-0 flex flex-1 list-none flex-wrap items-center gap-x-5 gap-y-2 p-0">
            {items.map((item) => (
              <li key={item.key}>
                <a href={item.href} className="inline-flex min-h-9 items-center gap-1.5 rounded text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
                  {item.label}
                  <IconArrowRight aria-hidden="true" size={14} />
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {digest.isError ? (
        <div role="status" className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <p>{digest.data ? "The attention summary could not refresh. Last known items are shown." : "The attention summary is unavailable."}</p>
          <Button type="button" variant="outline" size="sm" disabled={digest.isFetching} onClick={() => { void digest.refetch(); }}>
            {digest.isFetching ? "Checking…" : "Try again"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
