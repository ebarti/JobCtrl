import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { RpcMethods } from "../src/contracts.js";
import { openDatabase } from "../src/db.js";
import { SubprocessJsonRpcAdapter } from "../src/json-rpc-adapter.js";
import { refreshProjections } from "../src/projections.js";
import { AUTOMATION_PROJECT_DIR, createSourcePythonRuntime } from "../src/python-runtime.js";
import { buildApp } from "../src/server.js";
import {
  assertAscending,
  assertHash,
  BENCHMARK_SEED,
  DATASET_SIZES,
  distribution,
  EVENTS_PER_JOB,
  INCREMENTAL_EVENT_COUNT,
  offlineEnvironment,
  parseCliArgs,
  PROPOSED_REFERENCE_BUDGETS,
  seedSyntheticDataset,
  SSE_POLL_INTERVAL_MS,
  syntheticJob,
  withOwnedWorkspace,
  type BenchmarkWorkspace,
  type Distribution,
  type SeedSummary,
} from "./local-scale.js";

const WARMUPS = 2;
const SAMPLES = 7;
const SSE_BURST_EVENTS = 1_000;
const SSE_SUBSCRIBERS = 4;
const SUSTAINED_MIN_MS = 1_500;
const PROJECTION_DRAIN_TIMEOUT_MS = 120_000;

interface HttpResult {
  ordinaryList: Distribution;
  search: Distribution;
  inMemorySort: Distribution;
  searchExpected: number;
  searchObserved: number;
  ordinaryFirstJobId: string;
  inMemoryFirstPageSources: string[];
}

interface ProjectionResult {
  coldForegroundMs: number;
  fullyDrainedConvergenceMs: number;
  settledNoopMs: number;
  incrementalForegroundMs: number;
  projectionRows: number;
  maxEventId: number;
  watermark: number;
  incrementalEvents: number;
}

interface PreviewResult {
  pdf: Distribution;
  html: Distribution;
  pdfBytes: number;
  htmlBytes: number;
  pdfSha256: string;
  htmlSha256: string;
}

interface RpcResult {
  method: string;
  coldStartupMs: number;
  warm: Distribution;
  responseHasResult: boolean;
  processScope: ProcessScope;
  telemetryExportDisabled: true;
  providerModelCalls: 0;
}

interface SseResult {
  pollIntervalMs: number;
  idleObservationMs: number;
  idleDomainEvents: number;
  idleNodeCpuMs: number;
  oneSubscriberBurstMs: number;
  replayMs: number;
  severalSubscribersMs: number;
  subscribers: number;
  eventsPerBurst: number;
  nodeCpuMs: number;
  rssDeltaBytes: number;
  heapDeltaBytes: number;
  orderingVerified: true;
  countVerified: true;
}

interface SustainedResult {
  durationMs: number;
  writes: number;
  sseEventsObserved: number;
  readLatency: Distribution;
  operationsLatency: Distribution;
  rssGrowthBytes: number;
  heapGrowthBytes: number;
  nodeCpuMs: number;
  workflowContext: {
    workflowType: "DiscoverWorkflow";
    workflowStatus: "in_progress";
    heartbeatFresh: boolean;
    activeActivity: "score_job";
    activeDurationSamples: number;
    activityQueueBacklog: number;
    lifecycleEvents: number;
  };
  providerCalls: 0;
  llmSpend: { inputTokens: number; outputTokens: number; estimatedUsd: number };
  tokenEvidence: string;
}

interface ProcessScope {
  scope: string;
  processCount: number;
  rssBytes: number;
  cpuPercentSnapshot: number;
  commands: string[];
}

interface DatasetResult {
  jobs: number;
  seed: SeedSummary;
  projection: ProjectionResult;
  http: HttpResult;
  sse: SseResult;
  preview: PreviewResult;
  rpc: RpcResult;
  sustained: SustainedResult;
  storage: { databaseBytes: number; artifactBytes: number };
  nodePeak: { rssBytes: number; heapUsedBytes: number };
  proposedBudgetComparison: Record<string, { target: number; observed: number; pass: boolean }>;
}

interface BenchmarkReport {
  formatVersion: 1;
  benchmark: string;
  seed: string;
  candidate: { gitHead: string; gitStatus: string[]; excludedDirtyPath: string | null };
  schema: { version: 10; initializer: string };
  method: {
    datasetSizes: readonly number[];
    eventsPerJob: number;
    warmups: number;
    samples: number;
    isolation: string;
    productionPaths: string[];
    providerNetworkPolicy: string;
  };
  proposedReferenceBudgets: typeof PROPOSED_REFERENCE_BUDGETS;
  budgetRationale: Record<string, string>;
  provenance: Record<string, unknown>;
  backgroundLoadLimitation: string;
  datasets: DatasetResult[];
}

interface CpuSnapshot {
  userCPUTime: number;
  systemCPUTime: number;
}

interface MemorySnapshot {
  rss: number;
  heapUsed: number;
}

