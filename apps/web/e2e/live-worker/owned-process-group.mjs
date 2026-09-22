import { spawn } from "node:child_process";

const [capabilityFlag, capability, nameFlag, name, separator, executable, ...args] =
  process.argv.slice(2);
if (
  capabilityFlag !== "--capability" ||
  !/^[a-f0-9]{64}$/.test(capability ?? "") ||
  nameFlag !== "--name" ||
  !/^[a-z][a-z0-9-]{0,31}$/.test(name ?? "") ||
  separator !== "--" ||
  !executable
) {
  throw new Error("Owned process-group launcher received an invalid capability");
}

const child = spawn(executable, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // The target shares this process group and receives the original signal.
    // Keeping the authenticated leader alive lets fallback cleanup verify the
    // group before escalating a target that does not exit.
  });
}

const outcome = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
process.exitCode = outcome.code ?? (outcome.signal ? 128 : 1);
