// Per-source crawl-politeness rollup (R10 P4 — read side).
//
// The politeness gateway (R10 P1) records robots-disallow / rate-limit /
// budget-exhaustion as first-class NON-error outcomes in
// `operational_attempt_metrics`: `outcome = "blocked"`,
// `attempt_kind = "politeness_gate"`, `failure_category` set to the reason, and
// `is_scrape_failure = 0`. That table is the single source of truth for "why a
// source produced nothing"; the source-quality projection (built from
// `job_events`) never sees these rows, so — exactly like the existing
// operational failure counts — they are aggregated here at read time and merged
// into the source-health and source-registry read models.

import { POLITENESS_OUTCOME_REASONS, type PolitenessOutcomeReason } from "@jobctrl/contracts";
import type { SourcePolitenessOutcomes } from "@jobctrl/contracts";

import { allRows, tableExists, type SqliteDatabase } from "./db.js";

const DEFAULT_TENANT = "local";

// Must match the constants the Python recorder writes
// (`infrastructure/network/politeness.py`).
const POLITENESS_ATTEMPT_KIND = "politeness_gate";
const POLITENESS_BLOCKED_OUTCOME = "blocked";

const POLITENESS_REASONS: ReadonlySet<string> = new Set(POLITENESS_OUTCOME_REASONS);

interface PolitenessMetricRow extends Record<string, unknown> {
  source_id: string | null;
  failure_category: string | null;
  occurred_at: string | null;
}

/** Honest empty state: no politeness outcome recorded for the source. */
export function emptyPolitenessOutcomes(): SourcePolitenessOutcomes {
  return {
    robotsDisallowedCount: 0,
    rateLimitedCount: 0,
    budgetExhaustedCount: 0,
    lastBlockedReason: null,
    lastBlockedAt: null,
  };
}

/**
 * Aggregate per-source politeness outcomes from `operational_attempt_metrics`.
 *
 * Rows are ordered oldest→newest so the last recognised reason seen per source
 * is the most-recent one (`metric_id` breaks equal-timestamp ties). Only the
 * three known reasons are counted; any other `failure_category` under the
 * politeness attempt-kind is ignored rather than silently miscounted.
 */
export function politenessOutcomesBySource(
  db: SqliteDatabase,
): Map<string, SourcePolitenessOutcomes> {
  const rollups = new Map<string, SourcePolitenessOutcomes>();
  if (!tableExists(db, "operational_attempt_metrics")) return rollups;
  const rows = allRows<PolitenessMetricRow>(
    db,
    `SELECT source_id, failure_category, occurred_at
     FROM operational_attempt_metrics
     WHERE tenant_id = ?
       AND outcome = ?
       AND attempt_kind = ?
       AND source_id IS NOT NULL
     ORDER BY occurred_at ASC, metric_id ASC`,
    [DEFAULT_TENANT, POLITENESS_BLOCKED_OUTCOME, POLITENESS_ATTEMPT_KIND],
  );
  for (const row of rows) {
    const sourceId = row.source_id;
    const reason = row.failure_category;
    if (!sourceId || !reason || !POLITENESS_REASONS.has(reason)) continue;
    const typedReason = reason as PolitenessOutcomeReason;
    const current = rollups.get(sourceId) ?? emptyPolitenessOutcomes();
    if (typedReason === "robots_disallowed") current.robotsDisallowedCount += 1;
    else if (typedReason === "rate_limited") current.rateLimitedCount += 1;
    else if (typedReason === "budget_exhausted") current.budgetExhaustedCount += 1;
    current.lastBlockedReason = typedReason;
    current.lastBlockedAt = row.occurred_at ?? current.lastBlockedAt;
    rollups.set(sourceId, current);
  }
  return rollups;
}