interface SseCollector {
  ids: number[];
  eventTypes: string[];
  waitFor(count: number, timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export async function runBenchmark(): Promise<BenchmarkReport> {
  const datasets: DatasetResult[] = [];
  for (const jobs of DATASET_SIZES) {
    process.stderr.write(`local-scale: measuring ${jobs} jobs\n`);
    datasets.push(await withOwnedWorkspace((workspace) => runDataset(workspace, jobs)));
  }
  return {
    formatVersion: 1,
    benchmark: "JobCtrl synthetic local scale baseline",
    seed: BENCHMARK_SEED,
    candidate: gitCandidate(),
    schema: {
      version: 10,
      initializer: "jobctrl.infrastructure.migrations.schema_v10.create_exact_v10_schema via uv --locked",
    },
    method: {
      datasetSizes: DATASET_SIZES,
      eventsPerJob: EVENTS_PER_JOB,
      warmups: WARMUPS,
      samples: SAMPLES,
      isolation: "Each dataset uses a new benchmark-owned mkdtemp app/config/DB/artifact workspace and is removed after the run.",
      productionPaths: [
        "refreshProjections bounded foreground pass and background drain",
        "buildApp loopback HTTP /v1/jobs list/search/in-memory sort",
        "registerEventStreamRoute real 250 ms timer-driven SSE connection",
        "buildApp PDF and HTML artifact preview streams",
        "SubprocessJsonRpcAdapter -> uv -> production Python jobctrl rpc dispatcher provider_models",
      ],
      providerNetworkPolicy: "LANGFUSE_DISABLE=1, provider credentials removed, outbound proxy forced to an unreachable loopback port; provider_models is a local read and no model/provider calls are made.",
    },
    proposedReferenceBudgets: PROPOSED_REFERENCE_BUDGETS,
    budgetRationale: {
      warmP95Ms: "250 ms is a conservative local interactive-response target for repeated list/search/preview/RPC reads.",
      projectionSettledNoopMs: "50 ms keeps a settled read-model guard cheap relative to an interactive request.",
      projectionIncrementalForegroundMs: "100 ms bounds a fixed 50-event foreground fold before any background drain.",
      sseOneBatchVisibleMs: "600 ms equals two production 250 ms polls plus 100 ms local delivery allowance.",
      coldProjectionByJobsMs: "2/8/45 seconds separate one-time rebuild cost by declared scale and tolerate local hardware variance.",
      coldRpcStartupMs: "10 seconds isolates uv and Python import startup from warm RPC calls.",
      sustainedGrowth: "128 MiB RSS and 64 MiB heap are diagnostic leak sentinels for the bounded 1.5 second workload, not long-horizon guarantees.",
    },
    provenance: systemProvenance(),
    backgroundLoadLimitation: "Four other issue tasks were active on the same host during this run. There was no CPU pinning or isolated reference hardware. Raw samples are retained; these measurements must not be used to tighten the proposed budgets.",
    datasets,
  };
}

export async function runDataset(workspace: BenchmarkWorkspace, jobs: number): Promise<DatasetResult> {
  const seed = seedSyntheticDataset(workspace, jobs);
  seedLongRunningContext(workspace);
  const peak = { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed };
  const updatePeak = (): void => {
    const memory = process.memoryUsage();
    peak.rssBytes = Math.max(peak.rssBytes, memory.rss);
    peak.heapUsedBytes = Math.max(peak.heapUsedBytes, memory.heapUsed);
  };

  const projection = await measureProjection(workspace, jobs);
  updatePeak();
  const previousPoll = process.env.JOBCTRL_API_SSE_POLL_MS;
  process.env.JOBCTRL_API_SSE_POLL_MS = String(SSE_POLL_INTERVAL_MS);
  let app: ReturnType<typeof buildApp> | undefined;
  let baseUrl = "";
  try {
    app = buildApp({ dbPath: workspace.dbPath, appDir: workspace.directory, configPath: workspace.configPath });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("benchmark API did not expose a TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const http = await measureHttp(baseUrl, jobs);
    updatePeak();
    const preview = await measurePreviews(baseUrl, seed);
    updatePeak();
    const sse = await measureSse(baseUrl, workspace);
    updatePeak();
    const sustained = await measureSustained(baseUrl, workspace);
    updatePeak();
    const rpc = await measureRpc(workspace);
    updatePeak();
    const storage = storageBytes(workspace);
    const result: DatasetResult = {
      jobs,
      seed,
      projection,
      http,
      sse,
      preview,
      rpc,
      sustained,
      storage,
      nodePeak: peak,
      proposedBudgetComparison: compareBudgets(jobs, { projection, http, sse, preview, rpc, sustained }),
    };
    return result;
  } finally {
    await app?.close();
    if (previousPoll === undefined) delete process.env.JOBCTRL_API_SSE_POLL_MS;
    else process.env.JOBCTRL_API_SSE_POLL_MS = previousPoll;
  }
}

async function measureProjection(workspace: BenchmarkWorkspace, jobs: number): Promise<ProjectionResult> {
  const db = openDatabase(workspace.dbPath);
  const convergenceStart = performance.now();
  const coldStart = performance.now();
  refreshProjections(db);
  const coldForegroundMs = elapsed(coldStart);
  const initialMaxEventId = scalar(db, "SELECT COALESCE(MAX(event_id), 0) FROM job_events");
  await waitForProjectionDrain(db, initialMaxEventId, jobs);
  const fullyDrainedConvergenceMs = elapsed(convergenceStart);
  const noopStart = performance.now();
  refreshProjections(db);
  const settledNoopMs = elapsed(noopStart);

  const insert = db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level, message,
       occurred_at, payload_json, idempotency_key
     ) VALUES ('local', ?, 1, 'score', 'BenchmarkIncrementalEvent', 'info',
       'synthetic incremental benchmark event', ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let index = 0; index < INCREMENTAL_EVENT_COUNT; index += 1) {
      const jobId = syntheticJob(index % jobs).jobId;
      const occurredAt = new Date(Date.UTC(2026, 1, 1) + index).toISOString();
      insert.run(
        jobId,
        occurredAt,
        JSON.stringify({ tenantId: "local", jobId, synthetic: true, incremental: true }),
        `${BENCHMARK_SEED}:incremental:${index}`,
      );
    }
  })();
  const incrementalStart = performance.now();
  refreshProjections(db);
  const incrementalForegroundMs = elapsed(incrementalStart);
  const maxEventId = scalar(db, "SELECT COALESCE(MAX(event_id), 0) FROM job_events");
  await waitForProjectionDrain(db, maxEventId, jobs);
  const watermark = scalar(
    db,
    "SELECT COALESCE(last_event_id, 0) FROM event_watermarks WHERE projection_name = 'typescript:operations_projections:local'",
  );
  const projectionRows = scalar(db, "SELECT COUNT(*) FROM job_list_projections WHERE tenant_id = 'local'");
  db.close();
  if (watermark !== maxEventId) throw new Error(`projection watermark ${watermark} did not reach ${maxEventId}`);
  if (projectionRows !== jobs) throw new Error(`projection row total ${projectionRows} did not equal ${jobs}`);
  return {
    coldForegroundMs,
    fullyDrainedConvergenceMs,
    settledNoopMs,
    incrementalForegroundMs,
    projectionRows,
    maxEventId,
    watermark,
    incrementalEvents: INCREMENTAL_EVENT_COUNT,
  };
}

