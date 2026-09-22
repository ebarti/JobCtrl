import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { AUTOMATION_PROJECT_DIR } from "../src/python-runtime.js";
import { EXACT_V10_SCHEMA_MANIFEST, schemaManifest } from "../src/schema-manifest.js";

export const BENCHMARK_SEED = "jobctrl-local-scale-v1";
export const DATASET_SIZES = [100, 1_000, 10_000] as const;
export const EVENTS_PER_JOB = 3;
export const DESCRIPTION_BYTES = 1_024;
export const PDF_PREVIEW_BYTES = 256 * 1_024;
export const HTML_PREVIEW_BYTES = 128 * 1_024;
export const INCREMENTAL_EVENT_COUNT = 50;
export const SSE_POLL_INTERVAL_MS = 250;

/** Proposed diagnostics, not adopted SLOs or CI gates. */
export const PROPOSED_REFERENCE_BUDGETS = {
  warmP95Ms: 250,
  projectionSettledNoopMs: 50,
  projectionIncrementalForegroundMs: 100,
  sseOneBatchVisibleMs: SSE_POLL_INTERVAL_MS * 2 + 100,
  coldProjectionByJobsMs: { 100: 2_000, 1_000: 8_000, 10_000: 45_000 },
  coldRpcStartupMs: 10_000,
  sustainedNodeRssGrowthBytes: 128 * 1_024 * 1_024,
  sustainedNodeHeapGrowthBytes: 64 * 1_024 * 1_024,
} as const;

export interface Distribution {
  samples: number[];
  p50: number;
  p95: number;
  max: number;
}

export interface BenchmarkWorkspace {
  directory: string;
  dbPath: string;
  configPath: string;
  artifactDirectory: string;
}

export interface SeedSummary {
  jobs: number;
  events: number;
  eventsPerJob: number;
  stages: Record<string, number>;
  scores: Record<string, number>;
  artifacts: {
    pdfBytes: number;
    htmlBytes: number;
    pdfSha256: string;
    htmlSha256: string;
    artifactId: string;
  };
}

export interface CliOptions {
  jsonOut: string | null;
}

const EXACT_SCHEMA_INITIALIZER = [
  "import sqlite3, sys",
  "from jobctrl.infrastructure.migrations.schema_v10 import create_exact_v10_schema",
  "conn = sqlite3.connect(sys.argv[1])",
  "create_exact_v10_schema(conn)",
  "conn.commit()",
  "conn.close()",
].join("; ");

export function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0) throw new Error("at least one sample is required");
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("samples must be finite non-negative numbers");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: [...samples],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let jsonOut: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--json-out") {
      throw new Error(`unsupported argument: ${argument ?? ""}`);
    }
    const candidate = argv[index + 1];
    if (!candidate || candidate.startsWith("--")) {
      throw new Error("--json-out requires a new .json file path");
    }
    if (jsonOut !== null) throw new Error("--json-out may be provided only once");
    const resolved = path.resolve(candidate);
    if (path.extname(resolved) !== ".json") {
      throw new Error("--json-out must end in .json");
    }
    if (fs.existsSync(resolved)) {
      throw new Error("--json-out refuses to overwrite an existing path");
    }
    jsonOut = resolved;
    index += 1;
  }
  return { jsonOut };
}

