import { spawn } from "node:child_process";

// The IPC-connected group leader stays alive after its payload exits. Its live
// identity reserves the process-group ID until the harness has reaped the group.
// On harness death it tears down its own group, never a PID from an old receipt.
const [executable, ...args] = process.argv.slice(2);
if (!process.send || !executable)
  throw new Error("The E2E group requires its owning IPC parent");
let stopping = false;
let forcedStop;
const payload = spawn(executable, args, { env: process.env, stdio: "inherit" });
const report = (message) => {
  if (process.connected) process.send(message, () => {});
};
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
payload.once("spawn", () => report({ type: "spawn", pid: payload.pid }));
payload.once("error", (error) =>
  report({ type: "error", message: error.message }),
);
payload.once("exit", (code, signal) => report({ type: "exit", code, signal }));

function stop() {
  if (stopping) return;
  stopping = true;
  process.kill(-process.pid, "SIGTERM");
  forcedStop = setTimeout(() => process.kill(-process.pid, "SIGKILL"), 5_000);
}
process.on("message", (message) => {
  if (message?.type === "stop") stop();
  if (message?.type === "finish" && stopping) {
    clearTimeout(forcedStop);
    process.exit(0);
  }
});
process.on("disconnect", stop);