async function waitForProjectionDrain(db: Database.Database, target: number, jobs: number): Promise<void> {
  const deadline = performance.now() + PROJECTION_DRAIN_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const watermark = scalar(
      db,
      "SELECT COALESCE(last_event_id, 0) FROM event_watermarks WHERE projection_name = 'typescript:operations_projections:local'",
    );
    const rows = scalar(db, "SELECT COUNT(*) FROM job_list_projections WHERE tenant_id = 'local'");
    if (watermark >= target && rows === jobs) return;
    await delay(5);
  }
  throw new Error(`projection drain timed out at target ${target}`);
}

async function measureHttp(baseUrl: string, jobs: number): Promise<HttpResult> {
  const ordinaryUrl = `${baseUrl}/v1/jobs?page=1&pageSize=50&sort=discovered_at&dir=desc`;
  const searchUrl = `${baseUrl}/v1/jobs?page=1&pageSize=50&q=Needle&sort=discovered_at&dir=desc`;
  const sortUrl = `${baseUrl}/v1/jobs?page=1&pageSize=50&sort=source&dir=asc`;
  let ordinaryFirstJobId = "";
  let searchObserved = 0;
  let inMemoryFirstPageSources: string[] = [];
  const ordinaryList = await measureRequests(ordinaryUrl, (body) => {
    const parsed = asPage(body, "ordinary list");
    if (parsed.total !== jobs || parsed.items.length !== Math.min(50, jobs)) throw new Error("ordinary list total oracle failed");
    ordinaryFirstJobId = String(record(parsed.items[0]).jobKey ?? "");
    if (ordinaryFirstJobId !== syntheticJob(jobs - 1).jobId) throw new Error("ordinary list ordering oracle failed");
  });
  const searchExpected = Math.ceil(jobs / 10);
  const search = await measureRequests(searchUrl, (body) => {
    const parsed = asPage(body, "search");
    searchObserved = parsed.total;
    if (searchObserved !== searchExpected) throw new Error(`search selectivity oracle failed: ${searchObserved}`);
    if (parsed.items.some((item) => !String(record(item).title).includes("Needle"))) {
      throw new Error("search content oracle failed");
    }
  });
  const inMemorySort = await measureRequests(sortUrl, (body) => {
    const parsed = asPage(body, "in-memory sort");
    inMemoryFirstPageSources = parsed.items.map((item) => {
      const job = record(item);
      return String(job.postingSource || job.discoverySource || job.source || "").toLowerCase();
    });
    assertAscending(inMemoryFirstPageSources, "in-memory source sort");
  });
  return {
    ordinaryList,
    search,
    inMemorySort,
    searchExpected,
    searchObserved,
    ordinaryFirstJobId,
    inMemoryFirstPageSources,
  };
}

async function measureRequests(url: string, verify: (body: unknown) => void): Promise<Distribution> {
  const samples: number[] = [];
  for (let index = 0; index < WARMUPS + SAMPLES; index += 1) {
    const start = performance.now();
    const response = await fetch(url);
    const body = await response.json() as unknown;
    const duration = elapsed(start);
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    verify(body);
    if (index >= WARMUPS) samples.push(duration);
  }
  return distribution(samples);
}

