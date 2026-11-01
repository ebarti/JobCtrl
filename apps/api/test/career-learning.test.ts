import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { CareerLearningResponseSchema } from "@jobctrl/contracts";

import { buildApp } from "../src/server.js";
import { SubprocessJsonRpcAdapter } from "../src/json-rpc-adapter.js";
import { AUTOMATION_PROJECT_DIR } from "../src/python-runtime.js";
import { inspectJobDataPurge } from "../src/job-data-purge.js";

const JOB = "90000000-0000-4000-8000-000000000038";
const DUPLICATE = "90000000-0000-4000-8000-000000000039";
const MISSING = "90000000-0000-4000-8000-000000000040";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function workerRuntime(
  directory: string,
  python: string,
  env: NodeJS.ProcessEnv,
) {
  return {
    id: `owned-career-learning:${directory}`,
    resolve: () => ({
      executable: python,
      argv: ["-m", "tests.career_learning_fixture", "--rpc"],
      cwd: AUTOMATION_PROJECT_DIR,
      env,
    }),
  };
}

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-career-learning-api-"),
  );
  const dbPath = path.join(directory, "jobctrl.db");
  const python = path.join(AUTOMATION_PROJECT_DIR, ".venv/bin/python");
  const env = {
    ...process.env,
    JOBCTRL_DIR: directory,
    JOBCTRL_DB_PATH: dbPath,
    JOBCTRL_CONFIG_PATH: path.join(directory, "config.json"),
    LANGFUSE_DISABLE: "1",
  };
  const seeded = spawnSync(
    python,
    [
      "-m",
      "tests.career_learning_fixture",
      dbPath,
      path.join(directory, "initial.json"),
    ],
    { cwd: AUTOMATION_PROJECT_DIR, env, encoding: "utf8" },
  );
  expect(seeded.status, seeded.stderr).toBe(0);
  fs.writeFileSync(
    path.join(directory, ".career-learning-test"),
    "Owned synthetic sources and model port",
  );
  const worker = new SubprocessJsonRpcAdapter({
    appDir: directory,
    pythonRuntime: workerRuntime(directory, python, env),
  });
  const app = buildApp({
    appDir: directory,
    dbPath,
    configPath: path.join(directory, "config.json"),
    providerDispatcher: worker,
  });
  cleanup.push(async () => {
    await app.close();
    await worker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    app,
    worker,
    directory,
    dbPath,
    runtime: workerRuntime(directory, python, env),
    initial: CareerLearningResponseSchema.parse(
      JSON.parse(fs.readFileSync(path.join(directory, "initial.json"), "utf8")),
    ),
  };
}

describe("selected cohort and milestone HTTP / registered RPC / SQLite path", () => {
  it("retains cited sources, explicit choices, completion history and profile authority across reload", async () => {
    const { app, worker, dbPath, directory, runtime, initial } = fixture();
    const read = await app.inject({
      method: "GET",
      url: "/v1/evidence-map/learning",
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual(initial);
    const cohort = initial.cohorts[0]!;
    expect(cohort.snapshot).toMatchObject({
      cohortSize: 3,
      analyzedCount: 1,
      missingDescriptions: [MISSING],
      duplicateIdentities: [[JOB, DUPLICATE]],
    });
    expect(initial.milestones).toEqual([]);
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/evidence-map/learning",
      payload: {
        action: "update",
        milestoneId: "foreign",
        expectedRevision: 1,
        status: "completed",
        completionEvidence: "",
      },
    });
    expect(invalid.statusCode).toBe(400);
    const chosen = await app.inject({
      method: "POST",
      url: "/v1/evidence-map/learning",
      payload: {
        action: "choose",
        cohortId: cohort.cohortId,
        expectedRevision: cohort.revision,
        determinationId: cohort.determinationId,
        proposalId: "practice",
      },
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    const milestone = CareerLearningResponseSchema.parse(chosen.json())
      .milestones[0]!;
    expect(milestone.status).toBe("planned");
    const completed = await app.inject({
      method: "POST",
      url: "/v1/evidence-map/learning",
      payload: {
        action: "update",
        milestoneId: milestone.milestoneId,
        expectedRevision: 1,
        status: "completed",
        completionEvidence: "Private owned exercise report",
      },
    });
    expect(completed.statusCode, completed.body).toBe(200);
    const saved = CareerLearningResponseSchema.parse(completed.json());
    expect(saved.milestones[0]!.history.map((item) => item.status)).toEqual([
      "completed",
      "planned",
    ]);
    expect(saved.cohorts[0]!.comparison).toEqual(cohort.comparison);
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/evidence-map/learning",
      payload: {
        action: "update",
        milestoneId: milestone.milestoneId,
        expectedRevision: 1,
        status: "planned",
        completionEvidence: "",
      },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json().message).toBe("revision_conflict");
    const db = new Database(dbPath);
    expect(
      db
        .prepare(
          "SELECT user_confirmed FROM candidate_profile_achievement_evidence WHERE evidence_id='unconfirmed'",
        )
        .get(),
    ).toMatchObject({ user_confirmed: 0 });
    expect(db.prepare("SELECT version FROM candidate_profiles").get()).toEqual({
      version: 1,
    });
    expect(
      inspectJobDataPurge({ appDir: path.dirname(dbPath) })
        .retainedReferenceRows.career_learning_records,
    ).toBe(4);
    db.close();
    const activity = await app.inject({ method: "GET", url: "/v1/activity" });
    expect(activity.body).not.toContain("Private owned exercise report");
    await worker.close();
    // A new adapter instance reconstructs state exclusively from canonical storage.
    const reopenedWorker = new SubprocessJsonRpcAdapter({
      appDir: directory,
      pythonRuntime: runtime,
    });
    const reopened = buildApp({
      appDir: directory,
      dbPath,
      configPath: path.join(directory, "config.json"),
      providerDispatcher: reopenedWorker,
    });
    try {
      const persisted = await reopened.inject({
        method: "GET",
        url: "/v1/evidence-map/learning",
      });
      expect(persisted.statusCode, persisted.body).toBe(200);
      expect(CareerLearningResponseSchema.parse(persisted.json())).toEqual(
        saved,
      );
    } finally {
      await reopened.close();
      await reopenedWorker.close();
    }
  });

  it("keeps the accepted comparison after a provider failure and marks changed sources", async () => {
    const { app, dbPath, directory, initial } = fixture();
    const cohort = initial.cohorts[0]!;
    const db = new Database(dbPath);
    db.prepare(
      "UPDATE jobs SET description=description || ' New source revision.' WHERE job_id=?",
    ).run(JOB);
    db.close();
    fs.writeFileSync(
      path.join(directory, ".career-learning-provider-failure"),
      "Owned synthetic provider failure",
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/evidence-map/learning",
      payload: {
        action: "compare",
        cohortId: cohort.cohortId,
        expectedRevision: cohort.revision,
        title: cohort.title,
        asOf: cohort.asOf,
        aspirations: cohort.aspirations,
        jobIds: cohort.jobIds,
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().message).toBe("provider_error");
    const retained = await app.inject({
      method: "GET",
      url: "/v1/evidence-map/learning",
    });
    expect(retained.statusCode, retained.body).toBe(200);
    const state = CareerLearningResponseSchema.parse(retained.json());
    expect(state.cohorts[0]!.determinationId).toBe(cohort.determinationId);
    expect(state.cohorts[0]!.staleReasons).toEqual(["postings_changed"]);
    expect(state.cohorts[0]!.lastAttempt?.failureCode).toBe("provider_error");
  });
});
