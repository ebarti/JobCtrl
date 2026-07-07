import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const devScript = join(repoRoot, "scripts/dev");
type DevLauncherProcess = ChildProcessByStdio<null, Readable, Readable>;

function waitForOutput(child: DevLauncherProcess, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${text}`));
    }, 5_000);

    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(text)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Process exited before ${text}: code=${code} signal=${signal} output=${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForFileText(path: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for ${text} in ${path}`));
    }, 5_000);

    const interval = setInterval(() => {
      try {
        if (readFileSync(path, "utf8").includes(text)) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      } catch {
        // File is created by the child process; keep polling until timeout.
      }
    }, 25);
  });
}

function waitForFileMatchCount(path: string, pattern: RegExp, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for ${count} matches of ${pattern} in ${path}`));
    }, 5_000);

    const interval = setInterval(() => {
      try {
        const matches = readFileSync(path, "utf8").match(pattern);
        if ((matches?.length ?? 0) >= count) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      } catch {
        // File is created by the child process; keep polling until timeout.
      }
    }, 25);
  });
}

function waitForPidFile(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for numeric PID in ${path}`));
    }, 5_000);

    const interval = setInterval(() => {
      try {
        const text = readFileSync(path, "utf8").trim();
        if (/^[1-9][0-9]*$/.test(text)) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve(Number(text));
        }
      } catch {
        // File is created by the child process; keep polling until timeout.
      }
    }, 25);
  });
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function devScriptEnv(devDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: join(devDir, "home"),
    JOBCTRL_DIR: join(devDir, "app"),
    JOBCTRL_DEV_DIR: devDir,
    ...extra,
  };
}

