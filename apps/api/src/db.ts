import fs from "node:fs";
import Database from "better-sqlite3";

import { EXACT_V7_SCHEMA_MANIFEST, hasExactV7SchemaManifest } from "./schema-manifest.js";

export type SqliteDatabase = Database.Database;
export type SqliteValue = string | number | bigint | null;

// Mirror of the Python worker's ``SCHEMA_VERSION``
// (workers/automation/src/jobctrl/database.py). The worker is the single
// writer that stamps ``PRAGMA user_version``; the API only admits the exact
// migrated schema shape. Bump both constants together whenever the schema
// shape changes.
export const SUPPORTED_SCHEMA_VERSION = EXACT_V7_SCHEMA_MANIFEST.version;

export class IncompatibleSchemaVersionError extends Error {
  constructor(current: number) {
    super(
      `JobCtrl database schema version ${current} is incompatible with this API `
        + `build (expected exactly ${SUPPORTED_SCHEMA_VERSION}). Upgrade JobCtrl `
        + `or restore a compatible backup `
        + `('jobctrl backup').`,
    );
    this.name = "IncompatibleSchemaVersionError";
  }
}

export class IncompatibleSchemaManifestError extends Error {
  constructor() {
    super(
      "JobCtrl database schema does not match the exact v7 manifest; restore "
        + "a compatible backup or complete the documented stopped-runtime migration.",
    );
    this.name = "IncompatibleSchemaManifestError";
  }
}

function assertExactSchemaVersion(db: SqliteDatabase): void {
  // The API never writes ``user_version`` — the Python worker owns stamping so
  // the schema marker has a single writer. The v6-to-v7 migration is the only
  // upgrade path; runtime admission accepts only the completed v7 shape.
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current !== SUPPORTED_SCHEMA_VERSION) {
    db.close();
    throw new IncompatibleSchemaVersionError(current);
  }
  if (!hasExactV7SchemaManifest(db)) {
    db.close();
    throw new IncompatibleSchemaManifestError();
  }
}

export function openReadOnlyDatabase(dbPath: string): SqliteDatabase {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  assertExactSchemaVersion(db);
  // Match the worker's PRAGMA so contended reads wait instead of failing
  // immediately with SQLITE_BUSY.  Worker writes hold the WAL briefly;
  // 5s gives the API process room to retry transparently.
  db.pragma("busy_timeout = 5000");
  return db;
}

export function openDatabase(dbPath: string): SqliteDatabase {
  const db = new Database(dbPath, { fileMustExist: true });
  assertExactSchemaVersion(db);
  // L4 (round-1 review): now that read endpoints write (projection
  // refresh) and the worker process also writes to the same
  // ``*_projections`` tables + watermark, SQLite contention is more
  // likely.  Match the worker's ``PRAGMA busy_timeout=10000`` half-way
  // so the API doesn't fail with ``SQLITE_BUSY`` on a write conflict.
  db.pragma("busy_timeout = 5000");
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
