import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { SUPPORTED_SCHEMA_VERSION } from "../src/db.js";

export function initializeExactV7Database(dbPath: string): void {
  const schemaPath = fileURLToPath(
    new URL(
      "../../../workers/automation/src/jobctrl/infrastructure/migrations/schema_v7.sql",
      import.meta.url,
    ),
  );
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.resolve(schemaPath), "utf8"));
  db.pragma(`user_version = ${SUPPORTED_SCHEMA_VERSION}`);
  db.close();
}
