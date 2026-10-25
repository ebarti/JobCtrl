import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { buildApp } from "../src/server.js";

it.each([
  ["after_intent", "succeeded", "applied"],
  ["lost_ack", "manual", "needs_verification"],
] as const)("HTTP readback retains %s outcome separately from Skip and retry authority", async (mode, status, result) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-late-apply-"));
  const worker = path.resolve(process.cwd(), "../../workers/automation");
  fs.writeFileSync(path.join(directory, "owned-probe"), "synthetic apply 1173");
  const dispatch = vi.fn(async () => { throw new Error("No workflow dispatch is authorized in this fixture"); });
  try {
    const probe = spawnSync(path.join(worker, ".venv/bin/python"), [path.join(worker, "tests/apply_late_settlement_probe.py"), directory, mode], {
      cwd: worker, env: { ...process.env, PYTHONPATH: `${path.join(worker, "src")}:${worker}` },
      encoding: "utf8", timeout: 30_000,
    });
    expect(probe.status, probe.stdout + probe.stderr).toBe(0);
    console.info(probe.stdout);
    const observed = JSON.parse(probe.stdout.trim().split("\n").at(-1)!) as { job_id: string; runs: { run_id: string; status: string; result: string }[] };
    expect(observed.runs).toHaveLength(1);
    expect(observed.runs[0]).toMatchObject({ status, result });
    const dbPath = path.join(directory, "jobctrl.db");
    const db = new Database(dbPath);
    const stageBefore = db.prepare("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'").get(observed.job_id);
    const eventsBefore = db.prepare("SELECT * FROM job_events ORDER BY event_id").all();
    db.close();
    const app = buildApp({ dbPath, appDir: directory, configPath: path.join(directory, "config.json"), actionDispatcher: dispatch, requireHealthyWorkerForActions: false });
    try {
      for (let reload = 0; reload < 2; reload++) {
        const response = await app.inject({ method: "GET", url: `/v1/jobs/${observed.job_id}` });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().applyAudit.state).toBe("blocked");
        expect(response.json().activeApplyRun).toBeNull();
        expect(response.json().applyAudit.hardBlockers).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "manual_apply_skip" }),
          expect.objectContaining({ code: "submission_intent_recorded" }),
        ]));
        expect(response.json().applyAudit.hardBlockers).not.toContainEqual(expect.objectContaining({ code: "apply_run_failed" }));
        const history = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
        expect(history.statusCode, history.body).toBe(200);
        const run = history.json().applyRuns.find((r: {runId: string}) => r.runId === observed.runs[0]!.run_id);
        expect(run.status).toBe(status);
      }
      const reset = await app.inject({ method: "POST", url: `/v1/jobs/${observed.job_id}/actions/retry-stage`, payload: { stage: "apply" } });
      expect(reset.statusCode, reset.body).toBe(409);
      const check = new Database(dbPath);
      try {
        expect(check.prepare("SELECT state,attempt_count,version FROM job_stage_states WHERE job_id=? AND stage='apply'").get(observed.job_id)).toEqual(stageBefore);
        expect(check.prepare("SELECT * FROM job_events ORDER BY event_id").all()).toEqual(eventsBefore);
      } finally { check.close(); }
      expect(dispatch).not.toHaveBeenCalled();
    } finally { await app.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 45_000);
