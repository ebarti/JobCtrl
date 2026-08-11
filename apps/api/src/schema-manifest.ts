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
  objectCount: 242,
  tableCount: 110,
  fingerprint: "775312f0ec2640a2a87889602886c90e21a49e06fffc53cf26c435856247da97",
};

export const EXACT_V8_SCHEMA_MANIFEST: SchemaManifest = {
  version: 8,
  objectCount: 272,
  tableCount: 117,
  fingerprint: "3705f7c7d90454bbeaa85227a9d4ce87c12efd14935e0d14afc830939e80ff31",
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
  return hasExactSchemaManifest(db, EXACT_V7_SCHEMA_MANIFEST);
}

export function hasExactV8SchemaManifest(db: Pick<Database.Database, "prepare">): boolean {
  return hasExactSchemaManifest(db, EXACT_V8_SCHEMA_MANIFEST);
}

function hasExactSchemaManifest(
  db: Pick<Database.Database, "prepare">,
  expected: SchemaManifest,
): boolean {
  const observed = schemaManifest(db, expected.version);
  return (
    observed.version === expected.version
    && observed.objectCount === expected.objectCount
    && observed.tableCount === expected.tableCount
    && observed.fingerprint === expected.fingerprint
  );
}
