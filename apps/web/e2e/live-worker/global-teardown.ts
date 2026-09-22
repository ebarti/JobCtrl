import fs from "node:fs";
import { createRequire } from "node:module";

const {
  assertE2eWorkspaceEnvironment,
  assertExpectedWorkspace,
  removeOwnedE2eWorkspace,
} = createRequire(import.meta.url)("../fixtures/owned-workspace.cjs") as {
  assertE2eWorkspaceEnvironment(): unknown;
  assertExpectedWorkspace(report: unknown): void;
  removeOwnedE2eWorkspace(workspace: unknown): void;
};

export default async function globalTeardown(): Promise<void> {
  const owned = assertE2eWorkspaceEnvironment();
  let teardownError: unknown;
  try {
    const statePath = process.env["JOBCTRL_E2E_STATE_FILE"]!;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      workspace?: unknown;
    };
    assertExpectedWorkspace(state.workspace);

    const controlUrl = `http://127.0.0.1:${process.env["JOBCTRL_LIVE_WORKER_CONTROL_PORT"]}`;
    await fetch(`${controlUrl}/shutdown`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env["JOBCTRL_LIVE_WORKER_SMOKE_TOKEN"]}`,
      },
    });
    const deadline = Date.now() + 15_000;
    let stopped = false;
    while (Date.now() < deadline) {
      try {
        await fetch(`${controlUrl}/state`);
      } catch {
        stopped = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!stopped)
      throw new Error("Timed out waiting for owned runtime teardown");
  } catch (error) {
    teardownError = error;
  } finally {
    removeOwnedE2eWorkspace(owned);
  }
  if (teardownError) throw teardownError;
}
