import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// @ts-expect-error Node-only harness support is covered by runtime-support.test.mjs.
import { cleanupOwnedProcessGroups } from "./runtime-support.mjs";

const {
  assertE2eWorkspaceEnvironment,
  assertExpectedWorkspace,
  removeOwnedE2eWorkspace,
} = createRequire(import.meta.url)("../fixtures/owned-workspace.cjs") as {
  assertE2eWorkspaceEnvironment(): { appDir: string; token: string };
  assertExpectedWorkspace(report: unknown): void;
  removeOwnedE2eWorkspace(workspace: unknown): void;
};

export default async function globalTeardown(): Promise<void> {
  const owned = assertE2eWorkspaceEnvironment();
  let teardownError: unknown;
  let cleanupError: unknown;
  let cleanup: Record<string, string> = {};
  try {
    const statePath = process.env["JOBCTRL_E2E_STATE_FILE"]!;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      workspace?: unknown;
    };
    assertExpectedWorkspace(state.workspace);

    const controlUrl = `http://127.0.0.1:${process.env["JOBCTRL_LIVE_WORKER_CONTROL_PORT"]}`;
    const shutdown = await fetch(`${controlUrl}/shutdown`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env["JOBCTRL_LIVE_WORKER_SMOKE_TOKEN"]}`,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!shutdown.ok)
      throw new Error(`Owned runtime shutdown failed with HTTP ${shutdown.status}`);
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
  }

  try {
    cleanup = await cleanupOwnedProcessGroups({
      statePath: path.join(
        owned.appDir,
        ".jobctrl-live-worker-processes.json",
      ),
      workspace: owned,
    });
  } catch (error) {
    cleanupError = error;
  }
  fs.mkdirSync(process.env["JOBCTRL_LIVE_WORKER_EVIDENCE_DIR"]!, {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(
      process.env["JOBCTRL_LIVE_WORKER_EVIDENCE_DIR"]!,
      "outer-cleanup.json",
    ),
    JSON.stringify(
      {
        cleanup,
        controlShutdown: teardownError ? "failed" : "completed",
        fallbackCleanup: cleanupError ? "failed" : "verified",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  if (!cleanupError) {
    removeOwnedE2eWorkspace(owned);
  }
  if (cleanupError) throw cleanupError;
  if (teardownError) throw teardownError;
}
