import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

interface E2eState {
  workspace?: { dbPath?: string };
}

export function e2eStateFilePath(): string {
  const configured = process.env["JOBCTRL_E2E_STATE_FILE"];
  if (!configured) {
    throw new Error(
      "JOBCTRL_E2E_STATE_FILE is not set; playwright.config.ts should isolate the run before setup.",
    );
  }
  return path.resolve(configured);
}

export function loadE2eDbPath(): string {
  const state = JSON.parse(
    fs.readFileSync(e2eStateFilePath(), "utf-8"),
  ) as E2eState;
  if (!state.workspace?.dbPath) {
    throw new Error(
      "E2E state file is missing workspace.dbPath; global-setup did not run.",
    );
  }
  return state.workspace.dbPath;
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
