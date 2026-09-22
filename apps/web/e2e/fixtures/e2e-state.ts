import fs from "node:fs";
import { createRequire } from "node:module";
import Database from "better-sqlite3";

interface E2eState {
  workspace?: { appDir?: string; dbPath?: string };
}

/** Canonical ID emitted for QA_PLATFORM_JOB_URL by the exact-v7 QA seed. */
export const QA_PLATFORM_JOB_ID = "abaf847c-43cd-40ad-8dc3-76685694ff29";

const { assertE2eWorkspaceEnvironment, assertExpectedWorkspace } =
  createRequire(import.meta.url)("./owned-workspace.cjs") as {
    assertE2eWorkspaceEnvironment(): void;
    assertExpectedWorkspace(workspace: E2eState["workspace"]): void;
  };

export function e2eStateFilePath(): string {
  assertE2eWorkspaceEnvironment();
  return process.env["JOBCTRL_E2E_STATE_FILE"]!;
}

export function loadE2eDbPath(): string {
  const state = JSON.parse(
    fs.readFileSync(e2eStateFilePath(), "utf8"),
  ) as E2eState;
  assertExpectedWorkspace(state.workspace);
  return state.workspace!.dbPath!;
}

/**
 * The E2E seed intentionally models a worker-ready local runtime. Long,
 * single-worker browser runs can outlive the worker-health freshness window,
 * so a test that depends on that precondition must renew its fixture instead
 * of inheriting elapsed suite time.
 */
export function refreshE2eWorkerHeartbeat(now = new Date()): void {
  const db = new Database(loadE2eDbPath());
  try {
    const result = db
      .prepare(
        "UPDATE worker_runtime_heartbeats SET last_seen_at = ? WHERE component = 'temporal-worker'",
      )
      .run(now.toISOString());
    if (result.changes === 0) {
      throw new Error(
        "E2E fixture did not contain a temporal-worker heartbeat to refresh.",
      );
    }
  } finally {
    db.close();
  }
}
