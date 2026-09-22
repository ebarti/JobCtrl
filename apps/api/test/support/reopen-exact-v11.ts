import { openDatabase, openReadOnlyDatabase } from "../../src/db.js";

const databasePath = process.argv[2];
if (!databasePath) {
  throw new Error("exact-v11 reopen probe requires a database path");
}

for (const open of [openDatabase, openReadOnlyDatabase]) {
  const database = open(databasePath);
  try {
    if (database.pragma("user_version", { simple: true }) !== 11) {
      throw new Error("TypeScript API did not reopen schema v11");
    }
    const spendColumns = database.prepare("PRAGMA table_info(llm_spend)").all() as Array<{
      name: string;
    }>;
    if (!spendColumns.some((column) => column.name === "lane")) {
      throw new Error("TypeScript API reopened a spend ledger without lane authority");
    }
    const row = database
      .prepare("SELECT job_id, url FROM jobs ORDER BY tenant_id, job_id LIMIT 1")
      .get() as { job_id?: unknown; url?: unknown } | undefined;
    if (
      typeof row?.job_id !== "string"
      || row.job_id.length === 0
      || row.job_id === row.url
      || row.url !== "https://jobs.example/shipped-v6"
    ) {
      throw new Error("TypeScript API did not reopen the migrated canonical job");
    }
  } finally {
    database.close();
  }
}
