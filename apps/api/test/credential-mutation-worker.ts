import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createSecurityCommandRunner,
  KeychainCredentialStore,
  type SecurityChildProcess,
  type SecurityCommandRunner,
  type SecurityProcessSpawner,
} from "../src/credentials.js";

type StartMessage = {
  type: "start";
  role: "older" | "newer" | "orphan" | "preparing";
  statePath: string;
  configPath: string;
  lockPath: string;
  timeoutMs: number;
};

const marker = "synthetic-credential-marker";
const notify = (message: object): void => { process.send?.(message); };

process.on("message", (message: StartMessage | { type: "release" }) => {
  if (message.type !== "start") return;
  void run(message);
});

async function run(message: StartMessage): Promise<void> {
  let runnerReported = false;
  const fakeRunner: SecurityCommandRunner = async (args, options) => {
    if (!runnerReported) {
      runnerReported = true;
      notify({ type: "runner_started" });
    }
    const key = args[args.indexOf("-a") + 1] ?? "";
    const state = JSON.parse(fs.readFileSync(message.statePath, "utf8")) as Record<string, string>;
    if (args[0] === "find-generic-password") {
      if (!(key in state)) return { code: 44, stderr: "", stdout: "" };
      return args.includes("-g")
        ? { code: 0, stderr: `password: ${JSON.stringify(state[key])}`, stdout: "" }
        : { code: 0, stderr: "", stdout: "" };
    }
    if (message.role === "older" && args[0] === "delete-generic-password" && key === "GEMINI_API_KEY") {
      notify({ type: "blocked" });
      await new Promise<void>((resolve) => {
        const listener = (next: { type: string }): void => {
          if (next.type !== "release") return;
          process.off("message", listener);
          resolve();
        };
        process.on("message", listener);
      });
      return { code: 1, stderr: marker, stdout: marker };
    }
    if (args[0] === "add-generic-password") state[key] = options.sensitiveInput ?? "";
    else delete state[key];
    fs.writeFileSync(message.statePath, JSON.stringify(state));
    return { code: 0, stderr: "", stdout: "" };
  };
  const fakeSpawner: SecurityProcessSpawner = (binary, args, options) => {
    if (binary !== "/bin/sh") throw new Error("Unexpected synthetic helper invocation.");
    const child = spawn(binary, [
      ...args.slice(0, 3), process.execPath,
      fileURLToPath(new URL("./credential-orphan-helper.mjs", import.meta.url)),
    ], {
      ...options,
      env: {
        PATH: process.env.PATH,
        SYNTHETIC_STATE: message.statePath,
        SYNTHETIC_READY: `${message.statePath}.ready`,
        SYNTHETIC_RELEASE: `${message.statePath}.release`,
        SYNTHETIC_DONE: `${message.statePath}.done`,
      },
    }) as SecurityChildProcess;
    if (message.role === "preparing") {
      fs.writeFileSync(`${message.statePath}.spawned`, "spawned");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
    }
    return child;
  };
  const helperRunner = createSecurityCommandRunner(fakeSpawner);
  const runSecurity: SecurityCommandRunner = (args, options) => (message.role === "orphan" || message.role === "preparing") && args[0] === "add-generic-password"
    ? helperRunner(args, options)
    : fakeRunner(args, options);
  const store = new KeychainCredentialStore({
    platform: "darwin", runSecurity, env: {}, configPath: message.configPath,
    mutationLockPath: message.lockPath, mutationLockTimeoutMs: message.timeoutMs,
  });
  notify({ type: "started" });
  try {
    const response = await store.applyBatch(message.role === "older"
      ? [
          { operation: "set", key: "ANTHROPIC_API_KEY", value: `${marker}-older` },
          { operation: "delete", key: "GEMINI_API_KEY" },
        ]
      : [{ operation: "set", key: "ANTHROPIC_API_KEY", value: `${marker}-${message.role === "newer" ? "newer" : "older"}` }]);
    notify({
      type: "done", ok: true,
      configured: response.credentials.find((entry) => entry.key === "ANTHROPIC_API_KEY")?.configured,
      leaked: JSON.stringify(response).includes(marker),
    });
  } catch (error) {
    const reason = error && typeof error === "object" && "reason" in error ? error.reason : "unknown";
    notify({ type: "done", ok: false, reason, leaked: String(error).includes(marker) });
  } finally {
    process.disconnect?.();
  }
}
