import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { SUPPORTED_SCHEMA_VERSION } from "../src/db.js";

const v7SchemaPath = fileURLToPath(
  new URL(
    "../../../workers/automation/src/jobctrl/infrastructure/migrations/schema_v7.sql",
    import.meta.url,
  ),
);
const v8SchemaPath = fileURLToPath(
  new URL(
    "../../../workers/automation/src/jobctrl/infrastructure/migrations/schema_v8.sql",
    import.meta.url,
  ),
);

// The frozen v7 schema plus additive v8 DDL form the exact runtime schema. The
// seeding hooks across this suite call this helper once per test, so build it
// once per worker process and copy the closed single-file database instead.
let templatePath: string | undefined;

function schemaTemplate(): string {
  if (templatePath !== undefined) {
    return templatePath;
  }
  const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-v8-schema-"));
  const template = path.join(templateDir, "schema-v8.db");
  const db = new Database(template);
  db.exec(fs.readFileSync(path.resolve(v7SchemaPath), "utf8"));
  db.exec(fs.readFileSync(path.resolve(v8SchemaPath), "utf8"));
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