export async function withOwnedWorkspace<T>(
  run: (workspace: BenchmarkWorkspace) => Promise<T> | T,
): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-local-scale-"));
  const artifactDirectory = path.join(directory, "artifacts");
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const workspace: BenchmarkWorkspace = {
    directory,
    dbPath: path.join(directory, "jobctrl.db"),
    configPath: path.join(directory, "config.json"),
    artifactDirectory,
  };
  fs.writeFileSync(workspace.configPath, "{}\n", { mode: 0o600 });
  try {
    initializeExactV10Database(workspace);
    return await run(workspace);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function initializeExactV10Database(workspace: BenchmarkWorkspace): void {
  if (fs.existsSync(workspace.dbPath)) {
    throw new Error("benchmark database path must not exist before exact-v10 initialization");
  }
  const result = spawnSync(
    "uv",
    ["--project", AUTOMATION_PROJECT_DIR, "run", "--locked", "python", "-c", EXACT_SCHEMA_INITIALIZER, workspace.dbPath],
    {
      cwd: workspace.directory,
      encoding: "utf8",
      env: offlineEnvironment(workspace.directory),
    },
  );
  if (result.status !== 0) {
    throw new Error(`exact-v10 initializer failed (${result.status ?? "signal"}): ${result.stderr.trim()}`);
  }
  const db = new Database(workspace.dbPath, { readonly: true, fileMustExist: true });
  try {
    const userVersion = Number(db.pragma("user_version", { simple: true }));
    const observed = schemaManifest(db, userVersion);
    if (JSON.stringify(observed) !== JSON.stringify(EXACT_V10_SCHEMA_MANIFEST)) {
      throw new Error(`exact-v10 manifest mismatch: ${JSON.stringify(observed)}`);
    }
  } finally {
    db.close();
  }
}

export function seedSyntheticDataset(workspace: BenchmarkWorkspace, jobs: number): SeedSummary {
  if (!DATASET_SIZES.includes(jobs as (typeof DATASET_SIZES)[number])) {
    throw new Error(`unsupported dataset size: ${jobs}`);
  }
  const db = new Database(workspace.dbPath, { fileMustExist: true });
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  const insertJob = db.prepare(
    `INSERT INTO jobs (
       tenant_id, job_id, url, title, company, salary, description, location,
       site, strategy, discovered_at, full_description, detail_scraped_at,
       fit_score, score_reasoning, scored_at
     ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEnrichment = db.prepare(
    `INSERT INTO job_enrichments (
       tenant_id, job_id, current_status, full_description, application_url,
       enriched_at, extraction_tier, attempts_json, updated_at
     ) VALUES ('local', ?, 'enriched', ?, ?, ?, 'synthetic', '[]', ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level, message,
       occurred_at, payload_json, idempotency_key
     ) VALUES ('local', ?, 1, ?, ?, 'info', ?, ?, ?, ?)`,
  );
  const description = fixedUtf8Payload("deterministic backend systems scale evidence ", DESCRIPTION_BYTES);
  db.transaction(() => {
    for (let index = 0; index < jobs; index += 1) {
      const job = syntheticJob(index);
      insertJob.run(
        job.jobId, job.url, job.title, job.company, job.salary, description, job.location,
        job.source, job.strategy, job.discoveredAt, description, job.discoveredAt,
        job.fitScore, `Synthetic score ${job.fitScore}`, job.discoveredAt,
      );
      insertEnrichment.run(job.jobId, description, job.url, job.discoveredAt, job.discoveredAt);
      const events = [
        ["discover", "JobDiscovered"],
        ["enrich", "StageStarted"],
        ["score", "StageCompleted"],
      ] as const;
      for (const [eventOffset, [stage, eventType]] of events.entries()) {
        const occurredAt = new Date(Date.parse(job.discoveredAt) + eventOffset).toISOString();
        insertEvent.run(
          job.jobId,
          stage,
          eventType,
          `${eventType} synthetic job ${index}`,
          occurredAt,
          JSON.stringify({ tenantId: "local", jobId: job.jobId, stage, synthetic: true }),
          `${BENCHMARK_SEED}:${index}:${eventOffset}`,
        );
      }
    }
  })();

  const firstJob = syntheticJob(0);
  const pdfPath = path.join(workspace.artifactDirectory, "synthetic-resume.pdf");
  const htmlPath = path.join(workspace.artifactDirectory, "synthetic-resume.html");
  const pdf = fixedBuffer("%PDF-1.7 synthetic benchmark\n", PDF_PREVIEW_BYTES);
  const html = fixedBuffer("<!doctype html><title>Synthetic benchmark</title><main>", HTML_PREVIEW_BYTES);
  fs.writeFileSync(pdfPath, pdf);
  fs.writeFileSync(htmlPath, html);
  const artifactId = `${BENCHMARK_SEED}:resume-pdf`;
  db.prepare(
    `INSERT INTO job_artifacts (
       tenant_id, job_id, stage, artifact_type, status, path, created_at,
       size_bytes, metadata_json
     ) VALUES ('local', ?, 'tailor', 'tailored_resume_pdf', 'active', ?, ?, ?, '{}')`,
  ).run(firstJob.jobId, pdfPath, firstJob.discoveredAt, pdf.length);
  db.prepare(
    `INSERT INTO job_materials (
       tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
     ) VALUES ('local', ?, 1, 'resume_approved', ?, ?, '{}')`,
  ).run(firstJob.jobId, firstJob.discoveredAt, firstJob.discoveredAt);
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
       render_format, size_bytes, metadata_json, created_at
     ) VALUES ('local', ?, 1, 'resume_pdf', ?, 'approved', ?, 'html_pdf', ?, ?, ?)`,
  ).run(firstJob.jobId, artifactId, pdfPath, pdf.length, JSON.stringify({ html_path: htmlPath }), firstJob.discoveredAt);
  db.close();

  const summary: SeedSummary = {
    jobs,
    events: jobs * EVENTS_PER_JOB,
    eventsPerJob: EVENTS_PER_JOB,
    stages: { discover: jobs, enrich: jobs, score: jobs },
    scores: { minimum: 0, maximum: 10, distinct: 11 },
    artifacts: {
      pdfBytes: pdf.length,
      htmlBytes: html.length,
      pdfSha256: sha256(pdf),
      htmlSha256: sha256(html),
      artifactId,
    },
  };
  assertSeedTotals(workspace.dbPath, summary);
  return summary;
}

export function assertSeedTotals(dbPath: string, expected: SeedSummary): void {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const count = (table: string): number =>
      Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    if (count("jobs") !== expected.jobs) throw new Error("job total oracle failed");
    if (count("job_events") !== expected.events) throw new Error("event total oracle failed");
    if (count("job_enrichments") !== expected.jobs) throw new Error("enrichment total oracle failed");
    if (count("job_artifacts") !== 1 || count("job_materials_artifacts") !== 1) {
      throw new Error("artifact shape oracle failed");
    }
  } finally {
    db.close();
  }
}

