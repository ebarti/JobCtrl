import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const canary = "synthetic-private-apply-canary";
type Workspace = { appDir: string; temporaryRoot: string; token: string; device: string; inode: string; schemaVersion: number };
const owned = createRequire(import.meta.url)("../fixtures/owned-workspace.cjs") as {
  assertE2eWorkspaceEnvironment(): Workspace;
  createSiblingOwnedE2eWorkspace(parent: Workspace): Workspace;
  workspaceEnvironment(workspace: Workspace): Record<string, string>;
  requireLiveWorkerExitCleanup(workspace: Workspace): string;
  markLiveWorkerExitCleanupVerified(workspace: Workspace): void;
  removeOwnedE2eWorkspace(workspace: Workspace): void;
};

async function nextLine(lines: AsyncIterator<string>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const next = await Promise.race([
      lines.next(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic worker timed out")), 15_000); }),
    ]);
    if (next.done) throw new Error("Synthetic worker exited before reporting");
    return next.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    child.once("error", () => { if (!child.pid) resolve(); });
    child.once("exit", () => resolve());
  });
}

async function stopOwned(child: ChildProcessWithoutNullStreams, done: Promise<void>, command?: string): Promise<void> {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    if (command) child.stdin.end(`${command}\n`);
    else child.kill("SIGTERM");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      done,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned child ${child.pid} did not exit`)), 10_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("registered Apply occupancy flows from worker heartbeat through API to failed-run guidance", async ({ page, request }) => {
  test.setTimeout(60_000);
  const workspace = owned.createSiblingOwnedE2eWorkspace(owned.assertE2eWorkspaceEnvironment());
  owned.requireLiveWorkerExitCleanup(workspace);
  const env = owned.workspaceEnvironment(workspace);
  fs.mkdirSync(env["TMPDIR"]!, { recursive: true });
  fs.mkdirSync(env["JOBCTRL_E2E_SERVICE_HOME"]!, { recursive: true });
  const baseEnv = {
    ...env,
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: env["JOBCTRL_E2E_SERVICE_HOME"]!,
    LANG: "C.UTF-8",
    LANGFUSE_DISABLE: "1",
    OTEL_SDK_DISABLED: "true",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: path.join(repoRoot, "workers/automation/src"),
  };
  const worker = spawn(path.join(repoRoot, "workers/automation/.venv/bin/python"),
    [path.join(repoRoot, "apps/web/e2e/fixtures/pipeline-occupancy.py")],
    { cwd: repoRoot, env: baseEnv, stdio: ["pipe", "pipe", "pipe"] });
  const workerDone = exited(worker);
  worker.stderr.resume();
  const lines = createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
  let api: ChildProcessWithoutNullStreams | undefined;
  let apiDone: Promise<void> | undefined;
  try {
    expect(JSON.parse(await nextLine(lines))).toMatchObject({ state: "occupied", activeSlots: 1, detailsTotal: 0, details: [] });
    const server = spawn(process.execPath, ["--import", "tsx", "test/pipeline-occupancy-server.ts"], {
      cwd: path.join(repoRoot, "apps/api"),
      env: { ...baseEnv, JOBCTRL_E2E_ISOLATED: "1", JOBCTRL_API_HOST: "127.0.0.1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    api = server;
    apiDone = exited(server);
    server.stderr.resume();
    const serverLines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
    const address = JSON.parse(await nextLine(serverLines)) as { address: string; dbPath: string };
    expect(address.dbPath).toBe(env["JOBCTRL_E2E_DB_PATH"]);
    const apiUrl = new URL(address.address);
    expect(apiUrl.hostname).toBe("127.0.0.1");
    const base = apiUrl.origin;

    const occupied = await request.get(`${base}/v1/pipeline/operations`);
    expect(occupied.ok()).toBe(true);
    const occupiedBody = await occupied.json();
    expect(occupiedBody.capacity).toMatchObject({ status: "available", activeSlots: 1 });
    expect(occupiedBody).toMatchObject({ activeItems: [], activeItemsTotal: 0, activeItemsTruncated: true });
    expect(JSON.stringify(occupiedBody)).not.toContain(canary);

    await page.route("**/v1/**", async (route) => {
      const url = new URL(route.request().url());
      await route.continue({ url: `${base}${url.pathname}${url.search}` });
    });
    await page.goto("/pipelines");
    const alert = page.getByRole("alert").filter({ hasText: "Previous discovery history is unavailable" });
    await expect(alert).toContainText("1 background worker activity is running");
    await expect(alert).toContainText("Activity details are unavailable");
    await expect(alert.getByRole("link", { name: "Set up a new Discover run" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(canary);

    worker.stdin.write("finish\n");
    expect(JSON.parse(await nextLine(lines))).toMatchObject({ state: "idle", activeSlots: 0, detailsTotal: 0, details: [] });
    const idle = await request.get(`${base}/v1/pipeline/operations`);
    expect(idle.ok()).toBe(true);
    const idleBody = await idle.json();
    expect(idleBody.capacity).toMatchObject({ status: "available", activeSlots: 0 });
    expect(idleBody).toMatchObject({ activeItems: [], activeItemsTotal: 0, activeItemsTruncated: false });
    expect(JSON.stringify(idleBody)).not.toContain(canary);
    await page.reload();
    await expect(alert).toContainText("No remote worker activity is reported");
    await expect(alert).not.toContainText("No work is running");
    await expect(alert.getByRole("link", { name: "Set up a new Discover run" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(canary);
  } finally {
    let cleanupError: unknown;
    try { if (api && apiDone) await stopOwned(api, apiDone); } catch (error) { cleanupError = error; }
    try { await stopOwned(worker, workerDone, "stop"); } catch (error) { cleanupError ??= error; }
    if (cleanupError) throw cleanupError;
    owned.markLiveWorkerExitCleanupVerified(workspace);
    owned.removeOwnedE2eWorkspace(workspace);
  }
});
