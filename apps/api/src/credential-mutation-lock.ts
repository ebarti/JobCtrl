import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import {
  readCredentialProcessIdentity,
  validCredentialProcessIdentity,
  type ProcessIdentityObservation,
  type ProcessIdentityReader,
} from "./credential-process-identity.js";

// Every JobCtrl API process for this OS user addresses the same native
// credential namespace, even when its JOBCTRL_DIR or HOME differs.
const LOCK_NAME = ".jobctrl-credential-mutations.sqlite3";
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 20;

export class CredentialMutationLockError extends Error {
  constructor(readonly reason: "busy" | "unverified" | "operational") {
    super("Credential mutation coordination failed.");
  }
}

/** A timed-out mutation whose underlying helper has not yet stopped. */
export class CredentialMutationPendingError extends Error {
  constructor(readonly completion: Promise<unknown>) {
    super("Credential mutation completion is not yet known.");
  }
}

export interface CredentialMutationGuard {
  begin(): Promise<{ started(pid: number, isRunning?: () => boolean): Promise<void>; clear(): void }>;
}

type Marker = {
  version: 1; id: string; ownerPid: number; ownerIdentity: string;
  childPid: number | null; childIdentity: string | null;
};

/** Holds a secret-free SQLite writer lock until the complete mutation finishes. */
export async function withCredentialMutationLock<T>(
  action: (guard: CredentialMutationGuard) => Promise<T>,
  options: { path?: string; timeoutMs?: number; readIdentity?: ProcessIdentityReader } = {},
): Promise<T> {
  let db: Database.Database | undefined;
  let lockPath = "";
  const readIdentity = options.readIdentity ?? readCredentialProcessIdentity;
  try {
    lockPath = options.path ?? path.join(os.userInfo().homedir, LOCK_NAME);
    try {
      const file = fs.openSync(lockPath, "ax", 0o600);
      fs.closeSync(file);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const info = fs.lstatSync(lockPath);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Invalid credential lock file.");

    db = new Database(lockPath, { timeout: 0, fileMustExist: true });
    const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
    const deadline = performance.now() + timeoutMs;
    while (true) {
      try {
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!hasCode(error, "SQLITE_BUSY") && !hasCode(error, "SQLITE_LOCKED")) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new CredentialMutationLockError("busy");
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(LOCK_RETRY_MS, remaining)));
      }
    }
    await awaitPreviousHelper(`${lockPath}.inflight`, deadline, readIdentity);
  } catch (error) {
    try { db?.close(); } catch { /* Do not expose filesystem or SQLite errors. */ }
    if (error instanceof CredentialMutationLockError) throw error;
    throw new CredentialMutationLockError("operational");
  }

  let retained = false;
  try {
    return await action({ begin: () => beginMutation(`${lockPath}.inflight`, readIdentity) });
  } catch (error) {
    if (error instanceof CredentialMutationPendingError) {
      // A timed-out operation may still write. Keep ownership until its runner
      // actually settles; the caller receives a bounded partial-failure result.
      retained = true;
      const release = (): void => { try { db.close(); } catch { /* Remain fail-closed. */ } };
      void error.completion.then(release, release);
    }
    throw error;
  } finally {
    // Closing rolls back the empty transaction and releases the OS lock. The
    // persistent lock file must not be unlinked, including after a crash.
    if (!retained) {
      try {
        db.close();
      } catch {
        throw new CredentialMutationLockError("operational");
      }
    }
  }
}

