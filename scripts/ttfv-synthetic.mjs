#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const appDir =
  optionValue("--app-dir") ??
  fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-ttfv-synthetic-"));
const dbPath = optionValue("--db-path") ?? path.join(appDir, "jobhunter.db");
const recordPath = optionValue("--record");
const includeSetup = args.includes("--include-setup");
const startedAt = new Date().toISOString();
const start = performance.now();
const phases = [];

fs.mkdirSync(appDir, { recursive: true });

if (includeSetup) {
  phase("dependency_sync", [
    "corepack",
    "pnpm",
    "install",
    "--frozen-lockfile",
  ]);
  phase("python_sync", ["uv", "--project", "workers/automation", "sync", "--extra", "dev"]);
}

phase("workspace_init", [
  "uv",
  "--project",
  "workers/automation",
  "run",
  "python",
  "-c",
  "from jobhunter.database import init_db; init_db().close()",
]);
const load = phase("sample_data_load", [
  "corepack",
  "pnpm",
  "sample-data:load",
  "--",
  "--app-dir",
  appDir,
  "--db-path",
  dbPath,
  "--json",
]);
const probe = phase("sample_data_probe", [
  "corepack",
  "pnpm",
  "sample-data:probe",
  "--",
  "--app-dir",
  appDir,
  "--db-path",
  dbPath,
  "--json",
]);

const finishedAt = new Date().toISOString();
const totalMs = Math.round(performance.now() - start);
const probeJson = parseJson(probe.stdout);
const record = {
  schemaVersion: 1,
  mode: "synthetic_sample",
  description:
    "Measures the synthetic first-run sample-data path. It does not claim to measure live crawl, LLM scoring, or application submission.",
  commit: git(["rev-parse", "HEAD"]).trim(),
  startedAt,
  finishedAt,
  totalMs,
  thresholdsMs: {
    ttfv1FirstScoredJob: 10 * 60 * 1000,
    ttfv2FirstReviewedResumePdf: 30 * 60 * 1000,
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    appDir,
    dbPath,
    includeSetup,
    coldCachesRequiredForFullGate: !includeSetup ? "not_enforced_in_routine_subphase" : "recorded_only",
  },
  phases,
  sampleLoad: parseJson(load.stdout),
  probe: probeJson,
  pass: {
    ttfv1FirstScoredJob:
      Boolean(probeJson?.ttfv1?.passed) && totalMs <= 10 * 60 * 1000,
    ttfv2FirstReviewedResumePdf:
      Boolean(probeJson?.ttfv2?.passed) && totalMs <= 30 * 60 * 1000,
  },
};

const rendered = `${JSON.stringify(record, null, 2)}\n`;
if (recordPath) {
  fs.mkdirSync(path.dirname(path.resolve(recordPath)), { recursive: true });
  fs.writeFileSync(recordPath, rendered);
}
process.stdout.write(rendered);

function phase(name, command) {
  const phaseStartedAt = new Date().toISOString();
  const phaseStart = performance.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    env: {
      ...process.env,
      JOBHUNTER_DIR: appDir,
      JOBHUNTER_DB_PATH: dbPath,
    },
    encoding: "utf-8",
  });
  const durationMs = Math.round(performance.now() - phaseStart);
  const entry = {
    name,
    command: command.join(" "),
    startedAt: phaseStartedAt,
    durationMs,
    exitCode: result.status,
  };
  phases.push(entry);
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${name} failed\n`);
    process.exit(result.status ?? 1);
  }
  return { ...entry, stdout: result.stdout, stderr: result.stderr };
}

function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: repoRoot, encoding: "utf-8" });
  return result.status === 0 ? result.stdout : "";
}

function parseJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // pnpm emits script banners before command output. The sample-data CLI still
    // writes a single JSON object, so parse the final object rather than trusting
    // stdout to be JSON-only.
    for (let index = trimmed.lastIndexOf("\n{"); index >= 0; index = trimmed.lastIndexOf("\n{", index - 1)) {
      try {
        return JSON.parse(trimmed.slice(index + 1));
      } catch {
        // Keep looking for an earlier object boundary.
      }
    }
    return null;
  }
}

function optionValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
