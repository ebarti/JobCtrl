const { spawn } = require("node:child_process");
const path = require("node:path");
const {
  assertInside,
  assertE2eWorkspaceEnvironment,
} = require("./owned-workspace.cjs");

const repoRoot = path.resolve(__dirname, "../../../..");

function resolveE2eWebServerMode(value) {
  if (value === undefined || value === "preview") return "preview";
  if (value === "dev") return "dev";
  throw new Error("JOBCTRL_E2E_WEB_SERVER must be preview or dev");
}

async function runE2eWebServer({
  env = process.env,
  spawnProcess = spawn,
  signalProcess = process,
} = {}) {
  const mode = resolveE2eWebServerMode(env.JOBCTRL_E2E_WEB_SERVER);
  const workspace = assertE2eWorkspaceEnvironment(env);
  const buildDir = assertInside(
    workspace.appDir,
    path.join(workspace.appDir, "web-dist"),
  );
  const port = env.JOBCTRL_E2E_WEB_PORT ?? "5174";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("JOBCTRL_E2E_WEB_PORT must be a TCP port");

  const prefix = ["pnpm", "--filter", "@jobctrl/web", "exec", "vite"];
  const commands =
    mode === "dev"
      ? [[...prefix, "--host", "127.0.0.1", "--port", port, "--strictPort"]]
      : [
          [...prefix, "build", "--outDir", buildDir, "--emptyOutDir"],
          [
            ...prefix,
            "preview",
            "--outDir",
            buildDir,
            "--host",
            "127.0.0.1",
            "--port",
            port,
            "--strictPort",
          ],
        ];

  let child;
  let stopping = false;
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => {
      stopping = true;
      child?.kill(signal);
    };
    signalProcess.once(signal, handler);
    return [signal, handler];
  });
  try {
    for (const args of commands) {
      if (stopping) break;
      await new Promise((resolve, reject) => {
        child = spawnProcess("corepack", args, {
          cwd: repoRoot,
          env,
          stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0 && !signal) resolve();
          else
            reject(
              new Error(
                `E2E web ${args[5] ?? "server"} exited with ${signal ?? code}`,
              ),
            );
        });
      });
    }
  } finally {
    for (const [signal, handler] of handlers)
      signalProcess.removeListener(signal, handler);
  }
}

if (require.main === module) {
  runE2eWebServer().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { resolveE2eWebServerMode, runE2eWebServer };
