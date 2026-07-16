import fs from "node:fs";
import path from "node:path";

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
