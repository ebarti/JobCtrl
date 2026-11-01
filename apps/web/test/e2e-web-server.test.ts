// @vitest-environment node

import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createOwnedE2eWorkspace,
  workspaceEnvironment,
  removeOwnedE2eWorkspace,
} = require("../e2e/fixtures/owned-workspace.cjs");
const { runE2eWebServer } = require("../e2e/fixtures/start-web.cjs");
const workspaces: unknown[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0))
    removeOwnedE2eWorkspace(workspace);
});

function fixture() {
  const workspace = createOwnedE2eWorkspace();
  workspaces.push(workspace);
  return { workspace, env: workspaceEnvironment(workspace) };
}

function spawner(exitCode = 0) {
  return vi.fn((_command: string, _args: string[], _options: unknown) => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", exitCode, null));
    return child;
  });
}

test("a failed fresh build cannot serve a stale bundle", async () => {
  const { workspace, env } = fixture();
  const buildDir = path.join(workspace.appDir, "web-dist");
  fs.mkdirSync(buildDir);
  fs.writeFileSync(path.join(buildDir, "index.html"), "stale bundle sentinel");
  const spawnProcess = spawner(1);
  await expect(runE2eWebServer({ env, spawnProcess })).rejects.toThrow(
    "exited with 1",
  );
  expect(spawnProcess).toHaveBeenCalledOnce();
  expect(spawnProcess.mock.calls[0]?.[1]).toContain("build");
});

test("web builds cannot follow a symlink into another owned workspace", async () => {
  const current = fixture();
  const sibling = fixture();
  const sentinel = path.join(sibling.workspace.appDir, "sentinel");
  fs.writeFileSync(sentinel, "preserved");
  fs.symlinkSync(
    sibling.workspace.appDir,
    path.join(current.workspace.appDir, "web-dist"),
  );
  const spawnProcess = spawner();
  await expect(
    runE2eWebServer({ env: current.env, spawnProcess }),
  ).rejects.toThrow("symlink");
  expect(spawnProcess).not.toHaveBeenCalled();
  expect(fs.readFileSync(sentinel, "utf8")).toBe("preserved");
});

test("an interrupted build does not launch the preview server", async () => {
  const { env } = fixture();
  const signalProcess = new EventEmitter();
  const kill = vi.fn();
  const spawnProcess = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { kill });
    queueMicrotask(() => {
      signalProcess.emit("SIGTERM");
      child.emit("exit", 0, null);
    });
    return child;
  });
  await runE2eWebServer({ env, spawnProcess, signalProcess });
  expect(kill).toHaveBeenCalledWith("SIGTERM");
  expect(spawnProcess).toHaveBeenCalledOnce();
  expect(signalProcess.listenerCount("SIGTERM")).toBe(0);
});