export function assertAscending(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index - 1] ?? "").localeCompare(values[index] ?? "") > 0) {
      throw new Error(`${label} ordering oracle failed at index ${index}`);
    }
  }
}

export function assertHash(payload: Uint8Array, expected: string, label: string): void {
  const observed = sha256(payload);
  if (observed !== expected) throw new Error(`${label} hash oracle failed: ${observed}`);
}

export function offlineEnvironment(appDir: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(OPENAI|ANTHROPIC|GOOGLE|GEMINI|LANGFUSE)_/i.test(key)) delete environment[key];
  }
  return {
    ...environment,
    JOBCTRL_DIR: appDir,
    LANGFUSE_DISABLE: "1",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

export function syntheticJob(index: number) {
  const url = `https://synthetic.invalid/jobs/${index.toString().padStart(5, "0")}`;
  return {
    jobId: uuidFrom(url),
    url,
    title: `${index % 10 === 0 ? "Needle" : "Platform"} Engineer ${index.toString().padStart(5, "0")}`,
    company: `Synthetic Company ${index % 97}`,
    salary: `EUR ${70_000 + (index % 40) * 1_000}`,
    location: index % 2 === 0 ? "Remote" : "Madrid, Spain",
    source: `source-${index % 5}`,
    strategy: `synthetic-${index % 3}`,
    discoveredAt: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
    fitScore: index % 11,
  };
}

function uuidFrom(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function fixedUtf8Payload(prefix: string, bytes: number): string {
  return fixedBuffer(prefix, bytes).toString("utf8");
}

function fixedBuffer(prefix: string, bytes: number): Buffer {
  const prefixBytes = Buffer.from(prefix, "utf8");
  const output = Buffer.alloc(bytes, 0x20);
  for (let offset = 0; offset < bytes; offset += prefixBytes.length) {
    prefixBytes.copy(output, offset, 0, Math.min(prefixBytes.length, bytes - offset));
  }
  return output;
}

function sha256(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

async function main(): Promise<void> {
  parseCliArgs(process.argv.slice(2));
  throw new Error("benchmark runner is not complete yet; deterministic seed support is ready");
}

const isEntrypoint = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
