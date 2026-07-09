#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = 1;
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8766";
const DEFAULT_WEB_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_TTFV_1_THRESHOLD_MS = 10 * 60 * 1000;
const DEFAULT_TTFV_2_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_WORST_MULTIPLIER = 1.5;
const DEFAULT_TIMEOUT_MS = DEFAULT_TTFV_2_THRESHOLD_MS * DEFAULT_WORST_MULTIPLIER;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_INSTALL_COMMAND = "scripts/install";
const DEFAULT_INIT_COMMAND = "uv --project workers/automation run jobctrl init";
const DEFAULT_STACK_COMMAND = "corepack pnpm dev";
const DEFAULT_DISCOVERY_LIMIT = 1;
const DEFAULT_WORKERS = 1;
const DEFAULT_WORK_COMMAND_LABEL =
  "uv --project workers/automation run jobctrl run discover score tailor --limit 1 --workers 1";
const ALL_JOB_VISIBILITY_FILTER = "all";

if (isMainModule()) {
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
}

function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

function printHelp() {
  console.log(`Usage:
  node scripts/ttfv-real.mjs run [options]
  node scripts/ttfv-real.mjs probe [options]
  node scripts/ttfv-real.mjs summarize <record...> [--output <summary.json>]

Real-path measurement only. Do not run with synthetic data, fixtures, or CI.

Run options:
  --discovery-limit <n>        Default: ${DEFAULT_DISCOVERY_LIMIT}
  --workers <n>                Default: ${DEFAULT_WORKERS}
  --expected-job-key <key>     Optional probe binding key. Stored as a hash only.
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
  applyRunGateMetadata(record, options, {
    installCommand,
    initCommand,
    stackCommand,
    workCommand,
    apiBaseUrl,
    webBaseUrl,
  });
  record.t0 = {
    command: options.skipInstall ? "skipped install phase" : recordCommandLabel("install", installCommand, DEFAULT_INSTALL_COMMAND),
    startedAt: nowIso(),
  };

  let stack = null;
  let work = null;
  let workExit = null;
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
      await captureBaselineJobs(record, apiBaseUrl);
    }
    if (!options.skipWork) {
      work = startChildPhase(record, "real_job_pipeline", workCommand.command, workCommand.recordCommand);
      work.done.then((exit) => {
        workExit = exit;
        finishChildPhase(record, "real_job_pipeline", exit);
      });
    }

    await runProbeLoop(record, { apiBaseUrl, webBaseUrl }, options, () => {
      if (!workExit || workExit.exitCode === 0) return null;
      return `Real job command exited with ${workExit.exitCode} before both stop conditions passed.`;
    });

    if (work) {
      const exit = await work.done;
      workExit = exit;
      finishChildPhase(record, "real_job_pipeline", exit);
      if (exit.exitCode !== 0) {
        record.errors.push({
          code: "work_command_failed",
          message: `Real job command exited with ${exit.exitCode}.`,
        });
      }
    }
  } catch (error) {
    const message = errorMessage(error);
    record.errors.push({
      code: "measurement_failed",
      message,
    });
    failPendingProbes(record, message);
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
  const records = files.map((file) => ({ file, record: JSON.parse(fs.readFileSync(file, "utf8")) }));
  const summary = summarizeMeasurementRecords(records, options);
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

export function summarizeMeasurementRecords(records, options = {}) {
  const thresholdTtfv1Ms = DEFAULT_TTFV_1_THRESHOLD_MS;
  const thresholdTtfv2Ms = DEFAULT_TTFV_2_THRESHOLD_MS;
  const worstMultiplier = DEFAULT_WORST_MULTIPLIER;
  const configurationErrors = summaryConfigurationErrors(options);
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
    kind: "jobctrl.realPathTtfvMeasurementSummary",
    generatedAt: nowIso(),
    inputRecords: records.length,
    acceptedRecords: accepted.length,
    rejectedRecords: rejected,
    configurationErrors,
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
    accepted.length >= 3 &&
    rejected.length === 0 &&
    configurationErrors.length === 0 &&
    summary.ttfv1.passed &&
    summary.ttfv2.passed
      ? "passed"
      : "failed";
  return summary;
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

function summaryConfigurationErrors(options) {
  const rejectedOptions = [];
  if (options.thresholdTtfv1Ms !== undefined) rejectedOptions.push("--threshold-ttfv1-ms");
  if (options.thresholdTtfv2Ms !== undefined) rejectedOptions.push("--threshold-ttfv2-ms");
  if (options.worstMultiplier !== undefined) rejectedOptions.push("--worst-multiplier");
  return rejectedOptions.length
    ? [`owner thresholds are fixed; unsupported summary override(s): ${rejectedOptions.join(", ")}`]
    : [];
}

export function gateableRecordRejectionReasons(record) {
  const reasons = [];
  if (!record || typeof record !== "object") return ["record is not an object"];
  if (record.schemaVersion !== SCHEMA_VERSION) reasons.push("schema version mismatch");
  if (record.kind !== "jobctrl.realPathTtfvMeasurement") reasons.push("record kind mismatch");
  if (record.mode !== "run") reasons.push("record is not a run-mode measurement");
  if (record.status !== "passed") reasons.push("record status is not passed");
  if (record.gateable !== true) reasons.push(record.gateableReason || "record is not gateable");
  if (record.policy?.realPathOnly !== true) reasons.push("real-path policy missing");
  if (record.policy?.syntheticDataAllowed !== false) reasons.push("synthetic-data policy missing");
  if (record.policy?.ciAllowed !== false) reasons.push("CI policy missing");
  if (record.urls?.apiBaseUrl !== DEFAULT_API_BASE_URL) reasons.push("non-default API probe URL");
  if (record.urls?.webBaseUrl !== DEFAULT_WEB_BASE_URL) reasons.push("non-default web probe URL");
  if (!recordUsesOwnerThresholds(record)) reasons.push("owner TTFV thresholds missing or overridden");
  const measurementJobHash = measuredJobHash(record);
  if (!measurementJobHash) reasons.push("measurement job hash missing");
  if (!record.baseline?.capturedAt) reasons.push("pre-work discovery baseline missing");
  if (record.baseline?.visibilityFilter !== ALL_JOB_VISIBILITY_FILTER) {
    reasons.push("pre-work discovery baseline did not include all job visibility states");
  }
  if (!Array.isArray(record.baseline?.jobHashes)) {
    reasons.push("pre-work discovery baseline hashes missing");
  } else if (record.baseline.jobHashes.includes(measurementJobHash)) {
    reasons.push("measurement job was already present in the pre-work baseline");
  }
  if (!record.t0?.startedAt || record.t0?.command !== DEFAULT_INSTALL_COMMAND) {
    reasons.push("T0 was not captured on the default install command");
  }
  if (!phaseSucceeded(record, "install", DEFAULT_INSTALL_COMMAND)) reasons.push("default install phase did not succeed");
  if (!phaseSucceeded(record, "workspace_init", DEFAULT_INIT_COMMAND)) reasons.push("default workspace init phase did not succeed");
  if (!phaseHealthy(record, "stack_start", DEFAULT_STACK_COMMAND)) reasons.push("default stack phase was not healthy");
  if (!phaseSucceeded(record, "real_job_pipeline", DEFAULT_WORK_COMMAND_LABEL)) {
    reasons.push("discovery-inclusive real job command did not succeed");
  }
  if (record.probes?.ttfv1?.api?.discoveredAfterT0 !== true) {
    reasons.push("TTFV-1 job was not proven to be discovered after T0");
  }
  const selectedDiscoveredAt = record.probes?.ttfv1?.api?.selectedDiscoveredAt;
  if (!isTimestampAtOrAfter(selectedDiscoveredAt, record.t0?.startedAt)) {
    reasons.push("TTFV-1 selected job discoveredAt is missing or before T0");
  }
  if (record.probes?.ttfv1?.api?.realDiscoverySource !== true) {
    reasons.push("TTFV-1 real discovery source proof missing");
  }
  if (
    !record.probes?.ttfv1?.api?.selectedDiscoverySourceHash &&
    !record.probes?.ttfv1?.api?.selectedSourceHash &&
    !record.probes?.ttfv1?.api?.selectedPostingSourceHash
  ) {
    reasons.push("TTFV-1 discovery source hash missing");
  }
  if (!probeHasMeasurementJob(record.probes?.ttfv1, measurementJobHash)) {
    reasons.push("TTFV-1 probe is not bound to the measurement job");
  }
  if (!probeHasMeasurementJob(record.probes?.ttfv2, measurementJobHash)) {
    reasons.push("TTFV-2 probe is not bound to the measurement job");
  }
  if (record.probes?.ttfv1?.ui?.selectedJobRendered !== true) reasons.push("TTFV-1 selected-job UI proof missing");
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

function recordUsesOwnerThresholds(record) {
  return (
    record.thresholds?.ttfv1Ms === DEFAULT_TTFV_1_THRESHOLD_MS &&
    record.thresholds?.ttfv2Ms === DEFAULT_TTFV_2_THRESHOLD_MS &&
    record.thresholds?.worstRunCeilingMultiplier === DEFAULT_WORST_MULTIPLIER &&
    record.thresholds?.requiredRuns === 3
  );
}

function measuredJobHash(record) {
  return record.expected?.jobHash ?? record.probes?.ttfv1?.api?.selectedJobHash ?? null;
}

function probeHasMeasurementJob(probe, jobHash) {
  return (
    probe?.status === "passed" &&
    Number.isFinite(probe.durationMs) &&
    probe.api?.selectedJobHash === jobHash
  );
}

function median(sortedValues) {
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle];
  return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

async function runProbeLoop(record, urls, options, shouldAbort = null) {
  const t0Ms = Date.parse(record.t0.startedAt);
  const timeoutMs = numberOption(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollMs = numberOption(options.pollMs, DEFAULT_POLL_MS);
  const deadlineMs = (Number.isFinite(t0Ms) ? t0Ms : Date.now()) + timeoutMs;
  const chromium = loadChromium();
  const browser = await chromium.launch({ headless: !options.headed });
  const page = await browser.newPage();
  try {
    let attempted = false;
    while (!attempted || Date.now() <= deadlineMs) {
      attempted = true;
      const abortMessage = typeof shouldAbort === "function" ? shouldAbort() : null;
      if (abortMessage) {
        failPendingProbes(record, abortMessage);
        return;
      }
      const t0StartedAt = record.t0.startedAt;
      const expectedJobHash = record.expected?.jobHash ?? null;
      const ttfv1JobHash = record.probes.ttfv1.api?.selectedJobHash ?? null;
      const ttfv2JobHash = expectedJobHash ?? ttfv1JobHash;
      if (record.probes.ttfv1.status !== "passed") {
        await tryProbe(record, "ttfv1", () => probeTtfv1(page, urls, expectedJobHash, baselineHashSet(record), t0StartedAt));
      }
      if (record.probes.ttfv2.status !== "passed") {
        if (ttfv2JobHash) {
          await tryProbe(record, "ttfv2", () => probeTtfv2(page, urls, ttfv2JobHash));
        } else {
          record.probes.ttfv2.lastError = "Waiting for TTFV-1 to bind the discovered measurement job.";
        }
      }
      if (record.probes.ttfv1.status === "passed" && record.probes.ttfv2.status === "passed") {
        return;
      }
      if (Date.now() > deadlineMs) {
        break;
      }
      await sleep(pollMs);
    }
    for (const name of ["ttfv1", "ttfv2"]) {
      if (record.probes[name].status !== "passed") {
        record.probes[name].status = "timeout";
        const previous = record.probes[name].lastError;
        record.probes[name].lastError = previous
          ? `Timed out after ${timeoutMs}ms from T0. Last observed failure: ${previous}`
          : `Timed out after ${timeoutMs}ms from T0.`;
      }
    }
  } finally {
    await browser.close();
  }
}

function failPendingProbes(record, message) {
  for (const name of ["ttfv1", "ttfv2"]) {
    if (record.probes[name].status !== "passed") {
      record.probes[name].status = "failed";
      record.probes[name].lastError = message;
    }
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

async function probeTtfv1(page, { apiBaseUrl, webBaseUrl }, expectedJobHash, baselineHashes, t0StartedAt) {
  const items = await requestAllJobs(apiBaseUrl, "fit_score", "desc");
  const scored = items.filter((item) => Number.isFinite(item.fitScore));
  const candidate = expectedJobHash
    ? scored.find((item) => stableHash(item.jobKey) === expectedJobHash)
    : scored.find(
        (item) =>
          !baselineHashes.has(stableHash(item.jobKey)) &&
          isTimestampAtOrAfter(item.discoveredAt, t0StartedAt) &&
          discoveryProvenance(item).realDiscoverySource,
      );
  if (!candidate) {
    return {
      ok: false,
      message: expectedJobHash
        ? "The measurement job is not queryable through /v1/jobs with a numeric fit score."
        : "No post-T0 real-discovery scored job is queryable through /v1/jobs.",
    };
  }
  const provenance = discoveryProvenance(candidate);
  const discoveredAfterT0 = isTimestampAtOrAfter(candidate.discoveredAt, t0StartedAt);
  if (baselineHashes.has(stableHash(candidate.jobKey))) {
    return { ok: false, message: "The selected scored job was already present in the pre-work baseline." };
  }
  if (!discoveredAfterT0) {
    return { ok: false, message: "The selected scored job does not have a discoveredAt timestamp after T0." };
  }
  if (!provenance.realDiscoverySource) {
    return { ok: false, message: "The selected scored job does not expose real discovery source provenance." };
  }
  const jobsUrl = new URL(joinUrl(webBaseUrl, "/jobs"));
  jobsUrl.searchParams.set("q", candidate.url || candidate.title || candidate.company || candidate.jobKey);
  jobsUrl.searchParams.set("sort", "fit_score");
  jobsUrl.searchParams.set("dir", "desc");
  await page.goto(jobsUrl.href, { waitUntil: "domcontentloaded" });
  const table = page.locator("table.jobs-data-grid-table");
  await table.locator(".fit").first().waitFor({ timeout: 5_000 });
  const tableText = normalizeText(await table.innerText());
  const rowMatched =
    textMatchesIfPresent(tableText, candidate.title) &&
    textMatchesIfPresent(tableText, candidate.company);
  if (!rowMatched) {
    return { ok: false, message: "A scored job is queryable, but the selected job did not render on /jobs." };
  }
  const badgeTexts = await table.locator(".fit").allTextContents();
  const scoreText = String(candidate.fitScore);
  const rendered = badgeTexts.some((text) => text.trim() === scoreText);
  if (!rendered) {
    return { ok: false, message: "A scored job is queryable, but no matching fit-score badge rendered on /jobs." };
  }
  return {
    ok: true,
    details: {
      api: {
        scoredJobsQueryable: scored.length,
        selectedJobHash: stableHash(candidate.jobKey),
        selectedFitScore: candidate.fitScore,
        selectedDiscoveredAt: candidate.discoveredAt,
        selectedDiscoverySourceHash: provenance.discoverySourceHash,
        selectedSourceHash: provenance.sourceHash,
        selectedPostingSourceHash: provenance.postingSourceHash,
        realDiscoverySource: provenance.realDiscoverySource,
        discoveredAfterT0,
      },
      ui: {
        routePattern: "/jobs?q=<measurement-job-search-token>&sort=fit_score&dir=desc",
        selector: "table.jobs-data-grid-table .fit",
        selectedJobRendered: true,
        badgeMatched: true,
      },
    },
  };
}

function textMatchesIfPresent(haystack, needle) {
  return !needle || haystack.includes(normalizeText(String(needle)));
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
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
        ? "The measurement job is not present in Apply Review with a tailored resume PDF artifact."
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
        routePattern: "/apply-review?jobKey=<measurement-job-key>",
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

async function requestAllJobs(apiBaseUrl, sort, dir, filters = {}) {
  const pageSize = 200;
  const first = await requestJobsPage(apiBaseUrl, { page: 1, pageSize, sort, dir, ...filters });
  const items = Array.isArray(first.items) ? [...first.items] : [];
  const pages = Number(first.pagination?.pages ?? 1);
  for (let page = 2; page <= pages; page += 1) {
    const next = await requestJobsPage(apiBaseUrl, { page, pageSize, sort, dir, ...filters });
    if (Array.isArray(next.items)) items.push(...next.items);
  }
  return items;
}

async function requestJobsPage(apiBaseUrl, params) {
  const url = new URL(joinUrl(apiBaseUrl, "/v1/jobs"));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return requestJson(url.origin, `${url.pathname}${url.search}`);
}

async function captureBaselineJobs(record, apiBaseUrl) {
  const jobs = await requestAllJobs(apiBaseUrl, "discovered_at", "desc", { deleted: ALL_JOB_VISIBILITY_FILTER });
  record.baseline = {
    capturedAt: nowIso(),
    visibilityFilter: ALL_JOB_VISIBILITY_FILTER,
    jobCount: jobs.length,
    jobHashes: jobs.map((job) => stableHash(job.jobKey)).sort(),
  };
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
    throw new Error(
      "--work-command is not supported for gateable TTFV; use the default discovery-inclusive command and configure one real discovery role/source.",
    );
  }
  if (options.jobUrl) {
    throw new Error("--job-url is not supported for gateable TTFV; configure one real discovery role/source and let discovery select the measured job.");
  }
  const discoveryLimit = numberOption(options.discoveryLimit, DEFAULT_DISCOVERY_LIMIT);
  const workers = numberOption(options.workers, DEFAULT_WORKERS);
  if (discoveryLimit !== DEFAULT_DISCOVERY_LIMIT || workers !== DEFAULT_WORKERS) {
    return {
      command: `uv --project workers/automation run jobctrl run discover score tailor --limit ${shellQuote(String(discoveryLimit))} --workers ${shellQuote(String(workers))}`,
      recordCommand: "custom discovery-inclusive real job command (not recorded)",
      expectedJobKey: stringOption(options.expectedJobKey, ""),
      gateable: false,
    };
  }
  return {
    command: DEFAULT_WORK_COMMAND_LABEL,
    recordCommand: DEFAULT_WORK_COMMAND_LABEL,
    expectedJobKey: stringOption(options.expectedJobKey, ""),
    gateable: true,
  };
}

function applyRunGateMetadata(record, options, { installCommand, initCommand, stackCommand, workCommand, apiBaseUrl, webBaseUrl }) {
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
  if (apiBaseUrl !== DEFAULT_API_BASE_URL) blockers.push("non-default API probe URL");
  if (webBaseUrl !== DEFAULT_WEB_BASE_URL) blockers.push("non-default web probe URL");
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
    kind: "jobctrl.realPathTtfvMeasurement",
    mode,
    generatedAt: null,
    gateable: false,
    gateableReason: "not evaluated",
    expected: null,
    baseline: {
      capturedAt: null,
      visibilityFilter: null,
      jobCount: null,
      jobHashes: [],
    },
    status: "running",
    thresholds: {
      ttfv1Ms: DEFAULT_TTFV_1_THRESHOLD_MS,
      ttfv2Ms: DEFAULT_TTFV_2_THRESHOLD_MS,
      worstRunCeilingMultiplier: DEFAULT_WORST_MULTIPLIER,
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

function baselineHashSet(record) {
  return new Set(Array.isArray(record.baseline?.jobHashes) ? record.baseline.jobHashes : []);
}

export function discoveryProvenance(job) {
  const discoverySource = cleanSource(job.discoverySource);
  const source = cleanSource(job.source);
  const postingSource = cleanSource(job.postingSource);
  const values = [discoverySource, source, postingSource].filter(Boolean);
  const realDiscoverySource = values.length > 0 && values.every((value) => !looksNonRealDiscoverySource(value));
  return {
    discoverySourceHash: discoverySource ? stableHash(discoverySource) : null,
    sourceHash: source ? stableHash(source) : null,
    postingSourceHash: postingSource ? stableHash(postingSource) : null,
    realDiscoverySource,
  };
}

function cleanSource(value) {
  const cleaned = String(value ?? "").trim();
  return cleaned || null;
}

function looksNonRealDiscoverySource(value) {
  const normalized = value.trim().toLowerCase();
  if (["unknown", "n/a", "na", "none", "null", "undefined"].includes(normalized)) {
    return true;
  }
  return /(?:synthetic|fixture|sample|seed|test|qa|manual)/i.test(value);
}

function isTimestampAtOrAfter(value, reference) {
  const valueMs = Date.parse(String(value ?? ""));
  const referenceMs = Date.parse(String(reference ?? ""));
  return Number.isFinite(valueMs) && Number.isFinite(referenceMs) && valueMs >= referenceMs;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
  return path.join(os.homedir(), ".jobctrl", "measurements", `${prefix}-${stamp}.json`);
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
