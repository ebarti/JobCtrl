import fs from "node:fs";
import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;
export type SqliteValue = string | number | bigint | null;

// Mirror of the Python worker's ``SCHEMA_VERSION``
// (workers/automation/src/jobctrl/database.py). The worker is the single
// writer that stamps ``PRAGMA user_version``; the API only reads it to fail
// closed on a database written by a newer build. Bump both constants together
// whenever the schema shape changes.
export const SUPPORTED_SCHEMA_VERSION = 19;

export class IncompatibleSchemaVersionError extends Error {
  constructor(current: number) {
    super(
      `JobCtrl database schema version ${current} is newer than this API build `
        + `supports (max ${SUPPORTED_SCHEMA_VERSION}); it was created by a newer `
        + `JobCtrl build. Upgrade JobCtrl or restore a compatible backup `
        + `('jobctrl backup').`,
    );
    this.name = "IncompatibleSchemaVersionError";
  }
}

function assertSchemaVersionSupported(db: SqliteDatabase): void {
  // The API never writes ``user_version`` — the Python worker owns stamping so
  // the schema marker has a single writer. A pre-guard database (0) or one
  // stamped at the supported version opens normally; a greater version fails
  // closed so a stale API never additively writes a schema it cannot
  // understand.
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SUPPORTED_SCHEMA_VERSION) {
    db.close();
    throw new IncompatibleSchemaVersionError(current);
  }
}

export function openReadOnlyDatabase(dbPath: string): SqliteDatabase {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  // Match the worker's PRAGMA so contended reads wait instead of failing
  // immediately with SQLITE_BUSY.  Worker writes hold the WAL briefly;
  // 5s gives the API process room to retry transparently.
  db.pragma("busy_timeout = 5000");
  assertSchemaVersionSupported(db);
  return db;
}

export function openDatabase(dbPath: string): SqliteDatabase {
  const db = new Database(dbPath, { fileMustExist: true });
  // L4 (round-1 review): now that read endpoints write (projection
  // refresh) and the worker process also writes to the same
  // ``*_projections`` tables + watermark, SQLite contention is more
  // likely.  Match the worker's ``PRAGMA busy_timeout=10000`` half-way
  // so the API doesn't fail with ``SQLITE_BUSY`` on a write conflict.
  db.pragma("busy_timeout = 5000");
  assertSchemaVersionSupported(db);
  migrateLegacyJobTables(db);
  return db;
}

export function databaseExists(dbPath: string): boolean {
  return fs.existsSync(dbPath);
}

