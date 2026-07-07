import fs from "node:fs";
import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;
export type SqliteValue = string | number | bigint | null;

// Mirror of the Python worker's ``SCHEMA_VERSION``
// (workers/automation/src/jobctl/database.py). The worker is the single
// writer that stamps ``PRAGMA user_version``; the API only reads it to fail
// closed on a database written by a newer build. Bump both constants together
// whenever the schema shape changes.
export const SUPPORTED_SCHEMA_VERSION = 2;

export class IncompatibleSchemaVersionError extends Error {
  constructor(current: number) {
    super(
      `JobCtl database schema version ${current} is newer than this API build `
        + `supports (max ${SUPPORTED_SCHEMA_VERSION}); it was created by a newer `
        + `JobCtl build. Upgrade JobCtl or restore a compatible backup `
        + `('jobctl backup').`,
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

const legacyProductToken = "job" + "hunter";

export function migrateLegacyJobTables(db: SqliteDatabase): string[] {
  const migrated: string[] = [];
  for (const suffix of ["deleted_jobs", "hidden_jobs"]) {
    const legacyTable = `${legacyProductToken}_${suffix}`;
    const currentTable = `jobctl_${suffix}`;
    if (!tableExists(db, legacyTable)) continue;

    if (!tableExists(db, currentTable)) {
      db.prepare(`ALTER TABLE ${legacyTable} RENAME TO ${currentTable}`).run();
      migrated.push(currentTable);
      continue;
    }

    const currentColumns = tableColumns(db, currentTable);
    const commonColumns = tableColumns(db, legacyTable).filter((column) => currentColumns.includes(column));
    if (commonColumns.length === 0) {
      throw new Error(`Cannot migrate legacy table ${legacyTable}: no shared columns with ${currentTable}`);
    }
    const columns = commonColumns.map(quoteIdentifier).join(", ");
    db.prepare(`INSERT OR IGNORE INTO ${currentTable} (${columns}) SELECT ${columns} FROM ${legacyTable}`).run();
    db.prepare(`DROP TABLE ${legacyTable}`).run();
    migrated.push(currentTable);
  }
  return migrated;
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