async function measurePreviews(baseUrl: string, seed: SeedSummary): Promise<PreviewResult> {
  const artifact = encodeURIComponent(seed.artifacts.artifactId);
  const pdfUrl = `${baseUrl}/v1/artifacts/${artifact}/preview.pdf`;
  const htmlUrl = `${baseUrl}/v1/artifacts/${artifact}/preview.html`;
  const pdf = await measureBinaryRequests(pdfUrl, seed.artifacts.pdfSha256, seed.artifacts.pdfBytes, "PDF preview");
  const html = await measureBinaryRequests(htmlUrl, seed.artifacts.htmlSha256, seed.artifacts.htmlBytes, "HTML preview");
  return {
    pdf,
    html,
    pdfBytes: seed.artifacts.pdfBytes,
    htmlBytes: seed.artifacts.htmlBytes,
    pdfSha256: seed.artifacts.pdfSha256,
    htmlSha256: seed.artifacts.htmlSha256,
  };
}

async function measureBinaryRequests(url: string, hash: string, bytes: number, label: string): Promise<Distribution> {
  const samples: number[] = [];
  for (let index = 0; index < WARMUPS + SAMPLES; index += 1) {
    const start = performance.now();
    const response = await fetch(url);
    const body = new Uint8Array(await response.arrayBuffer());
    const duration = elapsed(start);
    if (!response.ok) throw new Error(`${label} returned ${response.status}`);
    if (body.byteLength !== bytes) throw new Error(`${label} size oracle failed`);
    assertHash(body, hash, label);
    if (index >= WARMUPS) samples.push(duration);
  }
  return distribution(samples);
}

async function measureSse(baseUrl: string, workspace: BenchmarkWorkspace): Promise<SseResult> {
  const memoryBefore = memorySnapshot();
  const cpuBefore = cpuSnapshot();
  const idle = await openSse(`${baseUrl}/v1/events/stream`);
  const idleCpuBefore = cpuSnapshot();
  const idleObservationMs = SSE_POLL_INTERVAL_MS * 2 + 50;
  await delay(idleObservationMs);
  const idleNodeCpuMs = cpuDeltaMs(idleCpuBefore, cpuSnapshot());
  const idleDomainEvents = idle.ids.length;
  await idle.close();
  if (idleDomainEvents !== 0) throw new Error("idle SSE unexpectedly delivered a domain event");

  const oneCursor = maxEventId(workspace.dbPath);
  const one = await openSse(`${baseUrl}/v1/events/stream?since=${oneCursor}`);
  const oneStart = performance.now();
  insertBurst(workspace.dbPath, SSE_BURST_EVENTS, "single", oneCursor);
  await one.waitFor(SSE_BURST_EVENTS, 5_000);
  const oneSubscriberBurstMs = elapsed(oneStart);
  verifySse(one, oneCursor + 1, SSE_BURST_EVENTS);
  await one.close();

  const replayCursor = maxEventId(workspace.dbPath);
  insertBurst(workspace.dbPath, SSE_BURST_EVENTS, "replay", replayCursor);
  const replayStart = performance.now();
  const replay = await openSse(`${baseUrl}/v1/events/stream`, replayCursor);
  await replay.waitFor(SSE_BURST_EVENTS, 5_000);
  const replayMs = elapsed(replayStart);
  verifySse(replay, replayCursor + 1, SSE_BURST_EVENTS);
  await replay.close();

  const severalCursor = maxEventId(workspace.dbPath);
  const subscribers = await Promise.all(
    Array.from({ length: SSE_SUBSCRIBERS }, () => openSse(`${baseUrl}/v1/events/stream?since=${severalCursor}`)),
  );
  const severalStart = performance.now();
  insertBurst(workspace.dbPath, SSE_BURST_EVENTS, "several", severalCursor);
  await Promise.all(subscribers.map((subscriber) => subscriber.waitFor(SSE_BURST_EVENTS, 5_000)));
  const severalSubscribersMs = elapsed(severalStart);
  for (const subscriber of subscribers) {
    verifySse(subscriber, severalCursor + 1, SSE_BURST_EVENTS);
    await subscriber.close();
  }
  const memoryAfter = memorySnapshot();
  const cpuAfter = cpuSnapshot();
  return {
    pollIntervalMs: SSE_POLL_INTERVAL_MS,
    idleObservationMs,
    idleDomainEvents,
    idleNodeCpuMs,
    oneSubscriberBurstMs,
    replayMs,
    severalSubscribersMs,
    subscribers: SSE_SUBSCRIBERS,
    eventsPerBurst: SSE_BURST_EVENTS,
    nodeCpuMs: cpuDeltaMs(cpuBefore, cpuAfter),
    rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    orderingVerified: true,
    countVerified: true,
  };
}

