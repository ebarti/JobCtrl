import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
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
const sourceDevScript = join(repoRoot, "scripts/dev");

function fixtureDevScript(tempDir: string): string {
  const script = join(tempDir, "repo", "scripts", "dev");
  mkdirSync(join(tempDir, "repo", "scripts"), { recursive: true });
  copyFileSync(sourceDevScript, script);
  copyFileSync(join(repoRoot, "scripts/dev-process-owner.py"), join(tempDir, "repo/scripts/dev-process-owner.py"));
  const infrastructure = join(tempDir, "repo/workers/automation/src/jobctrl/infrastructure");
  mkdirSync(infrastructure, { recursive: true });
  copyFileSync(join(repoRoot, "workers/automation/src/jobctrl/infrastructure/process_ownership.py"), join(infrastructure, "process_ownership.py"));
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  writeFileSync(join(tempDir, "python3"), `#!/bin/bash\nexec '${python.replaceAll("'", "'\\''")}' -I -S -B "$@"\n`);
  chmodSync(join(tempDir, "python3"), 0o755);
  writeFileSync(join(tempDir, "repo/scripts/fixture-controller-owner.py"), `import importlib.util,sys
script = sys.argv.pop(1)
spec = importlib.util.spec_from_file_location('fixture_source_owner', script)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
from jobctrl.infrastructure import process_ownership
# The synthetic controller must give the real inner owner time to drain.
# Leaf owners, custody checks and the total cleanup deadline stay unchanged.
process_ownership._PROCESS_TERMINATION_GRACE_SECONDS = 8.0
raise SystemExit(owner.main())
`);
  chmodSync(script, 0o755);
  const go = join(tempDir, "go");
  writeFileSync(go, `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-C" && "$3" == "run" && "$4" == "./cmd/jobctrl-source" ]]
root="$6"
controller_dir="$JOBCTRL_DEV_DIR/source-controller"
mkdir -p "$controller_dir"
if [[ "$5" == "stop" || "$5" == "switch" ]]; then
  exec python3 -B "$root/scripts/dev-process-owner.py" stop "$controller_dir" api
fi
[[ "$5" != "verify" ]] || exit 0
[[ "$5" == "run" ]]
shift 6
export JOBCTRL_DEV_INNER=1
printf -v command 'exec %q run' "$root/scripts/dev"
for component in "$@"; do printf -v command '%s %q' "$command" "$component"; done
launch_id=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
python3 -B "$root/scripts/fixture-controller-owner.py" "$root/scripts/dev-process-owner.py" launch "$controller_dir" api "$launch_id" "$command" &
controller_child=$!
finish() {
  python3 -B "$root/scripts/dev-process-owner.py" stop "$controller_dir" api
  wait "$controller_child"
  exit "$1"
}
trap 'finish 130' INT
trap 'finish 143' TERM
wait "$controller_child"
`);
  chmodSync(go, 0o755);
  return script;
}
function fixtureExtensionBuild(tempDir: string, callsLog: string): void {
  const corepack = join(tempDir, "corepack");
  writeFileSync(corepack, `#!/usr/bin/env bash
if [[ "$*" != "pnpm extension:build" ]]; then exit 1; fi
echo "fake corepack $*" >> "${callsLog}"
exit 0
`);
  chmodSync(corepack, 0o755);
}

type DevLauncherProcess = ChildProcessByStdio<null, Readable, Readable>;

function childClosed(child: DevLauncherProcess): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  // Keep an early spawn error handled until the owning cleanup awaits it.
  void closed.catch(() => {});
  return closed;
}

async function waitForChildClose(closed: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Owned fixture child did not close; retain its workspace")), 10_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function startStatusOwner(tempDir: string, component: "api" | "worker", env: NodeJS.ProcessEnv): Promise<() => Promise<void>> {
  const directory = join(env.JOBCTRL_DEV_DIR!, "pids");
  mkdirSync(directory, { recursive: true });
  const id = randomBytes(32).toString("hex");
  const script = join(tempDir, "repo/scripts/dev-process-owner.py");
  const child: DevLauncherProcess = spawn("python3", ["-B", script, "launch", directory, component, id,
    "exec sleep 300", join(tempDir, `${component}.log`)], { env, stdio: ["ignore", "pipe", "pipe"] });
  const closed = childClosed(child);
  const stop = async () => {
    execFileSync("python3", ["-B", script, "stop", directory, component, id], { env });
    await waitForChildClose(closed);
  };
  try {
    await waitForPidFile(join(directory, `${component}.pid`));
    execFileSync("python3", ["-B", script, "check", directory, component, id, String(child.pid)], { env });
    return stop;
  } catch (error) {
    child.kill("SIGTERM");
    await waitForChildClose(closed);
    throw error;
  }
}