export function tableExists(db: SqliteDatabase, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

export type JobReferenceColumn = "job_id" | "job_url";

export function tableColumnSet(db: SqliteDatabase, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) return new Set();
  return new Set(
    (db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
}

export function jobReferenceColumn(
  db: SqliteDatabase,
  tableName: string,
): JobReferenceColumn {
  const columns = tableColumnSet(db, tableName);
  if (columns.has("job_id")) return "job_id";
  if (columns.has("job_url")) return "job_url";
  throw new Error(`${tableName} has no Job identity column.`);
}

export function stableJobIdForUrl(
  db: SqliteDatabase,
  jobUrl: string,
  tenantId = "local",
): string | null {
  const direct = db.prepare(
    `SELECT job_id
       FROM jobs
      WHERE tenant_id = ? AND url = ?
      LIMIT 1`,
  ).get(tenantId, jobUrl) as { job_id?: string } | undefined;
  if (direct?.job_id) return direct.job_id;
  if (!tableExists(db, "job_identity_aliases")) return null;
  const alias = db.prepare(
    `SELECT alias.job_id
       FROM job_identity_aliases alias
       JOIN jobs j
         ON j.tenant_id = alias.tenant_id
        AND j.job_id = alias.job_id
      WHERE alias.tenant_id = ?
        AND alias.alias_kind = 'posting_url'
        AND alias.alias_value = ?
      LIMIT 1`,
  ).get(tenantId, jobUrl) as { job_id?: string } | undefined;
  return alias?.job_id ?? null;
}

export function jobReferenceForUrl(
  db: SqliteDatabase,
  tableName: string,
  jobUrl: string,
  tenantId = "local",
): string {
  if (jobReferenceColumn(db, tableName) === "job_url") return jobUrl;
  const jobId = stableJobIdForUrl(db, jobUrl, tenantId);
  if (!jobId) {
    throw new Error(`No stable Job identity for ${jobUrl}.`);
  }
  return jobId;
}

export function jobReferencePredicateForUrl(
  db: SqliteDatabase,
  tableName: string,
  jobUrl: string,
  tenantId = "local",
  alias = "",
): { sql: string; params: SqliteValue[] } {
  const prefix = alias ? `${alias}.` : "";
  const referenceColumn = jobReferenceColumn(db, tableName);
  const reference = jobReferenceForUrl(
    db,
    tableName,
    jobUrl,
    tenantId,
  );
  if (referenceColumn === "job_url") {
    return {
      sql: `${prefix}job_url = ?`,
      params: [reference],
    };
  }
  return {
    sql: `${prefix}tenant_id = ? AND ${prefix}job_id = ?`,
    params: [tenantId, reference],
  };
}

export function jobReferenceJoinToJobs(
  db: SqliteDatabase,
  tableName: string,
  sourceAlias: string,
  jobsAlias: string,
): string {
  return jobReferenceColumn(db, tableName) === "job_id"
    ? `${sourceAlias}.tenant_id = ${jobsAlias}.tenant_id AND ${sourceAlias}.job_id = ${jobsAlias}.job_id`
    : `${sourceAlias}.job_url = ${jobsAlias}.url`;
}

export function hasCompositeJobIdForeignKey(
  db: SqliteDatabase,
  tableName: string,
  referenceColumn = "job_id",
): boolean {
  if (!tableExists(db, tableName)) return false;
  const rows = db
    .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`)
    .all() as Array<{
      id: number;
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
  const groups = new Map<number, Set<string>>();
  const cascades = new Map<number, boolean>();
  for (const row of rows) {
    if (row.table !== "jobs") continue;
    const columns = groups.get(row.id) ?? new Set<string>();
    columns.add(`${row.from}:${row.to}`);
    groups.set(row.id, columns);
    cascades.set(row.id, row.on_delete.toUpperCase() === "CASCADE");
  }
  const expected = new Set([
    "tenant_id:tenant_id",
    `${referenceColumn}:job_id`,
  ]);
  return [...groups.entries()].some(([id, columns]) => (
    cascades.get(id) === true
    && columns.size === expected.size
    && [...expected].every((column) => columns.has(column))
  ));
}

const legacyProductTokens = ["job" + "ctl", "job" + "hunter"] as const;

type JobLifecycleTableSpec = {
  suffix: "deleted_jobs" | "hidden_jobs";
  currentTable: string;
  createSql: string;
  additiveColumns: Array<{ name: string; definition: string }>;
};

const jobLifecycleTableSpecs: JobLifecycleTableSpec[] = [
  {
    suffix: "deleted_jobs",
    currentTable: "jobctrl_deleted_jobs",
    createSql: `CREATE TABLE IF NOT EXISTS jobctrl_deleted_jobs (
      job_url TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      reason TEXT,
      restored_at TEXT
    )`,
    additiveColumns: [
      { name: "deleted_at", definition: "TEXT NOT NULL DEFAULT ''" },
      { name: "reason", definition: "TEXT" },
      { name: "restored_at", definition: "TEXT" },
    ],
  },
  {
    suffix: "hidden_jobs",
    currentTable: "jobctrl_hidden_jobs",
    createSql: `CREATE TABLE IF NOT EXISTS jobctrl_hidden_jobs (
      job_url TEXT PRIMARY KEY,
      hidden_at TEXT NOT NULL,
      reason TEXT,
      unhidden_at TEXT
    )`,
    additiveColumns: [
      { name: "hidden_at", definition: "TEXT NOT NULL DEFAULT ''" },
      { name: "reason", definition: "TEXT" },
      { name: "unhidden_at", definition: "TEXT" },
    ],
  },
];

export function migrateLegacyJobTables(db: SqliteDatabase): string[] {
  return db.transaction(() => {
    const migrated = new Set<string>();
    for (const spec of jobLifecycleTableSpecs) {
      const suffix = spec.suffix;
      const currentTable = spec.currentTable;
      const existingLegacyTables = legacyProductTokens
        .map((token) => `${token}_${suffix}`)
        .filter((legacyTable) => tableExists(db, legacyTable));
      const currentExists = tableExists(db, currentTable);
      if (existingLegacyTables.length === 0 && !currentExists) continue;

      for (const legacyTable of existingLegacyTables) {
        const legacyColumns = tableColumns(db, legacyTable);
        const knownColumns = new Set(["job_url", ...spec.additiveColumns.map((column) => column.name)]);
        const commonColumns = legacyColumns.filter((column) => knownColumns.has(column));
        if (!commonColumns.includes("job_url")) {
          throw new Error(`Cannot migrate legacy table ${legacyTable}: missing job_url column for ${currentTable}`);
        }
      }

      assertNoLifecycleMigrationConflicts(db, currentTable, existingLegacyTables);
      ensureJobLifecycleTableSchema(db, spec);
      if (existingLegacyTables.length === 0) {
        continue;
      }

      for (const legacyTable of existingLegacyTables) {
        const legacyColumns = tableColumns(db, legacyTable);
        const currentColumns = tableColumns(db, currentTable);
        const commonColumns = legacyColumns.filter((column) => currentColumns.includes(column));
        const columns = commonColumns.map(quoteIdentifier).join(", ");
        db.prepare(
          `INSERT INTO ${quoteIdentifier(currentTable)} (${columns}) SELECT ${columns} FROM ${quoteIdentifier(legacyTable)}`,
        ).run();
        db.prepare(`DROP TABLE ${quoteIdentifier(legacyTable)}`).run();
        migrated.add(currentTable);
      }
    }
    return [...migrated];
  })();
}

function ensureJobLifecycleTableSchema(db: SqliteDatabase, spec: JobLifecycleTableSpec): void {
  db.prepare(spec.createSql).run();
  const existingColumns = new Set(tableColumns(db, spec.currentTable));
  for (const column of spec.additiveColumns) {
    if (existingColumns.has(column.name)) continue;
    db.prepare(
      `ALTER TABLE ${quoteIdentifier(spec.currentTable)} ADD COLUMN ${quoteIdentifier(column.name)} ${column.definition}`,
    ).run();
    existingColumns.add(column.name);
  }
}

function assertNoLifecycleMigrationConflicts(db: SqliteDatabase, currentTable: string, legacyTables: string[]): void {
  const sources = [...(tableExists(db, currentTable) ? [currentTable] : []), ...legacyTables];
  const seen = new Map<string, string>();
  for (const source of sources) {
    const columns = tableColumns(db, source);
    if (!columns.includes("job_url")) {
      throw new Error(`Cannot migrate lifecycle table ${source}: missing job_url column`);
    }
    const rows = db.prepare(`SELECT job_url FROM ${quoteIdentifier(source)} WHERE job_url IS NOT NULL`).all() as Array<{ job_url: string }>;
    for (const row of rows) {
      const previousSource = seen.get(row.job_url);
      if (previousSource !== undefined) {
        throw new Error(
          `Cannot migrate lifecycle tables for ${currentTable}: duplicate job_url in ${previousSource} and ${source}`,
        );
      }
      seen.set(row.job_url, source);
    }
  }
}

function tableColumns(db: SqliteDatabase, tableName: string): string[] {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((row) => String((row as { name: unknown }).name));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function allRows<T extends Record<string, unknown>>(
  db: SqliteDatabase,
  sql: string,
  params: SqliteValue[] = [],
): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function getRow<T extends Record<string, unknown>>(
  db: SqliteDatabase,
  sql: string,
  params: SqliteValue[] = [],
): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
