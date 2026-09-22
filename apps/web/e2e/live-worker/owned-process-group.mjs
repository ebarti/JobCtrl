import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(import.meta.url);

const [
  stateFlag,
  statePath,
  ownerHashFlag,
  ownerTokenHash,
  capabilityFlag,
  capability,
  nameFlag,
  name,
  separator,
  executable,
  ...args
] = process.argv.slice(2);
if (
  stateFlag !== "--state" ||
  !statePath ||
  ownerHashFlag !== "--owner-hash" ||
  !/^[a-f0-9]{64}$/.test(ownerTokenHash ?? "") ||
  capabilityFlag !== "--capability" ||
  !/^[a-f0-9]{64}$/.test(capability ?? "") ||
  nameFlag !== "--name" ||
  !/^[a-z][a-z0-9-]{0,31}$/.test(name ?? "") ||
  separator !== "--" ||
  !executable
) {
  throw new Error("Owned process-group launcher received an invalid capability");
}

const registrationDeadline = Date.now() + 10_000;
let registered = false;
while (Date.now() < registrationDeadline) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    registered =
      state?.schemaVersion === 1 &&
      state.ownerTokenHash === ownerTokenHash &&
      state.groups?.some(
        (record) =>
          record.name === name &&
          record.pid === process.pid &&
          record.capability === capability &&
          record.launcherPath === launcherPath,
      );
  } catch {
    registered = false;
  }
  if (registered) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (!registered) {
  throw new Error("Owned process-group launcher was not registered by its supervisor");
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
