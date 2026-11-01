import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withCredentialMutationLock } from "../src/credential-mutation-lock.js";
import { readCredentialProcessIdentity } from "../src/credential-process-identity.js";

const marker = "synthetic-credential-marker";
const syntheticIdentity = process.platform === "linux"
  ? "linux:00000000-0000-0000-0000-000000000000:1"
  : process.platform === "win32" ? "windows:1:1" : "darwin:1:1";
let directory = "";
let lockPath = "";
let statePath = "";
let workers: ChildProcess[] = [];
let identities = new Map<ChildProcess, ReturnType<typeof readCredentialProcessIdentity>>();

type Worker = {
  child: ChildProcess;
  messages: Array<Record<string, unknown>>;
};

function startWorker(role: "older" | "newer" | "orphan" | "preparing", timeoutMs = 2_000): Worker {
  const child = fork(fileURLToPath(new URL("./credential-mutation-worker.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"],
    env: {
      PATH: process.env.PATH, HOME: directory, USERPROFILE: directory,
      TSX_DISABLE_CACHE: "1",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      ...(process.env.JOBCTRL_PYTHON_EXECUTABLE ? { JOBCTRL_PYTHON_EXECUTABLE: process.env.JOBCTRL_PYTHON_EXECUTABLE } : {}),
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  workers.push(child);
  if (child.pid) identities.set(child, readCredentialProcessIdentity(child.pid));
  const worker: Worker = { child, messages: [] };
  child.on("message", (message: Record<string, unknown>) => { worker.messages.push(message); });
  child.send({
    type: "start", role, statePath, lockPath, timeoutMs,
    configPath: path.join(directory, `${role}-config.json`),
  });
  return worker;
}

async function waitFor(worker: Worker, type: string): Promise<Record<string, unknown>> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const message = worker.messages.find((candidate) => candidate.type === type);
    if (message) return message;
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Synthetic credential worker did not report ${type}.`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const original = await identities.get(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const current = child.pid ? await readCredentialProcessIdentity(child.pid) : { state: "unverified" as const };
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (original?.state !== "alive" || current.state !== "alive" || original.identity !== current.identity) {
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, 1_000);
      const onExit = (): void => { clearTimeout(timer); resolve(true); };
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) onExit();
    });
    if (exited) return;
    throw new Error("Cannot verify the owned synthetic worker before cleanup.");
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
  child.kill("SIGKILL");
  await exited;
}

describe("cross-process credential mutation ownership", () => {
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-credential-lock-test-"));
    lockPath = path.join(directory, "credential-lock.sqlite3");
    statePath = path.join(directory, "fake-native-store.json");
    fs.writeFileSync(statePath, JSON.stringify({
      ANTHROPIC_API_KEY: `${marker}-original`,
      GEMINI_API_KEY: `${marker}-untouched`,
    }));
    workers = [];
    identities = new Map();
  });

  afterEach(async () => {
    if (fs.existsSync(`${statePath}.ready`)) {
      fs.writeFileSync(`${statePath}.release`, "release");
      const deadline = performance.now() + 3_000;
      while (!fs.existsSync(`${statePath}.done`) && performance.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (!fs.existsSync(`${statePath}.done`)) {
        throw new Error("The synthetic helper did not complete; its temporary directory was preserved.");
      }
    }
    await Promise.all(workers.map(stop));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("does not mistake a reused live PID for the helper in a stale marker", async () => {
    fs.writeFileSync(`${lockPath}.inflight`, JSON.stringify({
      version: 1, id: "synthetic-stale-marker", ownerPid: process.pid,
      ownerIdentity: syntheticIdentity, childPid: process.pid,
      childIdentity: syntheticIdentity,
    }));
    const signal = vi.spyOn(process, "kill");
    try {
      await expect(withCredentialMutationLock(async () => "acquired", { path: lockPath, timeoutMs: 400 }))
        .resolves.toBe("acquired");
      expect(signal).not.toHaveBeenCalled();
    } finally { signal.mockRestore(); }
    expect(fs.existsSync(`${lockPath}.inflight`)).toBe(false);
  });

  it("retains a live helper with the exact recorded birth identity", async () => {
    const current = await readCredentialProcessIdentity(process.pid);
    expect(current.state).toBe("alive");
    if (current.state !== "alive") return;
    const content = JSON.stringify({
      version: 1, id: "synthetic-live-marker", ownerPid: process.pid, ownerIdentity: current.identity,
      childPid: process.pid, childIdentity: current.identity,
    });
    fs.writeFileSync(`${lockPath}.inflight`, content);
    const result = await withCredentialMutationLock(async () => "acquired", { path: lockPath, timeoutMs: 100 })
      .catch((error: unknown) => error);
    expect(result).toMatchObject({ reason: "busy" });
    expect(fs.readFileSync(`${lockPath}.inflight`, "utf8")).toBe(content);
  });

  it("clears a pre-registration marker when the owner PID has been reused", async () => {
    fs.writeFileSync(`${lockPath}.inflight`, JSON.stringify({
      version: 1, id: "synthetic-old-owner", ownerPid: process.pid,
      ownerIdentity: syntheticIdentity, childPid: null, childIdentity: null,
    }));
    const signal = vi.spyOn(process, "kill");
    try {
      await expect(withCredentialMutationLock(async () => "acquired", { path: lockPath, timeoutMs: 400 }))
        .resolves.toBe("acquired");
      expect(signal).not.toHaveBeenCalled();
    } finally { signal.mockRestore(); }
    expect(fs.existsSync(`${lockPath}.inflight`)).toBe(false);
  });

  it("preserves the marker and reports unverified when process identity is unavailable", async () => {
    const content = JSON.stringify({
      version: 1, id: "synthetic-unknown-marker", ownerPid: process.pid, ownerIdentity: syntheticIdentity,
      childPid: process.pid, childIdentity: syntheticIdentity,
    });
    fs.writeFileSync(`${lockPath}.inflight`, content);
    let entered = false;
    const signal = vi.spyOn(process, "kill");
    try {
      const result = await withCredentialMutationLock(async () => { entered = true; }, {
        path: lockPath, timeoutMs: 100, readIdentity: async () => ({ state: "unverified" }),
      }).catch((error: unknown) => error);
      expect(result).toMatchObject({ reason: "unverified" });
      expect(entered).toBe(false);
      expect(signal).not.toHaveBeenCalled();
      expect(fs.readFileSync(`${lockPath}.inflight`, "utf8")).toBe(content);
    } finally { signal.mockRestore(); }
  });

  it("preserves a legacy marker that has no verifiable process generation", async () => {
    const content = JSON.stringify({ version: 1, id: "synthetic-legacy", ownerPid: process.pid, childPid: process.pid });
    fs.writeFileSync(`${lockPath}.inflight`, content);
    const result = await withCredentialMutationLock(async () => "acquired", { path: lockPath, timeoutMs: 100 })
      .catch((error: unknown) => error);
    expect(result).toMatchObject({ reason: "unverified" });
    expect(fs.readFileSync(`${lockPath}.inflight`, "utf8")).toBe(content);
  });

  it("bounds an identity reader that never settles and preserves the marker", async () => {
    const content = JSON.stringify({
      version: 1, id: "synthetic-stuck-reader", ownerPid: process.pid, ownerIdentity: syntheticIdentity,
      childPid: process.pid, childIdentity: syntheticIdentity,
    });
    fs.writeFileSync(`${lockPath}.inflight`, content);
    const started = performance.now();
    const result = await withCredentialMutationLock(async () => "acquired", {
      path: lockPath, timeoutMs: 40, readIdentity: () => new Promise(() => undefined),
    }).catch((error: unknown) => error);
    expect(result).toMatchObject({ reason: "unverified" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(fs.readFileSync(`${lockPath}.inflight`, "utf8")).toBe(content);
  });

  it("serializes independent stores before rollback and keeps the newer successful value", async () => {
    const older = startWorker("older");
    await waitFor(older, "blocked");
    const newer = startWorker("newer");
    await waitFor(newer, "started");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(newer.messages.some((message) => message.type === "runner_started")).toBe(false);

    older.child.send({ type: "release" });
    expect(await waitFor(older, "done")).toMatchObject({ ok: false, reason: "operational_failure", leaked: false });
    expect(await waitFor(newer, "done")).toMatchObject({ ok: true, configured: true, leaked: false });
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, string>;
    expect(state.ANTHROPIC_API_KEY === `${marker}-newer`).toBe(true);
    expect(state.GEMINI_API_KEY === `${marker}-untouched`).toBe(true);
    expect(fs.readFileSync(lockPath).includes(Buffer.from(marker))).toBe(false);
  });

  it("reports bounded contention without entering the store and releases ownership on process death", async () => {
    const older = startWorker("older");
    await waitFor(older, "blocked");
    const waiting = startWorker("newer", 120);
    expect(await waitFor(waiting, "done")).toMatchObject({ ok: false, reason: "busy", leaked: false });
    expect(waiting.messages.some((message) => message.type === "runner_started")).toBe(false);

    await stop(older.child);
    const successor = startWorker("newer");
    expect(await waitFor(successor, "done")).toMatchObject({ ok: true, configured: true, leaked: false });
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, string>;
    expect(state.ANTHROPIC_API_KEY === `${marker}-newer`).toBe(true);
    expect(fs.readFileSync(lockPath).includes(Buffer.from(marker))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("fences an orphaned helper after its API owner is killed", async () => {
    const owner = startWorker("orphan");
    const deadline = performance.now() + 5_000;
    while (!fs.existsSync(`${statePath}.ready`) && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(`${statePath}.ready`)).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(`${lockPath}.inflight`, "utf8")) as { childPid: number; childIdentity: string };
    expect(receipt.childPid > 0).toBe(true);
    const liveIdentity = await readCredentialProcessIdentity(receipt.childPid);
    expect(liveIdentity.state).toBe("alive");
    if (liveIdentity.state === "alive") expect(liveIdentity.identity === receipt.childIdentity).toBe(true);
    await stop(owner.child);
    try {
      const contender = startWorker("newer", 120);
      expect(await waitFor(contender, "done")).toMatchObject({ ok: false, reason: "busy", leaked: false });
      expect(contender.messages.some((message) => message.type === "runner_started")).toBe(false);
    } finally {
      fs.writeFileSync(`${statePath}.release`, "release");
    }

    const successor = startWorker("newer", 3_000);
    expect(await waitFor(successor, "done")).toMatchObject({ ok: true, configured: true, leaked: false });
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, string>;
    expect(state.ANTHROPIC_API_KEY === `${marker}-newer`).toBe(true);
    expect(fs.existsSync(`${lockPath}.inflight`)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("keeps a helper inert if its owner dies before recording the helper identity", async () => {
    const owner = startWorker("preparing");
    const deadline = performance.now() + 5_000;
    while (!fs.existsSync(`${statePath}.spawned`) && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(`${statePath}.spawned`)).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(`${lockPath}.inflight`, "utf8")) as { childPid: number | null };
    expect(receipt.childPid).toBeNull();
    await stop(owner.child);
    const successor = startWorker("newer");
    expect(await waitFor(successor, "done")).toMatchObject({ ok: true, configured: true, leaked: false });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(`${statePath}.ready`)).toBe(false);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, string>;
    expect(state.ANTHROPIC_API_KEY === `${marker}-newer`).toBe(true);
  });
});
