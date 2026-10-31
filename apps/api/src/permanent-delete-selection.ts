import crypto from "node:crypto";
import fs from "node:fs";

import type {
  BulkPermanentDeleteRequest,
  BulkJobMutationFilter,
  JobMutationResponse,
  JobListQuery,
  ReviewableJobsResponse,
  PreparePermanentDeleteSelectionRequest,
  PreparePermanentDeleteSelectionResponse,
} from "./contracts.js";
import { openDatabase, type SqliteDatabase } from "./db.js";
import { listJobs, matchingJobKeysWithin, withJobsSelectionSnapshot } from "./read-model.js";
import { permanentlyDeleteJobs } from "./write-model.js";

const LOCAL_TENANT = "local";
const MAX_SELECTIONS = 64;
const MAX_JOBS = 5000;
const SELECTION_TTL_MS = 60_000;

/** A refusal is deliberately indistinguishable for missing, expired and changed selections. */
export class PermanentDeleteSelectionConflict extends Error {
  constructor(
    message = "The removed-job selection is no longer current. This request made no changes. Refresh the list and select jobs again.",
    readonly conflictingJobKeys?: string[],
    readonly unprocessedJobKeys?: string[],
  ) {
    super(message);
  }
}

interface Lifecycle {
  deletedAt: string | null;
  hiddenAt: string | null;
  revision: string;
}

