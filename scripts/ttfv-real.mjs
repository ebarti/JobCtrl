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
const DEFAULT_INSTALL_COMMAND = "corepack pnpm install:interactive";
const DEFAULT_INIT_COMMAND = "uv --project workers/automation run jobhunter init";
const DEFAULT_STACK_COMMAND = "corepack pnpm dev";
const DEFAULT_WORK_COMMAND_LABEL = "uv --project workers/automation run jobhunter job <redacted-real-job-url> --tailor";

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
  --expected-job-key <key>     Optional canonical job key. Stored as a hash only.
  --install-command <command>  Default: ${DEFAULT_INSTALL_COMMAND}
  --init-command <command>     Default: ${DEFAULT_INIT_COMMAND}
  --stack-command <command>    Default: ${DEFAULT_STACK_COMMAND}
  --output <path>              Measurement record path.
  --skip-install               Do not run the install phase.
  --skip-init                  Do not run the init phase.
  --skip-stack                 Do not start the dev stack.
  --skip-work                  Do not start a real job command.
  --keep-stack                 Leave the spawned dev stack running.

Probe options:
  --expected-job-key <key>     Optional canonical job key. Stored as a hash only.
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
  const installCommand = stringOption(options.installCommand, DEFAULT_INSTALL_COMMAND);
  const initCommand = stringOption(options.initCommand, DEFAULT_INIT_COMMAND);
  const stackCommand = stringOption(options.stackCommand, DEFAULT_STACK_COMMAND);
  const workCommand = resolveWorkCommand(options);

  const record = baseRecord("run", options, { apiBaseUrl, webBaseUrl });
  applyRunGateMetadata(record, options, { installCommand, initCommand, stackCommand, workCommand });
  record.t0 = {
    command: options.skipInstall ? "skipped install phase" : recordCommandLabel("install", installCommand, DEFAULT_INSTALL_COMMAND),
    startedAt: nowIso(),
  };

  let stack = null;
  let work = null;
  try {
    if (!options.skipInstall) {
      await runShellPhase(record, "install", installCommand, recordCommandLabel("install", installCommand, DEFAULT_INSTALL_COMMAND));
    }
    if (!options.skipInit) {
      await runShellPhase(record, "workspace_init", initCommand, recordCommandLabel("workspace init", initCommand, DEFAULT_INIT_COMMAND));
    }
    if (!options.skipStack) {
      stack = startLongRunningPhase(record, "stack_start", stackCommand, recordCommandLabel("stack start", stackCommand, DEFAULT_STACK_COMMAND));
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
  applyProbeMetadata(record, options);
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
  refuseCi();
  const files = options._;
  if (!files.length) {
    throw new Error("summarize requires at least one measurement record path.");
  }
  const thresholdTtfv1Ms = numberOption(options.thresholdTtfv1Ms, DEFAULT_TTFV_1_THRESHOLD_MS);
  const thresholdTtfv2Ms = numberOption(options.thresholdTtfv2Ms, DEFAULT_TTFV_2_THRESHOLD_MS);
  const worstMultiplier = numberOption(options.worstMultiplier, DEFAULT_WORST_MULTIPLIER);
  const records = files.map((file) => ({ file, record: JSON.parse(fs.readFileSync(file, "utf8")) }));
  const evaluations = records.map(({ file, record }) => ({
    file: path.basename(file),
    reasons: gateableRecordRejectionReasons(record),
    record,
  }));
  const accepted = evaluations.filter((evaluation) => evaluation.reasons.length === 0).map((evaluation) => evaluation.record);
  const rejected = evaluations
    .filter((evaluation) => evaluation.reasons.length > 0)
    .map((evaluation) => ({ file: evaluation.file, reasons: evaluation.reasons }));
  const ttfv1Durations = accepted.map((record) => record.probes?.ttfv1?.durationMs).filter(Number.isFinite);
  const ttfv2Durations = accepted.map((record) => record.probes?.ttfv2?.durationMs).filter(Number.isFinite);
  const summary = {
    schemaVersion: SCHEMA_VERSION,
    kind: "jobhunter.realPathTtfvMeasurementSummary",
    generatedAt: nowIso(),
    inputRecords: files.length,
    acceptedRecords: accepted.length,
    rejectedRecords: rejected,
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
    accepted.length >= 3 && rejected.length === 0 && summary.ttfv1.passed && summary.ttfv2.passed ? "passed" : "failed";
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

function gateableRecordRejectionReasons(record) {
  const reasons = [];
  if (!record || typeof record !== "object") return ["record is not an object"];
  if (record.schemaVersion !== SCHEMA_VERSION) reasons.push("schema version mismatch");
  if (record.kind !== "jobhunter.realPathTtfvMeasurement") reasons.push("record kind mismatch");
  if (record.mode !== "run") reasons.push("record is not a run-mode measurement");
  if (record.status !== "passed") reasons.push("record status is not passed");
  if (record.gateable !== true) reasons.push(record.gateableReason || "record is not gateable");
  if (record.policy?.realPathOnly !== true) reasons.push("real-path policy missing");
  if (record.policy?.syntheticDataAllowed !== false) reasons.push("synthetic-data policy missing");
  if (record.policy?.ciAllowed !== false) reasons.push("CI policy missing");
  if (!record.expected?.jobHash) reasons.push("expected job hash missing");
  if (!record.t0?.startedAt || record.t0?.command !== DEFAULT_INSTALL_COMMAND) {
    reasons.push("T0 was not captured on the default install command");
  }
  if (!phaseSucceeded(record, "install", DEFAULT_INSTALL_COMMAND)) reasons.push("default install phase did not succeed");
  if (!phaseSucceeded(record, "workspace_init", DEFAULT_INIT_COMMAND)) reasons.push("default workspace init phase did not succeed");
  if (!phaseHealthy(record, "stack_start", DEFAULT_STACK_COMMAND)) reasons.push("default stack phase was not healthy");
  if (!phaseSucceeded(record, "real_job_pipeline", DEFAULT_WORK_COMMAND_LABEL)) reasons.push("tailor-only real job command did not succeed");
  if (!probeHasExpectedJob(record.probes?.ttfv1, record.expected?.jobHash)) {
    reasons.push("TTFV-1 probe is not bound to the expected job");
  }
  if (!probeHasExpectedJob(record.probes?.ttfv2, record.expected?.jobHash)) {
    reasons.push("TTFV-2 probe is not bound to the expected job");
  }
  if (record.probes?.ttfv1?.ui?.badgeMatched !== true) reasons.push("TTFV-1 UI badge proof missing");
  if (record.probes?.ttfv2?.ui?.linkMatchedSelectedArtifact !== true) reasons.push("TTFV-2 UI link proof missing");
  if (!record.probes?.ttfv2?.api?.selectedArtifactHash) reasons.push("TTFV-2 artifact hash missing");
  if (record.probes?.ttfv2?.artifact?.status !== 200) reasons.push("TTFV-2 artifact HTTP proof missing");
  if (!(Number(record.probes?.ttfv2?.artifact?.byteLength) > 0)) reasons.push("TTFV-2 artifact byte length missing");
  if (record.probes?.ttfv2?.artifact?.magicBytes !== "25504446") reasons.push("TTFV-2 PDF magic-byte proof missing");
  return reasons;
}

function phaseSucceeded(record, name, commandLabel) {
  const phase = (record.phases ?? []).find((entry) => entry?.name === name);
  return phase?.command === commandLabel && phase.exitCode === 0;
}

function phaseHealthy(record, name, commandLabel) {
  const phase = (record.phases ?? []).find((entry) => entry?.name === name);
  return phase?.command === commandLabel && phase.status === "healthy";
}

function probeHasExpectedJob(probe, expectedJobHash) {
  return (
    probe?.status === "passed" &&
    Number.isFinite(probe.durationMs) &&
    probe.api?.selectedJobHash === expectedJobHash
  );
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
        await tryProbe(record, "ttfv1", () => probeTtfv1(page, urls, record.expected?.jobHash ?? null));
      }
      if (record.probes.ttfv2.status !== "passed") {
        await tryProbe(record, "ttfv2", () => probeTtfv2(page, urls, record.expected?.jobHash ?? null));
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

async function probeTtfv1(page, { apiBaseUrl, webBaseUrl }, expectedJobHash) {
  const jobs = await requestJson(apiBaseUrl, "/v1/jobs?page=1&pageSize=100&sort=fit_score&dir=desc");
  const items = Array.isArray(jobs.items) ? jobs.items : [];
  const scored = items.filter((item) => Number.isFinite(item.fitScore));
  const candidate = expectedJobHash
    ? scored.find((item) => stableHash(item.jobKey) === expectedJobHash)
    : scored[0];
  if (!candidate) {
    return {
      ok: false,
      message: expectedJobHash
        ? "The expected job is not queryable through /v1/jobs with a numeric fit score."
        : "No scored job is queryable through /v1/jobs.",
    };
  }
  const jobsUrl = new URL(joinUrl(webBaseUrl, "/jobs"));
  jobsUrl.searchParams.set("q", candidate.jobKey);
  jobsUrl.searchParams.set("sort", "fit_score");
  jobsUrl.searchParams.set("dir", "desc");
  await page.goto(jobsUrl.href, { waitUntil: "domcontentloaded" });
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
        routePattern: "/jobs?q=<expected-job-key>&sort=fit_score&dir=desc",
        selector: "table.jobs-data-grid-table .fit",
        badgeMatched: true,
      },
    },
  };
}

async function probeTtfv2(page, { apiBaseUrl, webBaseUrl }, expectedJobHash) {
  const queue = await requestJson(apiBaseUrl, "/v1/apply/review-queue");
  const items = Array.isArray(queue.items) ? queue.items : [];
  const candidateIndex = items.findIndex((item) => {
    if (typeof item.materialsPreview?.resumePdfArtifactId !== "string") return false;
    return expectedJobHash ? stableHash(item.jobKey) === expectedJobHash : true;
  });
  const candidate = candidateIndex >= 0 ? items[candidateIndex] : null;
  if (!candidate) {
    return {
      ok: false,
      message: expectedJobHash
        ? "The expected job is not present in Apply Review with a tailored resume PDF artifact."
        : "No Apply Review queue item exposes a tailored resume PDF artifact.",
    };
  }
  const artifactId = candidate.materialsPreview.resumePdfArtifactId;
  const reviewUrl = new URL(joinUrl(webBaseUrl, "/apply-review"));
  reviewUrl.searchParams.set("jobKey", candidate.jobKey);
  await page.goto(reviewUrl.href, { waitUntil: "domcontentloaded" });
  const queueItems = page.locator(".apply-review-queue-item");
  if ((await queueItems.count()) > candidateIndex) {
    await queueItems.nth(candidateIndex).click();
  }
  await page.getByRole("link", { name: "open final file" }).first().waitFor({ timeout: 5_000 });
  const links = await page.getByRole("link", { name: "open final file" }).evaluateAll((anchors) =>
    anchors.map((anchor) => anchor.getAttribute("href")).filter(Boolean),
  );
  const encodedArtifactId = encodeURIComponent(artifactId);
  const href = links.find((value) => value.includes(`/v1/artifacts/${encodedArtifactId}/preview.pdf`));
  if (!href) {
    return { ok: false, message: "Apply Review did not render the expected artifact's open-final-file link." };
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
        routePattern: "/apply-review?jobKey=<expected-job-key>",
        linkName: "open final file",
        linkMatchedSelectedArtifact: true,
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

async function runShellPhase(record, name, commandText, commandLabel) {
  const phase = startPhase(record, name, commandLabel);
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

function startLongRunningPhase(record, name, commandText, commandLabel) {
  startPhase(record, name, commandLabel);
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
    return { command: "", recordCommand: "skipped real job command", expectedJobKey: null, gateable: false };
  }
  if (options.workCommand) {
    throw new Error("--work-command is not supported for real-path TTFV; use --job-url so the wrapper can scope probes without recording sensitive command text.");
  }
  if (!options.jobUrl) {
    throw new Error("run requires --job-url or --skip-work.");
  }
  const commandText = `uv --project workers/automation run jobhunter job ${shellQuote(String(options.jobUrl))} --tailor`;
  return {
    command: commandText,
    recordCommand: DEFAULT_WORK_COMMAND_LABEL,
    expectedJobKey: stringOption(options.expectedJobKey, String(options.jobUrl)),
    gateable: true,
  };
}

function applyRunGateMetadata(record, options, { installCommand, initCommand, stackCommand, workCommand }) {
  const expectedJobKey = stringOption(options.expectedJobKey, workCommand.expectedJobKey ?? "");
  record.expected = expectedJobKey ? { jobHash: stableHash(expectedJobKey) } : null;
  const blockers = [];
  if (options.skipInstall) blockers.push("install phase skipped");
  if (options.skipInit) blockers.push("workspace init phase skipped");
  if (options.skipStack) blockers.push("stack start phase skipped");
  if (options.skipWork) blockers.push("real job command skipped");
  if (installCommand !== DEFAULT_INSTALL_COMMAND) blockers.push("custom install command");
  if (initCommand !== DEFAULT_INIT_COMMAND) blockers.push("custom init command");
  if (stackCommand !== DEFAULT_STACK_COMMAND) blockers.push("custom stack command");
  if (!workCommand.gateable) blockers.push("non-default real job command");
  if (!record.expected?.jobHash) blockers.push("expected job hash missing");
  record.gateable = blockers.length === 0;
  record.gateableReason = blockers.length ? blockers.join("; ") : null;
}

function applyProbeMetadata(record, options) {
  const expectedJobKey = stringOption(options.expectedJobKey, "");
  record.expected = expectedJobKey ? { jobHash: stableHash(expectedJobKey) } : null;
  record.gateable = false;
  record.gateableReason = "probe-only record; clean install T0 was not captured";
}

function baseRecord(mode, options, urls) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "jobhunter.realPathTtfvMeasurement",
    mode,
    generatedAt: null,
    gateable: false,
    gateableReason: "not evaluated",
    expected: null,
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
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuCount: os.cpus().length,
    memoryClass: memoryClass(os.totalmem()),
    nodeMajor: process.versions.node.split(".")[0] ?? null,
  };
}

function loadChromium() {
  const requireFromWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
  const playwright = requireFromWeb("@playwright/test");
  return playwright.chromium;
}

function refuseCi() {
  if (process.env.CI) {
    throw new Error("Real-path TTFV measurement is owner-run only and must not run in CI.");
  }
}

function stableHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function recordCommandLabel(label, commandText, defaultCommand) {
  return commandText === defaultCommand ? defaultCommand : `custom ${label} command (not recorded)`;
}

function memoryClass(totalBytes) {
  const gib = totalBytes / (1024 ** 3);
  if (gib < 8) return "<8GiB";
  if (gib < 16) return "8-15GiB";
  if (gib < 32) return "16-31GiB";
  if (gib < 64) return "32-63GiB";
  return "64GiB+";
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
