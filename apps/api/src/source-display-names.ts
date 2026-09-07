import { allRows, tableExists, type SqliteDatabase } from "./db.js";

const JOBSTREAMING_SOURCE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "jobspy:glassdoor": "JobStreaming Glassdoor",
  "jobspy:indeed": "JobStreaming Indeed",
  "jobspy:linkedin": "JobStreaming LinkedIn",
  "jobspy:zip-recruiter": "JobStreaming ZipRecruiter",
};

export function canonicalSourceDisplayName(sourceId: string, fallback: string): string {
  return JOBSTREAMING_SOURCE_DISPLAY_NAMES[sourceId] ?? fallback;
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