async function measureRpc(workspace: BenchmarkWorkspace): Promise<RpcResult> {
  const adapter = new SubprocessJsonRpcAdapter({
    appDir: workspace.directory,
    configPath: workspace.configPath,
    pythonRuntime: createSourcePythonRuntime({ environment: offlineEnvironment(workspace.directory) }),
    requestTimeoutMs: 30_000,
  });
  try {
    const coldStart = performance.now();
    const cold = await adapter.call(RpcMethods.ProviderModels, {});
    const coldStartupMs = elapsed(coldStart);
    if (cold.error || cold.result === undefined) throw new Error("production RPC cold response oracle failed");
    for (let index = 0; index < WARMUPS; index += 1) {
      const response = await adapter.call(RpcMethods.ProviderModels, {});
      if (response.error || response.result === undefined) throw new Error("production RPC warmup response oracle failed");
    }
    const samples: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const start = performance.now();
      const response = await adapter.call(RpcMethods.ProviderModels, {});
      const duration = elapsed(start);
      if (response.error || response.result === undefined) throw new Error("production RPC warm response oracle failed");
      samples.push(duration);
    }
    return {
      method: RpcMethods.ProviderModels,
      coldStartupMs,
      warm: distribution(samples),
      responseHasResult: true,
      processScope: descendantProcessScope(),
      telemetryExportDisabled: true,
      providerModelCalls: 0,
    };
  } finally {
    await adapter.close();
  }
}

async function measureSustained(baseUrl: string, workspace: BenchmarkWorkspace): Promise<SustainedResult> {
  const cursor = maxEventId(workspace.dbPath);
  const subscriber = await openSse(`${baseUrl}/v1/events/stream?since=${cursor}`);
  const memoryBefore = memorySnapshot();
  const cpuBefore = cpuSnapshot();
  const readSamples: number[] = [];
  const operationSamples: number[] = [];
  const started = performance.now();
  let writes = 0;
  let batch = 0;
  try {
    while (performance.now() - started < SUSTAINED_MIN_MS) {
      const writeCount = 10;
      insertBurst(workspace.dbPath, writeCount, `sustained-${batch}`, maxEventId(workspace.dbPath));
      writes += writeCount;
      refreshHeartbeat(workspace.dbPath);
      const readStart = performance.now();
      const readResponse = await fetch(`${baseUrl}/v1/jobs?page=1&pageSize=20&q=Needle&sort=source&dir=asc`);
      const readBody = await readResponse.json() as unknown;
      if (!readResponse.ok || asPage(readBody, "sustained list").total < 1) throw new Error("sustained list oracle failed");
      readSamples.push(elapsed(readStart));
      const operationsStart = performance.now();
      const operationsResponse = await fetch(`${baseUrl}/v1/pipeline/operations`);
      const operations = record(await operationsResponse.json() as unknown);
      if (!operationsResponse.ok) throw new Error("pipeline operations route failed during sustained load");
      verifyOperationsContext(operations);
      operationSamples.push(elapsed(operationsStart));
      batch += 1;
    }
    await subscriber.waitFor(writes, 10_000);
  } finally {
    await subscriber.close();
  }
  const durationMs = elapsed(started);
  const memoryAfter = memorySnapshot();
  const cpuAfter = cpuSnapshot();
  const context = readWorkflowContext(workspace.dbPath);
  const llmSpend = readLlmSpend(workspace.dbPath);
  if (llmSpend.inputTokens !== 0 || llmSpend.outputTokens !== 0 || llmSpend.estimatedUsd !== 0) {
    throw new Error("benchmark unexpectedly recorded provider spend");
  }
  return {
    durationMs,
    writes,
    sseEventsObserved: subscriber.ids.length,
    readLatency: distribution(readSamples),
    operationsLatency: distribution(operationSamples),
    rssGrowthBytes: memoryAfter.rss - memoryBefore.rss,
    heapGrowthBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    nodeCpuMs: cpuDeltaMs(cpuBefore, cpuAfter),
    workflowContext: context,
    providerCalls: 0,
    llmSpend,
    tokenEvidence: "The production RPC dispatcher executed rpc.provider_models spans, but LANGFUSE_DISABLE=1 intentionally prevented export. No LLM method ran, llm_spend remained zero, and no provider token-usage observation exists for this benchmark; zero spend does not imply complete usage telemetry for unrelated workflows.",
  };
}

