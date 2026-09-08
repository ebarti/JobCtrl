import { allRows, tableExists, type SqliteDatabase } from "./db.js";

const JOBSTREAMING_SOURCE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "jobspy:glassdoor": "JobStreaming Glassdoor",
  "jobspy:indeed": "JobStreaming Indeed",
  "jobspy:linkedin": "JobStreaming LinkedIn",
  "jobspy:zip-recruiter": "JobStreaming ZipRecruiter",
};

export function canonicalSourceDisplayName(sourceId: string, fallback: string): string {
  const knownName = JOBSTREAMING_SOURCE_DISPLAY_NAMES[sourceId];
  if (knownName) return knownName;
  if (!sourceId.startsWith("jobspy:")) return fallback;
  // Match the worker's title-casing rule for other configured board slugs.
  const board = sourceId.slice("jobspy:".length)
    .replace(/[-_]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[a-z]+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
  return `JobStreaming ${board}`;
}

/** Resolve names once per read while retaining stable source identities. */
export function sourceDisplayNames(db: SqliteDatabase): Map<string, string> {
  if (!tableExists(db, "source_registry_entries")) return new Map();
  return new Map(
    allRows<{ source_id: string; display_name: string }>(
      db,
      "SELECT source_id, display_name FROM source_registry_entries WHERE tenant_id = ?",
      ["local"],
    ).map((row) => [row.source_id, canonicalSourceDisplayName(row.source_id, row.display_name)]),
  );
}
