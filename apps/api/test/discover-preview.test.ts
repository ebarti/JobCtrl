import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { expect, it } from "vitest";

import { callRpc } from "../src/json-rpc-adapter.js";
import { createActionDispatcher } from "../src/local-actions.js";
import { AUTOMATION_PROJECT_DIR } from "../src/python-runtime.js";
import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";
import { workflowRpcFixture } from "./rpc-workflow-fixture.js";

function databaseBytes(dbPath: string): Buffer {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.serialize();
  } finally {
    db.close();
  }
}

it("rejects direct and nested Discover previews before HTTP or registered RPC dispatch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-discover-preview-"));
  const dbPath = path.join(dir, "jobctrl.db");
  const configPath = path.join(dir, "config.json");
  initializeExactDatabase(dbPath);
  const fixture = workflowRpcFixture(dir, dbPath, configPath);
  const app = buildApp({ appDir: dir, dbPath, configPath, actionDispatcher: createActionDispatcher(fixture.adapter) });
  try {
    await app.ready();
    const before = databaseBytes(dbPath);
    for (const payload of [
      { stages: ["discover"], dryRun: true },
      { stages: ["score", "discover"], dryRun: true },
      { stages: ["discover"] }, // HTTP defaults dryRun to true.
    ]) {
      const response = await app.inject({ method: "POST", url: "/v1/pipeline/actions/run-stage", payload });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({
        ok: false,
        error: "discover_preview_unsupported",
        message: "Discover does not support dry runs. Turn off Dry run to start a search.",
      });
    }
    expect(fixture.rows()).toEqual([]);

    for (const params of [
      { stage: "discover" as const, dryRun: true },
      { stage: "score" as const, stages: ["score", "discover"] as ("score" | "discover")[], dryRun: true },
      { stage: "discover" as const, stages: ["score"] as "score"[], dryRun: true },
    ]) {
      const response = await callRpc(fixture.adapter, "run_stage", params);
      expect(response.error).toMatchObject({ code: -32602, message: expect.stringContaining("Discover does not support dry runs") });
    }
    expect(fixture.rows().filter((row) => row.kind === "start")).toEqual([]);
    expect(fixture.rows().find((row) => row.kind === "runtime")).toMatchObject({
      workflowSpecsPath: path.resolve(AUTOMATION_PROJECT_DIR, "src/jobctrl/workflow_specs.py"),
    });
    expect(databaseBytes(dbPath)).toEqual(before);

    const search = await app.inject({
      method: "POST",
      url: "/v1/pipeline/actions/run-stage",
      payload: { stages: ["discover"], dryRun: false, sourceIds: ["jobspy:indeed"] },
    });
    expect(search.statusCode, search.body).toBe(202);
    expect(search.json()).toMatchObject({ command: { stages: ["discover"], dryRun: false } });
    expect(fixture.rows().filter((row) => row.kind === "start")).toHaveLength(1);
    expect(fixture.rows().find((row) => row.kind === "start")).toMatchObject({ input: { source_ids: ["jobspy:indeed"] } });

    const ordinaryConflict = await callRpc(fixture.adapter, "run_stage", {
      stage: "discover", stages: ["score"], dryRun: false,
    });
    expect(ordinaryConflict.error).toBeUndefined();
    expect(fixture.rows().filter((row) => row.kind === "start")).toHaveLength(2);
    expect(fixture.rows().filter((row) => row.kind === "start")[1]).toMatchObject({
      input: { stages: ["score"], dry_run: false },
    });
  } finally {
    await app.close();
    await fixture.adapter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