function seedLongRunningContext(workspace: BenchmarkWorkspace): void {
  const db = new Database(workspace.dbPath, { fileMustExist: true });
  const now = new Date();
  const started = new Date(now.getTime() - 30 * 60_000).toISOString();
  const runId = "11111111-1111-4111-8111-111111111111";
  db.prepare(
    `INSERT INTO workflow_run_projections (
       workflow_id, tenant_id, workflow_type, status, input_summary_json,
       started_at, temporal_run_id, events_json
     ) VALUES ('discover-local', 'local', 'DiscoverWorkflow', 'in_progress', ?, ?, ?, ?)`,
  ).run(
    JSON.stringify({ membershipClosed: false, synthetic: true }),
    started,
    runId,
    JSON.stringify([{ eventType: "WorkflowExecutionStarted", occurredAt: started }]),
  );
  const activityDetail = {
    activityType: "score_job",
    operationalRef: { kind: "job-scoring", opaqueId: "op_111111111111111111111111" },
    workflowRef: "discover-local",
    executionRef: runId,
    attempt: 1,
    startedAt: started,
  };
  const queueStats = {
    pollerCount: 1,
    approximateBacklogCount: 3,
    approximateBacklogAgeSeconds: 4,
    tasksAddRate: 2,
    tasksDispatchRate: 1,
  };
  db.prepare(
    `INSERT INTO worker_runtime_heartbeats (
       worker_id, component, pid, hostname, app_dir, db_path, task_queue,
       started_at, last_seen_at, max_concurrent_activities,
       activity_executor_max_workers, active_activity_count,
       active_activity_counts_json, active_activity_details_json,
       active_activity_details_total, active_activity_details_truncated,
       activity_duration_summary_json, task_queue_observation_json,
       heartbeat_schema_version
     ) VALUES (
       'benchmark-worker', 'temporal-worker', ?, 'synthetic-host', ?, ?,
       'jobctrl-default', ?, ?, 4, 6, 1, ?, ?, 1, 0, ?, ?, 2
     )`,
  ).run(
    process.pid,
    workspace.directory,
    workspace.dbPath,
    started,
    now.toISOString(),
    JSON.stringify({ score_job: 1 }),
    JSON.stringify([activityDetail]),
    JSON.stringify({ score_job: { completedCount: 8, totalDurationMs: 32_000, maxDurationMs: 7_000 } }),
    JSON.stringify({ status: "available", observedAt: now.toISOString(), workflow: queueStats, activity: queueStats }),
  );
  insertLifecycleEvents(db, runId, started);
  db.close();
}

function insertLifecycleEvents(db: Database.Database, runId: string, started: string): void {
  const insert = db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level, message,
       occurred_at, payload_json, idempotency_key
     ) VALUES ('local', NULL, 1, 'discover', ?, 'info', ?, ?, ?, ?)`,
  );
  const shared = {
    tenantId: "local",
    execution: { tenantId: "local", workflowId: "discover-local", temporalRunId: runId },
    stepKind: "source_family",
    itemKey: "synthetic-source",
    attempt: 1,
    detail: { code: "source_family", itemCount: 100 },
  };
  const queuedAt = started;
  const startedAt = new Date(Date.parse(started) + 1_000).toISOString();
  for (const [index, event] of [
    ["PipelineStepQueued", { ...shared, queuedAt }],
    ["PipelineStepStarted", { ...shared, startedAt }],
  ].entries()) {
    const [eventType, payload] = event as [string, Record<string, unknown>];
    const occurredAt = index === 0 ? queuedAt : startedAt;
    insert.run(eventType, `synthetic ${eventType}`, occurredAt, JSON.stringify(payload), `${BENCHMARK_SEED}:lifecycle:${index}`);
  }
}

function verifyOperationsContext(operations: Record<string, unknown>): void {
  const freshness = record(operations.freshness);
  const capacity = record(operations.capacity);
  if (freshness.status !== "fresh") throw new Error("pipeline heartbeat freshness oracle failed");
  if (capacity.status !== "available") throw new Error("pipeline capacity oracle failed");
  const queue = record(capacity.approximateTaskQueue);
  const activity = record(queue.activity);
  if (activity.approximateBacklogCount !== 3) throw new Error("pipeline queue field oracle failed");
  if (Number(operations.activeItemsTotal) < 1) throw new Error("pipeline active-work oracle failed");
}

function readWorkflowContext(dbPath: string): SustainedResult["workflowContext"] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const workflow = db.prepare(
      "SELECT workflow_type, status FROM workflow_run_projections WHERE workflow_id = 'discover-local'",
    ).get() as { workflow_type: string; status: string };
    const heartbeat = db.prepare(
      "SELECT last_seen_at, active_activity_counts_json, activity_duration_summary_json, task_queue_observation_json FROM worker_runtime_heartbeats WHERE worker_id = 'benchmark-worker'",
    ).get() as {
      last_seen_at: string;
      active_activity_counts_json: string;
      activity_duration_summary_json: string;
      task_queue_observation_json: string;
    };
    const durations = record(JSON.parse(heartbeat.activity_duration_summary_json) as unknown);
    const scoreDuration = record(durations.score_job);
    const queue = record(JSON.parse(heartbeat.task_queue_observation_json) as unknown);
    const activity = record(queue.activity);
    const lifecycleEvents = scalar(
      db,
      "SELECT COUNT(*) FROM job_events WHERE event_type IN ('PipelineStepQueued', 'PipelineStepStarted', 'PipelineStepCompleted', 'PipelineStepFailed')",
    );
    return {
      workflowType: workflow.workflow_type as "DiscoverWorkflow",
      workflowStatus: workflow.status as "in_progress",
      heartbeatFresh: Date.now() - Date.parse(heartbeat.last_seen_at) < 45_000,
      activeActivity: "score_job",
      activeDurationSamples: Number(scoreDuration.completedCount),
      activityQueueBacklog: Number(activity.approximateBacklogCount),
      lifecycleEvents,
    };
  } finally {
    db.close();
  }
}

function refreshHeartbeat(dbPath: string): void {
  const db = new Database(dbPath, { fileMustExist: true });
  const now = new Date().toISOString();
  const row = db.prepare(
    "SELECT task_queue_observation_json FROM worker_runtime_heartbeats WHERE worker_id = 'benchmark-worker'",
  ).get() as { task_queue_observation_json: string };
  const observation = record(JSON.parse(row.task_queue_observation_json) as unknown);
  observation.observedAt = now;
  db.prepare(
    "UPDATE worker_runtime_heartbeats SET last_seen_at = ?, task_queue_observation_json = ? WHERE worker_id = 'benchmark-worker'",
  ).run(now, JSON.stringify(observation));
  db.close();
}

function readLlmSpend(dbPath: string): SustainedResult["llmSpend"] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(
      "SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(estimated_usd), 0) AS estimated_usd FROM llm_spend",
    ).get() as { input_tokens: number; output_tokens: number; estimated_usd: number };
    return {
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      estimatedUsd: Number(row.estimated_usd),
    };
  } finally {
    db.close();
  }
}

function insertBurst(dbPath: string, count: number, label: string, startingCursor: number): void {
  const db = new Database(dbPath, { fileMustExist: true });
  const jobId = syntheticJob(0).jobId;
  const insert = db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level, message,
       occurred_at, payload_json, idempotency_key
     ) VALUES ('local', ?, 1, 'score', 'BenchmarkSyntheticWrite', 'info', ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const sequence = startingCursor + index + 1;
      const occurredAt = new Date(Date.UTC(2026, 2, 1) + sequence).toISOString();
      insert.run(
        jobId,
        `synthetic ${label} ${index}`,
        occurredAt,
        JSON.stringify({ tenantId: "local", jobId, synthetic: true, label, index }),
        `${BENCHMARK_SEED}:${label}:${sequence}`,
      );
    }
  })();
  db.close();
}

async function openSse(url: string, lastEventId?: number): Promise<SseCollector> {
  const controller = new AbortController();
  const response = await fetch(url, {
    signal: controller.signal,
    ...(lastEventId === undefined ? {} : { headers: { "Last-Event-ID": String(lastEventId) } }),
  });
  if (!response.ok || !response.body) throw new Error(`SSE connection failed with ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const ids: number[] = [];
  const eventTypes: string[] = [];
  let buffer = "";
  let stopped = false;
  const read = (async () => {
    try {
      while (!stopped) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const id = /^id:\s*(\d+)$/m.exec(frame)?.[1];
          const eventType = /^event:\s*(\S+)$/m.exec(frame)?.[1];
          if (id !== undefined) {
            ids.push(Number(id));
            eventTypes.push(eventType ?? "message");
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!stopped && !(error instanceof DOMException && error.name === "AbortError")) throw error;
    }
  })();
  return {
    ids,
    eventTypes,
    async waitFor(count, timeoutMs) {
      const deadline = performance.now() + timeoutMs;
      while (ids.length < count && performance.now() < deadline) await delay(5);
      if (ids.length < count) throw new Error(`SSE timed out after ${ids.length}/${count} events`);
    },
    async close() {
      stopped = true;
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // Abort and server teardown are expected close paths.
      }
      await read.catch(() => undefined);
    },
  };
}