function cleanupDevFixture(tempDir: string, script: string, component: string, env: NodeJS.ProcessEnv): void {
  // A failed managed stop retains the fixture and receipts for diagnosis.
  // A PID recovered from those receipts never authorizes fallback signals.
  execFileSync(script, ["stop", component], { cwd: repoRoot, env, timeout: 20_000 });
  expect(existsSync(join(env.JOBCTRL_DEV_DIR!, "pids", `${component}.pid`))).toBe(false);
  rmSync(tempDir, { force: true, recursive: true });
}

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
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    // Match scripts/dev: a zombie has exited and is no longer a live process
    // tree member even though kill(pid, 0) still succeeds until it is reaped.
    return !stat.includes("Z");
  } catch {
    return false;
  }
}

function devScriptEnv(devDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = extra.HOME ?? join(devDir, "home");
  const appDir = "JOBCTRL_DIR" in extra ? extra.JOBCTRL_DIR ?? join(home, ".jobctrl") : join(devDir, "app");
  const tempDir = join(devDir, "tmp");
  mkdirSync(tempDir, { recursive: true });
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    HOME: home,
    JOBCTRL_DIR: appDir,
    JOBCTRL_DB_PATH: join(appDir, "jobctrl.db"),
    JOBCTRL_CONFIG_PATH: join(appDir, "config.json"),
    JOBCTRL_DEV_DIR: devDir,
    // Fixtures launch fake processes and must not probe a real developer API.
    JOBCTRL_API_PORT: "0",
    JOBCTRL_USER_ENV_PATH: join(home, "JobCtrl", ".env"),
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
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
    const devScript = fixtureDevScript(tempDir);
    const env = devScriptEnv(join(tempDir, "dev-state"));

    try {
      execFileSync("bash", ["-n", devScript], { cwd: repoRoot, env });

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

  it("reports worker heartbeat health in status output", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devScript = fixtureDevScript(tempDir);
    const devDir = join(tempDir, "dev-state");
    const pidDir = join(devDir, "pids");
    const env = devScriptEnv(devDir, { PATH: `${tempDir}:${process.env.PATH ?? ""}`, JOBCTRL_API_PORT: "9988" });
    let stopOwned: (() => Promise<void>) | undefined;

    try {
      mkdirSync(pidDir, { recursive: true });
      writeFileSync(
        join(tempDir, "curl"),
        `#!/usr/bin/env bash
echo '{"worker":{"status":"stale"}}'
`,
      );
      chmodSync(join(tempDir, "curl"), 0o755);
      stopOwned = await startStatusOwner(tempDir, "worker", env);

      const output = execFileSync(devScript, ["status"], {
        cwd: repoRoot,
        encoding: "utf8",
        env,
      });

      expect(output).toContain("HEALTH");
      expect(output).toMatch(/worker\s+up\s+\d+\s+stale\s+/);
    } finally {
      if (stopOwned) {
        await stopOwned();
        rmSync(tempDir, { force: true, recursive: true });
      }
    }
  });

  it("distinguishes a running API watcher from a schema-blocked API", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devScript = fixtureDevScript(tempDir);
    const devDir = join(tempDir, "dev-state");
    const env = devScriptEnv(devDir, { PATH: `${tempDir}:${process.env.PATH ?? ""}` });
    let stopOwned: (() => Promise<void>) | undefined;
    try {
      mkdirSync(join(devDir, "pids"), { recursive: true });
      writeFileSync(join(tempDir, "curl"), "#!/usr/bin/env bash\necho '{\"ok\":false,\"error\":\"database_migration_required\"}'\n");
      chmodSync(join(tempDir, "curl"), 0o755);
      stopOwned = await startStatusOwner(tempDir, "api", env);
      const output = execFileSync(devScript, ["status", "api"], {
        cwd: repoRoot, encoding: "utf8",
        env,
      });
      expect(output).toMatch(/api\s+up\s+\d+\s+migration\s+/);
    } finally {
      if (stopOwned) {
        await stopOwned();
        rmSync(tempDir, { force: true, recursive: true });
      }
    }
  });

  it("reports status without inspecting legacy default workspaces", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devScript = fixtureDevScript(tempDir);
    const home = join(tempDir, "home");
    const devDir = join(tempDir, "dev-state");
    const legacyDirname = ".job" + "ctl";

    try {
      mkdirSync(join(home, ".jobctrl"), { recursive: true });
      mkdirSync(join(home, legacyDirname), { recursive: true });

      const output = execFileSync(devScript, ["status"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: devScriptEnv(devDir, { HOME: home, JOBCTRL_DIR: undefined }),
      });

      expect(output).toContain("NAME");
      expect(output).toContain("temporal");
      expect(existsSync(join(home, ".jobctrl"))).toBe(true);
      expect(existsSync(join(home, legacyDirname))).toBe(true);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("starts without migrating or rejecting legacy default workspaces", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devScript = fixtureDevScript(tempDir);
    const home = join(tempDir, "home");
    const devDir = join(tempDir, "dev-state");
    const callsLog = join(tempDir, "calls.log");
    const pidFile = join(devDir, "pids/api.pid");
    const legacyDirname = ".job" + "ctl";
    let apiPid: number | undefined;
    let env: NodeJS.ProcessEnv | undefined;

    try {
      mkdirSync(join(home, ".jobctrl"), { recursive: true });
      mkdirSync(join(home, legacyDirname), { recursive: true });
      writeFileSync(
        join(tempDir, "pnpm"),
        `#!/usr/bin/env bash
echo "fake pnpm $* jobctrl_dir=$JOBCTRL_DIR" >> "${callsLog}"
trap 'echo "fake pnpm terminated $$" >> "${callsLog}"; exit 0' TERM INT
while true; do sleep 1; done
`,
      );
      chmodSync(join(tempDir, "pnpm"), 0o755);

      env = devScriptEnv(devDir, {
        HOME: home,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        JOBCTRL_DIR: undefined,
        JOBCTRL_STOP_WAIT_TICKS: "10",
        JOBCTRL_STOP_WAIT_INTERVAL_SECONDS: "0.05",
      });

      const output = execFileSync(devScript, ["start", "api"], {
        cwd: repoRoot,
        encoding: "utf8",
        env,
      });
      apiPid = await waitForPidFile(pidFile);
      await waitForFileText(
        callsLog,
        `fake pnpm --filter @jobctrl/api dev jobctrl_dir=${join(home, ".jobctrl")}`,
      );

      expect(output).toMatch(/api: started|detached source stack started/);
      expect(processExists(apiPid)).toBe(true);
      expect(existsSync(join(home, ".jobctrl"))).toBe(true);
      expect(existsSync(join(home, legacyDirname))).toBe(true);
    } finally {
      cleanupDevFixture(tempDir, devScript, "api", env ?? devScriptEnv(devDir, { PATH: `${tempDir}:${process.env.PATH ?? ""}` }));
    }
  });

  it("replaces a tracked process before starting a fresh detached process", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devScript = fixtureDevScript(tempDir);
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
      cleanupDevFixture(tempDir, devScript, "api", devScriptEnv(devDir, { PATH: `${tempDir}:${process.env.PATH ?? ""}` }));
    }
  });

  it("prints the actual Vite binding observed from detached web logs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devScript = fixtureDevScript(tempDir);
    const devDir = join(tempDir, "dev-state");
    const callsLog = join(tempDir, "calls.log");
    const pidFile = join(devDir, "pids/web.pid");
    let webPid: number | undefined;
    let env: NodeJS.ProcessEnv | undefined;

    try {
      fixtureExtensionBuild(tempDir, callsLog);
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
      expect(readFileSync(callsLog, "utf8").split("\n")[0]).toBe("fake corepack pnpm extension:build");
      expect(processExists(webPid)).toBe(true);
    } finally {
      cleanupDevFixture(tempDir, devScript, "web", env ?? devScriptEnv(devDir, { PATH: `${tempDir}:${process.env.PATH ?? ""}` }));
    }
  });

  it("loads user-local frontend env before starting the web process", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devScript = fixtureDevScript(tempDir);
    const devDir = join(tempDir, "dev-state");
    const callsLog = join(tempDir, "calls.log");
    const pidFile = join(devDir, "pids/web.pid");
    let webPid: number | undefined;
    let env: NodeJS.ProcessEnv | undefined;

    try {
      fixtureExtensionBuild(tempDir, callsLog);
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

      expect(readFileSync(callsLog, "utf8").split("\n")[0]).toBe("fake corepack pnpm extension:build");
      expect(processExists(webPid)).toBe(true);
    } finally {
      cleanupDevFixture(tempDir, devScript, "web", env ?? devScriptEnv(devDir, { PATH: `${tempDir}:${process.env.PATH ?? ""}` }));
    }
  });

  it("runs attached processes and cleans PID files on termination", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devScript = fixtureDevScript(tempDir);
    const devDir = join(tempDir, "dev-state");
    const callsLog = join(tempDir, "calls.log");
    const childPidFile = join(tempDir, "child.pid");
    const grandchildPidFile = join(tempDir, "grandchild.pid");
    const pidFile = join(devDir, "pids/api.pid");
    let child: DevLauncherProcess | undefined;
    let closed: Promise<void> | undefined;
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
        env: devScriptEnv(devDir, {
          PATH: `${tempDir}:${process.env.PATH ?? ""}`,
          JOBCTRL_STOP_WAIT_TICKS: "2",
          JOBCTRL_STOP_WAIT_INTERVAL_SECONDS: "0.05",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = runningChild;
      closed = childClosed(runningChild);

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
      if (closed) await waitForChildClose(closed);
      cleanupDevFixture(tempDir, devScript, "api", devScriptEnv(devDir, { PATH: `${tempDir}:${process.env.PATH ?? ""}` }));
    }
  });

  it("starts Temporal with a persistent dev-store filename", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "jobctrl-dev-launcher-"));
    const devScript = fixtureDevScript(tempDir);
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
        `fake temporal server start-dev --db-filename ${join(devDir, "app/temporal.db")}`,
      );

      expect(processExists(temporalPid)).toBe(true);
      expect(readFileSync(callsLog, "utf8")).not.toContain(
        join(devDir, "temporal/temporal.db"),
      );
    } finally {
      cleanupDevFixture(tempDir, devScript, "temporal", env ?? devScriptEnv(devDir, { PATH: `${tempDir}:${process.env.PATH ?? ""}` }));
    }
  });
});
