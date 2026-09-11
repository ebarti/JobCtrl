import fs from "node:fs";
import { createRequire } from "node:module";
import { e2eStateFilePath } from "./e2e-state.js";

const { assertExpectedWorkspace } = createRequire(import.meta.url)(
  "./owned-workspace.cjs",
) as {
  assertExpectedWorkspace(report: unknown): void;
};

export default async function globalSetup(): Promise<void> {
  // The guarded API launcher must publish the seed receipt before listening.
  const state = JSON.parse(fs.readFileSync(e2eStateFilePath(), "utf8")) as {
    workspace?: unknown;
  };
  assertExpectedWorkspace(state.workspace);
}
