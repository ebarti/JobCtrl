import fs from "node:fs";
import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;
export type SqliteValue = string | number | bigint | null;

export function openReadOnlyDatabase(dbPath: string): SqliteDatabase {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
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
