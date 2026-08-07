import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { SUPPORTED_SCHEMA_VERSION } from "../src/db.js";

const schemaPath = fileURLToPath(
  new URL(
    "../../../workers/automation/src/jobctrl/infrastructure/migrations/schema_v7.sql",
    import.meta.url,
  ),
);

// schema_v7.sql is pure DDL (110 tables, 108 indexes, 24 triggers, no seed rows
// and no PRAGMAs), and the seeding hooks across this suite call it once per
// test. Re-executing it every time made those hooks the slowest thing in CI and
// pushed them past Vitest's hook deadline on loaded runners. Build it once per
// worker process and copy the closed file instead: with no PRAGMAs the database
// is a single self-contained file, so the copy is byte-identical to a fresh
// build, `user_version` included.
let templatePath: string | undefined;

function schemaTemplate(): string {
  if (templatePath !== undefined) {
    return templatePath;
  }
  const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-v7-schema-"));
  const template = path.join(templateDir, "schema-v7.db");
  const db = new Database(template);
  db.exec(fs.readFileSync(path.resolve(schemaPath), "utf8"));
  db.pragma(`user_version = ${SUPPORTED_SCHEMA_VERSION}`);
  db.close();
  process.on("exit", () => {
    fs.rmSync(templateDir, { force: true, recursive: true });
  });
  templatePath = template;
  return template;
}

export function initializeExactV7Database(dbPath: string): void {
  fs.copyFileSync(schemaTemplate(), dbPath);
}
