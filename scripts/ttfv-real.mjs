#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const SCHEMA_VERSION = 1;
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8766";
const DEFAULT_WEB_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_TTFV_1_THRESHOLD_MS = 10 * 60 * 1000;
const DEFAULT_TTFV_2_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_WORST_MULTIPLIER = 1.5;
const DEFAULT_TIMEOUT_MS = DEFAULT_TTFV_2_THRESHOLD_MS * DEFAULT_WORST_MULTIPLIER;
const DEFAULT_POLL_MS = 5_000;

const command = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "help";
const argv = command === "help" ? process.argv.slice(2) : process.argv.slice(3);

try {
  if (command === "run") {
    await runMeasurement(parseArgs(argv));
  } else if (command === "probe") {
    await runProbeOnly(parseArgs(argv));
  } else if (command === "summarize") {
    summarizeRecords(parseArgs(argv));
  } else {
    printHelp();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function printHelp() {
  console.log(`Usage:
  node scripts/ttfv-real.mjs run --job-url <real-job-posting-url> [options]
  node scripts/ttfv-real.mjs probe [options]
  node scripts/ttfv-real.mjs summarize <record...> [--output <summary.json>]

Real-path measurement only. Do not run with synthetic data, fixtures, or CI.

Run options:
  --job-url <url>              Real job posting URL passed to "jobhunter job".
  --work-command <command>     Custom real pipeline command. Stored redacted.
  --install-command <command>  Default: corepack pnpm install:interactive
  --init-command <command>     Default: uv --project workers/automation run jobhunter init
  --stack-command <command>    Default: corepack pnpm dev
  --output <path>              Measurement record path.
  --skip-install               Do not run the install phase.
  --skip-init                  Do not run the init phase.
  --skip-stack                 Do not start the dev stack.
  --skip-work                  Do not start a real job command.
  --keep-stack                 Leave the spawned dev stack running.

Probe options:
  --api-base-url <url>         Default: ${DEFAULT_API_BASE_URL}
  --web-base-url <url>         Default: ${DEFAULT_WEB_BASE_URL}
  --timeout-ms <ms>            Default: ${DEFAULT_TIMEOUT_MS}
  --poll-ms <ms>               Default: ${DEFAULT_POLL_MS}
  --headed                     Show the Playwright browser.
`);
}

function parseArgs(args) {
  const parsed = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      parsed._.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

async function runMeasurement(options) {
  refuseCi(options);
  const apiBaseUrl = stringOption(options.apiBaseUrl, DEFAULT_API_BASE_URL);
  const webBaseUrl = stringOption(options.webBaseUrl, DEFAULT_WEB_BASE_URL);
  const output = stringOption(options.output, defaultOutputPath("ttfv-real"));
  const installCommand = stringOption(options.installCommand, "corepack pnpm install:interactive");
  const initCommand = stringOption(options.initCommand, "uv --project workers/automation run jobhunter init");
  const stackCommand = stringOption(options.stackCommand, "corepack pnpm dev");
  const workCommand = resolveWorkCommand(options);

  const record = baseRecord("run", options, { apiBaseUrl, webBaseUrl });
  record.t0 = {
    command: options.skipInstall ? "skipped install phase" : redactCommand(installCommand),
    startedAt: nowIso(),
  };

  let stack = null;
  let work = null;
  try {
    if (!options.skipInstall) {
      await runShellPhase(record, "install", installCommand);
    }
    if (!options.skipInit) {
      await runShellPhase(record, "workspace_init", initCommand);
    }
    if (!options.skipStack) {
      stack = startLongRunningPhase(record, "stack_start", stackCommand);
      await waitForHealth(apiBaseUrl, numberOption(options.timeoutMs, DEFAULT_TIMEOUT_MS), numberOption(options.pollMs, DEFAULT_POLL_MS));
      finishLongRunningPhase(record, "stack_start", "healthy");
    }
    if (!options.skipWork) {
      work = startChildPhase(record, "real_job_pipeline", workCommand.command, workCommand.recordCommand);
      work.done.then((exit) => {
        finishChildPhase(record, "real_job_pipeline", exit);
      });
    }

    await runProbeLoop(record, { apiBaseUrl, webBaseUrl }, options);

    if (work) {
      const exit = await work.done;
      finishChildPhase(record, "real_job_pipeline", exit);
      if (exit.exitCode !== 0) {
        record.errors.push({
          code: "work_command_failed",
          message: `Real job command exited with ${exit.exitCode}.`,
        });
      }
    }
  } finally {
    if (stack && !options.keepStack) {
      await stopLongRunningProcess(stack.child);
      finishLongRunningPhase(record, "stack_start", "stopped");
    }
    finalizeRecord(record);
    writeJson(output, record);
    console.log(`measurement record: ${output}`);
    if (record.status !== "passed") {
      process.exitCode = 1;
    }
  }
}

async function runProbeOnly(options) {
  refuseCi(options);
  const apiBaseUrl = stringOption(options.apiBaseUrl, DEFAULT_API_BASE_URL);
  const webBaseUrl = stringOption(options.webBaseUrl, DEFAULT_WEB_BASE_URL);
  const output = stringOption(options.output, defaultOutputPath("ttfv-probe"));
  const record = baseRecord("probe", options, { apiBaseUrl, webBaseUrl });
  record.t0 = {
    command: stringOption(options.t0Command, "probe-only; install command not captured"),
    startedAt: stringOption(options.t0, nowIso()),
  };

  try {
    await runProbeLoop(record, { apiBaseUrl, webBaseUrl }, options);
  } finally {
    finalizeRecord(record);
    writeJson(output, record);
    console.log(`measurement record: ${output}`);
    if (record.status !== "passed") {
      process.exitCode = 1;
    }
  }
}

function summarizeRecords(options) {
  const files = options._;
  if (!files.length) {
    throw new Error("summarize requires at least one measurement record path.");
  }
  const thresholdTtfv1Ms = numberOption(options.thresholdTtfv1Ms, DEFAULT_TTFV_1_THRESHOLD_MS);
  const thresholdTtfv2Ms = numberOption(options.thresholdTtfv2Ms, DEFAULT_TTFV_2_THRESHOLD_MS);
  const worstMultiplier = numberOption(options.worstMultiplier, DEFAULT_WORST_MULTIPLIER);
  const records = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  const successful = records.filter((record) => record.status === "passed");
  const ttfv1Durations = successful.map((record) => record.probes?.ttfv1?.durationMs).filter(Number.isFinite);
  const ttfv2Durations = successful.map((record) => record.probes?.ttfv2?.durationMs).filter(Number.isFinite);
  const summary = {
    schemaVersion: SCHEMA_VERSION,
    kind: "jobhunter.realPathTtfvMeasurementSummary",
    generatedAt: nowIso(),
    inputRecords: files.length,
    successfulRecords: successful.length,
    requiredRuns: 3,
    thresholds: {
      ttfv1Ms: thresholdTtfv1Ms,
      ttfv2Ms: thresholdTtfv2Ms,
      worstRunCeilingMultiplier: worstMultiplier,
    },
    ttfv1: summarizeMetric(ttfv1Durations, thresholdTtfv1Ms, worstMultiplier),
    ttfv2: summarizeMetric(ttfv2Durations, thresholdTtfv2Ms, worstMultiplier),
  };
  summary.status =
    successful.length >= 3 && summary.ttfv1.passed && summary.ttfv2.passed ? "passed" : "failed";
  const payload = `${JSON.stringify(summary, null, 2)}\n`;
  if (options.output) {
    writeText(String(options.output), payload);
    console.log(`summary record: ${options.output}`);
  } else {
    process.stdout.write(payload);
  }
  if (summary.status !== "passed") {
    process.exitCode = 1;
  }
}

function summarizeMetric(values, thresholdMs, worstMultiplier) {
  const sorted = [...values].sort((left, right) => left - right);
  const medianMs = sorted.length ? median(sorted) : null;
  const worstMs = sorted.length ? sorted[sorted.length - 1] : null;
  return {
    runCount: sorted.length,
    medianMs,
    worstMs,
    thresholdMs,
    worstCeilingMs: thresholdMs * worstMultiplier,
    passed:
      sorted.length >= 3 &&
      medianMs !== null &&
      worstMs !== null &&
      medianMs <= thresholdMs &&
      worstMs <= thresholdMs * worstMultiplier,
  };
}

function median(sortedValues) {
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle];
  return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

async function runProbeLoop(record, urls, options) {
  const t0Ms = Date.parse(record.t0.startedAt);
  const timeoutMs = numberOption(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollMs = numberOption(options.pollMs, DEFAULT_POLL_MS);
  const deadlineMs = (Number.isFinite(t0Ms) ? t0Ms : Date.now()) + timeoutMs;
  const chromium = loadChromium();
  const browser = await chromium.launch({ headless: !options.headed });
  const page = await browser.newPage();
  try {
    while (Date.now() <= deadlineMs) {
      if (record.probes.ttfv1.status !== "passed") {
        await tryProbe(record, "ttfv1", () => probeTtfv1(page, urls));
      }
      if (record.probes.ttfv2.status !== "passed") {
        await tryProbe(record, "ttfv2", () => probeTtfv2(page, urls));
      }
      if (record.probes.ttfv1.status === "passed" && record.probes.ttfv2.status === "passed") {
        return;
      }
      await sleep(pollMs);
    }
    for (const name of ["ttfv1", "ttfv2"]) {
      if (record.probes[name].status !== "passed") {
        record.probes[name].status = "timeout";
        record.probes[name].lastError = `Timed out after ${timeoutMs}ms from T0.`;
      }
    }
  } finally {
    await browser.close();
  }
}

async function tryProbe(record, name, probe) {
  try {
    const result = await probe();
    if (!result.ok) {
      record.probes[name].lastError = result.message;
      return;
    }
    const stoppedAt = nowIso();
    record.probes[name] = {
      ...record.probes[name],
      ...result.details,
      status: "passed",
      stoppedAt,
      durationMs: Date.parse(stoppedAt) - Date.parse(record.t0.startedAt),
      lastError: null,
    };
  } catch (error) {
    record.probes[name].lastError = error instanceof Error ? error.message : String(error);
  }
}

async function probeTtfv1(page, { apiBaseUrl, webBaseUrl }) {
  const jobs = await requestJson(apiBaseUrl, "/v1/jobs?page=1&pageSize=100&sort=fit_score&dir=desc");
  const items = Array.isArray(jobs.items) ? jobs.items : [];
  const scored = items.filter((item) => Number.isFinite(item.fitScore));
  const candidate = scored[0];
  if (!candidate) {
    return { ok: false, message: "No scored job is queryable through /v1/jobs." };
  }
  await page.goto(joinUrl(webBaseUrl, "/jobs"), { waitUntil: "domcontentloaded" });
  await page.locator("table.jobs-data-grid-table .fit").first().waitFor({ timeout: 5_000 });
  const badgeTexts = await page.locator("table.jobs-data-grid-table .fit").allTextContents();
  const scoreText = String(candidate.fitScore);
  const rendered = badgeTexts.some((text) => text.trim() === scoreText);
  if (!rendered) {
    return { ok: false, message: "A scored job is queryable, but no matching fit-score badge rendered on /jobs." };
  }
  return {
    ok: true,
    details: {
      api: {
        scoredJobsOnFirstPage: scored.length,
        selectedJobHash: stableHash(candidate.jobKey),
        selectedFitScore: candidate.fitScore,
      },
      ui: {
        path: "/jobs",
        selector: "table.jobs-data-grid-table .fit",
        badgeMatched: true,
      },
    },
  };
}

async function probeTtfv2(page, { apiBaseUrl, webBaseUrl }) {
  const queue = await requestJson(apiBaseUrl, "/v1/apply/review-queue");
  const items = Array.isArray(queue.items) ? queue.items : [];
  const candidate = items.find((item) => typeof item.materialsPreview?.resumePdfArtifactId === "string");
  if (!candidate) {
    return { ok: false, message: "No Apply Review queue item exposes a tailored resume PDF artifact." };
  }
  const artifactId = candidate.materialsPreview.resumePdfArtifactId;
  await page.goto(joinUrl(webBaseUrl, "/apply-review"), { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "open final file" }).first().waitFor({ timeout: 5_000 });
  const links = await page.getByRole("link", { name: "open final file" }).evaluateAll((anchors) =>
    anchors.map((anchor) => anchor.getAttribute("href")).filter(Boolean),
  );
  const encodedArtifactId = encodeURIComponent(artifactId);
  const href = links.find((value) => value.includes(`/v1/artifacts/${encodedArtifactId}/preview.pdf`)) ?? links[0];
  if (!href) {
    return { ok: false, message: "Apply Review rendered without an open-final-file link." };
  }
  const pdfUrl = new URL(href, webBaseUrl).href;
  const pdf = await requestBytes(pdfUrl);
  const magic = Buffer.from(pdf.bytes.subarray(0, 4)).toString("utf8");
  if (pdf.status !== 200 || magic !== "%PDF") {
    return {
      ok: false,
      message: `Final-file link did not resolve to a PDF byte stream; status=${pdf.status}, magic=${JSON.stringify(magic)}.`,
    };
  }
  return {
    ok: true,
    details: {
      api: {
        reviewQueueItems: items.length,
        selectedJobHash: stableHash(candidate.jobKey),
        selectedArtifactHash: stableHash(artifactId),
      },
      ui: {
        path: "/apply-review",
        linkName: "open final file",
        linkMatchedSelectedArtifact: href.includes(`/v1/artifacts/${encodedArtifactId}/preview.pdf`),
      },
      artifact: {
        routePattern: "/v1/artifacts/:artifactId/preview.pdf",
        status: pdf.status,
        contentType: pdf.contentType,
        byteLength: pdf.bytes.byteLength,
        magicBytes: "25504446",
      },
    },
  };
}

async function requestJson(baseUrl, pathname) {
  const response = await fetch(joinUrl(baseUrl, pathname), { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${pathname} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function requestBytes(url) {
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    bytes,
  };
}

async function waitForHealth(apiBaseUrl, timeoutMs, pollMs) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    try {
      const health = await requestJson(apiBaseUrl, "/v1/health");
      if (health.ok && health.worker?.status === "healthy") {
        return;
      }
    } catch {
      // keep polling
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for ${apiBaseUrl}/v1/health worker.status=healthy.`);
}

async function runShellPhase(record, name, commandText) {
  const phase = startPhase(record, name, redactCommand(commandText));
  const exit = await spawnShell(commandText);
  phase.endedAt = nowIso();
  phase.durationMs = Date.parse(phase.endedAt) - Date.parse(phase.startedAt);
  phase.exitCode = exit.exitCode;
  phase.signal = exit.signal;
  if (exit.exitCode !== 0) {
    record.errors.push({
      code: "phase_failed",
      phase: name,
      message: `${name} exited with ${exit.exitCode}.`,
    });
    throw new Error(`${name} exited with ${exit.exitCode}.`);
  }
}

function startLongRunningPhase(record, name, commandText) {
  startPhase(record, name, redactCommand(commandText));
  return {
    child: spawn(commandText, {
      shell: true,
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: process.env,
    }),
  };
}

function finishLongRunningPhase(record, name, status) {
  const phase = [...record.phases].reverse().find((entry) => entry.name === name && !entry.endedAt);
  if (!phase) return;
  phase.status = status;
  phase.endedAt = nowIso();
  phase.durationMs = Date.parse(phase.endedAt) - Date.parse(phase.startedAt);
}

function startChildPhase(record, name, commandText, recordCommand) {
  startPhase(record, name, recordCommand);
  const child = spawn(commandText, {
    shell: true,
    stdio: "inherit",
    env: process.env,
  });
  const done = new Promise((resolve) => {
    child.on("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  return { child, done };
}

function finishChildPhase(record, name, exit) {
  const phase = [...record.phases].reverse().find((entry) => entry.name === name && !entry.endedAt);
  if (!phase) return;
  phase.endedAt = nowIso();
  phase.durationMs = Date.parse(phase.endedAt) - Date.parse(phase.startedAt);
  phase.exitCode = exit.exitCode;
  phase.signal = exit.signal;
}

function startPhase(record, name, commandText) {
  const phase = {
    name,
    command: commandText,
    startedAt: nowIso(),
    endedAt: null,
    durationMs: null,
    exitCode: null,
    signal: null,
  };
  record.phases.push(phase);
  return phase;
}

function spawnShell(commandText) {
  const child = spawn(commandText, { shell: true, stdio: "inherit", env: process.env });
  return new Promise((resolve) => {
    child.on("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function stopLongRunningProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    child.kill("SIGINT");
  } else {
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      child.kill("SIGINT");
    }
  }
  await sleep(2_000);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
}

function resolveWorkCommand(options) {
  if (options.skipWork) {
    return { command: "", recordCommand: "skipped real job command" };
  }
  if (options.workCommand) {
    const commandText = String(options.workCommand);
    return { command: commandText, recordCommand: redactCommand(commandText) };
  }
  if (!options.jobUrl) {
    throw new Error("run requires --job-url, --work-command, or --skip-work.");
  }
  const commandText = `uv --project workers/automation run jobhunter job ${shellQuote(String(options.jobUrl))}`;
  return {
    command: commandText,
    recordCommand: "uv --project workers/automation run jobhunter job <redacted-real-job-url>",
  };
}

function baseRecord(mode, options, urls) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "jobhunter.realPathTtfvMeasurement",
    mode,
    generatedAt: null,
    status: "running",
    thresholds: {
      ttfv1Ms: numberOption(options.thresholdTtfv1Ms, DEFAULT_TTFV_1_THRESHOLD_MS),
      ttfv2Ms: numberOption(options.thresholdTtfv2Ms, DEFAULT_TTFV_2_THRESHOLD_MS),
      worstRunCeilingMultiplier: numberOption(options.worstMultiplier, DEFAULT_WORST_MULTIPLIER),
      requiredRuns: 3,
      referenceClass: "owner Apple-silicon macOS machine",
      cadence: "pre-release owner-run only",
    },
    policy: {
      realPathOnly: true,
      syntheticDataAllowed: false,
      ciAllowed: false,
      noLogsCaptured: true,
      privacy: "stores timings, hashes, counts, and artifact byte sizes; omits job titles, URLs, local paths, resumes, credentials, and logs",
    },
    repo: repoIdentity(),
    environment: environmentSnapshot(),
    urls: {
      apiBaseUrl: urls.apiBaseUrl,
      webBaseUrl: urls.webBaseUrl,
    },
    t0: null,
    phases: [],
    probes: {
      ttfv1: { status: "pending", stoppedAt: null, durationMs: null, lastError: null },
      ttfv2: { status: "pending", stoppedAt: null, durationMs: null, lastError: null },
    },
    errors: [],
  };
}

function finalizeRecord(record) {
  record.generatedAt = nowIso();
  const probePass = record.probes.ttfv1.status === "passed" && record.probes.ttfv2.status === "passed";
  const noErrors = record.errors.length === 0;
  record.status = probePass && noErrors ? "passed" : "failed";
}

function repoIdentity() {
  return {
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["branch", "--show-current"]) || "detached",
    dirty: git(["status", "--short"]).trim().length > 0,
  };
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function environmentSnapshot() {
  const cpu = os.cpus()[0];
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuCount: os.cpus().length,
    cpuModel: cpu?.model ?? null,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
  };
}

function loadChromium() {
  const requireFromWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
  const playwright = requireFromWeb("@playwright/test");
  return playwright.chromium;
}

function refuseCi(options) {
  if (process.env.CI && !options.allowCi) {
    throw new Error("Real-path TTFV measurement is owner-run only and must not run in CI.");
  }
}

function stableHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function redactCommand(commandText) {
  return String(commandText)
    .replace(/https?:\/\/[^\s'"]+/gi, "<redacted-url>")
    .replace(/(api[_-]?key|token|secret|password)=([^\s]+)/gi, "$1=<redacted>");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function joinUrl(baseUrl, pathname) {
  return new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;
}

function numberOption(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringOption(value, fallback) {
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultOutputPath(prefix) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(os.homedir(), ".jobhunter", "measurements", `${prefix}-${stamp}.json`);
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
