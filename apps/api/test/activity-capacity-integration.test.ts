import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { PipelineOperationsSnapshotSchema } from "@jobctrl/contracts";
import { expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

it("reports actual worker admission through Operations while held calls recover", async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "jobctrl-capacity-api-"));
  const dbPath = path.join(directory, "jobctrl.db");
  const configPath = path.join(directory, "config.json");
  initializeExactDatabase(dbPath);
  fs.writeFileSync(configPath, "{}");
  const forbidden = async (): Promise<never> => { throw new Error("Unexpected credential or provider access"); };
  const app = buildApp({
    dbPath, configPath, appDir: directory,
    pythonRuntime: { id: "integration-deny-python", resolve: () => { throw new Error("Unexpected API Python subprocess"); } },
    credentialStore: { list: forbidden, set: forbidden, delete: forbidden, applyBatch: forbidden },
    providerDispatcher: { call: forbidden, close: async () => undefined },
  });
  const python = process.env["JOBCTRL_MIGRATION_TEST_PYTHON"] ?? path.join(root, "workers/automation/.venv/bin/python");
  const child = spawn(python, [path.join(root, "workers/automation/tests/activity_capacity_api_fixture.py"), dbPath], {
    cwd: root,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: directory,
      USERPROFILE: directory,
      JOBCTRL_DIR: directory,
      JOBCTRL_CONFIG_PATH: configPath,
      PYTHONPATH: path.join(root, "workers/automation/src"),
      PYTHONUNBUFFERED: "1",
      LANGFUSE_DISABLE: "1",
      OTEL_SDK_DISABLED: "true",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_000); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = once(child, "exit");
  void exited.catch(() => undefined);
  async function phase(expected: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        lines.next(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out awaiting ${expected}: ${stderr}`)), 10_000); }),
      ]);
      if (result.done) throw new Error(`Worker exited before ${expected}: ${stderr}`);
      const value = JSON.parse(result.value) as { phase: string; heldStages?: number; heldControls?: number };
      expect(value.phase).toBe(expected);
      return value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function readCapacity() {
    const response = await app.inject({ method: "GET", url: "/v1/pipeline/operations" });
    expect(response.statusCode, response.body).toBe(200);
    const snapshot = PipelineOperationsSnapshotSchema.parse(response.json());
    expect(snapshot.capacity.status).toBe("available");
    if (snapshot.capacity.status !== "available") throw new Error("Expected available capacity");
    return snapshot.capacity;
  }

  try {
    expect(await phase("blocked")).toMatchObject({ heldStages: 3, heldControls: 1 });
    const blocked = await readCapacity();
    expect(blocked.availableSlots).toBe(4);
    expect(blocked.blockingExecutor).toEqual({
      acceptingWorkers: 0, refusingWorkers: 1, unknownWorkers: 0,
      unfinishedRetiredGenerations: 3, unfinishedRetiredCalls: 3,
      controlAcceptingWorkers: 1, controlRefusingWorkers: 0, controlUnknownWorkers: 0,
      controlUnfinishedCalls: 1,
    });

    child.stdin.write("recover\n");
    expect(await phase("recovered")).toMatchObject({ heldStages: 2, heldControls: 1 });
    const recovered = await readCapacity();
    expect(recovered.blockingExecutor).toEqual({
      acceptingWorkers: 1, refusingWorkers: 0, unknownWorkers: 0,
      unfinishedRetiredGenerations: 2, unfinishedRetiredCalls: 2,
      controlAcceptingWorkers: 1, controlRefusingWorkers: 0, controlUnknownWorkers: 0,
      controlUnfinishedCalls: 1,
    });

    child.stdin.write("legacy\n");
    await phase("legacy");
    const mixed = await readCapacity();
    expect(mixed.blockingExecutor).toEqual({
      acceptingWorkers: 1, refusingWorkers: 0, unknownWorkers: 1,
      unfinishedRetiredGenerations: 2, unfinishedRetiredCalls: 2,
      controlAcceptingWorkers: 1, controlRefusingWorkers: 0, controlUnknownWorkers: 1,
      controlUnfinishedCalls: 1,
    });
  } finally {
    child.stdin.end("stop\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let childExited = false;
    try {
      const [code] = await Promise.race([
        exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic worker did not exit")), 10_000); }),
      ]);
      childExited = true;
      expect(code, stderr).toBe(0);
    } finally {
      if (timer) clearTimeout(timer);
      if (!childExited && child.exitCode === null) {
        child.kill();
        // Never remove a workspace while its owned worker may still write.
        const result = await Promise.race([exited.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000))]);
        childExited = result;
      }
      await app.close();
      if (childExited) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}, 20_000);
