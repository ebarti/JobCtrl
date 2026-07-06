import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveApiConfig } from "./config.js";
import { databaseExists, openDatabase } from "./db.js";
import {
  clearSampleData,
  loadSampleData,
  missingDatabaseSampleDataStatus,
  readSampleDataStatus,
  sampleDataTtfvProbe,
} from "./sample-data.js";

type Command = "status" | "load" | "clear" | "probe";

interface CliOptions {
  readonly appDir: string;
  readonly dbPath: string;
  readonly command: Command;
  readonly json: boolean;
}

const options = parseArgs(process.argv.slice(2));
const result = run(options);
if (options.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function run({ appDir, command, dbPath }: CliOptions): unknown {
  if (!databaseExists(dbPath)) {
    if (command === "status" || command === "probe") {
      return command === "status"
        ? missingDatabaseSampleDataStatus()
        : {
            ok: true,
            mode: "synthetic_sample",
            checkedAt: new Date().toISOString(),
            ttfv1: { passed: false, job: null },
            ttfv2: { passed: false, job: null, artifactId: null, artifactBytes: null },
          };
    }
    throw new Error(`No JobHunter database found at ${dbPath}. Run jobhunter doctor or initialize a workspace first.`);
  }
  const db = openDatabase(dbPath);
  try {
    if (command === "status") return readSampleDataStatus(db);
    if (command === "load") return loadSampleData(db, appDir);
    if (command === "clear") return clearSampleData(db, appDir);
    return sampleDataTtfvProbe(db);
  } finally {
    db.close();
  }
}

function parseArgs(args: readonly string[]): CliOptions {
  const command = parseCommand(firstPositional(args) ?? "status");
  const appDirArg = optionValue(args, "--app-dir");
  const dbPathArg = optionValue(args, "--db-path");
  const json = args.includes("--json");
  const config = resolveApiConfig({
    ...process.env,
    ...(appDirArg ? { JOBHUNTER_DIR: appDirArg } : {}),
    ...(dbPathArg ? { JOBHUNTER_DB_PATH: dbPathArg } : {}),
  });
  const appDir = path.resolve(config.appDir || path.join(os.homedir(), ".jobhunter"));
  const dbPath = path.resolve(config.dbPath || path.join(appDir, "jobhunter.db"));
  fs.mkdirSync(appDir, { recursive: true });
  return { appDir, command, dbPath, json };
}

function firstPositional(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--app-dir" || arg === "--db-path") {
      index += 1;
      continue;
    }
    if (arg && !arg.startsWith("-")) return arg;
  }
  return null;
}

function parseCommand(value: string): Command {
  if (value === "status" || value === "load" || value === "clear" || value === "probe") {
    return value;
  }
  throw new Error(`Unknown sample-data command "${value}". Expected status, load, clear, or probe.`);
}

function optionValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