function verifySse(collector: SseCollector, firstId: number, count: number): void {
  if (collector.ids.length < count) throw new Error("SSE count oracle failed");
  const observed = collector.ids.slice(0, count);
  for (let index = 0; index < count; index += 1) {
    if (observed[index] !== firstId + index) throw new Error(`SSE ordering oracle failed at ${index}`);
  }
}

function compareBudgets(
  jobs: number,
  input: Pick<DatasetResult, "projection" | "http" | "sse" | "preview" | "rpc" | "sustained">,
): Record<string, { target: number; observed: number; pass: boolean }> {
  const compare = (target: number, observed: number) => ({ target, observed, pass: observed <= target });
  const coldTarget = PROPOSED_REFERENCE_BUDGETS.coldProjectionByJobsMs[
    jobs as keyof typeof PROPOSED_REFERENCE_BUDGETS.coldProjectionByJobsMs
  ];
  return {
    projectionColdConvergenceMs: compare(coldTarget, input.projection.fullyDrainedConvergenceMs),
    projectionSettledNoopMs: compare(PROPOSED_REFERENCE_BUDGETS.projectionSettledNoopMs, input.projection.settledNoopMs),
    projectionIncrementalForegroundMs: compare(PROPOSED_REFERENCE_BUDGETS.projectionIncrementalForegroundMs, input.projection.incrementalForegroundMs),
    httpOrdinaryListP95Ms: compare(PROPOSED_REFERENCE_BUDGETS.warmP95Ms, input.http.ordinaryList.p95),
    httpSearchP95Ms: compare(PROPOSED_REFERENCE_BUDGETS.warmP95Ms, input.http.search.p95),
    httpInMemorySortP95Ms: compare(PROPOSED_REFERENCE_BUDGETS.warmP95Ms, input.http.inMemorySort.p95),
    previewPdfP95Ms: compare(PROPOSED_REFERENCE_BUDGETS.warmP95Ms, input.preview.pdf.p95),
    previewHtmlP95Ms: compare(PROPOSED_REFERENCE_BUDGETS.warmP95Ms, input.preview.html.p95),
    rpcColdStartupMs: compare(PROPOSED_REFERENCE_BUDGETS.coldRpcStartupMs, input.rpc.coldStartupMs),
    rpcWarmP95Ms: compare(PROPOSED_REFERENCE_BUDGETS.warmP95Ms, input.rpc.warm.p95),
    sseOneSubscriberBatchMs: compare(PROPOSED_REFERENCE_BUDGETS.sseOneBatchVisibleMs, input.sse.oneSubscriberBurstMs),
    sustainedRssGrowthBytes: compare(PROPOSED_REFERENCE_BUDGETS.sustainedNodeRssGrowthBytes, input.sustained.rssGrowthBytes),
    sustainedHeapGrowthBytes: compare(PROPOSED_REFERENCE_BUDGETS.sustainedNodeHeapGrowthBytes, input.sustained.heapGrowthBytes),
  };
}