async function beginMutation(
  markerPath: string,
  readIdentity: ProcessIdentityReader,
): Promise<{ started(pid: number, isRunning?: () => boolean): Promise<void>; clear(): void }> {
  if (readMarker(markerPath)) throw new Error("Credential helper ownership is still recorded.");
  const owner = await observeIdentity(readIdentity, process.pid, 1_000);
  if (owner.state !== "alive" || !validCredentialProcessIdentity(owner.identity)) throw new CredentialMutationLockError("unverified");
  const marker: Marker = {
    version: 1, id: crypto.randomUUID(), ownerPid: process.pid, ownerIdentity: owner.identity,
    childPid: null, childIdentity: null,
  };
  publishMarker(markerPath, marker);
  return {
    async started(pid: number, isRunning?: () => boolean): Promise<void> {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Missing credential helper identity.");
      if (isRunning && !isRunning()) throw new CredentialMutationLockError("unverified");
      const child = await observeIdentity(readIdentity, pid, 1_000);
      if ((isRunning && !isRunning()) || child.state !== "alive" || !validCredentialProcessIdentity(child.identity)) {
        throw new CredentialMutationLockError("unverified");
      }
      marker.childPid = pid;
      marker.childIdentity = child.identity;
      publishMarker(markerPath, marker);
    },
    clear(): void {
      const current = readMarker(markerPath);
      if (!current || current.id !== marker.id) throw new Error("Credential helper ownership changed.");
      fs.unlinkSync(markerPath);
      syncDirectory(path.dirname(markerPath));
    },
  };
}

function publishMarker(markerPath: string, marker: Marker): void {
  const temporary = `${markerPath}.${marker.id}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(marker));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, markerPath);
  syncDirectory(path.dirname(markerPath));
}

async function awaitPreviousHelper(markerPath: string, deadline: number, readIdentity: ProcessIdentityReader): Promise<void> {
  let previouslyMatched = false;
  while (true) {
    const marker = readMarker(markerPath);
    if (!marker) return;
    const pid = marker.childPid ?? marker.ownerPid;
    const identity = marker.childPid === null ? marker.ownerIdentity : marker.childIdentity;
    const remainingBeforeRead = deadline - performance.now();
    if (remainingBeforeRead <= 0) throw new CredentialMutationLockError(previouslyMatched ? "busy" : "unverified");
    const observation = await observeIdentity(readIdentity, pid, remainingBeforeRead);
    if (observation.state === "timeout") {
      throw new CredentialMutationLockError(previouslyMatched && remainingBeforeRead <= 1_000 ? "busy" : "unverified");
    }
    if (observation.state === "unverified") throw new CredentialMutationLockError("unverified");
    if (observation.state === "alive" && !validCredentialProcessIdentity(observation.identity)) {
      throw new CredentialMutationLockError("unverified");
    }
    if (observation.state === "exited" || observation.identity !== identity) {
      fs.unlinkSync(markerPath);
      syncDirectory(path.dirname(markerPath));
      return;
    }
    previouslyMatched = true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new CredentialMutationLockError("busy");
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(LOCK_RETRY_MS, remaining)));
  }
}

async function observeIdentity(reader: ProcessIdentityReader, pid: number, timeoutMs: number): Promise<ProcessIdentityObservation> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => reader(pid, timeoutMs)).catch((): ProcessIdentityObservation => ({ state: "unverified" })),
      new Promise<ProcessIdentityObservation>((resolve) => {
        timer = setTimeout(() => resolve({ state: "timeout" }), Math.max(1, Math.min(timeoutMs, 1_000)));
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function readMarker(markerPath: string): Marker | null {
  try {
    const info = fs.lstatSync(markerPath);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Invalid credential helper marker.");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<Marker>;
    if (marker.version !== 1 || typeof marker.id !== "string" ||
        !Number.isSafeInteger(marker.ownerPid) || (marker.ownerPid ?? 0) <= 0 ||
        typeof marker.ownerIdentity !== "string" || !validCredentialProcessIdentity(marker.ownerIdentity) ||
        (marker.childPid === null ? marker.childIdentity !== null :
          !Number.isSafeInteger(marker.childPid) || (marker.childPid ?? 0) <= 0 ||
          typeof marker.childIdentity !== "string" || !validCredentialProcessIdentity(marker.childIdentity))) {
      throw new CredentialMutationLockError("unverified");
    }
    return marker as Marker;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    if (error instanceof CredentialMutationLockError) throw error;
    throw new CredentialMutationLockError("unverified");
  }
}

function syncDirectory(directory: string): void {
  // Windows does not support opening directories with fs.openSync. File data
  // is flushed before publication; a surviving marker always fails closed.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
