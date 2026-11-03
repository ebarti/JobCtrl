import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceSuite = "scripts/dev-lifecycle.test.mjs";
const files = (await readdir(new URL("./", import.meta.url), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => `scripts/${entry.name}`).sort();
if (!files.includes(sourceSuite)) throw new Error("Source lifecycle test suite is missing");
const regular = files.filter((file) => file !== sourceSuite);
if (regular.length === 0) throw new Error("Repository script test suites are missing");

// Lifecycle ownership checks require a stable process census. Other fixture
// processes must finish before this suite starts; both phases remain required.
let activeChild;
let cancellation;
const cancel = (signal) => {
  cancellation = signal;
  activeChild?.kill(signal);
};
const onInterrupt = () => cancel("SIGINT");
const onTerminate = () => cancel("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
try {
  for (const phase of [regular, [sourceSuite]]) {
    if (cancellation) break;
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--test", ...phase], { cwd: root, stdio: "inherit" });
      activeChild = child;
      let spawnError;
      child.once("error", (error) => { spawnError = error; });
      child.once("close", (code, signal) => {
        activeChild = undefined;
        resolve({ code, signal, spawnError });
      });
    });
    if (result.spawnError) console.error(result.spawnError);
    if (result.code !== 0 || result.signal || result.spawnError) {
      process.exitCode = result.signal ? 128 + (constants.signals[result.signal] ?? 0) : Math.max(result.code || 1, 1);
      break;
    }
  }
  if (cancellation) process.exitCode = 128 + constants.signals[cancellation];
} finally {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
}