function descendantProcessScope(): ProcessScope {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,comm="], { encoding: "utf8" });
  if (result.status !== 0) {
    return { scope: "recursive descendants of benchmark Node PID (sampler unavailable)", processCount: 0, rssBytes: 0, cpuPercentSnapshot: 0, commands: [] };
  }
  const rows = result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), cpu: Number(match[4]), command: path.basename(match[5] ?? "") }] : [];
  });
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if ((row.ppid === process.pid || descendants.has(row.ppid)) && row.command !== "ps" && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const scoped = rows.filter((row) => descendants.has(row.pid));
  return {
    scope: "recursive descendants of benchmark Node PID while production RPC adapter is warm; excludes ps sampler and Node parent",
    processCount: scoped.length,
    rssBytes: scoped.reduce((total, row) => total + row.rssKb * 1_024, 0),
    cpuPercentSnapshot: scoped.reduce((total, row) => total + row.cpu, 0),
    commands: [...new Set(scoped.map((row) => row.command))].sort(),
  };
}

function systemProvenance(): Record<string, unknown> {
  const python = spawnSync(
    "uv",
    ["--project", AUTOMATION_PROJECT_DIR, "run", "--locked", "python", "--version"],
    { encoding: "utf8", env: offlineEnvironment(AUTOMATION_PROJECT_DIR) },
  );
  const db = new Database(":memory:");
  const sqliteVersion = String((db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version);
  db.close();
  return {
    capturedAt: new Date().toISOString(),
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
    python: (python.stdout || python.stderr).trim(),
    sqlite: sqliteVersion,
    nodeProcessScope: `PID ${process.pid}; process.resourceUsage plus process.memoryUsage`,
    rpcProcessScope: "recursive descendants sampled while SubprocessJsonRpcAdapter's production process was warm",
  };
}

function gitCandidate(): BenchmarkReport["candidate"] {
  const git = (args: string[]): string => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  const status = git(["status", "--short"]).split("\n").filter(Boolean);
  return {
    gitHead: git(["rev-parse", "HEAD"]),
    gitStatus: status,
    excludedDirtyPath: status.some((line) => line.endsWith("workers/automation/uv.lock"))
      ? "workers/automation/uv.lock (unrelated pre-existing two-line change; excluded from candidate)"
      : null,
  };
}

function storageBytes(workspace: BenchmarkWorkspace): { databaseBytes: number; artifactBytes: number } {
  const databaseBytes = [workspace.dbPath, `${workspace.dbPath}-wal`, `${workspace.dbPath}-shm`]
    .filter((candidate) => fs.existsSync(candidate))
    .reduce((total, candidate) => total + fs.statSync(candidate).size, 0);
  const artifactBytes = fs.readdirSync(workspace.artifactDirectory)
    .map((name) => fs.statSync(path.join(workspace.artifactDirectory, name)).size)
    .reduce((total, bytes) => total + bytes, 0);
  return { databaseBytes, artifactBytes };
}

function maxEventId(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return scalar(db, "SELECT COALESCE(MAX(event_id), 0) FROM job_events");
  } finally {
    db.close();
  }
}

function scalar(db: Database.Database, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, number | bigint | string> | undefined;
  return Number(row ? Object.values(row)[0] : 0);
}

function asPage(value: unknown, label: string): { items: unknown[]; total: number } {
  const page = record(value);
  const pagination = record(page.pagination);
  if (!Array.isArray(page.items) || !Number.isInteger(pagination.total)) throw new Error(`${label} response oracle failed`);
  return { items: page.items, total: Number(pagination.total) };
}

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, any>;
}

function cpuSnapshot(): CpuSnapshot {
  const usage = process.resourceUsage();
  return { userCPUTime: usage.userCPUTime, systemCPUTime: usage.systemCPUTime };
}

function cpuDeltaMs(before: CpuSnapshot, after: CpuSnapshot): number {
  return (after.userCPUTime - before.userCPUTime + after.systemCPUTime - before.systemCPUTime) / 1_000;
}

function memorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  return { rss: memory.rss, heapUsed: memory.heapUsed };
}

function elapsed(start: number): number {
  return Math.round((performance.now() - start) * 1_000) / 1_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const report = await runBenchmark();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.jsonOut) {
    fs.mkdirSync(path.dirname(options.jsonOut), { recursive: true });
    fs.writeFileSync(options.jsonOut, serialized, { flag: "wx", mode: 0o644 });
    process.stderr.write(`local-scale: wrote ${options.jsonOut}\n`);
  } else {
    process.stdout.write(serialized);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