describe("dev launcher contract", () => {
  it("keeps the documented default dev command attached", () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.dev).toBe("scripts/dev run");
    expect(packageJson.scripts["dev:start"]).toBe("scripts/dev start");
  });

  it("advertises foreground run mode and a direct web port override", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const env = devScriptEnv(join(tempDir, "dev-state"));

    try {
      execFileSync("bash", ["-n", devScript], { cwd: repoRoot });

      const help = execFileSync(devScript, ["help"], { cwd: repoRoot, encoding: "utf8", env });
      expect(help).toContain("scripts/dev run [name...]");

      const list = execFileSync(devScript, ["list"], { cwd: repoRoot, encoding: "utf8", env });
      expect(list).toContain('temporal   temporal server start-dev --db-filename "$JOBCTRL_TEMPORAL_DB"');
      expect(list).toContain(
        'web        pnpm --filter @jobctrl/web exec vite --host 127.0.0.1 --port "$JOBCTRL_WEB_PORT"',
      );
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("reports worker heartbeat health in status output", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devDir = join(tempDir, "dev-state");
    const pidDir = join(devDir, "pids");

    try {
      mkdirSync(pidDir, { recursive: true });
      writeFileSync(join(pidDir, "worker.pid"), String(process.pid));
      writeFileSync(
        join(tempDir, "curl"),
        `#!/usr/bin/env bash
echo '{"worker":{"status":"stale"}}'
`,
      );
      chmodSync(join(tempDir, "curl"), 0o755);

      const output = execFileSync(devScript, ["status"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: devScriptEnv(devDir, {
          PATH: `${tempDir}:${process.env.PATH ?? ""}`,
          JOBCTRL_API_PORT: "9988",
        }),
      });

      expect(output).toContain("HEALTH");
      expect(output).toMatch(/worker\s+up\s+\d+\s+stale\s+/);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("reports status without requiring default workspace migration", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const home = join(tempDir, "home");
    const devDir = join(tempDir, "dev-state");
    const legacyDirname = ".job" + "ctl";

    try {
      mkdirSync(join(home, ".jobctrl"), { recursive: true });
      mkdirSync(join(home, legacyDirname), { recursive: true });

      const output = execFileSync(devScript, ["status"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          JOBCTRL_DEV_DIR: devDir,
        },
      });

      expect(output).toContain("NAME");
      expect(output).toContain("temporal");
      expect(existsSync(join(home, ".jobctrl"))).toBe(true);
      expect(existsSync(join(home, legacyDirname))).toBe(true);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("replaces a tracked process before starting a fresh detached process", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devDir = join(tempDir, "dev-state");
    const callsLog = join(tempDir, "calls.log");
    const pidFile = join(devDir, "pids/api.pid");
    let firstPid: number | undefined;
    let secondPid: number | undefined;

    try {
      writeFileSync(
        join(tempDir, "pnpm"),
        `#!/usr/bin/env bash
echo "fake pnpm $*" >> "${callsLog}"
trap 'echo "fake pnpm terminated $$" >> "${callsLog}"; exit 0' TERM INT
while true; do sleep 1; done
`,
      );
      chmodSync(join(tempDir, "pnpm"), 0o755);
      const env = devScriptEnv(devDir, {
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        JOBCTRL_STOP_WAIT_TICKS: "10",
        JOBCTRL_STOP_WAIT_INTERVAL_SECONDS: "0.05",
      });

      execFileSync(devScript, ["start", "api"], { cwd: repoRoot, env });
      firstPid = await waitForPidFile(pidFile);
      await waitForFileText(callsLog, "fake pnpm --filter @jobctrl/api dev");
      expect(processExists(firstPid)).toBe(true);

      execFileSync(devScript, ["start", "api"], { cwd: repoRoot, env });
      secondPid = await waitForPidFile(pidFile);
      await waitForFileMatchCount(callsLog, /fake pnpm --filter @jobctrl\/api dev/g, 2);

      expect(secondPid).not.toBe(firstPid);
      expect(processExists(firstPid)).toBe(false);
      expect(processExists(secondPid)).toBe(true);
      expect(readFileSync(callsLog, "utf8").match(/fake pnpm --filter @jobctrl\/api dev/g)).toHaveLength(2);
    } finally {
      try {
        execFileSync(devScript, ["stop", "api"], { cwd: repoRoot, env: devScriptEnv(devDir) });
      } catch {
        // The process may already be stopped if an assertion failed late.
      }
      if (firstPid !== undefined && processExists(firstPid)) {
        process.kill(firstPid, "SIGKILL");
      }
      if (secondPid !== undefined && processExists(secondPid)) {
        process.kill(secondPid, "SIGKILL");
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("prints the actual Vite binding observed from detached web logs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devDir = join(tempDir, "dev-state");
    const callsLog = join(tempDir, "calls.log");
    const pidFile = join(devDir, "pids/web.pid");
    let webPid: number | undefined;
    let env: NodeJS.ProcessEnv | undefined;

    try {
      writeFileSync(
        join(tempDir, "pnpm"),
        `#!/usr/bin/env bash
echo "fake pnpm $*" >> "${callsLog}"
echo "  Local:   http://127.0.0.1:5175/"
trap 'echo "fake pnpm terminated $$" >> "${callsLog}"; exit 0' TERM INT
while true; do sleep 1; done
`,
      );
      chmodSync(join(tempDir, "pnpm"), 0o755);
      env = devScriptEnv(devDir, {
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        JOBCTRL_BINDING_WAIT_TICKS: "20",
        JOBCTRL_BINDING_WAIT_INTERVAL_SECONDS: "0.05",
        JOBCTRL_STOP_WAIT_TICKS: "10",
        JOBCTRL_STOP_WAIT_INTERVAL_SECONDS: "0.05",
        JOBCTRL_WEB_PORT: "5173",
      });

      const output = execFileSync(devScript, ["start", "web"], {
        cwd: repoRoot,
        encoding: "utf8",
        env,
      });
      webPid = await waitForPidFile(pidFile);
      await waitForFileText(callsLog, "fake pnpm --filter @jobctrl/web exec vite --host 127.0.0.1 --port 5173");

      expect(output).toContain("dev: bindings");
      expect(output).toContain("web: http://127.0.0.1:5175/");
      expect(processExists(webPid)).toBe(true);
    } finally {
      try {
        execFileSync(devScript, ["stop", "web"], {
          cwd: repoRoot,
          env: env ?? devScriptEnv(devDir),
        });
      } catch {
        // The process may already be stopped if an assertion failed late.
      }
      if (webPid !== undefined && processExists(webPid)) {
        process.kill(webPid, "SIGKILL");
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("loads user-local frontend env before starting the web process", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devDir = join(tempDir, "dev-state");
    const callsLog = join(tempDir, "calls.log");
    const pidFile = join(devDir, "pids/web.pid");
    let webPid: number | undefined;
    let env: NodeJS.ProcessEnv | undefined;

    try {
      mkdirSync(join(tempDir, "JobCtrl"), { recursive: true });
      writeFileSync(join(tempDir, "JobCtrl", ".env"), "VITE_GOOGLE_MAPS_API_KEY=maps-test-key\n");
      writeFileSync(
        join(tempDir, "pnpm"),
        `#!/usr/bin/env bash
echo "fake pnpm $*" >> "${callsLog}"
echo "maps=$VITE_GOOGLE_MAPS_API_KEY" >> "${callsLog}"
echo "  Local:   http://127.0.0.1:5175/"
trap 'echo "fake pnpm terminated $$" >> "${callsLog}"; exit 0' TERM INT
while true; do sleep 1; done
`,
      );
      chmodSync(join(tempDir, "pnpm"), 0o755);
      env = devScriptEnv(devDir, {
        HOME: tempDir,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        JOBCTRL_BINDING_WAIT_TICKS: "20",
        JOBCTRL_BINDING_WAIT_INTERVAL_SECONDS: "0.05",
        JOBCTRL_STOP_WAIT_TICKS: "10",
        JOBCTRL_STOP_WAIT_INTERVAL_SECONDS: "0.05",
      });

      execFileSync(devScript, ["start", "web"], { cwd: repoRoot, env });
      webPid = await waitForPidFile(pidFile);
      await waitForFileText(callsLog, "maps=maps-test-key");

      expect(processExists(webPid)).toBe(true);
    } finally {
      try {
        execFileSync(devScript, ["stop", "web"], {
          cwd: repoRoot,
          env: env ?? devScriptEnv(devDir),
        });
      } catch {
        // The process may already be stopped if an assertion failed late.
      }
      if (webPid !== undefined && processExists(webPid)) {
        process.kill(webPid, "SIGKILL");
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("runs attached processes and cleans PID files on termination", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devDir = join(tempDir, "dev-state");
    const callsLog = join(tempDir, "calls.log");
    const childPidFile = join(tempDir, "child.pid");
    const grandchildPidFile = join(tempDir, "grandchild.pid");
    const pidFile = join(devDir, "pids/api.pid");
    let child: DevLauncherProcess | undefined;
    let spawnedChildPid: number | undefined;
    let spawnedGrandchildPid: number | undefined;

    try {
      rmSync(pidFile, { force: true });
      writeFileSync(
        join(tempDir, "pnpm"),
        `#!/usr/bin/env bash
echo "fake pnpm $*" >> "${callsLog}"
(
  trap '' TERM INT
  sleep 300 &
  echo "$!" > "${grandchildPidFile}"
  while true; do sleep 1; done
) &
echo "$!" > "${childPidFile}"
trap 'echo "fake pnpm terminated" >> "${callsLog}"; exit 0' TERM INT
while true; do sleep 1; done
`,
      );
      chmodSync(join(tempDir, "pnpm"), 0o755);

      const runningChild: DevLauncherProcess = spawn(devScript, ["run", "--", "api"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: join(devDir, "home"),
          JOBCTRL_DIR: join(devDir, "app"),
          PATH: `${tempDir}:${process.env.PATH ?? ""}`,
          JOBCTRL_DEV_DIR: devDir,
          JOBCTRL_STOP_WAIT_TICKS: "2",
          JOBCTRL_STOP_WAIT_INTERVAL_SECONDS: "0.05",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = runningChild;

      await waitForOutput(runningChild, "dev: foreground run active");
      expect(existsSync(pidFile)).toBe(true);
      await waitForFileText(callsLog, "fake pnpm --filter @jobctrl/api dev");
      spawnedChildPid = await waitForPidFile(childPidFile);
      spawnedGrandchildPid = await waitForPidFile(grandchildPidFile);
      expect(processExists(spawnedChildPid)).toBe(true);
      expect(processExists(spawnedGrandchildPid)).toBe(true);

      runningChild.kill("SIGTERM");
      const exitCode = await new Promise<number | null>((resolve) => {
        runningChild.once("exit", (code) => resolve(code));
      });

      expect(exitCode).toBe(143);
      expect(existsSync(pidFile)).toBe(false);
      expect(processExists(spawnedChildPid)).toBe(false);
      expect(processExists(spawnedGrandchildPid)).toBe(false);
    } finally {
      child?.kill("SIGTERM");
      if (spawnedChildPid !== undefined && processExists(spawnedChildPid)) {
        process.kill(spawnedChildPid, "SIGKILL");
      }
      if (spawnedGrandchildPid !== undefined && processExists(spawnedGrandchildPid)) {
        process.kill(spawnedGrandchildPid, "SIGKILL");
      }
      rmSync(pidFile, { force: true });
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("starts Temporal with a persistent dev-store filename", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devDir = join(tempDir, "dev-state");
    const callsLog = join(tempDir, "calls.log");
    const pidFile = join(devDir, "pids/temporal.pid");
    let temporalPid: number | undefined;
    let env: NodeJS.ProcessEnv | undefined;

    try {
      writeFileSync(
        join(tempDir, "temporal"),
        `#!/usr/bin/env bash
echo "fake temporal $*" >> "${callsLog}"
trap 'echo "fake temporal terminated $$" >> "${callsLog}"; exit 0' TERM INT
while true; do sleep 1; done
`,
      );
      chmodSync(join(tempDir, "temporal"), 0o755);
      env = devScriptEnv(devDir, {
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        JOBCTRL_STOP_WAIT_TICKS: "10",
        JOBCTRL_STOP_WAIT_INTERVAL_SECONDS: "0.05",
      });

      execFileSync(devScript, ["start", "temporal"], { cwd: repoRoot, env });
      temporalPid = await waitForPidFile(pidFile);
      await waitForFileText(
        callsLog,
        `fake temporal server start-dev --db-filename ${join(devDir, "temporal/temporal.db")}`,
      );

      expect(processExists(temporalPid)).toBe(true);
    } finally {
      try {
        execFileSync(devScript, ["stop", "temporal"], {
          cwd: repoRoot,
          env: env ?? devScriptEnv(devDir),
        });
      } catch {
        // The process may already be stopped if an assertion failed late.
      }
      if (temporalPid !== undefined && processExists(temporalPid)) {
        process.kill(temporalPid, "SIGKILL");
      }
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