interface Receipt {
  identity: string;
  jobKeys: string[];
  revisions: Map<string, string>;
  kind: "observation" | "selection";
  tooLarge?: boolean;
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

function databaseIdentity(dbPath: string): string {
  try {
    const stat = fs.statSync(dbPath);
    if (!stat.isFile()) throw new PermanentDeleteSelectionConflict();
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch {
    throw new PermanentDeleteSelectionConflict();
  }
}

/** Read authoritative lifecycle state in bounded SQLite parameter batches. */
function lifecycles(db: SqliteDatabase, jobIds: readonly string[], strict = true): Map<string, Lifecycle> {
  const values = new Map<string, Lifecycle>();
  for (let offset = 0; offset < jobIds.length; offset += 250) {
    const batch = jobIds.slice(offset, offset + 250);
    const rows = db.prepare(`SELECT j.job_id,
      CASE WHEN d.deleted_at IS NOT NULL AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
        THEN d.deleted_at ELSE NULL END AS deleted_at,
      CASE WHEN h.unhidden_at IS NULL THEN h.hidden_at ELSE NULL END AS hidden_at,
      CAST(r.revision AS TEXT) AS revision
      FROM jobs j
      LEFT JOIN jobctrl_deleted_jobs d ON d.tenant_id = j.tenant_id AND d.job_id = j.job_id
      LEFT JOIN jobctrl_hidden_jobs h ON h.tenant_id = j.tenant_id AND h.job_id = j.job_id
      LEFT JOIN job_lifecycle_revisions r ON r.tenant_id = j.tenant_id AND r.job_id = j.job_id
      WHERE j.tenant_id = ? AND j.job_id IN (${batch.map(() => "?").join(", ")})`)
      .all(LOCAL_TENANT, ...batch) as Array<{job_id: string; deleted_at: string | null; hidden_at: string | null; revision: string | null}>;
    for (const row of rows) {
      if (row.revision === null) {
        if (strict) throw new PermanentDeleteSelectionConflict();
        continue;
      }
      values.set(row.job_id, { deletedAt: row.deleted_at, hiddenAt: row.hidden_at, revision: row.revision });
    }
  }
  if (strict && values.size !== new Set(jobIds).size) throw new PermanentDeleteSelectionConflict();
  return values;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const keys = new Set(left);
  return keys.size === left.length && right.every((key) => keys.has(key));
}

/** A receipt freezes the visible cohort and its canonical lifecycle revisions.
 * Persistent SQLite triggers advance each job's revision in the same write as
 * any lifecycle change, including same-valued ABA and other-process writers.
 * Unrelated commits do not invalidate an otherwise unchanged selection.
 */
export class PermanentDeleteSelectionRegistry {
  private readonly receipts = new Map<string, Receipt>();

  constructor(private readonly dbPath: string) {}

  close(): void {
    for (const id of this.receipts.keys()) this.discard(id);
  }

  private discard(id: string): void {
    const receipt = this.receipts.get(id);
    if (!receipt) return;
    this.receipts.delete(id);
    clearTimeout(receipt.timer);
  }

  private prune(): void {
    for (const [id, receipt] of this.receipts) {
      if (Date.now() >= receipt.expiresAt) this.discard(id);
    }
  }

  private save(receipt: Omit<Receipt, "timer" | "expiresAt">): string {
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + SELECTION_TTL_MS;
    const timer = setTimeout(() => this.discard(id), SELECTION_TTL_MS);
    timer.unref?.();
    this.receipts.set(id, { ...receipt, timer, expiresAt });
    return id;
  }

  observe(db: SqliteDatabase, query: JobListQuery, openedIdentity: string): ReviewableJobsResponse {
    this.prune();
    const removedStates = query.jobStates?.filter((state) => state !== "active");
    const activeOnly = query.jobStates ? removedStates?.length === 0 : query.deleted === "active";
    const identity = openedIdentity;
    if (!identity || identity !== databaseIdentity(this.dbPath)) throw new PermanentDeleteSelectionConflict();
    // Browsing remains available when no removal is possible or the bounded
      // observation pool is full. Without a receipt deletion fails closed.
    if (activeOnly || this.receipts.size >= MAX_SELECTIONS) {
      return { ...listJobs(db, query), observationId: null };
    }
    // Page, filter membership and lifecycle revisions share one SQLite read
    // snapshot and one retained query index; unrelated workers need not wait
    // for an IMMEDIATE write lock while the user merely views the list.
    const filter: Partial<BulkJobMutationFilter> = {
      ...query,
      ...(query.jobStates ? { jobStates: removedStates } : query.deleted === "all"
        ? { jobStates: ["deleted", "hidden"] }
        : {}),
    };
    const snapshot = withJobsSelectionSnapshot(db, query, filter, MAX_JOBS + 1, (page, candidates) => {
        if (identity !== databaseIdentity(this.dbPath)) throw new PermanentDeleteSelectionConflict();
        // Do not load or retain an unbounded all-matching cohort. More than
        // the cap is refused, while explicit visible-page selection stays safe.
        const tooLarge = candidates.length > MAX_JOBS;
        const candidateKeys = tooLarge
          ? page.items.filter((item) => item.deletedAt || item.hiddenAt).map((item) => item.jobKey)
          : candidates;
        const states = lifecycles(db, candidateKeys);
        const jobKeys = candidateKeys.filter((id) => {
          const current = states.get(id)!;
          return Boolean(current.deletedAt || current.hiddenAt);
        });
        const revisions = new Map(jobKeys.map((id) => [id, states.get(id)!.revision]));
        return { page, jobKeys, tooLarge, revisions };
      });
    const observationId = this.save({ identity, jobKeys: snapshot.jobKeys, revisions: snapshot.revisions,
      tooLarge: snapshot.tooLarge, kind: "observation" });
    return { ...snapshot.page, observationId };
  }

  prepare(request: PreparePermanentDeleteSelectionRequest): PreparePermanentDeleteSelectionResponse {
    this.prune();
    const observation = this.receipts.get(request.observationId);
    if (!observation || observation.kind !== "observation") throw new PermanentDeleteSelectionConflict();
    this.receipts.delete(request.observationId);
    clearTimeout(observation.timer);
    const db = openDatabase(this.dbPath);
    try {
      const selected = db.transaction(() => {
        if (Date.now() >= observation.expiresAt || observation.identity !== databaseIdentity(this.dbPath)) {
          throw new PermanentDeleteSelectionConflict();
        }
        const observed = new Set(observation.jobKeys);
        const expected = new Map<string, Pick<Lifecycle, "deletedAt" | "hiddenAt">>();
        for (const item of request.expected ?? []) {
          if (expected.has(item.jobKey)) throw new PermanentDeleteSelectionConflict();
          expected.set(item.jobKey, { deletedAt: item.deletedAt, hiddenAt: item.hiddenAt });
        }
        const jobKeys = new Set<string>();
        const conflicts = new Set<string>();
        const allMatching = request.selections.some((selection) => selection.allMatching);
        if (allMatching && request.selections.some((selection) => !selection.allMatching)) {
          throw new PermanentDeleteSelectionConflict();
        }
        if (allMatching) {
          if (observation.tooLarge) {
            throw new PermanentDeleteSelectionConflict("This selection exceeds 5,000 removed jobs. Narrow the filters or select jobs on the current page. This request made no changes.");
          }
          // The user reviewed this original cohort. New matches cannot widen
          // it; members no longer matching remain identifiable conflicts.
          const matching = new Set<string>();
          for (const selection of request.selections) {
            const filter: Partial<BulkJobMutationFilter> = selection.filter ?? {};
            const removed = filter.jobStates?.filter((state) => state !== "active");
            if (filter.jobStates ? removed?.length === 0 : !filter.deleted || filter.deleted === "active" || filter.deleted === "closed") {
              continue;
            }
            const removedFilter: Partial<BulkJobMutationFilter> = {
              ...filter,
              ...(filter.jobStates ? { jobStates: removed } : filter.deleted === "all"
                ? { jobStates: ["deleted", "hidden"] }
                : {}),
            };
            for (const id of matchingJobKeysWithin(db, removedFilter, observation.jobKeys)) matching.add(id);
          }
          const currentStates = lifecycles(db, observation.jobKeys, false);
          for (const id of observation.jobKeys) {
            const current = currentStates.get(id);
            if (!current || !matching.has(id) || (!current.deletedAt && !current.hiddenAt) ||
                observation.revisions.get(id) !== current.revision) {
              conflicts.add(id);
            }
            jobKeys.add(id);
          }
        } else {
          const resolved: Array<{ locator: string; id: string }> = [];
          for (const selection of request.selections) {
            for (const locator of selection.jobKeys) {
              // Reviewed selections accept only IDs from the observation.
              // Re-resolving an alias here could target a different canonical
              // job if that alias was rebound after the list was displayed.
              if (!observed.has(locator)) { conflicts.add(locator); continue; }
              const id = locator;
              resolved.push({ locator, id });
              jobKeys.add(id);
              if (jobKeys.size > MAX_JOBS) throw new PermanentDeleteSelectionConflict();
            }
          }
          const currentStates = lifecycles(db, [...jobKeys], false);
          for (const { locator, id } of resolved) {
            const current = currentStates.get(id);
            const original = expected.get(locator);
            if (!observed.has(id) || !current || (!current.deletedAt && !current.hiddenAt) ||
                observation.revisions.get(id) !== current.revision || !original ||
                original.deletedAt !== current.deletedAt || original.hiddenAt !== current.hiddenAt) {
              conflicts.add(id);
            }
          }
        }
        if (conflicts.size) {
          const selected = allMatching ? observation.jobKeys : [...jobKeys];
          throw new PermanentDeleteSelectionConflict(undefined, [...conflicts], selected.filter((id) => !conflicts.has(id)));
        }
        const keys = [...jobKeys];
        const states = lifecycles(db, keys);
        return { jobKeys: keys, revisions: new Map(keys.map((id) => [id, states.get(id)!.revision])) };
      }).immediate();
      db.close();
      const selectionId = this.save({ identity: observation.identity, revisions: selected.revisions,
        jobKeys: selected.jobKeys, kind: "selection" });
      return { ok: true, selectionId, jobKeys: selected.jobKeys };
    } catch (error) {
      if (db.open) db.close();
      throw error;
    }
  }

  delete(request: BulkPermanentDeleteRequest): JobMutationResponse {
    const selectionId = request.selectionId;
    const receipt = selectionId ? this.receipts.get(selectionId) : undefined;
    if (!selectionId || !receipt || receipt.kind !== "selection") throw new PermanentDeleteSelectionConflict();
    // Consume before executing so a failed, competing, or repeated request can
    // never replay a previously reviewed confirmation.
    this.receipts.delete(selectionId);
    clearTimeout(receipt.timer);
    const db = openDatabase(this.dbPath);
    try {
      if (request.allMatching || !sameKeys(request.jobKeys, receipt.jobKeys)) {
        throw new PermanentDeleteSelectionConflict();
      }
      return db.transaction(() => {
        if (Date.now() >= receipt.expiresAt || databaseIdentity(this.dbPath) !== receipt.identity) {
          throw new PermanentDeleteSelectionConflict();
        }
        const conflicts: string[] = [];
        const currentStates = lifecycles(db, receipt.jobKeys, false);
        for (const jobId of receipt.jobKeys) {
          const current = currentStates.get(jobId);
          if (!current || (!current.deletedAt && !current.hiddenAt) || current.revision !== receipt.revisions.get(jobId)) {
            conflicts.push(jobId);
          }
        }
        if (conflicts.length) {
          const conflictsSet = new Set(conflicts);
          throw new PermanentDeleteSelectionConflict(undefined, conflicts, receipt.jobKeys.filter((id) => !conflictsSet.has(id)));
        }
        return permanentlyDeleteJobs(db, { allMatching: false, jobKeys: receipt.jobKeys });
      }).immediate();
    } finally {
      db.close();
    }
  }
}
