import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { serialize } from "node:v8";
import { JOB_SORT_FIELDS, compareValues, effectiveJobStages, jobSortValue, type JobListQuery, type JobQueryScalars } from "./contracts.js";
import type { SqliteDatabase, SqliteValue } from "./db.js";

export interface JobQueryMetrics {
  initializationMs: number;
  refreshes: number;
  indexedRows: number;
  refreshMs: number;
  sourceChecks: number;
  sourceCheckMs: number;
  selectionMs: number;
  selectedRows: number;
}
const metrics = new WeakMap<SqliteDatabase, JobQueryMetrics>();
export function jobQueryMetrics(db: SqliteDatabase): Readonly<JobQueryMetrics> {
  return { ...(metrics.get(db) ?? { initializationMs: 0, refreshes: 0, indexedRows: 0, refreshMs: 0, sourceChecks: 0, sourceCheckMs: 0, selectionMs: 0, selectedRows: 0 }) };
}
function observations(db: SqliteDatabase): JobQueryMetrics {
  let value = metrics.get(db);
  if (!value) {
    value = { initializationMs: 0, refreshes: 0, indexedRows: 0, refreshMs: 0, sourceChecks: 0, sourceCheckMs: 0, selectionMs: 0, selectedRows: 0 };
    metrics.set(db, value);
  }
  return value;
}
export function querySourceVersion(db: SqliteDatabase): number {
  return Number(db.pragma("data_version", { simple: true }));
}
function changes(db: SqliteDatabase): number {
  return (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}
const searchFields = ["title", "company", "url", "location", "source", "discoverySource", "postingSource", "postingSourceUrl", "strategy", "currentStage", "currentSubstage", "currentState"] as const;
const sourceFields = [4, 5, 6, 7];
const directions = ["ASC", "DESC"] as const;
const sortColumn = (field: string, direction: string): string => `sort_${JOB_SORT_FIELDS.indexOf(field as typeof JOB_SORT_FIELDS[number])}_${direction}`;

function initialize(db: SqliteDatabase): number {
  const start = performance.now();
  if (db.prepare("SELECT name FROM sqlite_temp_master WHERE name = 'job_query_meta'").get()) return 0;
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS job_query_meta (
    tenant_id TEXT PRIMARY KEY, source_version INTEGER NOT NULL, connection_changes INTEGER NOT NULL,
    source_fingerprint TEXT NOT NULL);
    CREATE TEMP TABLE IF NOT EXISTS job_query_rows (
      tenant_id TEXT NOT NULL, job_id TEXT NOT NULL,
      ${searchFields.map((_, i) => `s${i} TEXT NOT NULL`).join(",")},
      discovered_ms REAL, scored_ms REAL,
      ${JOB_SORT_FIELDS.flatMap((field) => directions.map((direction) => `${sortColumn(field, direction)} INTEGER NOT NULL`)).join(",")},
      PRIMARY KEY (tenant_id, job_id)) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS job_query_grams (
      tenant_id TEXT NOT NULL, gram TEXT NOT NULL, job_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, gram, job_id)) WITHOUT ROWID;`);
  for (const field of JOB_SORT_FIELDS) for (const direction of directions) {
    db.exec(`CREATE INDEX IF NOT EXISTS temp.job_query_${field}_${direction}
      ON job_query_rows (tenant_id, ${sortColumn(field, direction)} ASC, job_id ASC)`);
  }
  return performance.now() - start;
}

/** Called inside the source transaction. The marker and index roll back together.
 * data_version detects other connections; total_changes detects this connection,
 * including rolled-back writes. Changed tokens require a source comparison,
 * not necessarily a rebuild: heartbeats and other tenants are not query inputs.
 * load returns scalar rows in canonical JobId order. Neither timestamps nor
 * event cursors prove freshness.
 */
export function refreshJobQueryIndex(
  db: SqliteDatabase, tenant: string, sourceVersion: number, load: () => JobQueryScalars[],
): void {
  if (!db.inTransaction) throw new Error("Job query index refresh requires a source transaction");
  observations(db).initializationMs += initialize(db);
  const previous = db.prepare("SELECT * FROM temp.job_query_meta WHERE tenant_id = ?").get(tenant) as
    { source_version: number; connection_changes: number; source_fingerprint: string } | undefined;
  if (sourceVersion >= 0 && previous?.source_version === sourceVersion && previous.connection_changes === changes(db)) return;
  const checkStart = performance.now();
  const rows = load();
  const hash = createHash("sha256");
  // Per-row serialization avoids one tenant-sized JSON string and preserves
  // scalar types (including nonfinite numeric fallbacks). TEMP state cannot
  // outlive this process/runtime's serialization format.
  for (const row of rows) hash.update(serialize(row));
  const fingerprint = hash.digest("hex");
  const observation = observations(db);
  observation.sourceChecks++;
  observation.sourceCheckMs += performance.now() - checkStart;
  const markFresh = (): void => {
    // Include the marker write itself in total_changes. SQLite owns the marker
    // so failed refreshes and enclosing rollbacks restore source binding too.
    db.prepare("INSERT OR REPLACE INTO temp.job_query_meta VALUES (?, ?, ?, ?)")
      .run(tenant, sourceVersion, changes(db) + 1, fingerprint);
  };
  if (previous?.source_fingerprint === fingerprint) {
    markFresh();
    return;
  }
  const ordinals = rows.map(() => [] as number[]);
  // ICU comparisons happen only during refresh. Preserve separate directional
  // orders, including the legacy null/empty compareValues boundary. JobId ties
  // remain ascending in both directions; no DTOs are constructed or sorted.
  for (const field of JOB_SORT_FIELDS) for (const direction of directions) {
    const values = rows.map((row, index) => ({ index, value: jobSortValue(row, field) }));
    values.sort((a, b) => compareValues(a.value, b.value) * (direction === "ASC" ? 1 : -1)
      || rows[a.index]!.jobKey.localeCompare(rows[b.index]!.jobKey));
    for (let i = 0; i < values.length; i++) {
      ordinals[values[i]!.index]!.push(i);
    }
  }
  db.prepare("DELETE FROM temp.job_query_rows WHERE tenant_id = ?").run(tenant);
  db.prepare("DELETE FROM temp.job_query_grams WHERE tenant_id = ?").run(tenant);
  const insert = db.prepare(`INSERT INTO temp.job_query_rows VALUES (${Array(2 + searchFields.length + 2 + JOB_SORT_FIELDS.length * directions.length).fill("?").join(",")})`);
  const gramInsert = db.prepare("INSERT OR IGNORE INTO temp.job_query_grams VALUES (?, ?, ?)");
  const instant = (value: string | null): number | null => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : null;
  };
  for (const [index, row] of rows.entries()) {
    const texts = searchFields.map((field) => (row[field] ?? "").toLowerCase());
    insert.run(tenant, row.jobKey, ...texts, instant(row.discoveredAt), instant(row.scoredAt), ...ordinals[index]!);
    const grams = new Set<string>();
    for (const text of texts) {
      const points = Array.from(text);
      for (let i = 0; i + 2 < points.length; i++) grams.add(points.slice(i, i + 3).join(""));
    }
    for (const gram of grams) gramInsert.run(tenant, gram, row.jobKey);
  }
  markFresh();
  observation.refreshes++;
  observation.indexedRows = rows.length;
  observation.refreshMs += performance.now() - checkStart;
}

export function jobQuerySelection(
  query: JobListQuery, base: { where: string; params: SqliteValue[] },
): { from: string; pageFrom: string; where: string; params: SqliteValue[]; order: string } {
  const clauses: string[] = [];
  const params = [...base.params];
  const postings: string[] = [];
  const substring = (indices: number[], value: string): void => {
    const points = Array.from(value.toLowerCase());
    if (points.length >= 3) {
      const alias = `g${postings.length}`;
      postings.push(alias);
      clauses.push(`${alias}.gram = ?`);
      params.push(points.slice(0, 3).join(""));
    }
    clauses.push(`(${indices.map((i) => `instr(qi.s${i}, ?) > 0`).join(" OR ")})`);
    params.push(...indices.map(() => value.toLowerCase()));
  };
  if (query.q) substring(searchFields.map((_, i) => i), query.q);
  if (query.source) substring(sourceFields, query.source);
  if (query.company) substring([1], query.company);
  const dates: string[] = [];
  for (const [cutoff, column] of [[query.discoveredSince, "discovered_ms"], [query.scoredSince, "scored_ms"]] as const) {
    if (cutoff) { dates.push(`qi.${column} >= ?`); params.push(Date.parse(cutoff)); }
  }
  if (dates.length) clauses.push(`(${dates.join(" OR ")})`);
  const field = JOB_SORT_FIELDS.includes(query.sort) ? query.sort : "discovered_at";
  const direction = query.dir === "asc" ? "ASC" : "DESC";
  const join = "job_list_projections ON job_list_projections.tenant_id = qi.tenant_id AND job_list_projections.job_id = qi.job_id";
  // CROSS JOIN fixes the candidate loop before reading any literal fields.
  // Intersect postings for all long filters, then recheck field membership.
  // Page sorting uses precomputed integer ordinals on this candidate subset;
  // unrestricted/short-query pages can walk the ordinal index directly.
  const candidateFrom = postings.length
    ? postings.map((alias, index) => `temp.job_query_grams ${alias}${index
      ? ` ON ${alias}.tenant_id = g0.tenant_id AND ${alias}.job_id = g0.job_id` : ""}`).join(" CROSS JOIN ")
      + ` CROSS JOIN temp.job_query_rows qi ON qi.tenant_id = g0.tenant_id AND qi.job_id = g0.job_id CROSS JOIN ${join}`
    : null;
  return {
    // Counting/bulk membership may start from the canonical tenant/stage index
    // and look up the query row by its primary key. Paging walks the ordinal
    // index first, avoiding a temporary sort of the entire matching set.
    from: candidateFrom ?? (effectiveJobStages(query).length || query.state
      ? `job_list_projections INDEXED BY idx_job_list_projections_stage_state
          CROSS JOIN temp.job_query_rows qi ON job_list_projections.tenant_id = qi.tenant_id AND job_list_projections.job_id = qi.job_id`
      : `temp.job_query_rows qi JOIN ${join}`),
    pageFrom: candidateFrom ?? `temp.job_query_rows qi INDEXED BY job_query_${field}_${direction} CROSS JOIN ${join}`,
    where: base.where + (clauses.length ? ` AND ${clauses.join(" AND ")}` : ""),
    params,
    order: `qi.${sortColumn(field, direction)} ASC, qi.job_id ASC`,
  };
}

export function selectJobPage(db: SqliteDatabase, query: JobListQuery, base: { where: string; params: SqliteValue[] }) {
  const start = performance.now();
  const selection = jobQuerySelection(query, base);
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM ${selection.from}${selection.where}`).get(...selection.params) as { count: number }).count;
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pages);
  const ids = (db.prepare(`SELECT qi.job_id FROM ${selection.pageFrom}${selection.where} ORDER BY ${selection.order} LIMIT ? OFFSET ?`)
    .all(...selection.params, query.pageSize, (page - 1) * query.pageSize) as { job_id: string }[]).map((row) => row.job_id);
  const observation = observations(db);
  observation.selectionMs += performance.now() - start;
  observation.selectedRows = ids.length;
  return { ids, total, page };
}
