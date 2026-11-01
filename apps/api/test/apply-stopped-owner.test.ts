import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { buildApp } from "../src/server.js";

it.each([false, true])("HTTP reset refuses untracked owner exit with intent=%s", async (intended) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-stopped-owner-"));
  fs.writeFileSync(path.join(directory, "owned-owner-probe"), "synthetic apply owner 1173");
  const worker = path.resolve(process.cwd(), "../../workers/automation");
  const python = path.join(worker, ".venv/bin/python");
  const jobId = "90000000-0000-4000-8000-000000000011";
  const environment = { ...process.env, JOBCTRL_DIR: directory, LANGFUSE_DISABLE: "1", OTEL_SDK_DISABLED: "true", PYTHONPATH: `${path.join(worker, "src")}:${worker}` };
  const owner = spawn(python, [path.join(worker, "tests/apply_stopped_owner_probe.py"), directory, jobId, intended ? "api_intent" : "api_none"], { cwd: worker, env: environment });
  const exit = once(owner, "exit");
  let diagnostics = "";
  owner.stderr.on("data", (data) => { diagnostics += String(data); });
  owner.stdout.on("data", (data) => { diagnostics += String(data); });
  const dbPath = path.join(directory, "jobctrl.db");
  const dispatch = vi.fn(async () => { throw new Error("No workflow may be dispatched by recovery/reset"); });
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    const ready = path.join(directory, "owner-ready.json");
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(ready) && owner.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(ready), diagnostics).toBe(true);
    const context = JSON.parse(fs.readFileSync(ready, "utf8")) as { run_id: string };
    app = buildApp({ dbPath, appDir: directory, configPath: path.join(directory, "config.json"), actionDispatcher: dispatch, requireHealthyWorkerForActions: false });
    const skipped = await app.inject({ method: "POST", url: `/v1/jobs/${jobId}/actions/mark-skipped`, payload: {} });
    expect(skipped.statusCode, skipped.body).toBe(200);
    const beforeExit = await app.inject({ method: "POST", url: `/v1/jobs/${jobId}/actions/retry-stage`, payload: { stage: "apply" } });
    expect(beforeExit.statusCode, beforeExit.body).toBe(409);
    const snapshot = () => {
      const db = new Database(dbPath);
      try {
        return { stage: db.prepare("SELECT state,version,attempt_count FROM job_stage_states WHERE stage='apply'").get(),
          materials: db.prepare("SELECT * FROM job_materials_artifacts ORDER BY artifact_id").all(),
          events: db.prepare("SELECT * FROM job_events ORDER BY event_id").all() };
      } finally { db.close(); }
    };
    const stopped = snapshot();
    owner.stdin.end("exit without settlement\n");
    expect((await exit)[0], diagnostics).toBe(0);
    const recovery = spawnSync(python, ["-m", "jobctrl", "apply", "--recover-stopped"], { cwd: worker, env: environment, encoding: "utf8", timeout: 30_000 });
    expect(recovery.status, recovery.stdout + recovery.stderr).toBe(0);
    expect(recovery.stdout).toContain("Recovered 0");
    const after = snapshot();
    expect(after).toEqual(stopped);
    const recoveredDetail = await app.inject({ method: "GET", url: `/v1/jobs/${jobId}` });
    expect(recoveredDetail.statusCode, recoveredDetail.body).toBe(200);
    const reset = await app.inject({ method: "POST", url: `/v1/jobs/${jobId}/actions/retry-stage`, payload: { stage: "apply" } });
    expect(reset.statusCode, reset.body).toBe(409);
    const final = snapshot();
    expect(final).toEqual(after);
    const readback = await app.inject({ method: "GET", url: `/v1/jobs/${jobId}` });
    expect(readback.statusCode, readback.body).toBe(200);
    if (intended) expect(readback.json().applyAudit.hardBlockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "manual_apply_skip" }), expect.objectContaining({ code: "submission_intent_recorded" }),
    ]));
    console.info(JSON.stringify({ job: jobId, run: context.run_id, intended, ownerPid: owner.pid, recovery: recovery.stdout,
      stageBeforeRecovery: stopped.stage, stageAfterRecovery: after.stage, stageAfterReset: final.stage, resetStatus: reset.statusCode,
      eventsBefore: stopped.events.length, eventsAfterRecovery: after.events.length, eventsAfterReset: final.events.length, senderCalls: 0 }));
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    if (owner.exitCode === null) { owner.kill("SIGKILL"); await exit; }
    await app?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);
