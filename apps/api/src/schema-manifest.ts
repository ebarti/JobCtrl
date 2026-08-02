import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type SchemaManifest = {
  version: number;
  objectCount: number;
  tableCount: number;
  fingerprint: string;
};

// Checked against the Python worker's authoritative
// ``infrastructure/migrations/schema_manifest.py`` by the API schema guard
// tests. Keep the raw SQLite DDL fingerprint exact; normalization would admit
// a different schema.
export const EXACT_V7_SCHEMA_MANIFEST: SchemaManifest = {
  version: 7,
  objectCount: 226,
  tableCount: 107,
  fingerprint: "b80552dd38f1bdfcd75b95c09054f80a1169c609610ce4975edb837dd76808c8",
};

type SqliteMasterRow = [type: string, name: string, tableName: string, sql: string];

type SqliteMasterQueryRow = {
  type: unknown;
  name: unknown;
  tbl_name: unknown;
  sql: unknown;
};

const SQLITE_OWNED_SCHEMA_ROWS: readonly SqliteMasterRow[] = [
  ["table", "sqlite_sequence", "sqlite_sequence", "CREATE TABLE sqlite_sequence(name,seq)"],
  ["table", "sqlite_stat1", "sqlite_stat1", "CREATE TABLE sqlite_stat1(tbl,idx,stat)"],
  ["table", "sqlite_stat4", "sqlite_stat4", "CREATE TABLE sqlite_stat4(tbl,idx,neq,nlt,ndlt,sample)"],
];

function isSqliteOwnedSchemaRow(row: SqliteMasterRow): boolean {
  const [objectType, name, tableName, sql] = row;
  if (objectType === "index" && name.startsWith("sqlite_autoindex_") && tableName && sql === "") {
    return true;
  }
  return SQLITE_OWNED_SCHEMA_ROWS.some((owned) => owned.every((value, index) => value === row[index]));
}

function ensureAsciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-\u{10ffff}]/gu, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0xffff) {
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
    const offset = codePoint - 0x10000;
    const high = 0xd800 + (offset >> 10);
    const low = 0xdc00 + (offset & 0x3ff);
    return `\\u${high.toString(16)}\\u${low.toString(16)}`;
  });
}

export function schemaManifest(
  db: Pick<Database.Database, "prepare">,
  version: number,
): SchemaManifest {
  const rows = db.prepare(
    `
      SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
      FROM sqlite_master
      ORDER BY type, name
    `,
  ).all() as SqliteMasterQueryRow[];
  const dump = rows
    .map((row): SqliteMasterRow => [
      String(row.type),
      String(row.name),
      String(row.tbl_name),
      String(row.sql),
    ])
    .filter((row) => !isSqliteOwnedSchemaRow(row));

  return {
    version,
    objectCount: dump.length,
    tableCount: dump.filter(([objectType]) => objectType === "table").length,
    fingerprint: createHash("sha256").update(ensureAsciiJson(dump)).digest("hex"),
  };
}

export function hasExactV7SchemaManifest(db: Pick<Database.Database, "prepare">): boolean {
  const observed = schemaManifest(db, EXACT_V7_SCHEMA_MANIFEST.version);
  return (
    observed.version === EXACT_V7_SCHEMA_MANIFEST.version
    && observed.objectCount === EXACT_V7_SCHEMA_MANIFEST.objectCount
    && observed.tableCount === EXACT_V7_SCHEMA_MANIFEST.tableCount
    && observed.fingerprint === EXACT_V7_SCHEMA_MANIFEST.fingerprint
  );
}
