import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import {
  sanitizedRuntimeEnvironment,
  stopProcessGroup,
  validateLiveWorkerEnvironment,
  waitForCondition,
} from "./runtime-support.mjs";

const require = createRequire(import.meta.url);
const { seedOwnedE2eWorkspace } = require("../fixtures/seed-workspace.cjs");
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const automationProject = path.join(repoRoot, "workers", "automation");
const LIVE_JOB_ID = "abaf847c-43cd-40ad-8dc3-76685694ff29";
const config = validateLiveWorkerEnvironment();
const runtimeEnv = sanitizedRuntimeEnvironment(process.env);
const children = [];
let shuttingDown = false;
let workerPaused = false;
let releaseProvider;
const providerRelease = new Promise((resolve) => { releaseProvider = resolve; });
const state = {
  providerCalls: 0,
  providerWaiting: false,
  providerReleased: false,
  unexpectedProviderCalls: 0,
  workerPaused: false,
  workerResumed: false,
};

fs.mkdirSync(config.evidenceDir, { recursive: true });
const reportPath = path.join(config.evidenceDir, "runtime-summary.json");

function writeJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function authorized(request) {
  return request.headers.authorization === `Bearer ${config.token}`;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const controlServer = http.createServer(async (request, response) => {
  try {
    if (!authorized(request)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/state") {
      writeJson(response, 200, {
        ...state,
        childPids: Object.fromEntries(children.map((item) => [item.name, item.child.pid])),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/resume") {
      const worker = children.find((item) => item.name === "worker")?.child;
      if (!worker?.pid || !workerPaused) {
        writeJson(response, 409, { error: "worker_not_paused" });
        return;
      }
      process.kill(-worker.pid, "SIGCONT");
      workerPaused = false;
      state.workerPaused = false;
      state.workerResumed = true;
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/provider/release") {
      if (!state.providerWaiting || state.providerReleased) {
        writeJson(response, 409, { error: "provider_not_waiting" });
        return;
      }
      state.providerReleased = true;
      releaseProvider();
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/provider/chat") {
      const payload = await readJson(request);
      state.providerCalls += 1;
      if (
        state.providerCalls !== 1 ||
        payload?.operation !== "chat" ||
        payload?.model !== "live-worker-smoke-fixture" ||
        !Array.isArray(payload?.messages)
      ) {
        state.unexpectedProviderCalls += 1;
        writeJson(response, 409, { error: "unexpected_provider_call" });
        return;
      }
      state.providerWaiting = true;
      const released = await Promise.race([
        providerRelease.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 60_000)),
      ]);
      state.providerWaiting = false;
      if (!released) {
        writeJson(response, 504, { error: "provider_release_timeout" });
        return;
      }
      writeJson(response, 200, {
        text:
          "Dear Hiring Manager,\n\n" +
          "I have led platform and security engineering work focused on reliability and incident response. " +
          "I would welcome the opportunity to bring that experience to this role.\n\n" +
          "John Doe\nEND_OF_COVER_LETTER",
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/shutdown") {
      writeJson(response, 202, { ok: true });
      setTimeout(() => void shutdown("control-request"), 0);
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  } catch (error) {
    writeJson(response, 400, {
      error: "invalid_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

function startChild(name, executable, args) {
  const logPath = path.join(config.evidenceDir, `${name}.log`);
  const log = fs.openSync(logPath, "a", 0o600);
  const child = spawn(executable, args, {
    cwd: repoRoot,
    env: runtimeEnv,
    detached: true,
    stdio: ["ignore", log, log],
  });
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const item = { name, child, exit, log };
  children.push(item);
  child.once("error", (error) => {
    if (!shuttingDown) void fail(`${name} failed to start: ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    if (!shuttingDown) void fail(`${name} exited before teardown (${code ?? signal})`);
  });
  return child;
}

async function waitForTcp(port, description) {
  await waitForCondition(
    () =>
      new Promise((resolve) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
        socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
      }),
    { timeoutMs: 30_000, intervalMs: 100, description },
  );
}

function prepareLiveCoverScenario(dbPath) {
  const db = new Database(dbPath);
  try {
    db.transaction(() => {
      db.prepare("DELETE FROM worker_runtime_heartbeats").run();
      const coverIds = db
        .prepare(
          "SELECT artifact_id FROM job_materials_artifacts " +
            "WHERE tenant_id = 'local' AND job_id = ? AND artifact_type IN ('cover_letter', 'cover_letter_pdf')",
        )
        .all(LIVE_JOB_ID)
        .map((row) => row.artifact_id);
      for (const artifactId of coverIds) {
        db.prepare("DELETE FROM job_material_layout_boxes WHERE artifact_id = ?").run(artifactId);
        db.prepare("DELETE FROM artifact_list_projections WHERE artifact_id = ?").run(artifactId);
      }
      db.prepare(
        "DELETE FROM job_materials_artifacts WHERE tenant_id = 'local' AND job_id = ? " +
          "AND artifact_type IN ('cover_letter', 'cover_letter_pdf')",
      ).run(LIVE_JOB_ID);
      db.prepare(
        "DELETE FROM job_artifacts WHERE tenant_id = 'local' AND job_id = ? AND stage = 'cover'",
      ).run(LIVE_JOB_ID);
      db.prepare(
        "UPDATE job_materials SET status = 'resume_approved' " +
          "WHERE tenant_id = 'local' AND job_id = ? AND generation = 1",
      ).run(LIVE_JOB_ID);
      db.prepare(
        "UPDATE jobs SET cover_letter_path = NULL, cover_letter_at = NULL, cover_attempts = 0 " +
          "WHERE tenant_id = 'local' AND job_id = ?",
      ).run(LIVE_JOB_ID);
      db.prepare(
        "UPDATE job_stage_states SET state = 'pending', attempt_count = 0, started_at = NULL, " +
          "finished_at = NULL, duration_ms = NULL, error_code = NULL, error_message = NULL, " +
          "retryable = 1, blocked_by_json = '[]', next_action = NULL, metadata_json = NULL, version = version + 1 " +
          "WHERE tenant_id = 'local' AND job_id = ? AND stage = 'cover'",
      ).run(LIVE_JOB_ID);
      db.prepare(
        "DELETE FROM job_events WHERE tenant_id = 'local' AND job_id = ? AND stage = 'cover'",
      ).run(LIVE_JOB_ID);
    })();
  } finally {
    db.close();
  }
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  controlServer.close();
  const outcomes = {};
  for (const item of [...children].reverse()) {
    outcomes[item.name] = await stopProcessGroup(item.child.pid, {
      paused: item.name === "worker" && workerPaused,
      waitForExit: () => item.exit,
    });
    fs.closeSync(item.log);
  }
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        reason,
        state,
        cleanup: outcomes,
        workspaceHash: path.basename(config.evidenceDir),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  process.exitCode = reason === "control-request" || reason.startsWith("signal:") ? 0 : 1;
}

async function fail(message) {
  if (shuttingDown) return;
  process.stderr.write(`${message}\n`);
  await shutdown(`failure:${message}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void shutdown(`signal:${signal}`));
}

try {
  await new Promise((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(config.ports.JOBCTRL_LIVE_WORKER_CONTROL_PORT, "127.0.0.1", resolve);
  });
  seedOwnedE2eWorkspace(repoRoot);
  prepareLiveCoverScenario(process.env.JOBCTRL_E2E_DB_PATH);

  fs.mkdirSync(path.dirname(process.env.JOBCTRL_TEMPORAL_DB), { recursive: true });
  startChild("temporal", config.temporalBinary, [
    "server",
    "start-dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(config.ports.JOBCTRL_LIVE_WORKER_TEMPORAL_PORT),
    "--ui-ip",
    "127.0.0.1",
    "--ui-port",
    String(config.ports.JOBCTRL_LIVE_WORKER_TEMPORAL_UI_PORT),
    "--ui-disable-news-fetch",
    "--db-filename",
    process.env.JOBCTRL_TEMPORAL_DB,
  ]);
  await waitForTcp(
    config.ports.JOBCTRL_LIVE_WORKER_TEMPORAL_PORT,
    "owned Temporal frontend",
  );

  const worker = startChild("worker", "uv", [
    "--project",
    automationProject,
    "run",
    "--locked",
    "jobctrl",
    "worker",
  ]);
  await waitForCondition(
    () => {
      const db = new Database(process.env.JOBCTRL_E2E_DB_PATH, { readonly: true });
      try {
        return db
          .prepare(
            "SELECT worker_id FROM worker_runtime_heartbeats " +
              "WHERE component = 'temporal-worker' AND app_dir = ? AND db_path = ? " +
              "ORDER BY last_seen_at DESC LIMIT 1",
          )
          .get(config.workspace.appDir, process.env.JOBCTRL_E2E_DB_PATH);
      } finally {
        db.close();
      }
    },
    { timeoutMs: 45_000, intervalMs: 200, description: "real worker heartbeat" },
  );
  process.kill(-worker.pid, "SIGSTOP");
  workerPaused = true;
  state.workerPaused = true;

  startChild("api", "corepack", [
    "pnpm",
    "--filter",
    "@jobctrl/api",
    "exec",
    "tsx",
    "src/main.ts",
  ]);
  await waitForCondition(
    async () => {
      try {
        const response = await fetch(
          `http://127.0.0.1:${config.ports.JOBCTRL_E2E_API_PORT}/v1/health`,
        );
        const body = await response.json();
        return response.ok && body?.ok === true && body?.worker?.status === "healthy";
      } catch {
        return false;
      }
    },
    { timeoutMs: 45_000, intervalMs: 200, description: "real API and worker identity" },
  );
  process.stdout.write(
    `Live-worker runtime ready on API ${config.ports.JOBCTRL_E2E_API_PORT}\n`,
  );
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error));
}
